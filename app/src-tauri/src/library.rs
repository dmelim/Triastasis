//! App-owned access to the existing revisioned desktop Library. Not a second catalogue.
use super::*;
use serde_json::{json, Value};
use tauri::Manager;

pub(crate) fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("triastasis/gallery-v1");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::canonicalize(root).map_err(|e| e.to_string())
}

fn encoded(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 512 {
        return Err("invalid Library ID".into());
    }
    Ok(id.as_bytes().iter().map(|b| format!("{b:02x}")).collect())
}

fn contained(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("Library path escapes its root".into());
    }
    Ok(canonical)
}

pub(crate) struct Record {
    pub metadata: Value,
    input: PathBuf,
    model: PathBuf,
}

fn read_revision(root: &Path, dir: &Path, expected: &str) -> Result<Record, String> {
    let dir = contained(root, dir)?;
    let meta = contained(&dir, &dir.join("metadata.json"))?;
    if std::fs::metadata(&meta).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Library metadata exceeds 1 MB".into());
    }
    let mut metadata: Value =
        serde_json::from_slice(&std::fs::read(meta).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let id = metadata["id"]
        .as_str()
        .ok_or("Library record has no ID")?
        .to_owned();
    if encoded(&id)? != expected {
        return Err("Library ID does not match its directory".into());
    }
    if !metadata["versionId"].is_string() {
        metadata["versionId"] = json!(id);
    }
    if !metadata["assetId"].is_string() {
        metadata["assetId"] = metadata
            .get("sweepGroupId")
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or(json!(id));
    }
    if !metadata["createdAt"].is_number() {
        metadata["createdAt"] = metadata["ts"].clone();
    }
    let input = contained(&dir, &dir.join("input.bin"))?;
    let model = contained(&dir, &dir.join("model.glb"))?;
    if !input.is_file() || !model.is_file() {
        return Err("Library blobs are not files".into());
    }
    Ok(Record {
        metadata,
        input,
        model,
    })
}

fn read_record(root: &Path, name: &str) -> Result<Record, String> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not a Library record".into());
    }
    let dir = contained(root, &root.join(name))?;
    let mut revisions = Vec::new();
    if let Ok(revision_root) = contained(&dir, &dir.join("revisions")) {
        for entry in std::fs::read_dir(revision_root)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Ok(n) = name.parse::<u64>() {
                revisions.push((n, entry.path()));
            }
        }
    }
    revisions.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in revisions {
        if let Ok(record) = read_revision(&dir, &path, name) {
            return Ok(record);
        }
    }
    read_revision(root, &dir, name)
}

pub(crate) fn records(root: &Path) -> Result<(Vec<Record>, Vec<String>), String> {
    let mut records = Vec::new();
    let mut warnings = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        match read_record(root, &name) {
            Ok(record) => records.push(record),
            Err(error) => warnings.push(format!("Unreadable Library record {name}: {error}")),
        }
    }
    records.sort_by_key(|r| std::cmp::Reverse(r.metadata["createdAt"].as_u64().unwrap_or(0)));
    Ok((records, warnings))
}

fn version(root: &Path, id: &str) -> Result<Record, String> {
    // Directory ID and versionId normally coincide. Preserve legacy aliases too.
    if let Ok(record) = read_record(root, &encoded(id)?) {
        if record.metadata["versionId"] == id || record.metadata["id"] == id {
            return Ok(record);
        }
    }
    records(root)?
        .0
        .into_iter()
        .find(|r| r.metadata["versionId"] == id)
        .ok_or_else(|| "Library version not found".into())
}

pub(crate) fn list(root: &Path, asset: Option<&str>) -> Result<Value, String> {
    let (records, warnings) = records(root)?;
    if let Some(asset) = asset {
        let versions: Vec<Value> = records
            .into_iter()
            .filter(|r| r.metadata["assetId"] == asset)
            .map(|r| r.metadata)
            .collect();
        return Ok(json!({"assetId":asset, "versions":versions, "warnings":warnings}));
    }
    let mut assets = std::collections::BTreeMap::<String, Value>::new();
    for record in records {
        let m = record.metadata;
        let id = m["assetId"].as_str().ok_or("invalid asset ID")?.to_owned();
        let entry = assets.entry(id.clone()).or_insert_with(|| {
            json!({
                "assetId":id, "label":m.get("label").unwrap_or(&m["name"]),
                "latestVersionId":m["versionId"], "createdAt":m["createdAt"], "versionCount":0
            })
        });
        entry["versionCount"] = json!(entry["versionCount"].as_u64().unwrap_or(0) + 1);
    }
    Ok(json!({"assets":assets.into_values().collect::<Vec<_>>(), "warnings":warnings}))
}

pub(crate) fn inspect(root: &Path, id: &str) -> Result<Value, String> {
    Ok(version(root, id)?.metadata)
}

fn package_job(record: &Record) -> Result<DurableJob, String> {
    let m = &record.metadata;
    let mut params = m["params"].clone();
    if !params.is_object() {
        params = json!({});
    }
    for key in [
        "targetFaces",
        "atlasSize",
        "textureResolution",
        "remeshBand",
    ] {
        if params[key] == "auto" {
            params[key] = Value::Null;
        }
    }
    Ok(DurableJob {
        id: m["versionId"].as_str().ok_or("missing version ID")?.into(),
        status: JobStatus::Succeeded,
        source_image_path: record.input.to_string_lossy().into_owned(),
        output_path: Some(record.model.to_string_lossy().into_owned()),
        source_name: match m["inputType"].as_str() {
            Some("image/jpeg") => "source.jpg",
            Some("image/webp") => "source.webp",
            _ => "source.png",
        }
        .into(),
        params: serde_json::from_value(params)
            .map_err(|e| format!("invalid Library parameters: {e}"))?,
        submitted_at: m["createdAt"].as_u64().unwrap_or(0),
        ..DurableJob::default()
    })
}

fn validate_model(path: &Path) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    if !(20..=512 * 1024 * 1024).contains(&length) {
        return Err("Library GLB size is invalid".into());
    }
    let mut header = [0u8; 20];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    let word = |start| u32::from_le_bytes(header[start..start + 4].try_into().unwrap());
    if &header[..4] != b"glTF"
        || word(4) != 2
        || u64::from(word(8)) != length
        || word(16) != 0x4e4f534a
        || u64::from(word(12)) + 20 > length
    {
        return Err("Library model is not a valid GLB 2 container".into());
    }
    Ok(())
}

pub(crate) fn export(
    root: &Path,
    id: &str,
    destination: &Path,
    format: &str,
) -> Result<Value, (u16, String)> {
    let record = version(root, id).map_err(|e| (404, e))?;
    validate_model(&record.model).map_err(|e| (422, e))?;
    if format == "glb" {
        if !destination.is_absolute() {
            return Err((400, "destinationPath must be absolute".into()));
        }
        // create_new in copy_file_verified refuses existing files, including links.
        if destination.symlink_metadata().is_ok() {
            return Err((409, "exports never overwrite".into()));
        }
        let file = copy_file_verified(&record.model, destination, "glb").map_err(|e| (500, e))?;
        return Ok(
            json!({"versionId":id,"destinationPath":destination,"qualityWarning":record.metadata["qualityWarning"],"files":[file]}),
        );
    }
    if format != "package" {
        return Err((400, "format must be package or glb".into()));
    }
    let job = package_job(&record).map_err(|e| (422, e))?;
    let source = export_source_name(&job.source_name);
    let mut manifest = generation_manifest(&job, &source, "asset-static.glb");
    let m = &record.metadata;
    manifest.quality_warning =
        serde_json::from_value(m.get("qualityWarning").cloned().unwrap_or(Value::Null))
            .map_err(|e| (422, format!("invalid saved quality warning: {e}")))?;
    manifest.job_id = m["operationParams"]["automationJobId"]
        .as_str()
        .map(str::to_owned);
    manifest.asset_id = m["assetId"].as_str().map(str::to_owned);
    manifest.version_id = m["versionId"].as_str().map(str::to_owned);
    manifest.parent_version_id = m["parentVersionId"].as_str().map(str::to_owned);
    manifest.label = m["label"]
        .as_str()
        .or(m["name"].as_str())
        .unwrap_or("Model")
        .into();
    if let Some(group) = m["sweepGroupId"].as_str() {
        manifest.sweep = serde_json::from_value(json!({
            "groupId":group,"index":m["sweepIndex"],"count":m["sweepCount"],
            "seed":job.params.seed,"state":"completed"
        }))
        .ok();
    }
    // Full Library metadata travels with the package, including operation history.
    let response = export_package(job, destination, Some(manifest), Some(m.clone()))?;
    Ok(
        json!({"versionId":id,"assetId":m["assetId"],"destinationPath":response.destination_path,
        "manifestPath":response.manifest_path,"files":response.files}),
    )
}

/// Registration receipts outlive deletion. Missing Library items are not resurrected.
fn receipt(root: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(root.join(format!(".registered-{}", encoded(id)?)))
}

pub(super) fn register(root: &Path, job: &DurableJob) -> Result<bool, String> {
    let id = format!("automation-{}", job.id);
    let marker = receipt(root, &id)?;
    if marker.try_exists().map_err(|e| e.to_string())? {
        return Ok(false);
    }
    if let Ok(record) = version(root, &id) {
        if record.metadata["id"] == id {
            std::fs::write(&marker, b"registered\n").map_err(|e| e.to_string())?;
            return Ok(false);
        }
    }
    // Packages imported before automatic registration may already represent this job.
    if records(root)?
        .0
        .iter()
        .any(|r| r.metadata["operationParams"]["originalIds"]["jobId"] == job.id)
    {
        std::fs::write(&marker, b"registered\n").map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let target = root.join(encoded(&id)?);
    if target.exists() {
        return Err(format!("Library record {id} exists but is unreadable"));
    }
    let stage = root.join(format!(
        ".registration-{}-{}",
        std::process::id(),
        JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        copy_file_verified(
            Path::new(&job.source_image_path),
            &stage.join("input.bin"),
            "sourceImage",
        )?;
        let model = job
            .output_path
            .as_ref()
            .ok_or("completed job has no model")?;
        copy_file_verified(Path::new(model), &stage.join("model.glb"), "glb")?;
        let metadata = json!({
            "id":id,"versionId":id,"assetId":id,"name":job.source_name,"label":job.source_name,
            "ts":job.submitted_at,"createdAt":job.submitted_at,"params":job.params,
            "operation":"generated","operationParams":{"automationJobId":job.id},
            "favorite":false,"qualityWarning":job.quality_warning,"metrics":null,
            "inputType":job.source_type,"glbType":"model/gltf-binary","thumbType":null,"hasThumb":false
        });
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(stage.join("metadata.json"))
            .map_err(|e| e.to_string())?;
        f.write_all(&serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&stage, &target).map_err(|e| e.to_string())?;
        std::fs::write(&marker, b"registered\n").map_err(|e| e.to_string())?;
        Ok(true)
    })();
    if result.is_err() {
        for file in ["input.bin", "model.glb", "metadata.json"] {
            let _ = std::fs::remove_file(stage.join(file));
        }
        let _ = std::fs::remove_dir(stage);
    }
    result
}

/// Do not resurrect pre-upgrade deletions whose old job history has no receipt.
/// Historical outputs remain available through the legacy job export/import flow.
pub(super) fn baseline(root: &Path, jobs: &[DurableJob]) -> Result<(), String> {
    let marker = root.join(".registration-baseline");
    if marker.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    for job in jobs {
        let path = receipt(root, &format!("automation-{}", job.id))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(b"historical\n").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(marker)
        .map_err(|e| e.to_string())?;
    file.write_all(b"historical jobs accounted for\n")
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "triastasis-library-test-{}-{}",
                std::process::id(),
                JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&p).unwrap();
            Self(std::fs::canonicalize(p).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn glb() -> Vec<u8> {
        let mut json = br#"{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}],"scene":0}"#.to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let mut bytes = b"glTF".to_vec();
        bytes.extend(2u32.to_le_bytes());
        bytes.extend(((20 + json.len()) as u32).to_le_bytes());
        bytes.extend((json.len() as u32).to_le_bytes());
        bytes.extend(0x4e4f534au32.to_le_bytes());
        bytes.extend(json);
        bytes
    }
    fn record(root: &Path, id: &str, revision: Option<u32>, metadata: Value) -> PathBuf {
        let dir = root.join(encoded(id).unwrap());
        let dir = revision
            .map(|n| dir.join("revisions").join(n.to_string()))
            .unwrap_or(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("input.bin"), b"\x89PNG\r\n\x1a\nsource pixels").unwrap();
        std::fs::write(dir.join("model.glb"), glb()).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        dir
    }
    fn metadata(id: &str) -> Value {
        json!({"id":id,"versionId":id,"assetId":"arch-group","parentVersionId":"base",
            "operation":"edited","operationParams":{"scale":2},"label":"Edited arch","name":"arch.png",
            "createdAt":10,"inputType":"image/png","hasThumb":false,
            "params":{"resolution":512,"seed":42,"targetFaces":"auto","atlasSize":"auto"},
            "sweepGroupId":"arch-group","sweepIndex":0,"sweepCount":4})
    }
    #[test]
    fn all_origins_share_assets_and_keep_sweep_grouping() {
        let f = Fixture::new();
        for (n, operation) in ["generated", "imported", "edited", "generated"]
            .iter()
            .enumerate()
        {
            let id = format!("version-{n}");
            let mut m = metadata(&id);
            m["operation"] = json!(operation);
            record(&f.0, &id, Some(1), m);
        }
        let listing = list(&f.0, None).unwrap();
        assert_eq!(listing["assets"].as_array().unwrap().len(), 1);
        assert_eq!(listing["assets"][0]["versionCount"], 4);
        assert_eq!(
            list(&f.0, Some("arch-group")).unwrap()["versions"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }
    #[test]
    fn reads_latest_complete_revision_and_falls_back_from_interruption() {
        let f = Fixture::new();
        record(&f.0, "v", None, metadata("v"));
        let mut m = metadata("v");
        m["label"] = json!("newest");
        record(&f.0, "v", Some(2), m);
        let bad = record(&f.0, "v", Some(3), metadata("v"));
        std::fs::remove_file(bad.join("model.glb")).unwrap();
        assert_eq!(inspect(&f.0, "v").unwrap()["label"], "newest");
    }
    #[test]
    fn export_preserves_selected_version_lineage_and_hashes() {
        let f = Fixture::new();
        let source = record(&f.0, "v", Some(1), metadata("v"));
        let before = sha256_file(&source.join("model.glb")).unwrap();
        let destination = f.0.join("export");
        let response = export(&f.0, "v", &destination, "package").unwrap();
        assert_eq!(response["versionId"], "v");
        assert_eq!(
            sha256_file(&destination.join("asset-static.glb")).unwrap(),
            before
        );
        assert_eq!(sha256_file(&source.join("model.glb")).unwrap(), before);
        let preview = crate::manifest::read_generation_manifest_impl(
            &destination
                .join("asset-static.triastasis.json")
                .to_string_lossy(),
        )
        .unwrap();
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        assert_eq!(preview.manifest.version_id.as_deref(), Some("v"));
        assert_eq!(preview.manifest.parent_version_id.as_deref(), Some("base"));
        assert_eq!(preview.manifest.sweep.unwrap().group_id, "arch-group");
        let m: Value =
            serde_json::from_slice(&std::fs::read(destination.join("job.json")).unwrap()).unwrap();
        assert_eq!(m["operationParams"]["scale"], 2);
        assert_eq!(
            export(&f.0, "v", &destination, "package").unwrap_err().0,
            409
        );
    }
    #[test]
    fn standalone_export_uses_same_version_and_never_overwrites() {
        let f = Fixture::new();
        record(&f.0, "v", None, metadata("v"));
        let path = f.0.join("chosen.glb");
        export(&f.0, "v", &path, "glb").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), glb());
        assert_eq!(export(&f.0, "v", &path, "glb").unwrap_err().0, 409);
        assert_eq!(
            export(&f.0, "v", Path::new("relative"), "glb")
                .unwrap_err()
                .0,
            400
        );
    }
    #[test]
    fn malformed_records_and_path_escape_do_not_become_assets() {
        let f = Fixture::new();
        record(&f.0, "v", None, metadata("other"));
        assert_eq!(
            list(&f.0, None).unwrap()["warnings"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(inspect(&f.0, "../../v").is_err());
        assert!(contained(&f.0, f.0.parent().unwrap()).is_err());
        assert!(decode_library_id("%ZZ").is_err());
        assert_eq!(decode_library_id("a%20b").unwrap(), "a b");
    }
    #[test]
    fn registration_is_durable_idempotent_and_survives_deletion() {
        let f = Fixture::new();
        let source = record(&f.0, "source", None, metadata("source"));
        let job = DurableJob {
            id: "synthetic".into(),
            status: JobStatus::Succeeded,
            source_image_path: source.join("input.bin").to_string_lossy().into_owned(),
            output_path: Some(source.join("model.glb").to_string_lossy().into_owned()),
            source_name: "arch.png".into(),
            source_type: "image/png".into(),
            ..DurableJob::default()
        };
        assert!(register(&f.0, &job).unwrap());
        assert!(!register(&f.0, &job).unwrap());
        let m = inspect(&f.0, "automation-synthetic").unwrap();
        assert_eq!(m["operationParams"]["automationJobId"], "synthetic");
        std::fs::remove_dir_all(f.0.join(encoded("automation-synthetic").unwrap())).unwrap();
        assert!(!register(&f.0, &job).unwrap());
        assert!(inspect(&f.0, "automation-synthetic").is_err());
    }
    #[test]
    fn registration_does_not_duplicate_previously_imported_packages() {
        let f = Fixture::new();
        let mut m = metadata("imported");
        m["operationParams"] = json!({"originalIds":{"jobId":"synthetic"}});
        record(&f.0, "imported", None, m);
        let job = DurableJob {
            id: "synthetic".into(),
            ..DurableJob::default()
        };
        assert!(!register(&f.0, &job).unwrap());
        assert_eq!(records(&f.0).unwrap().0.len(), 1);
    }
    #[test]
    fn upgrade_baseline_does_not_resurrect_historical_deletions() {
        let f = Fixture::new();
        let old = DurableJob {
            id: "old".into(),
            status: JobStatus::Succeeded,
            ..DurableJob::default()
        };
        baseline(&f.0, &[old.clone()]).unwrap();
        assert!(!register(&f.0, &old).unwrap());
        assert!(records(&f.0).unwrap().0.is_empty());
        assert!(!receipt(&f.0, "automation-new").unwrap().exists());
        baseline(
            &f.0,
            &[DurableJob {
                id: "new".into(),
                ..DurableJob::default()
            }],
        )
        .unwrap();
        assert!(!receipt(&f.0, "automation-new").unwrap().exists());
    }

    #[test]
    fn corrupt_glb_is_rejected_before_creating_destination() {
        let f = Fixture::new();
        let source = record(&f.0, "v", None, metadata("v"));
        std::fs::write(source.join("model.glb"), b"not a GLB").unwrap();
        let target = f.0.join("bad.glb");
        assert_eq!(export(&f.0, "v", &target, "glb").unwrap_err().0, 422);
        assert!(!target.exists());
    }
}

#[tauri::command]
pub(crate) async fn export_library_version(
    app: tauri::AppHandle,
    version_id: String,
    destination_path: String,
    format: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export(
            &root(&app)?,
            &version_id,
            Path::new(&destination_path),
            format.as_deref().unwrap_or("package"),
        )
        .map_err(|(_, e)| e)
    })
    .await
    .map_err(|e| e.to_string())?
}
