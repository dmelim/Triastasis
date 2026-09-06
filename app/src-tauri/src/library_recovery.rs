//! Explicit, app-owned recovery of an old Library. Never writes to the source.
use super::*;
use std::sync::Mutex;
static RECOVERY: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    pub id: String,
    pub fingerprint: String,
}

fn source_root(destination: &Path, source: &Path) -> Result<PathBuf, String> {
    if !source.is_absolute() {
        return Err("sourcePath must be absolute".into());
    }
    let source = std::fs::canonicalize(source).map_err(|e| e.to_string())?;
    if !source.is_dir() || source.starts_with(destination) || destination.starts_with(&source) {
        return Err("source must be a separate Library directory".into());
    }
    Ok(source)
}
fn signature(record: &Record) -> Result<(String, String, String), String> {
    let model = sha256_file(&record.model)?.1;
    let input = sha256_file(&record.input)?.1;
    let mut hash = Sha256::new();
    hash.update(model.as_bytes());
    hash.update(input.as_bytes());
    hash.update(serde_json::to_vec(&record.metadata).map_err(|e| e.to_string())?);
    Ok((model, input, format!("{:x}", hash.finalize())))
}
type Indexed = (Record, (String, String, String));
fn index(root: &Path) -> Result<(Vec<Indexed>, Vec<String>), String> {
    let (records, warnings) = records(root)?;
    let mut indexed = Vec::new();
    for record in records {
        let hashes = signature(&record)?;
        indexed.push((record, hashes));
    }
    Ok((indexed, warnings))
}
fn classify(root: &Path, record: &Record, existing: &[Indexed]) -> Result<Value, String> {
    let (model, input, fingerprint) = signature(record)?;
    let id = record.metadata["id"].as_str().ok_or("missing ID")?;
    let mut status = "missing";
    let mut matching = Value::Null;
    // Identity collisions take precedence over a matching model elsewhere.
    let collision = existing.iter().find(|(r, _)| {
        r.metadata["id"] == id || r.metadata["versionId"] == record.metadata["versionId"]
    });
    if let Some((other, (m, i, _))) = collision {
        status = if m == &model && i == &input {
            "duplicate"
        } else {
            "conflict"
        };
        matching = other.metadata["id"].clone();
    } else if root
        .join(encoded(id)?)
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        status = "conflict";
    } else {
        for (other, (m, i, _)) in existing {
            if m == &model && i == &input {
                status = "duplicate";
                matching = other.metadata["id"].clone();
                break;
            }
        }
    }
    Ok(
        json!({"id":id,"label":record.metadata.get("label").or(record.metadata.get("name")),"status":status,
        "matchingId":matching,"fingerprint":fingerprint,"modelSha256":model,"inputSha256":input,
        "sourceDirectory":record.model.parent()}),
    )
}
pub(crate) fn scan(root: &Path, source: &Path) -> Result<Value, String> {
    let source = source_root(root, source)?;
    let (candidates, warnings) = records(&source)?;
    let (existing, destination_warnings) = index(root)?;
    let mut entries = Vec::new();
    for record in candidates {
        entries.push(classify(root, &record, &existing)?);
    }
    Ok(
        json!({"sourcePath":source,"destinationPath":root,"records":entries,"warnings":warnings,"destinationWarnings":destination_warnings}),
    )
}
fn copy_record(
    root: &Path,
    source: &Path,
    record: &Record,
    fingerprint: &str,
) -> Result<(), String> {
    let id = record.metadata["id"].as_str().ok_or("missing ID")?;
    let target = root.join(encoded(id)?);
    if target.try_exists().map_err(|e| e.to_string())? {
        return Err("destination already exists".into());
    }
    let stage = root.join(format!(
        ".recovery-{}-{}",
        std::process::id(),
        JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        copy_file_verified(&record.input, &stage.join("input.bin"), "sourceImage")?;
        copy_file_verified(&record.model, &stage.join("model.glb"), "glb")?;
        let mut metadata = record.metadata.clone();
        metadata
            .as_object_mut()
            .ok_or("invalid metadata")?
            .remove("revision");
        let thumb = record.model.parent().unwrap().join("thumb.bin");
        if metadata["hasThumb"] == true {
            if let Ok(thumb) = contained(source, &thumb) {
                copy_file_verified(&thumb, &stage.join("thumb.bin"), "thumbnail")?;
            } else {
                metadata["hasThumb"] = json!(false);
                metadata["thumbType"] = Value::Null;
            }
        }
        // Re-read the selected revision and metadata after copying; changed scans are rejected.
        let fresh = read_record(source, &encoded(id)?)?;
        if signature(&fresh)?.2 != fingerprint {
            return Err("source changed since scan; scan again".into());
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.join("metadata.json"))
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if target.try_exists().map_err(|e| e.to_string())? {
            return Err("destination appeared during recovery".into());
        }
        std::fs::rename(&stage, &target).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}
pub(crate) fn recover(root: &Path, source: &Path, selected: &[Selection]) -> Result<Value, String> {
    let _guard = RECOVERY.lock().map_err(|_| "recovery lock unavailable")?;
    if selected.is_empty() || selected.len() > 500 {
        return Err("select between 1 and 500 records".into());
    }
    let source = source_root(root, source)?;
    let mut results = Vec::new();
    let (mut existing, _) = index(root)?;
    for selection in selected {
        let result = (|| -> Result<Value, String> {
            let record = read_record(&source, &encoded(&selection.id)?)?;
            let entry = classify(root, &record, &existing)?;
            if entry["status"] != "missing" {
                return Ok(entry);
            }
            if entry["fingerprint"] != selection.fingerprint {
                return Err("source changed since scan; scan again".into());
            }
            validate_model(&record.model)?;
            copy_record(root, &source, &record, &selection.fingerprint)?;
            let copied = read_record(root, &encoded(&selection.id)?)?;
            let hashes = signature(&copied)?;
            existing.push((copied, hashes));
            Ok(json!({"id":selection.id,"status":"imported"}))
        })();
        results
            .push(result.unwrap_or_else(
                |error| json!({"id":selection.id,"status":"failed","error":error}),
            ));
    }
    Ok(json!({"sourcePath":source,"destinationPath":root,"results":results}))
}
