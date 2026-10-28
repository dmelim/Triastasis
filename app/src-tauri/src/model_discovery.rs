//! Recognition of catalog bundles in configured, user-owned model folders.
//! Discovery never adopts, moves, registers or deletes those files.
use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBundleState {
    pub bundle_id: String,
    pub dir: String,
    pub verified: bool,
    pub active: bool,
    pub total_bytes: u64,
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| dunce::simplified(path).to_path_buf())
}

pub fn same_directory(left: &Path, right: &Path) -> bool {
    let (left, right) = (canonical(left), canonical(right));
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub fn directory_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("gguf"))
            {
                return None;
            }
            entry
                .metadata()
                .ok()
                .filter(|m| m.is_file())
                .map(|m| m.len())
        })
        .sum()
}

pub fn cache_dir() -> Option<PathBuf> {
    crate::config::config_path()?
        .parent()
        .map(|p| p.join("model-verifications"))
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct FileStamp {
    name: String,
    size: u64,
    modified: (u64, u32),
    created: Option<(u64, u32)>,
}

fn timestamp(value: std::time::SystemTime) -> Result<(u64, u32), String> {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs(), d.subsec_nanos()))
        .map_err(|e| format!("could not inspect model timestamp: {e}"))
}

fn stamps(dir: &Path, bundle: &Bundle) -> Result<Vec<FileStamp>, String> {
    bundle
        .files
        .iter()
        .map(|file| {
            let md = std::fs::metadata(dir.join(&file.name))
                .map_err(|e| format!("{}: {e}", file.name))?;
            if !md.is_file() || md.len() != file.size {
                return Err(format!("{} no longer matches the catalog size", file.name));
            }
            Ok(FileStamp {
                name: file.name.clone(),
                size: md.len(),
                modified: timestamp(md.modified().map_err(|e| e.to_string())?)?,
                created: md.created().ok().and_then(|t| timestamp(t).ok()),
            })
        })
        .collect()
}

#[derive(Serialize, Deserialize)]
struct Verification {
    dir: PathBuf,
    bundle_id: String,
    revision: String,
    files: Vec<ModelFile>,
    stamps: Vec<FileStamp>,
}

fn cache_path(cache: &Path, dir: &Path, bundle: &Bundle) -> PathBuf {
    let key = format!("{}\n{}", canonical(dir).to_string_lossy(), bundle.id);
    cache.join(format!("{:x}.json", Sha256::digest(key.as_bytes())))
}

fn cached_verification(
    cache: Option<&Path>,
    dir: &Path,
    cat: &ModelCatalog,
    bundle: &Bundle,
) -> bool {
    let read = || -> Option<bool> {
        let record: Verification =
            serde_json::from_slice(&std::fs::read(cache_path(cache?, dir, bundle)).ok()?).ok()?;
        Some(
            same_directory(&record.dir, dir)
                && record.bundle_id == bundle.id
                && record.revision == cat.model_revision
                && record.files == bundle.files
                && record.stamps == stamps(dir, bundle).ok()?,
        )
    };
    read().unwrap_or(false)
}

/// Hash in place; only the application's separate verification cache is written.
pub fn verify_local(
    dir: &Path,
    bundle_id: &str,
    cat: &ModelCatalog,
    cache: &Path,
) -> Result<PathBuf, String> {
    static VERIFY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = VERIFY_LOCK
        .lock()
        .map_err(|_| "model verification is unavailable")?;
    let dir = dunce::canonicalize(dir).map_err(|e| e.to_string())?;
    let bundle = cat.bundle(bundle_id).ok_or("unknown model bundle")?;
    let before = stamps(&dir, bundle)?;
    for file in &bundle.files {
        if stream_sha256(&dir.join(&file.name))? != file.sha256 {
            return Err(format!("checksum mismatch for {}", file.name));
        }
    }
    if before != stamps(&dir, bundle)? {
        return Err("model files changed during verification; try again".into());
    }
    let record = Verification {
        dir: dir.clone(),
        bundle_id: bundle.id.clone(),
        revision: cat.model_revision.clone(),
        files: bundle.files.clone(),
        stamps: before,
    };
    std::fs::create_dir_all(cache)
        .map_err(|e| format!("could not save model verification: {e}"))?;
    atomic_write(
        &cache_path(cache, &dir, bundle),
        &serde_json::to_string(&record).map_err(|e| e.to_string())?,
    )?;
    Ok(dir)
}

/// Only inspect roots already implied by a configured model folder.
fn containing_root(dir: &Path, cat: &ModelCatalog) -> PathBuf {
    let dir = canonical(dir);
    let quant = dir.file_name().map(|q| q.to_string_lossy());
    if quant.is_some_and(|q| cat.bundles.iter().any(|b| b.quantization == q)) {
        if let Some(installed) = dir
            .parent()
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n == cat.model_revision.as_str())
            })
            .and_then(Path::parent)
        {
            if installed.file_name().is_some_and(|n| n == "installed") {
                if let Some(root) = installed.parent() {
                    return root.to_path_buf();
                }
            }
        }
    }
    dir
}

pub fn discover(
    cat: &ModelCatalog,
    active: &Path,
    remembered: Option<&Path>,
    managed: &[ManagedBundleState],
    cache: Option<&Path>,
) -> Vec<LocalBundleState> {
    let mut candidates = Vec::new();
    for dir in std::iter::once(active).chain(remembered) {
        let root = containing_root(dir, cat);
        candidates.push(canonical(dir));
        candidates.push(root.clone());
        candidates.extend(cat.bundles.iter().map(|b| bundle_leaf_dir(&root, cat, b)));
    }
    let mut seen = Vec::<PathBuf>::new();
    let mut found = Vec::new();
    for dir in candidates {
        if !dir.is_dir() || seen.iter().any(|p| same_directory(p, &dir)) {
            continue;
        }
        seen.push(dir.clone());
        if managed
            .iter()
            .any(|m| same_directory(Path::new(&m.dir), &dir))
        {
            continue;
        }
        let matched = scan_legacy_dir(&dir, cat);
        if !matches!(matched.status, LegacyStatus::CompleteUnverified) {
            continue;
        }
        let Some(bundle) = matched.bundle_id.as_deref().and_then(|id| cat.bundle(id)) else {
            continue;
        };
        found.push(LocalBundleState {
            bundle_id: bundle.id.clone(),
            dir: dir.to_string_lossy().into_owned(),
            verified: cached_verification(cache, &dir, cat, bundle),
            active: same_directory(&dir, active),
            total_bytes: ModelCatalog::total_bytes(bundle),
        });
    }
    found
}

pub fn selected_local<'a>(
    scan: &'a ModelsScan,
    bundle_id: &str,
    directory: &str,
) -> Result<&'a LocalBundleState, String> {
    scan.local
        .iter()
        .find(|entry| {
            entry.bundle_id == bundle_id
                && same_directory(Path::new(&entry.dir), Path::new(directory))
        })
        .ok_or_else(|| {
            "the selected catalog folder is no longer available; refresh models and try again"
                .into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, ModelCatalog) {
        let root = std::env::temp_dir().join(format!(
            "model-discovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut cat = catalog().unwrap().clone();
        cat.model_revision = "synthetic-revision".into();
        cat.bundles.truncate(2);
        for (index, bundle) in cat.bundles.iter_mut().enumerate() {
            let content = vec![index as u8 + 1; index + 3];
            bundle.files = vec![ModelFile {
                name: "weights.gguf".into(),
                size: content.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&content)),
            }];
        }
        (root, cat)
    }

    fn put(dir: &Path, bundle: &Bundle, byte: u8) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("weights.gguf"),
            vec![byte; bundle.files[0].size as usize],
        )
        .unwrap();
    }

    #[test]
    fn external_flat_active_bundle_and_sibling_are_recognized_without_adoption() {
        let (root, cat) = fixture();
        let active = root.join("existing");
        put(&active, &cat.bundles[0], 1);
        let other = bundle_leaf_dir(&active, &cat, &cat.bundles[1]);
        put(&other, &cat.bundles[1], 2);
        let found = discover(&cat, &active, Some(&active.join(".")), &[], None);
        assert_eq!(found.len(), 2);
        assert!(found
            .iter()
            .any(|b| b.active && b.bundle_id == cat.bundles[0].id));
        assert!(found.iter().all(|b| !b.verified));
        assert!(!active.join("installation.json").exists());
        assert!(!root.join("cache").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_verification_persists_outside_models_and_invalidates_changed_bytes() {
        let (root, cat) = fixture();
        let active = root.join("existing");
        let cache = root.join("app-cache");
        put(&active, &cat.bundles[0], 1);
        verify_local(&active, &cat.bundles[0].id, &cat, &cache).unwrap();
        assert!(cached_verification(
            Some(&cache),
            &active,
            &cat,
            &cat.bundles[0]
        ));
        assert_eq!(std::fs::read_dir(&active).unwrap().count(), 1);
        assert_eq!(
            std::fs::read(active.join("weights.gguf")).unwrap(),
            vec![1; 3]
        );
        let found = discover(&cat, &active, None, &[], Some(&cache));
        assert!(found[0].verified);
        std::thread::sleep(std::time::Duration::from_millis(20));
        put(&active, &cat.bundles[0], 9);
        assert!(!cached_verification(
            Some(&cache),
            &active,
            &cat,
            &cat.bundles[0]
        ));
        assert!(verify_local(&active, &cat.bundles[0].id, &cat, &cache).is_err());
        assert!(!discover(&cat, &active, None, &[], Some(&cache))[0].verified);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_unknown_and_managed_directories_are_not_duplicate_local_bundles() {
        let (root, cat) = fixture();
        let active = root.join("existing");
        std::fs::create_dir(&active).unwrap();
        std::fs::write(active.join("unknown.gguf"), b"x").unwrap();
        assert!(discover(&cat, &active, None, &[], None).is_empty());
        std::fs::remove_file(active.join("unknown.gguf")).unwrap();
        put(&active, &cat.bundles[0], 1);
        let managed = vec![ManagedBundleState {
            bundle_id: cat.bundles[0].id.clone(),
            quantization: "q4".into(),
            dir: active.to_string_lossy().into(),
            registered: true,
            sized_files: 1,
            total_files: 1,
            total_bytes: 3,
        }];
        assert!(discover(&cat, &active, None, &managed, None).is_empty());
        assert_eq!(directory_bytes(&active), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_leaf_discovers_its_containing_flat_bundle_and_catalog_changes_require_reverification(
    ) {
        let (root, mut cat) = fixture();
        put(&root, &cat.bundles[0], 1);
        let active = bundle_leaf_dir(&root, &cat, &cat.bundles[1]);
        put(&active, &cat.bundles[1], 2);
        let cache = root.join("cache");
        verify_local(&active, &cat.bundles[1].id, &cat, &cache).unwrap();
        let found = discover(&cat, &active, None, &[], Some(&cache));
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|b| b.active && b.verified));
        cat.bundles[1].files[0].sha256 = "0".repeat(64);
        assert!(!cached_verification(
            Some(&cache),
            &active,
            &cat,
            &cat.bundles[1]
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
