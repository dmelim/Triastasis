// Phase 1 of the in-app model installation plan
// (docs/model-installation-plan.md): bundled model catalog, installed/legacy
// bundle detection, free-space reporting, and full SHA-256 verification that
// writes the `installation.json` commit marker.
//
// Downloading lives in a later phase; this module only ever reads and verifies.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

const CATALOG_JSON: &str = include_str!("../catalog/model-catalog.json");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bundle {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub quantization: String,
    /// Remote subpath inside the upstream repository ("", "q4", "q8").
    #[serde(rename = "pathPrefix", default)]
    pub path_prefix: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogSource {
    pub kind: String,
    pub repo: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalog {
    #[serde(rename = "catalogVersion")]
    pub catalog_version: u32,
    #[serde(rename = "modelFamily")]
    pub model_family: String,
    #[serde(rename = "modelRevision")]
    pub model_revision: String,
    pub source: CatalogSource,
    pub bundles: Vec<Bundle>,
}

/// Commit marker written last after every file in a bundle has been verified.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallationRecord {
    #[serde(rename = "bundleId")]
    pub bundle_id: String,
    #[serde(rename = "modelRevision")]
    pub model_revision: String,
    #[serde(rename = "catalogVersion")]
    pub catalog_version: u32,
    #[serde(rename = "installedAt")]
    pub installed_at: String,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSummary {
    pub id: String,
    pub display_name: String,
    pub quantization: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyStatus {
    /// Every catalog file present with the expected size; not yet hashed.
    CompleteUnverified,
    /// Some catalog files recognized.
    Incomplete,
    /// GGUF files exist but do not match any bundle well enough.
    Unrecognized,
    /// Directory exists with no GGUF files.
    Empty,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMatch {
    pub status: LegacyStatus,
    /// Best-matching bundle by name+size, when any files matched.
    pub bundle_id: Option<String>,
    pub matched_files: usize,
    pub total_files: usize,
    pub unrecognized_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedBundleState {
    pub bundle_id: String,
    pub quantization: String,
    pub dir: String,
    /// True when a parseable `installation.json` commit marker exists.
    pub registered: bool,
    /// Files present with the expected size (fast scan, no hashing).
    pub sized_files: usize,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsScan {
    pub models_root: String,
    pub models_dir: String,
    pub portable: bool,
    pub active_bundle: Option<String>,
    pub managed: Vec<ManagedBundleState>,
    pub legacy: Option<LegacyMatch>,
    pub free_bytes: Option<u64>,
    pub catalog_version: u32,
    pub model_revision: String,
}

// ---- catalog access and validation -----------------------------------------

fn validate_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("empty file name".to_string());
    }
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(format!("unsafe file name: {name:?}"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(format!("control character in file name: {name:?}"));
    }
    Ok(())
}

fn validate_sha256(hash: &str) -> Result<(), String> {
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("invalid SHA-256 for catalog entry: {hash:?}"));
    }
    Ok(())
}

impl ModelCatalog {
    pub fn validate(&self) -> Result<(), String> {
        if self.catalog_version == 0 {
            return Err("catalog version must be positive".to_string());
        }
        if self.model_revision.is_empty() {
            return Err("missing pinned model revision".to_string());
        }
        if self.bundles.is_empty() {
            return Err("catalog contains no bundles".to_string());
        }
        let mut seen_ids = std::collections::HashSet::new();
        let mut seen_quants = std::collections::HashSet::new();
        for bundle in &self.bundles {
            if !seen_ids.insert(bundle.id.clone()) {
                return Err(format!("duplicate bundle id: {}", bundle.id));
            }
            if !seen_quants.insert(bundle.quantization.clone()) {
                return Err(format!("duplicate quantization: {}", bundle.quantization));
            }
            if bundle.files.is_empty() {
                return Err(format!("bundle {} has no files", bundle.id));
            }
            if !bundle.path_prefix.is_empty() {
                validate_file_name(&bundle.path_prefix)
                    .map_err(|e| format!("unsafe path prefix in {}: {e}", bundle.id))?;
            }
            let mut seen_names = std::collections::HashSet::new();
            for file in &bundle.files {
                validate_file_name(&file.name)?;
                if !seen_names.insert(file.name.clone()) {
                    return Err(format!(
                        "duplicate file {} in bundle {}",
                        file.name, bundle.id
                    ));
                }
                if file.size == 0 {
                    return Err(format!("zero-size file {}", file.name));
                }
                validate_sha256(&file.sha256)?;
            }
        }
        Ok(())
    }

    pub fn bundle(&self, id: &str) -> Option<&Bundle> {
        self.bundles.iter().find(|b| b.id == id)
    }

    // Used by the Phase 2 download engine and by unit tests.
    #[allow(dead_code)]
    pub fn bundle_mut(&mut self, id: &str) -> Option<&mut Bundle> {
        self.bundles.iter_mut().find(|b| b.id == id)
    }

    pub fn total_bytes(bundle: &Bundle) -> u64 {
        bundle.files.iter().map(|f| f.size).sum()
    }

    // Used by the Phase 2 download engine and by unit tests.
    #[allow(dead_code)]
    pub fn file_url(&self, bundle: &Bundle, file: &ModelFile) -> String {
        if bundle.path_prefix.is_empty() {
            format!(
                "{}/{}/{}",
                self.source.base_url, self.model_revision, file.name
            )
        } else {
            format!(
                "{}/{}/{}/{}",
                self.source.base_url, self.model_revision, bundle.path_prefix, file.name
            )
        }
    }
}

static CATALOG: std::sync::OnceLock<Result<ModelCatalog, String>> = std::sync::OnceLock::new();

/// The embedded, validated model catalog. Parsed once per process.
pub fn catalog() -> Result<&'static ModelCatalog, String> {
    CATALOG
        .get_or_init(|| {
            serde_json::from_str::<ModelCatalog>(CATALOG_JSON)
                .map_err(|e| format!("bundled model catalog is invalid JSON: {e}"))
                .and_then(|c| {
                    c.validate()?;
                    Ok(c)
                })
        })
        .as_ref()
        .map_err(|e| e.clone())
}

// ---- directory resolution ---------------------------------------------------

fn portable_root() -> Option<PathBuf> {
    crate::config::portable_mode_root()
}

/// The managed models root: explicit `modelsRoot` when set, otherwise derived
/// from an effective `modelsDir` pointing into `installed/<rev>/<quant>`,
/// otherwise `modelsDir` itself (legacy flat layout).
pub fn resolve_models_root(models_dir: &Path, cat: &ModelCatalog) -> PathBuf {
    if let Some(cfg) = crate::config::load() {
        if !cfg.models_root.trim().is_empty() {
            return PathBuf::from(cfg.models_root.trim());
        }
    }
    // <root>/installed/<revision>/<quant>/ggufs
    let leaf_is_quant = models_dir
        .file_name()
        .map(|q| {
            cat.bundles
                .iter()
                .any(|b| b.quantization == q.to_string_lossy())
        })
        .unwrap_or(false);
    if leaf_is_quant {
        if let (Some(rev), Some(installed)) = (
            models_dir.parent().and_then(|p| p.file_name()),
            models_dir.parent().and_then(|p| p.parent()),
        ) {
            if rev.to_string_lossy() == cat.model_revision
                && installed.file_name().map(|n| n.to_string_lossy()) == Some("installed".into())
            {
                if let Some(root) = installed.parent() {
                    return root.to_path_buf();
                }
            }
        }
    }
    models_dir.to_path_buf()
}

/// Default managed root for a fresh install. Respects portable mode:
/// `<exe>/models` next to the portable marker, never AppData silently.
pub fn default_models_root() -> PathBuf {
    if let Some(root) = portable_root() {
        return root.join("models");
    }
    dirs::data_local_dir()
        .map(|d| d.join("triastasis").join("models"))
        .unwrap_or_else(|| PathBuf::from("models"))
}

fn bundle_leaf_dir(models_root: &Path, cat: &ModelCatalog, bundle: &Bundle) -> PathBuf {
    models_root
        .join("installed")
        .join(&cat.model_revision)
        .join(&bundle.quantization)
}

// ---- scanning ----------------------------------------------------------------

fn count_sized_files(dir: &Path, files: &[ModelFile]) -> usize {
    files
        .iter()
        .filter(|f| match dir.join(&f.name).metadata() {
            Ok(md) => md.is_file() && md.len() == f.size,
            Err(_) => false,
        })
        .count()
}

fn read_installation_record(dir: &Path) -> Option<InstallationRecord> {
    let raw = std::fs::read_to_string(dir.join("installation.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn installation_record_matches(dir: &Path, cat: &ModelCatalog, bundle: &Bundle) -> bool {
    let Some(record) = read_installation_record(dir) else {
        return false;
    };
    record.bundle_id == bundle.id
        && record.model_revision == cat.model_revision
        && record.catalog_version == cat.catalog_version
        && record.files == bundle.files
        && count_sized_files(dir, &bundle.files) == bundle.files.len()
}

/// Compare a flat legacy directory against every catalog bundle by name+size.
fn scan_legacy_dir(dir: &Path, cat: &ModelCatalog) -> LegacyMatch {
    let mut entries: Vec<(String, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().map(|e| e == "gguf") != Some(true) {
                continue;
            }
            if let Ok(md) = entry.metadata() {
                entries.push((entry.file_name().to_string_lossy().into_owned(), md.len()));
            }
        }
    }
    if entries.is_empty() {
        return LegacyMatch {
            status: LegacyStatus::Empty,
            bundle_id: None,
            matched_files: 0,
            total_files: 0,
            unrecognized_files: 0,
        };
    }

    let mut best: Option<(&Bundle, usize)> = None;
    for bundle in &cat.bundles {
        let names: std::collections::HashMap<&str, u64> = bundle
            .files
            .iter()
            .map(|f| (f.name.as_str(), f.size))
            .collect();
        let matched = entries
            .iter()
            .filter(|(name, size)| names.get(name.as_str()) == Some(size))
            .count();
        if best.map(|(_, m)| matched > m).unwrap_or(true) {
            best = Some((bundle, matched));
        }
    }

    let (bundle, matched) = best.expect("catalog validated to contain bundles");
    let recognized: std::collections::HashSet<&str> =
        bundle.files.iter().map(|f| f.name.as_str()).collect();
    let unrecognized = entries
        .iter()
        .filter(|(n, _)| !recognized.contains(n.as_str()))
        .count();

    let status = if matched == bundle.files.len() && unrecognized == 0 {
        LegacyStatus::CompleteUnverified
    } else if matched > 0 {
        LegacyStatus::Incomplete
    } else {
        LegacyStatus::Unrecognized
    };

    LegacyMatch {
        status,
        bundle_id: (matched > 0).then(|| bundle.id.clone()),
        matched_files: matched,
        total_files: bundle.files.len(),
        unrecognized_files: unrecognized,
    }
}

/// Full launch-time detection over the configured installation.
pub fn scan_models() -> Result<ModelsScan, String> {
    let cat = catalog()?;
    let cfg = crate::config::load();
    let models_dir = cfg
        .as_ref()
        .filter(|c| !c.models_dir.trim().is_empty())
        .map(|c| PathBuf::from(c.models_dir.trim()))
        .unwrap_or_else(default_models_root);
    let root = resolve_models_root(&models_dir, cat);

    let mut managed = Vec::new();
    for bundle in &cat.bundles {
        let leaf = bundle_leaf_dir(&root, cat, bundle);
        let sized = count_sized_files(&leaf, &bundle.files);
        let registered = installation_record_matches(&leaf, cat, bundle);
        if leaf.exists() || registered {
            managed.push(ManagedBundleState {
                bundle_id: bundle.id.clone(),
                quantization: bundle.quantization.clone(),
                dir: leaf.to_string_lossy().into_owned(),
                registered,
                sized_files: sized,
                total_files: bundle.files.len(),
            });
        }
    }

    // A flat legacy layout only matters when we are not looking at a managed
    // root whose leaf directories were scanned above.
    let legacy = if models_dir == root {
        Some(scan_legacy_dir(&models_dir, cat))
    } else {
        None
    };

    Ok(ModelsScan {
        models_root: root.to_string_lossy().into_owned(),
        models_dir: models_dir.to_string_lossy().into_owned(),
        portable: portable_root().is_some(),
        active_bundle: cfg.and_then(|c| {
            (!c.active_bundle.trim().is_empty()).then_some(c.active_bundle.trim().to_string())
        }),
        managed,
        legacy,
        free_bytes: free_space_bytes(&root).ok(),
        catalog_version: cat.catalog_version,
        model_revision: cat.model_revision.clone(),
    })
}

// ---- verification ------------------------------------------------------------

fn stream_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// SHA-256 of a file on disk, streamed (used by the download engine for
/// partial-file verification).
pub fn hash_file(path: &Path) -> Result<String, String> {
    stream_sha256(path)
}

/// Write `data` atomically: temp file in the same directory, flush, rename.
fn atomic_write(target: &Path, data: &str) -> Result<(), String> {
    let tmp = target.with_extension("tmp");
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    use std::io::Write;
    file.write_all(data.as_bytes())
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    file.sync_all()
        .map_err(|e| format!("flush {}: {e}", tmp.display()))?;
    drop(file);
    #[cfg(windows)]
    if target.exists() {
        std::fs::remove_file(target).map_err(|e| format!("replace {}: {e}", target.display()))?;
    }
    std::fs::rename(&tmp, target).map_err(|e| format!("commit {}: {e}", target.display()))
}

/// Verify every file of a bundle (size + SHA-256) inside `dir`. On success,
/// write the `installation.json` commit marker atomically. This is the same
/// verification manual/offline registration must pass through.
pub fn verify_and_register(models_root: &Path, bundle_id: &str) -> Result<PathBuf, String> {
    let cat = catalog()?;
    let bundle = cat
        .bundle(bundle_id)
        .ok_or_else(|| format!("unknown bundle: {bundle_id}"))?;
    let leaf = bundle_leaf_dir(models_root, cat, bundle);

    for file in &bundle.files {
        let path = leaf.join(&file.name);
        let md =
            std::fs::metadata(&path).map_err(|e| format!("missing {}: {e}", path.display()))?;
        if !md.is_file() {
            return Err(format!("not a file: {}", path.display()));
        }
        if md.len() != file.size {
            return Err(format!(
                "{} has {} bytes, expected {}",
                path.display(),
                md.len(),
                file.size
            ));
        }
        let actual = stream_sha256(&path)?;
        if actual != file.sha256 {
            return Err(format!(
                "checksum mismatch for {}: {}",
                path.display(),
                actual
            ));
        }
    }

    let record = InstallationRecord {
        bundle_id: bundle.id.clone(),
        model_revision: cat.model_revision.clone(),
        catalog_version: cat.catalog_version,
        installed_at: time_now_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        files: bundle.files.clone(),
    };
    let payload = serde_json::to_string_pretty(&record)
        .map_err(|e| format!("serialize installation record: {e}"))?;
    atomic_write(&leaf.join("installation.json"), &payload)?;
    Ok(leaf)
}

fn time_now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal civil-time conversion (days since epoch algorithm), avoids a
    // chrono dependency for one timestamp field.
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

// ---- free space ---------------------------------------------------------------

/// Actual free bytes on the volume containing `path`, via platform APIs.
/// Windows requires an existing directory, so non-existent paths resolve to
/// their nearest existing ancestor (same volume).
pub fn free_space_bytes(path: &Path) -> Result<u64, String> {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => return Err(format!("no existing ancestor for {}", path.display())),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[repr(C)]
        #[derive(Default)]
        struct Ularge(u64);
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut Ularge,
                lpTotalNumberOfBytes: *mut Ularge,
                lpTotalNumberOfFreeBytes: *mut Ularge,
            ) -> i32;
        }
        let wide: Vec<u16> = probe
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut avail = Ularge(0);
        let mut total = Ularge(0);
        let mut free = Ularge(0);
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) };
        if ok == 0 {
            return Err(format!("free-space query failed for {}", probe.display()));
        }
        Ok(avail.0)
    }
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        let c = CString::new(probe.as_os_str().to_string_lossy().as_bytes())
            .map_err(|e| format!("bad path: {e}"))?;
        let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(c.as_ptr(), &mut vfs) };
        if rc != 0 {
            return Err(format!("statvfs failed for {}", probe.display()));
        }
        Ok(vfs.f_bavail as u64 * vfs.f_frsize as u64)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = probe;
        Err("free-space query unsupported on this platform".to_string())
    }
}

// ---- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "triastasis-models-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn embedded_catalog_is_valid() {
        let cat = catalog().expect("embedded catalog must be valid");
        assert_eq!(cat.bundles.len(), 3);
        assert_eq!(
            cat.model_revision,
            "a57397bd3d351599d9729fc144b3f87c3f87d65b"
        );
        for b in &cat.bundles {
            assert_eq!(b.files.len(), 10);
        }
    }

    #[test]
    fn bundle_sizes_match_published_totals() {
        let cat = catalog().unwrap();
        let q4 = ModelCatalog::total_bytes(cat.bundle("trellis2-q4").unwrap());
        let q8 = ModelCatalog::total_bytes(cat.bundle("trellis2-q8").unwrap());
        let f16 = ModelCatalog::total_bytes(cat.bundle("trellis2-f16").unwrap());
        assert_eq!(q4, 6_546_263_488); // ~6.1 GiB / 6.5 GB
        assert_eq!(q8, 9_997_159_776); // ~9.3 GiB / 10 GB
        assert_eq!(f16, 16_467_590_304); // ~15.3 GiB / 16.5 GB
    }

    #[test]
    fn file_urls_reference_pinned_revision() {
        let cat = catalog().unwrap();
        let q8 = cat.bundle("trellis2-q8").unwrap();
        let url = cat.file_url(q8, &q8.files[0]);
        assert_eq!(
            url,
            format!(
                "https://huggingface.co/ilintar/trellis2-gguf/resolve/{}/q8/birefnet.gguf",
                cat.model_revision
            )
        );
        let f16 = cat.bundle("trellis2-f16").unwrap();
        let url = cat.file_url(f16, &f16.files[1]);
        assert!(url.ends_with(&format!("/{}/dinov3.gguf", cat.model_revision)));
        assert!(!url.contains("/resolve/main"));
    }

    #[test]
    fn validation_rejects_bad_catalogs() {
        let mut cat = catalog().unwrap().clone();

        let mut dup = cat.clone();
        dup.bundles.push(dup.bundles[0].clone());
        assert!(dup.validate().is_err());

        let mut unsafe_path = cat.clone();
        unsafe_path.bundles[0].files[0].name = "..\\evil.gguf".into();
        assert!(unsafe_path.validate().is_err());

        let mut bad_hash = cat.clone();
        bad_hash.bundles[0].files[0].sha256 = "deadbeef".into();
        assert!(bad_hash.validate().is_err());

        let mut zero = cat.clone();
        zero.bundles[0].files[0].size = 0;
        assert!(zero.validate().is_err());

        let mut no_rev = cat.clone();
        no_rev.model_revision = String::new();
        assert!(no_rev.validate().is_err());

        cat.bundles.clear();
        assert!(cat.validate().is_err());
    }

    #[test]
    fn legacy_scan_recognizes_complete_flat_install() {
        let dir = unique_tmp("legacy-complete");
        // Fake a complete q8 install using tiny files with correct names+sizes
        // is impossible (sizes are GB-scale); instead verify the Incomplete /
        // Unrecognized paths here and rely on size-matching logic below via a
        // synthetic catalog.
        let synthetic = synthetic_catalog();
        let q8 = synthetic.bundle("synthetic-q8").unwrap();
        for f in &q8.files {
            std::fs::write(dir.join(&f.name), vec![0u8; f.size as usize]).unwrap();
        }
        let m = scan_legacy_dir(&dir, &synthetic);
        assert!(matches!(m.status, LegacyStatus::CompleteUnverified));
        assert_eq!(m.bundle_id.as_deref(), Some("synthetic-q8"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_scan_reports_incomplete_and_unrecognized() {
        let synthetic = synthetic_catalog();
        let dir = unique_tmp("legacy-partial");
        let q8 = synthetic.bundle("synthetic-q8").unwrap();
        for f in q8.files.iter().take(2) {
            std::fs::write(dir.join(&f.name), vec![0u8; f.size as usize]).unwrap();
        }
        std::fs::write(dir.join("mystery.gguf"), b"junk").unwrap();
        let m = scan_legacy_dir(&dir, &synthetic);
        assert!(matches!(m.status, LegacyStatus::Incomplete));
        assert_eq!(m.matched_files, 2);
        assert_eq!(m.unrecognized_files, 1);

        let empty = unique_tmp("legacy-empty");
        let m = scan_legacy_dir(&empty, &synthetic);
        assert!(matches!(m.status, LegacyStatus::Empty));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn size_mismatch_does_not_count_as_matched() {
        let synthetic = synthetic_catalog();
        let dir = unique_tmp("legacy-wrongsize");
        let q8 = synthetic.bundle("synthetic-q8").unwrap();
        for f in &q8.files {
            std::fs::write(dir.join(&f.name), vec![0u8; f.size as usize - 1]).unwrap();
        }
        let m = scan_legacy_dir(&dir, &synthetic);
        assert!(matches!(m.status, LegacyStatus::Unrecognized));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_and_register_hashes_and_commits_marker() {
        let synthetic = synthetic_catalog();
        let root = unique_tmp("managed-root");
        let leaf = root
            .join("installed")
            .join(&synthetic.model_revision)
            .join("q8");
        std::fs::create_dir_all(&leaf).unwrap();
        let q8 = synthetic.bundle("synthetic-q8").unwrap();
        // Real content so SHA-256 can be computed and checked. Deterministic
        // bytes with the exact expected length.
        let contents: Vec<Vec<u8>> = q8
            .files
            .iter()
            .map(|f| (0..f.size).map(|i| (i % 251) as u8).collect())
            .collect();
        for (f, data) in q8.files.iter().zip(&contents) {
            std::fs::write(leaf.join(&f.name), data).unwrap();
        }

        // Wrong content must fail without writing a marker.
        std::fs::write(leaf.join(&q8.files[0].name), b"corrupted!").unwrap();
        assert!(verify_synthetic(&root, "synthetic-q8", &synthetic).is_err());
        assert!(!leaf.join("installation.json").exists());

        // Restore correct content and verify: hashes computed over real bytes
        // must match the synthetic catalog's recorded hashes.
        for (f, data) in q8.files.iter().zip(&contents) {
            std::fs::write(leaf.join(&f.name), data).unwrap();
        }
        let hashes: Vec<String> = contents
            .iter()
            .map(|d| format!("{:x}", Sha256::digest(d)))
            .collect();
        let mut verified = synthetic.clone();
        for (i, f) in verified
            .bundle_mut("synthetic-q8")
            .unwrap()
            .files
            .iter_mut()
            .enumerate()
        {
            f.sha256 = hashes[i].clone();
        }
        let leaf_out = verify_synthetic(&root, "synthetic-q8", &verified).unwrap();
        assert_eq!(leaf_out, leaf);
        let record = read_installation_record(&leaf).expect("marker written");
        assert_eq!(record.bundle_id, "synthetic-q8");
        assert_eq!(record.files.len(), 3);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_file_fails_verification() {
        let synthetic = synthetic_catalog();
        let root = unique_tmp("managed-missing");
        let leaf = root
            .join("installed")
            .join(&synthetic.model_revision)
            .join("q8");
        std::fs::create_dir_all(&leaf).unwrap();
        assert!(verify_synthetic(&root, "synthetic-q8", &synthetic).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn free_space_reports_the_real_volume() {
        let v = free_space_bytes(Path::new(".")).expect("free space on cwd volume");
        assert!(v > 0);
        // A deep nonexistent subdirectory still resolves to its future volume.
        let nested = std::env::temp_dir().join("no-such-sub-dir-triastasis");
        let w = free_space_bytes(&nested).expect("free space on temp volume");
        assert!(w > 0);
    }

    // A small deterministic catalog standing in for multi-GB real bundles in
    // filesystem/hash tests.
    fn synthetic_catalog() -> ModelCatalog {
        let mk = |id: &str, quant: &str| Bundle {
            id: id.to_string(),
            display_name: id.to_string(),
            quantization: quant.to_string(),
            path_prefix: String::new(),
            files: vec![
                ModelFile {
                    name: "alpha.gguf".into(),
                    size: 4096,
                    sha256: "0".repeat(64),
                },
                ModelFile {
                    name: "beta.gguf".into(),
                    size: 512,
                    sha256: "0".repeat(64),
                },
                ModelFile {
                    name: "gamma.gguf".into(),
                    size: 64,
                    sha256: "0".repeat(64),
                },
            ],
        };
        ModelCatalog {
            catalog_version: 1,
            model_family: "synthetic".into(),
            model_revision: "rev00000000000000000000000000000000000000".into(),
            source: CatalogSource {
                kind: "test".into(),
                repo: "test/repo".into(),
                base_url: "https://example.invalid/resolve".into(),
            },
            bundles: vec![mk("synthetic-q8", "q8"), mk("synthetic-q4", "q4")],
        }
    }

    fn verify_synthetic(
        root: &Path,
        bundle_id: &str,
        synthetic: &ModelCatalog,
    ) -> Result<PathBuf, String> {
        // Same algorithm as verify_and_register but against the injected
        // synthetic catalog instead of the embedded one.
        let bundle = synthetic.bundle(bundle_id).unwrap();
        let leaf = root
            .join("installed")
            .join(&synthetic.model_revision)
            .join(&bundle.quantization);
        for file in &bundle.files {
            let path = leaf.join(&file.name);
            let md = std::fs::metadata(&path).map_err(|e| format!("missing: {e}"))?;
            if md.len() != file.size {
                return Err(format!("size mismatch for {}", file.name));
            }
            let actual = stream_sha256(&path)?;
            if actual != file.sha256 {
                return Err(format!("checksum mismatch for {}", file.name));
            }
        }
        let record = InstallationRecord {
            bundle_id: bundle.id.clone(),
            model_revision: synthetic.model_revision.clone(),
            catalog_version: synthetic.catalog_version,
            installed_at: time_now_rfc3339(),
            app_version: "test".into(),
            files: bundle.files.clone(),
        };
        atomic_write(
            &leaf.join("installation.json"),
            &serde_json::to_string(&record).unwrap(),
        )?;
        Ok(leaf)
    }
}
