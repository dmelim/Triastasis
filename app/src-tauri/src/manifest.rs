// `.triastasis.json` generation manifests: a versioned, self-describing record
// written beside every generated model so any generation can later be
// re-imported, re-linked, or requeued with its reference image, settings, and
// lineage intact.
//
// Security posture: only relative paths inside the manifest's directory are
// accepted — absolute paths, `..` components, and rooted/backslash tricks are
// rejected before the filesystem is touched. Import verifies SHA-256 hashes
// and file formats, and never creates partial gallery records on failure.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// Version emitted by every new write. Schema 2 adds the advanced generation
/// parameters (`targetFaces`, `atlasSize`, `textureResolution`, `remeshBand`,
/// `textureEncoding`) that schema 1 could not record.
pub const MANIFEST_SCHEMA_VERSION: u32 = 2;
/// Oldest schema still accepted for reading; v1 manifests predate the
/// advanced parameter fields and recover with documented defaults for them.
pub const MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION: u32 = 1;

pub const MANIFEST_EXTENSION: &str = "triastasis.json";
pub const LEGACY_MANIFEST_EXTENSION: &str = "polyloom.json";

/// The validation bounds shared with trellis-server, enforced when parsing.
const TARGET_FACES_RANGE: (u32, u32) = (10_000, 1_000_000);
const ATLAS_SIZE_RANGE: (u32, u32) = (128, 4_096);
const REMESH_BAND_RANGE: (u32, u32) = (0, 8);

/// `"auto"` or a non-negative integer — serializes exactly like the
/// TypeScript `TargetFaces` / `AtlasSize` / `RemeshBand` union members so the
/// JSON representation stays identical across the app and the shell.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum AutoU32 {
    #[default]
    Auto,
    Value(u32),
}

impl Serialize for AutoU32 {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            AutoU32::Auto => serializer.serialize_str("auto"),
            AutoU32::Value(value) => serializer.serialize_u32(*value),
        }
    }
}

impl<'de> Deserialize<'de> for AutoU32 {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct AutoU32Visitor;
        impl serde::de::Visitor<'_> for AutoU32Visitor {
            type Value = AutoU32;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("\"auto\" or a non-negative integer")
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<AutoU32, E> {
                if value.eq_ignore_ascii_case("auto") {
                    Ok(AutoU32::Auto)
                } else {
                    Err(E::invalid_value(
                        serde::de::Unexpected::Str(value),
                        &"\"auto\" or a non-negative integer",
                    ))
                }
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<AutoU32, E> {
                u32::try_from(value).map(AutoU32::Value).map_err(|_| {
                    E::invalid_value(
                        serde::de::Unexpected::Unsigned(value),
                        &"a non-negative integer within the u32 range",
                    )
                })
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<AutoU32, E> {
                u32::try_from(value).map(AutoU32::Value).map_err(|_| {
                    E::invalid_value(
                        serde::de::Unexpected::Signed(value),
                        &"a non-negative integer within the u32 range",
                    )
                })
            }
        }
        deserializer.deserialize_any(AutoU32Visitor)
    }
}

impl AutoU32 {
    fn value_in_range(&self, name: &str, range: (u32, u32)) -> Result<(), String> {
        match self {
            AutoU32::Auto => Ok(()),
            AutoU32::Value(value) => {
                if *value >= range.0 && *value <= range.1 {
                    Ok(())
                } else {
                    Err(format!(
                        "{name} must be \"auto\" or between {} and {}",
                        range.0, range.1
                    ))
                }
            }
        }
    }
}

/// Texture encoding choice serialized exactly like the TypeScript values.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub enum TextureEncodingChoice {
    #[serde(rename = "auto")]
    #[default]
    Auto,
    #[serde(rename = "webp")]
    Webp,
    #[serde(rename = "png")]
    Png,
}

fn is_manifest_name(name: &str) -> bool {
    name.ends_with(MANIFEST_EXTENSION) || name.ends_with(LEGACY_MANIFEST_EXTENSION)
}

/// Refusal thresholds. A manifest is small structured data; artifacts are
/// bounded well above any realistic reconstruction output.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// Why a referenced file could not be read and verified.
enum ReadFileError {
    Missing(String),
    Escaped(String),
    TooLarge(String),
    Io(String),
}

impl ReadFileError {
    fn issue_kind(&self) -> &'static str {
        match self {
            ReadFileError::Missing(_) => "missing",
            ReadFileError::Escaped(_) => "unsafePath",
            ReadFileError::TooLarge(_) => "invalidFormat",
            ReadFileError::Io(_) => "missing",
        }
    }

    fn detail(&self) -> &str {
        match self {
            ReadFileError::Missing(d)
            | ReadFileError::Escaped(d)
            | ReadFileError::TooLarge(d)
            | ReadFileError::Io(d) => d,
        }
    }

    /// Missing files stay tolerable for optional roles; escapes and size
    /// violations never are.
    fn blocks_even_when_optional(&self) -> bool {
        matches!(self, ReadFileError::Escaped(_) | ReadFileError::TooLarge(_))
    }
}

/// Reads `path`, refusing files that resolve outside `dir` through symlinks
/// or junctions and files beyond the artifact size limit.
fn read_contained_file(dir: &Path, path: &Path) -> Result<Vec<u8>, ReadFileError> {
    let metadata = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ReadFileError::Missing(format!("{} does not exist", path.display()))
        } else {
            ReadFileError::Io(format!("could not stat {}: {e}", path.display()))
        }
    })?;
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(ReadFileError::TooLarge(format!(
            "{} exceeds the {} MB artifact limit",
            path.display(),
            MAX_ARTIFACT_BYTES / (1024 * 1024)
        )));
    }
    // Lexical validation happens earlier; this catches filesystem-level
    // escapes: a symlink or junction inside the directory pointing elsewhere
    // canonicalizes to an outside path and is refused here.
    let dir_canonical = std::fs::canonicalize(dir)
        .map_err(|e| ReadFileError::Io(format!("could not resolve {}: {e}", dir.display())))?;
    let file_canonical = std::fs::canonicalize(path).map_err(|e| {
        ReadFileError::Escaped(format!("could not resolve {}: {e}", path.display()))
    })?;
    if !file_canonical.starts_with(&dir_canonical) {
        return Err(ReadFileError::Escaped(format!(
            "{} resolves outside the manifest directory",
            path.display()
        )));
    }
    std::fs::read(path)
        .map_err(|e| ReadFileError::Io(format!("could not read {}: {e}", path.display())))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GenerationManifest {
    pub schema_version: u32,
    pub status: String, // completed | interrupted | failed
    pub label: String,
    pub source_image: Option<String>,
    pub model: Option<String>,
    pub cutout: Option<String>,
    pub thumbnail: Option<String>,
    pub log: Option<String>,
    pub resolution: u16,
    pub seed: u64,
    pub bg_removal: String,
    pub uv: String,
    pub texture: bool,
    /// Advanced generation settings; schema 1 manifests predate them and
    /// deserialize with `"auto"` defaults via the container-level `default`.
    pub target_faces: AutoU32,
    pub atlas_size: AutoU32,
    pub texture_resolution: AutoU32,
    pub remesh_band: AutoU32,
    pub texture_encoding: TextureEncodingChoice,
    pub job_id: Option<String>,
    pub native_request_id: Option<String>,
    pub asset_id: Option<String>,
    pub version_id: Option<String>,
    pub parent_version_id: Option<String>,
    pub submitted_at_utc: Option<String>,
    pub started_at_utc: Option<String>,
    pub finished_at_utc: Option<String>,
    pub duration_seconds: Option<f64>,
    pub triastasis_version: Option<String>,
    /// Retained so manifests created before the rename remain importable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polyloom_version: Option<String>,
    pub server_version: Option<String>,
    pub metrics: Option<ManifestMetrics>,
    pub quality_warning: Option<ManifestQualityWarning>,
    pub error: Option<String>,
    pub files: Vec<ManifestFileRef>,
    pub sweep: Option<ManifestSweep>,
}

impl Default for GenerationManifest {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: "interrupted".to_string(),
            label: String::new(),
            source_image: None,
            model: None,
            cutout: None,
            thumbnail: None,
            log: None,
            resolution: 512,
            seed: 42,
            bg_removal: "auto".to_string(),
            uv: "xatlas".to_string(),
            texture: true,
            target_faces: AutoU32::Auto,
            atlas_size: AutoU32::Auto,
            texture_resolution: AutoU32::Auto,
            remesh_band: AutoU32::Auto,
            texture_encoding: TextureEncodingChoice::Auto,
            job_id: None,
            native_request_id: None,
            asset_id: None,
            version_id: None,
            parent_version_id: None,
            submitted_at_utc: None,
            started_at_utc: None,
            finished_at_utc: None,
            duration_seconds: None,
            triastasis_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            polyloom_version: None,
            server_version: None,
            metrics: None,
            quality_warning: None,
            error: None,
            files: Vec::new(),
            sweep: None,
        }
    }
}

impl GenerationManifest {
    fn role_path(&self, role: &str) -> Option<&str> {
        match role {
            "sourceImage" => self.source_image.as_deref(),
            "glb" => self.model.as_deref(),
            "cutout" => self.cutout.as_deref(),
            "thumbnail" => self.thumbnail.as_deref(),
            "log" => self.log.as_deref(),
            _ => None,
        }
    }

    /// Every (role, relative path) pair referenced by this manifest.
    fn references(&self) -> Vec<(String, String)> {
        let roles = ["sourceImage", "glb", "cutout", "thumbnail", "log"];
        roles
            .iter()
            .filter_map(|role| {
                self.role_path(role)
                    .map(|path| (role.to_string(), path.to_string()))
            })
            .collect()
    }

    fn set_role_path(&mut self, role: &str, path: String) {
        match role {
            "sourceImage" => self.source_image = Some(path.clone()),
            "glb" => self.model = Some(path.clone()),
            "cutout" => self.cutout = Some(path.clone()),
            "thumbnail" => self.thumbnail = Some(path.clone()),
            "log" => self.log = Some(path.clone()),
            _ => {}
        }
        if let Some(entry) = self.files.iter_mut().find(|file| file.role == role) {
            entry.path = path;
        } else {
            self.files.push(ManifestFileRef {
                role: role.to_string(),
                path,
                sha256: String::new(),
            });
        }
    }

    fn files_entry(&self, role: &str) -> Option<&ManifestFileRef> {
        self.files.iter().find(|file| file.role == role)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ManifestFileRef {
    pub role: String,
    #[serde(rename = "path")]
    pub path: String,
    pub sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestMetrics {
    pub dimensions: Option<ManifestDimensions>,
    pub triangles: Option<u64>,
    pub file_size_bytes: Option<u64>,
    pub thin_ratio: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDimensions {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestQualityWarning {
    pub code: String,
    pub message: String,
    pub thin_ratio: f64,
    pub threshold: f64,
    pub dimensions: ManifestDimensions,
}

/// Optional sweep membership. Absent on single-generation manifests, which
/// keeps the v1 schema backward compatible.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSweep {
    pub group_id: String,
    pub index: usize,
    pub count: usize,
    pub seed: u64,
    /// queued | running | completed | failed | cancelled
    pub state: String,
}

/// One problem found while validating a manifest's referenced files.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManifestIssue {
    pub role: String,
    pub path: String,
    pub kind: String, // missing | hashMismatch | invalidFormat | unsafePath
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPreview {
    pub path: String,
    pub manifest: GenerationManifest,
    pub issues: Vec<ManifestIssue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedGeneration {
    pub manifest_path: String,
    pub manifest: GenerationManifest,
    pub image_bytes: Vec<u8>,
    pub glb_bytes: Vec<u8>,
}

// ---- path safety -----------------------------------------------------------

/// Normalizes a manifest-referenced path to a safe relative component list.
/// Rejects anything that could escape the manifest directory.
fn safe_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("path is empty".to_string());
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err("path is rooted".to_string());
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return Err("path is absolute".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.is_empty() || part == "." {
                    continue;
                }
                // Windows drive/UNC syntax smuggled into a Normal component on
                // non-Windows parsers ("C:", "//server") is rejected outright.
                if part.ends_with(':') || part.starts_with("//") {
                    return Err(format!("unsupported path component: {part}"));
                }
                normalized.push(part.replace('\\', "_"));
            }
            Component::CurDir => {}
            other => {
                return Err(format!("unsafe path component: {other:?}"));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("path resolves to nothing".to_string());
    }
    Ok(normalized)
}

fn resolve_in_dir(dir: &Path, raw: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(raw)?;
    Ok(dir.join(relative))
}

fn looks_like_image(bytes: &[u8]) -> bool {
    const MAGIC: &[&[u8]] = &[b"\x89PNG", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"BM"];
    if MAGIC.iter().any(|magic| bytes.starts_with(magic)) {
        return true;
    }
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

fn looks_like_glb(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"glTF"
}

fn sniff(role: &str, bytes: &[u8]) -> Result<(), String> {
    match role {
        "sourceImage" | "thumbnail" | "cutout" => {
            if looks_like_image(bytes) {
                Ok(())
            } else {
                Err("file is not a recognizable image".to_string())
            }
        }
        "glb" => {
            if looks_like_glb(bytes) {
                Ok(())
            } else {
                Err("file is not a GLB (missing glTF magic)".to_string())
            }
        }
        _ => Ok(()),
    }
}

/// Validates every file reference: existence, hash, and format. Returns all
/// issues found instead of failing fast so import previews can show them.
fn validate_references(
    dir: &Path,
    manifest: &GenerationManifest,
    require_core: bool,
) -> Vec<ManifestIssue> {
    let mut issues = Vec::new();
    for (role, raw) in manifest.references() {
        let resolved = match resolve_in_dir(dir, &raw) {
            Ok(resolved) => resolved,
            Err(detail) => {
                issues.push(ManifestIssue {
                    role: role.clone(),
                    path: raw,
                    kind: "unsafePath".to_string(),
                    detail,
                });
                continue;
            }
        };
        let bytes = match read_contained_file(dir, &resolved) {
            Ok(bytes) => bytes,
            Err(error) => {
                // A model that was never produced (interrupted/failed runs
                // record its planned name with a blank hash) is expected to be
                // absent, not an error; missing optional attachments are also
                // tolerable. Escapes and size violations never are.
                let expected_absent_model = role == "glb"
                    && manifest.status != "completed"
                    && manifest
                        .files_entry("glb")
                        .map(|entry| entry.sha256.is_empty())
                        .unwrap_or(true);
                let required = matches!(role.as_str(), "sourceImage" | "glb");
                if (required && require_core && !expected_absent_model)
                    || error.blocks_even_when_optional()
                {
                    issues.push(ManifestIssue {
                        role: role.clone(),
                        path: raw,
                        kind: error.issue_kind().to_string(),
                        detail: error.detail().to_string(),
                    });
                }
                continue;
            }
        };
        if let Err(detail) = sniff(&role, &bytes) {
            issues.push(ManifestIssue {
                role: role.clone(),
                path: raw,
                kind: "invalidFormat".to_string(),
                detail,
            });
            continue;
        }
        if let Some(entry) = manifest.files_entry(&role) {
            if !entry.sha256.is_empty() {
                let actual = format!("{:x}", {
                    let mut hasher = Sha256::new();
                    hasher.update(&bytes);
                    hasher.finalize()
                });
                if actual != entry.sha256 {
                    issues.push(ManifestIssue {
                        role: role.clone(),
                        path: raw,
                        kind: "hashMismatch".to_string(),
                        detail: format!("expected {}, found {actual}", entry.sha256),
                    });
                }
            }
        }
    }
    issues
}

fn parse_manifest_text(text: &str) -> Result<GenerationManifest, String> {
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);
    let manifest: GenerationManifest = serde_json::from_str(stripped)
        .map_err(|e| format!("manifest is not valid JSON for this schema: {e}"))?;
    if manifest.schema_version < MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION
        || manifest.schema_version > MANIFEST_SCHEMA_VERSION
    {
        return Err(format!(
            "unsupported manifest schema version {} (supported: {}..={MANIFEST_SCHEMA_VERSION})",
            manifest.schema_version, MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION
        ));
    }
    // Advanced settings recorded by schema 2 must satisfy the same bounds the
    // native server enforces, so recovery never replays an out-of-range value.
    manifest
        .target_faces
        .value_in_range("targetFaces", TARGET_FACES_RANGE)?;
    manifest
        .atlas_size
        .value_in_range("atlasSize", ATLAS_SIZE_RANGE)?;
    if let AutoU32::Value(resolution) = manifest.texture_resolution {
        if resolution != 512 && resolution != 1024 {
            return Err("textureResolution must be \"auto\", 512, or 1024".to_string());
        }
    }
    manifest
        .remesh_band
        .value_in_range("remeshBand", REMESH_BAND_RANGE)?;
    Ok(manifest)
}

fn manifest_dir(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("manifest path must be absolute".to_string());
    }
    if path.extension().and_then(|ext| ext.to_str()) != Some("json")
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .map(is_manifest_name)
            .unwrap_or(false)
    {
        return Err("not a .triastasis.json or legacy .polyloom.json manifest".to_string());
    }
    path.parent()
        .map(|parent| parent.to_path_buf())
        .ok_or_else(|| "manifest has no parent directory".to_string())
}

/// Writes a manifest atomically beside its generation. Hashes left blank by
/// the caller are computed from whatever already exists on disk, so callers
/// never need to implement hashing themselves. `force_file_name` pins the
/// manifest filename — used when resuming an existing interrupted manifest so
/// the replacement updates the same file; otherwise the canonical
/// `<model-or-job-stem>.triastasis.json` name applies.
pub fn write_generation_manifest_impl(
    dir: &Path,
    mut manifest: GenerationManifest,
    force_file_name: Option<&str>,
) -> Result<PathBuf, String> {
    // Every write emits the current schema; a v1 manifest updated in place
    // (for example during recovery) is upgraded transparently.
    manifest.schema_version = MANIFEST_SCHEMA_VERSION;
    if !matches!(
        manifest.status.as_str(),
        "completed" | "interrupted" | "failed" | "cancelled"
    ) {
        return Err(format!("invalid manifest status {}", manifest.status));
    }
    if manifest.triastasis_version.is_none() {
        manifest.triastasis_version = Some(env!("CARGO_PKG_VERSION").to_string());
    }
    for (role, raw) in manifest.references() {
        resolve_in_dir(dir, &raw).map_err(|e| format!("{role}: {e}"))?;
    }
    // Lifecycle guard: a completed manifest must never silently regress to
    // interrupted/cancelled under the same file name (e.g. a reused job id).
    if matches!(manifest.status.as_str(), "interrupted" | "cancelled") {
        let existing_name = force_file_name
            .map(safe_relative_path)
            .transpose()?
            .map(|name| dir.join(name));
        let existing_name = existing_name.unwrap_or_else(|| dir.join(manifest_filename(&manifest)));
        if existing_name.is_file()
            && std::fs::read_to_string(&existing_name)
                .ok()
                .and_then(|text| parse_manifest_text(&text).ok())
                .map(|existing| existing.status == "completed")
                .unwrap_or(false)
        {
            return Err(format!(
                "{} already holds a completed generation; refusing to mark it {}",
                existing_name.display(),
                manifest.status
            ));
        }
    }
    // Fill in hashes for existing files; missing files keep a blank hash so an
    // interrupted manifest can be written before its model exists. Containment
    // applies here too: never hash through an escaping symlink.
    for (role, raw) in manifest.references() {
        let resolved = dir.join(safe_relative_path(&raw)?);
        if resolved.is_file() {
            let bytes = read_contained_file(dir, &resolved)
                .map_err(|e| format!("{role}: {}", e.detail()))?;
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = format!("{:x}", hasher.finalize());
            if let Some(entry) = manifest.files.iter_mut().find(|entry| entry.role == role) {
                entry.sha256 = hash;
            }
        }
    }
    let body = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("could not encode manifest: {e}"))?;
    let target_name = match force_file_name {
        Some(name) => {
            let validated = safe_relative_path(name)?;
            let as_str = validated.to_string_lossy().into_owned();
            if !is_manifest_name(&as_str) {
                return Err(
                    "forced manifest name must end with .triastasis.json or .polyloom.json"
                        .to_string(),
                );
            }
            as_str
        }
        None => manifest_filename(&manifest),
    };
    let target = dir.join(target_name);
    // Remove a stale temp file from an interrupted previous write; the pid
    // suffix keeps concurrent processes from clobbering each other's temp.
    let temp = target.with_extension(format!("json.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// Canonical manifest filename: `<model-stem>.triastasis.json`, falling back to
/// the job id when no model has been produced yet.
fn manifest_filename(manifest: &GenerationManifest) -> String {
    let stem = manifest
        .model
        .as_deref()
        .map(Path::new)
        .and_then(Path::file_stem)
        .map(|stem| stem.to_string_lossy().into_owned())
        .or_else(|| manifest.job_id.clone())
        .unwrap_or_else(|| "generation".to_string());
    format!("{stem}.{MANIFEST_EXTENSION}")
}

pub fn read_generation_manifest_impl(path: &str) -> Result<ManifestPreview, String> {
    let manifest_file = PathBuf::from(path);
    if let Ok(metadata) = std::fs::metadata(&manifest_file) {
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(format!(
                "manifest exceeds the {} MB size limit",
                MAX_MANIFEST_BYTES / (1024 * 1024)
            ));
        }
    }
    let dir = manifest_dir(path)?;
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("could not read manifest: {e}"))?;
    let manifest = parse_manifest_text(&text)?;
    // Core files (source image + model) always surface as missing when absent
    // so import previews can warn and relink; optional attachments stay
    // tolerant of absence.
    let issues = validate_references(&dir, &manifest, true);
    Ok(ManifestPreview {
        path: path.to_string(),
        manifest,
        issues,
    })
}

pub fn import_generation_manifest_impl(path: &str) -> Result<ImportedGeneration, String> {
    let preview = read_generation_manifest_impl(path)?;
    let blocking: Vec<&ManifestIssue> = preview
        .issues
        .iter()
        .filter(|issue| {
            matches!(
                issue.kind.as_str(),
                "missing" | "hashMismatch" | "invalidFormat" | "unsafePath"
            )
        })
        .filter(|issue| matches!(issue.role.as_str(), "sourceImage" | "glb"))
        .collect();
    if !blocking.is_empty() {
        let detail = blocking
            .iter()
            .map(|issue| format!("{} ({}): {}", issue.role, issue.kind, issue.detail))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("cannot import generation: {detail}"));
    }
    let dir = manifest_dir(path)?;
    let image_bytes = read_contained_file(
        &dir,
        &resolve_in_dir(
            &dir,
            preview
                .manifest
                .source_image
                .as_deref()
                .ok_or("manifest does not reference a source image")?,
        )?,
    )
    .map_err(|e| format!("could not read source image: {}", e.detail()))?;
    let glb_bytes = read_contained_file(
        &dir,
        &resolve_in_dir(
            &dir,
            preview
                .manifest
                .model
                .as_deref()
                .ok_or("manifest does not reference a model")?,
        )?,
    )
    .map_err(|e| format!("could not read model: {}", e.detail()))?;
    Ok(ImportedGeneration {
        manifest_path: preview.path,
        manifest: preview.manifest,
        image_bytes,
        glb_bytes,
    })
}

/// Reads one validated attachment (used for requeueing interrupted jobs).
pub fn read_manifest_asset_impl(path: &str, role: &str) -> Result<Vec<u8>, String> {
    let preview = read_generation_manifest_impl(path)?;
    let raw = preview
        .manifest
        .role_path(role)
        .ok_or_else(|| format!("manifest does not reference a {role}"))?;
    let dir = manifest_dir(path)?;
    let resolved = resolve_in_dir(&dir, raw)?;
    let bytes =
        read_contained_file(&dir, &resolved).map_err(|e| format!("{role}: {}", e.detail()))?;
    sniff(role, &bytes)?;
    if let Some(entry) = preview.manifest.files_entry(role) {
        if !entry.sha256.is_empty() {
            let actual = format!("{:x}", {
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                hasher.finalize()
            });
            if actual != entry.sha256 {
                return Err(format!("{role} failed hash verification"));
            }
        }
    }
    Ok(bytes)
}

/// Copies a user-picked replacement into the manifest directory and updates
/// the recorded hash atomically. Used by the relinking flow.
///
/// The writer is forced onto the EXACT manifest file the user opened — never
/// a freshly derived canonical name — so a noncanonical
/// Legacy and Triastasis manifest names are repaired in place with no second file.
pub fn relink_manifest_file_impl(
    manifest_path: &str,
    role: &str,
    source_path: &str,
) -> Result<GenerationManifest, String> {
    if !matches!(role, "sourceImage" | "glb" | "cutout" | "thumbnail" | "log") {
        return Err(format!("unknown manifest role {role}"));
    }
    let dir = manifest_dir(manifest_path)?;
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_file() {
        return Err("picked file must be an existing absolute path".to_string());
    }
    let mut manifest = {
        let text = std::fs::read_to_string(manifest_path)
            .map_err(|e| format!("could not read manifest: {e}"))?;
        parse_manifest_text(&text)?
    };
    // Keep the previously-recorded name when there is one so relinking never
    // leaves orphaned names behind; otherwise derive from the picked file.
    let target_name = manifest
        .files_entry(role)
        .map(|entry| entry.path.clone())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| {
            source
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| role.to_string())
        });
    let resolved = resolve_in_dir(&dir, &target_name)?;
    // A pre-existing symlink at the destination could redirect the copy
    // outside the directory; refuse rather than follow it.
    if resolved.symlink_metadata().is_ok() {
        read_contained_file(&dir, &resolved).map_err(|e| format!("{role}: {}", e.detail()))?;
    }
    // Copying a file onto itself is a no-op at best and truncating at worst.
    let same_file = std::fs::canonicalize(&source)
        .ok()
        .zip(std::fs::canonicalize(&resolved).ok())
        .map(|(picked, destination)| picked == destination)
        .unwrap_or(false);
    if !same_file {
        std::fs::copy(&source, &resolved)
            .map_err(|e| format!("could not copy replacement file: {e}"))?;
    }
    manifest.set_role_path(role, target_name);

    // Pin the writer to the original basename, then reread from disk so the
    // returned hashes reflect what is actually persisted.
    let file_name = PathBuf::from(manifest_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or("manifest has no file name")?;
    safe_relative_path(&file_name)?;
    write_generation_manifest_impl(&dir, manifest.clone(), Some(&file_name))?;
    let reread = read_generation_manifest_impl(manifest_path)?;
    Ok(reread.manifest)
}

/// Finds a manifest linked to a standalone GLB: the conventional sibling name
/// first, then any manifest in the same directory referencing this file.
pub fn find_linked_manifest_impl(glb_path: &str) -> Option<String> {
    let glb = PathBuf::from(glb_path);
    let dir = glb.parent()?;
    let stem = glb.file_stem()?.to_string_lossy().into_owned();
    for extension in [MANIFEST_EXTENSION, LEGACY_MANIFEST_EXTENSION] {
        let conventional = dir.join(format!("{stem}.{extension}"));
        if conventional.is_file() {
            return Some(conventional.to_string_lossy().into_owned());
        }
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let named = path.file_name()?.to_str()?;
        if !is_manifest_name(named) {
            continue;
        }
        if let Ok(preview) = read_generation_manifest_impl(&path.to_string_lossy()) {
            if preview
                .issues
                .iter()
                .any(|issue| issue.kind == "unsafePath")
            {
                continue;
            }
            if let Some(model) = preview.manifest.model {
                if let Ok(linked) = resolve_in_dir(dir, &model) {
                    if linked == glb {
                        return Some(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    None
}

/// Lists every Triastasis or legacy Polyloom manifest beside `path` (used to
/// reconstruct a full sweep from one of its candidate manifests).
pub fn list_sibling_manifests_impl(path: &str) -> Result<Vec<String>, String> {
    let dir = manifest_dir(path)?;
    let mut found = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("could not read directory: {e}"))?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        let is_manifest = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .map(is_manifest_name)
            .unwrap_or(false);
        if is_manifest {
            found.push(candidate.to_string_lossy().into_owned());
        }
    }
    found.sort();
    Ok(found)
}

/// Finds interrupted generations in the output directory for recovery.
pub fn scan_interrupted_manifests_impl() -> Vec<(String, GenerationManifest)> {
    let dir = match crate::config::resolve_output_dir() {
        Ok(dir) => dir,
        Err(_) => return Vec::new(),
    };
    let mut found = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return found,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_manifest = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(is_manifest_name)
            .unwrap_or(false);
        if !is_manifest {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(manifest) = parse_manifest_text(&text) {
                if manifest.status == "interrupted" {
                    found.push((path.to_string_lossy().into_owned(), manifest));
                }
            }
        }
    }
    found.sort_by(|a, b| a.1.label.cmp(&b.1.label));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE_PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot-really-an-image-but-magic-ok";
    const FAKE_GLB: &[u8] = b"glTF\x02\x00\x00\x00binary-payload";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("triastasis-manifest-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sample_manifest(source: &str, model: &str) -> GenerationManifest {
        GenerationManifest {
            status: "completed".to_string(),
            label: "Test generation".to_string(),
            source_image: Some(source.to_string()),
            model: Some(model.to_string()),
            seed: 42,
            resolution: 512,
            job_id: Some("job-1".to_string()),
            native_request_id: Some("req-1".to_string()),
            asset_id: Some("asset-1".to_string()),
            version_id: Some("version-1".to_string()),
            submitted_at_utc: Some("2026-08-21T00:00:00Z".to_string()),
            files: vec![
                ManifestFileRef {
                    role: "sourceImage".to_string(),
                    path: source.to_string(),
                    sha256: String::new(),
                },
                ManifestFileRef {
                    role: "glb".to_string(),
                    path: model.to_string(),
                    sha256: String::new(),
                },
            ],
            ..GenerationManifest::default()
        }
    }

    fn existing_manifest_in(dir: &Path) -> PathBuf {
        let current = dir.join("model.triastasis.json");
        if current.is_file() {
            current
        } else {
            dir.join("model.polyloom.json")
        }
    }

    #[test]
    fn round_trip_preserves_binary_files_and_hashes() {
        let temp = TempDir::new("roundtrip");
        let png = temp.write("source.png", FAKE_PNG);
        let glb = temp.write("model.glb", FAKE_GLB);
        let mut manifest = sample_manifest("source.png", "model.glb");
        manifest.triastasis_version = None;

        let target = write_generation_manifest_impl(&temp.0, manifest, None).unwrap();
        assert!(target.file_name().unwrap() == "model.triastasis.json");

        // Binary files are untouched by writing the manifest.
        assert_eq!(std::fs::read(&png).unwrap(), FAKE_PNG);
        assert_eq!(std::fs::read(&glb).unwrap(), FAKE_GLB);

        let imported = import_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert_eq!(imported.image_bytes, FAKE_PNG);
        assert_eq!(imported.glb_bytes, FAKE_GLB);
        assert_eq!(imported.manifest.seed, 42);
        assert_eq!(imported.manifest.job_id.as_deref(), Some("job-1"));
        assert_eq!(
            imported.manifest.triastasis_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn missing_source_or_model_blocks_import() {
        let temp = TempDir::new("missing");
        temp.write("model.glb", FAKE_GLB);
        // The manifest references a source image that was never written.
        let target = write_generation_manifest_impl(
            &temp.0,
            sample_manifest("gone-source.png", "model.glb"),
            None,
        )
        .unwrap();

        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert!(preview
            .issues
            .iter()
            .any(|issue| issue.role == "sourceImage" && issue.kind == "missing"));
        assert!(import_generation_manifest_impl(&target.to_string_lossy()).is_err());
    }

    #[test]
    fn tampered_files_are_flagged_as_hash_mismatch() {
        let temp = TempDir::new("hash");
        temp.write("source.png", FAKE_PNG);
        temp.write("model.glb", FAKE_GLB);
        let target = write_generation_manifest_impl(
            &temp.0,
            sample_manifest("source.png", "model.glb"),
            None,
        )
        .unwrap();

        // Tamper after hashing.
        temp.write("model.glb", b"glTF\x02\x00\x00\x00tampered");
        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        let mismatch = preview
            .issues
            .iter()
            .find(|issue| issue.role == "glb")
            .unwrap();
        assert_eq!(mismatch.kind, "hashMismatch");
        assert!(import_generation_manifest_impl(&target.to_string_lossy()).is_err());

        // A valid relink repairs the manifest.
        let replacement = temp.write("replacement.glb", FAKE_GLB);
        let repaired = relink_manifest_file_impl(
            &target.to_string_lossy(),
            "glb",
            &replacement.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(repaired.model.as_deref(), Some("model.glb")); // keeps recorded name
        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert!(!preview.issues.iter().any(|issue| issue.role == "glb"));
    }

    #[test]
    fn unsupported_schema_versions_are_rejected() {
        let json = serde_json::json!({
            "schemaVersion": 99,
            "status": "completed",
            "files": []
        });
        let error = parse_manifest_text(&json.to_string()).unwrap_err();
        assert!(error.contains("unsupported manifest schema version 99"));
    }

    #[test]
    fn version_one_manifests_parse_with_advanced_defaults() {
        // Schema 1 never stored the advanced generation parameters.
        let json = serde_json::json!({
            "schemaVersion": 1,
            "status": "interrupted",
            "label": "legacy",
            "resolution": 512,
            "seed": 7,
            "bgRemoval": "auto",
            "uv": "xatlas",
            "texture": true,
            "files": []
        });
        let manifest = parse_manifest_text(&json.to_string()).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.target_faces, AutoU32::Auto);
        assert_eq!(manifest.atlas_size, AutoU32::Auto);
        assert_eq!(manifest.texture_resolution, AutoU32::Auto);
        assert_eq!(manifest.remesh_band, AutoU32::Auto);
        assert_eq!(manifest.texture_encoding, TextureEncodingChoice::Auto);
    }

    #[test]
    fn version_two_manifests_round_trip_advanced_settings() {
        let json = serde_json::json!({
            "schemaVersion": 2,
            "status": "completed",
            "label": "advanced",
            "resolution": 1024,
            "seed": 9,
            "bgRemoval": "birefnet",
            "uv": "box",
            "texture": true,
            "targetFaces": 250_000,
            "atlasSize": "auto",
            "textureResolution": 512,
            "remeshBand": 3,
            "textureEncoding": "webp",
            "files": []
        });
        let manifest = parse_manifest_text(&json.to_string()).unwrap();
        assert_eq!(manifest.target_faces, AutoU32::Value(250_000));
        assert_eq!(manifest.atlas_size, AutoU32::Auto);
        assert_eq!(manifest.texture_resolution, AutoU32::Value(512));
        assert_eq!(manifest.remesh_band, AutoU32::Value(3));
        assert_eq!(manifest.texture_encoding, TextureEncodingChoice::Webp);

        // Serialization matches the TypeScript spelling exactly: bare numbers
        // for values, the lowercase string for choices.
        let encoded: serde_json::Value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(encoded["targetFaces"], serde_json::json!(250_000));
        assert_eq!(encoded["atlasSize"], serde_json::json!("auto"));
        assert_eq!(encoded["textureResolution"], serde_json::json!(512));
        assert_eq!(encoded["remeshBand"], serde_json::json!(3));
        assert_eq!(encoded["textureEncoding"], serde_json::json!("webp"));

        // The encoded document parses back to an identical manifest.
        let reparsed = parse_manifest_text(&encoded.to_string()).unwrap();
        assert_eq!(reparsed, manifest);
    }

    #[test]
    fn out_of_range_advanced_values_are_rejected() {
        let base = serde_json::json!({
            "schemaVersion": 2,
            "status": "interrupted",
            "files": []
        });
        let invalid = [
            serde_json::json!({ "targetFaces": 9_999 }),
            serde_json::json!({ "targetFaces": 1_000_001 }),
            serde_json::json!({ "atlasSize": 127 }),
            serde_json::json!({ "atlasSize": 4097 }),
            serde_json::json!({ "textureResolution": 256 }),
            serde_json::json!({ "remeshBand": 9 }),
            serde_json::json!({ "textureEncoding": "jpeg" }),
        ];
        for patch in invalid {
            let mut candidate = base.clone();
            for (key, value) in patch.as_object().unwrap() {
                candidate[key] = value.clone();
            }
            let error = parse_manifest_text(&candidate.to_string())
                .expect_err("expected out-of-range rejection");
            assert!(
                !error.contains("unsupported manifest schema"),
                "unexpected rejection reason: {error}"
            );
        }
    }

    #[test]
    fn every_write_emits_the_current_schema_version() {
        let temp = TempDir::new("upgrade-on-write");
        temp.write("source.png", FAKE_PNG);
        temp.write("model.glb", FAKE_GLB);
        // Simulate an updated legacy manifest: still on schema 1 when handed
        // to the writer.
        let mut manifest = sample_manifest("source.png", "model.glb");
        manifest.schema_version = 1;
        let target = write_generation_manifest_impl(&temp.0, manifest, None).unwrap();
        let reloaded = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert_eq!(reloaded.manifest.schema_version, MANIFEST_SCHEMA_VERSION);
    }

    #[test]
    fn path_traversal_attempts_are_rejected() {
        for evil in [
            "../escape.png",
            "..\\escape.png",
            "/absolute/escape.png",
            "C:\\escape.png",
            "a/../../escape.png",
        ] {
            assert!(
                safe_relative_path(evil).is_err(),
                "expected rejection of {evil}"
            );
        }
        assert_eq!(
            safe_relative_path("sub/dir/file.png").unwrap(),
            PathBuf::from("sub").join("dir").join("file.png")
        );

        // A manifest smuggling traversal is flagged, not followed.
        let temp = TempDir::new("traversal");
        let mut manifest = GenerationManifest {
            source_image: Some("../outside.png".to_string()),
            files: vec![ManifestFileRef {
                role: "sourceImage".to_string(),
                path: "../outside.png".to_string(),
                sha256: String::new(),
            }],
            ..GenerationManifest::default()
        };
        manifest.status = "completed".to_string();
        let issues = validate_references(&temp.0, &manifest, false);
        assert!(issues.iter().any(|issue| issue.kind == "unsafePath"));
        assert!(write_generation_manifest_impl(&temp.0, manifest, None).is_err());
    }

    #[test]
    fn invalid_image_and_glb_formats_are_flagged() {
        let temp = TempDir::new("formats");
        temp.write("source.png", b"definitely not an image");
        temp.write("model.glb", b"PK\x03\x04 zip not glb");
        let mut manifest = sample_manifest("source.png", "model.glb");
        manifest.status = "completed".to_string();
        let target = write_generation_manifest_impl(&temp.0, manifest.clone(), None).unwrap();
        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert!(preview
            .issues
            .iter()
            .any(|issue| issue.role == "sourceImage" && issue.kind == "invalidFormat"));
        assert!(preview
            .issues
            .iter()
            .any(|issue| issue.role == "glb" && issue.kind == "invalidFormat"));
        assert!(import_generation_manifest_impl(&target.to_string_lossy()).is_err());
    }

    #[test]
    fn interrupted_manifests_support_requeue_asset_reads() {
        let temp = TempDir::new("requeue");
        temp.write("source.png", FAKE_PNG);
        let mut manifest = GenerationManifest {
            status: "interrupted".to_string(),
            label: "Interrupted run".to_string(),
            source_image: Some("source.png".to_string()),
            job_id: Some("job-9".to_string()),
            native_request_id: Some("req-9".to_string()),
            files: vec![ManifestFileRef {
                role: "sourceImage".to_string(),
                path: "source.png".to_string(),
                sha256: String::new(),
            }],
            ..GenerationManifest::default()
        };
        // No model yet: the writer must tolerate its absence.
        let target = write_generation_manifest_impl(&temp.0, manifest.clone(), None).unwrap();
        assert!(target.to_string_lossy().ends_with("job-9.triastasis.json"));

        manifest.job_id = None;
        let bytes = read_manifest_asset_impl(&target.to_string_lossy(), "sourceImage").unwrap();
        assert_eq!(bytes, FAKE_PNG);
        assert!(read_manifest_asset_impl(&target.to_string_lossy(), "glb").is_err());
    }

    #[test]
    fn symlink_escape_of_referenced_files_is_refused() {
        let temp = TempDir::new("symlink");
        let outside_dir = TempDir::new("symlink-outside");
        let secret = outside_dir.write("secret.glb", FAKE_GLB);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, temp.0.join("model.glb")).unwrap();
        }
        #[cfg(windows)]
        {
            // Junctions/symlinks require elevated or developer-mode rights on
            // some systems; skip rather than fail the suite when unavailable.
            match std::os::windows::fs::symlink_file(&secret, temp.0.join("model.glb")) {
                Ok(()) => {}
                Err(_) => return,
            }
        }

        let manifest = sample_manifest("source.png", "model.glb");
        let target = write_generation_manifest_impl(&temp.0, manifest, None);
        // The writer hashes through containment and must refuse the escape.
        assert!(target.is_err(), "symlinked artifact must be refused");
    }

    #[test]
    fn unicode_filenames_round_trip() {
        let temp = TempDir::new("unicode");
        temp.write("référence-日本語.png", FAKE_PNG);
        temp.write("модель-★.glb", FAKE_GLB);
        let manifest = sample_manifest("référence-日本語.png", "модель-★.glb");
        let target = write_generation_manifest_impl(&temp.0, manifest, None).unwrap();
        let imported = import_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert_eq!(imported.image_bytes, FAKE_PNG);
        assert_eq!(imported.glb_bytes, FAKE_GLB);
    }

    #[test]
    fn completed_manifests_cannot_regress_to_interrupted() {
        let temp = TempDir::new("lifecycle");
        temp.write("source.png", FAKE_PNG);
        temp.write("model.glb", FAKE_GLB);
        let completed = sample_manifest("source.png", "model.glb");
        let target = write_generation_manifest_impl(&temp.0, completed, None).unwrap();
        assert!(target.to_string_lossy().ends_with("model.triastasis.json"));

        // A reused job id must not overwrite a completed generation with an
        // interrupted placeholder under ordinary writes.
        let mut stale = GenerationManifest {
            status: "interrupted".to_string(),
            model: Some("model.glb".to_string()),
            job_id: Some("job-stale".to_string()),
            ..GenerationManifest::default()
        };
        stale.source_image = None;
        assert!(write_generation_manifest_impl(
            &temp.0,
            stale.clone(),
            Some("model.triastasis.json")
        )
        .is_err());
        // The original file survives untouched.
        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert_eq!(preview.manifest.status, "completed");
        drop(stale);
    }

    #[test]
    fn sweep_manifests_round_trip_and_cancel_safely() {
        let temp = TempDir::new("sweep");
        temp.write("source.png", FAKE_PNG);
        temp.write("cand0.glb", FAKE_GLB);
        let manifest = GenerationManifest {
            status: "interrupted".to_string(),
            label: "Candidate 1/2".to_string(),
            source_image: Some("shared_source.png".to_string()),
            model: Some("cand0.glb".to_string()),
            seed: 43,
            job_id: Some("sweep-version-1".to_string()),
            sweep: Some(ManifestSweep {
                group_id: "sweep-1".to_string(),
                index: 1,
                count: 2,
                seed: 43,
                state: "queued".to_string(),
            }),
            files: vec![
                ManifestFileRef {
                    role: "sourceImage".to_string(),
                    path: "shared_source.png".to_string(),
                    sha256: String::new(),
                },
                ManifestFileRef {
                    role: "glb".to_string(),
                    path: "cand0.glb".to_string(),
                    sha256: String::new(),
                },
            ],
            ..GenerationManifest::default()
        };
        let target = write_generation_manifest_impl(&temp.0, manifest.clone(), None).unwrap();

        // Round trip preserves the sweep block.
        let loaded = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        let sweep = loaded.manifest.sweep.as_ref().unwrap();
        assert_eq!(sweep.group_id, "sweep-1");
        assert_eq!(sweep.index, 1);
        assert_eq!(sweep.count, 2);

        // queued -> cancelled is a legal transition.
        let mut cancelled = manifest.clone();
        cancelled.status = "cancelled".to_string();
        if let Some(sweep) = cancelled.sweep.as_mut() {
            sweep.state = "cancelled".to_string();
        }
        write_generation_manifest_impl(&temp.0, cancelled, None).unwrap();
        let reloaded = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert_eq!(reloaded.manifest.status, "cancelled");

        // ...but completed -> cancelled is refused (no silent regression).
        let mut completed = manifest;
        completed.status = "completed".to_string();
        write_generation_manifest_impl(&temp.0, completed, None).unwrap();
        let mut regress = read_generation_manifest_impl(&target.to_string_lossy())
            .unwrap()
            .manifest;
        regress.status = "cancelled".to_string();
        assert!(write_generation_manifest_impl(&temp.0, regress, None).is_err());
    }

    #[test]
    fn sibling_listing_finds_only_manifest_files() {
        let temp = TempDir::new("siblings");
        temp.write("a.triastasis.json", b"{}");
        temp.write("b.polyloom.json", b"{}");
        temp.write("model.glb", FAKE_GLB);
        temp.write("notes.txt", b"hello");

        let mut siblings =
            list_sibling_manifests_impl(&temp.0.join("a.triastasis.json").to_string_lossy())
                .unwrap();
        siblings.sort();
        assert_eq!(siblings.len(), 2);
        assert!(siblings[0].ends_with("a.triastasis.json"));
        assert!(siblings[1].ends_with("b.polyloom.json"));
    }

    #[test]
    fn relink_updates_noncanonical_manifest_files_in_place() {
        let temp = TempDir::new("noncanonical-relink");
        temp.write("source.png", FAKE_PNG);
        temp.write("model.glb", FAKE_GLB);
        // Persist under a noncanonical name.
        let target = write_generation_manifest_impl(
            &temp.0,
            sample_manifest("source.png", "model.glb"),
            Some("custom-name.polyloom.json"),
        )
        .unwrap();
        assert!(target.file_name().unwrap() == "custom-name.polyloom.json");

        // Tamper, then repair through the noncanonical manifest.
        temp.write("model.glb", b"glTF\x02\x00\x00\x00tampered");
        let replacement = temp.write("replacement.glb", FAKE_GLB);
        let repaired = relink_manifest_file_impl(
            &target.to_string_lossy(),
            "glb",
            &replacement.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(repaired.status, "completed");

        // The EXACT original file was updated; no canonical duplicate exists.
        assert!(target.is_file());
        assert!(!temp.0.join("model.triastasis.json").exists());
        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert!(!preview.issues.iter().any(|issue| issue.role == "glb"));
        let entry = preview
            .manifest
            .files_entry("glb")
            .expect("glb hash recorded");
        assert_eq!(
            entry.sha256,
            format!("{:x}", {
                let mut hasher = Sha256::new();
                hasher.update(FAKE_GLB);
                hasher.finalize()
            })
        );
        assert!(import_generation_manifest_impl(&target.to_string_lossy()).is_ok());
    }

    #[test]
    fn relinking_the_destination_onto_itself_is_safe() {
        let temp = TempDir::new("self-relink");
        temp.write("source.png", FAKE_PNG);
        let replacement = temp.write("model.glb", FAKE_GLB);
        let target = write_generation_manifest_impl(
            &temp.0,
            sample_manifest("source.png", "model.glb"),
            None,
        )
        .unwrap();

        // Tamper so the recorded hash no longer matches, then "relink" by
        // selecting the existing destination file itself.
        temp.write("model.glb", b"glTF\x02\x00\x00\x00tampered");
        let repaired = relink_manifest_file_impl(
            &target.to_string_lossy(),
            "glb",
            &replacement.to_string_lossy(),
        );
        // Either the operation is refused as a self-copy or it rewrites the
        // hash from the identical content — both are safe outcomes.
        match repaired {
            Err(_) => {}
            Ok(manifest) => {
                let entry = manifest.files_entry("glb").unwrap().clone();
                assert_eq!(entry.path, "model.glb");
            }
        }
        assert!(replacement.is_file(), "destination content must survive");
    }

    #[test]
    fn relinking_source_images_updates_that_role() {
        let temp = TempDir::new("source-relink");
        temp.write("source.png", FAKE_PNG);
        temp.write("model.glb", FAKE_GLB);
        let target = write_generation_manifest_impl(
            &temp.0,
            sample_manifest("source.png", "model.glb"),
            None,
        )
        .unwrap();

        let new_image = temp.write("better-source.png", b"\x89PNG\r\n\x1a\nnew-image-bytes");
        let repaired = relink_manifest_file_impl(
            &target.to_string_lossy(),
            "sourceImage",
            &new_image.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(repaired.source_image.as_deref(), Some("source.png"));
        let preview = read_generation_manifest_impl(&target.to_string_lossy()).unwrap();
        assert!(!preview
            .issues
            .iter()
            .any(|issue| issue.role == "sourceImage"));
    }

    #[test]
    fn oversized_manifests_are_rejected() {
        let temp = TempDir::new("oversize");
        let oversized = vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize];
        temp.write("huge.triastasis.json", &oversized);
        assert!(read_generation_manifest_impl(
            &temp.0.join("huge.triastasis.json").to_string_lossy()
        )
        .is_err());
    }

    /// Runs the generated runtime fixture set (tools/make_runtime_fixtures.py)
    /// through the real validation layer. Skips silently when the fixtures
    /// have not been generated on this machine.
    #[test]
    fn runtime_fixture_matrix() {
        let dir = std::env::var("TRIASTASIS_FIXTURE_DIR")
            .or_else(|_| std::env::var("POLYLOOM_FIXTURE_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let current = std::env::temp_dir().join("triastasis-runtime-fixtures");
                if current.is_dir() {
                    current
                } else {
                    std::env::temp_dir().join("polyloom-runtime-fixtures")
                }
            });
        if !dir.is_dir() {
            eprintln!("fixtures not generated; skipping matrix");
            return;
        }
        let case = |name: &str| dir.join(name);
        let manifest_path = |name: &str| {
            existing_manifest_in(&case(name))
                .to_string_lossy()
                .into_owned()
        };
        let preview_issues = |name: &str| {
            read_generation_manifest_impl(&manifest_path(name))
                .unwrap()
                .issues
        };
        fn has_issue(issues: &[ManifestIssue], role: &str, kind: &str) -> bool {
            issues
                .iter()
                .any(|issue| issue.role == role && issue.kind == kind)
        }

        // 01: clean import of a fully valid generation.
        let imported =
            import_generation_manifest_impl(&manifest_path("01-valid-completed")).unwrap();
        assert_eq!(&imported.glb_bytes[0..4], b"glTF");
        assert!(imported.image_bytes.len() > 8);

        // 02/03: interrupted and failed manifests reference their source only;
        // the absent model is expected, not an error to preview.
        for name in ["02-valid-interrupted", "03-valid-failed"] {
            let issues = preview_issues(name);
            assert!(
                !has_issue(&issues, "glb", "missing"),
                "{name}: expected-absent model must not be flagged"
            );
            assert!(import_generation_manifest_impl(&manifest_path(name)).is_err());
        }
        let failed = read_generation_manifest_impl(&manifest_path("03-valid-failed")).unwrap();
        assert!(failed.manifest.error.as_deref().unwrap().contains("500"));

        // 04–07: missing and tampered artifacts block import explicitly.
        for (name, role) in [
            ("04-missing-source", "sourceImage"),
            ("05-missing-glb", "glb"),
            ("06-modified-source", "sourceImage"),
            ("07-modified-glb", "glb"),
        ] {
            let issues = preview_issues(name);
            let kind = if name.starts_with("04") || name.starts_with("05") {
                "missing"
            } else {
                "hashMismatch"
            };
            assert!(
                has_issue(&issues, role, kind),
                "{name}: expected {kind} on {role}"
            );
            assert!(
                import_generation_manifest_impl(&manifest_path(name)).is_err(),
                "{name}"
            );
        }

        // 08/09: structurally broken manifests are refused outright.
        assert!(
            read_generation_manifest_impl(&manifest_path("08-unsupported-version"))
                .unwrap_err()
                .contains("unsupported manifest schema version 99")
        );
        assert!(read_generation_manifest_impl(&manifest_path("09-invalid-json")).is_err());

        // 10–12: hostile path forms never reach the filesystem.
        for (name, role) in [
            ("10-absolute-path", "sourceImage"),
            ("11-traversal-path", "sourceImage"),
        ] {
            let issues = preview_issues(name);
            assert!(has_issue(&issues, role, "unsafePath"), "{name}");
            assert!(
                import_generation_manifest_impl(&manifest_path(name)).is_err(),
                "{name}"
            );
        }
        // Drive-relative is a Windows prefix form; on other platforms it is a
        // legal (here absent) relative name — either way import must fail.
        assert!(import_generation_manifest_impl(&manifest_path("12-drive-relative-path")).is_err());

        // 14/15: sibling detection is exact and failure-tolerant.
        let linked = find_linked_manifest_impl(
            &case("14-glb-with-sibling-manifest")
                .join("sibling-model.glb")
                .to_string_lossy(),
        );
        let linked = linked.unwrap();
        assert!(
            linked.ends_with("sibling-model.triastasis.json")
                || linked.ends_with("sibling-model.polyloom.json")
        );
        // A conventional-but-broken sibling is still discovered so the UI can
        // report it; opening the GLB itself remains unaffected.
        let broken = find_linked_manifest_impl(
            &case("15-glb-with-invalid-sibling")
                .join("broken-sibling.glb")
                .to_string_lossy(),
        )
        .expect("invalid conventional sibling must still be discovered");
        assert!(
            broken.ends_with("broken-sibling.triastasis.json")
                || broken.ends_with("broken-sibling.polyloom.json")
        );
        assert!(read_generation_manifest_impl(&broken).is_err());

        // 16: colliding lineage imports independently at the command layer.
        for suffix in ["a", "b"] {
            let imported = import_generation_manifest_impl(&manifest_path(&format!(
                "16-duplicate-ids-{suffix}"
            )))
            .unwrap();
            assert_eq!(
                imported.manifest.asset_id.as_deref(),
                Some("colliding-asset-id")
            );
        }

        // 17: unicode artifact names survive the whole path.
        let imported =
            import_generation_manifest_impl(&manifest_path("17-unicode-filenames")).unwrap();
        assert!(!imported.glb_bytes.is_empty());

        // 18: large-but-valid artifacts stay under the size limit.
        let imported =
            import_generation_manifest_impl(&manifest_path("18-large-valid-glb")).unwrap();
        assert_eq!(&imported.glb_bytes[0..4], b"glTF");
    }

    /// An optional external reconstruction run must validate and import cleanly,
    /// with its recorded hashes matching the files on disk. The large corpus is
    /// intentionally not distributed with the source repository.
    #[test]
    fn reconstruction_set_imports_end_to_end() {
        let Ok(run_dir) = std::env::var("TRIASTASIS_RECON_RUN").map(PathBuf::from) else {
            eprintln!("TRIASTASIS_RECON_RUN not set; skipping external corpus");
            return;
        };
        if !run_dir.is_dir() {
            eprintln!("reconstruction run not present; skipping");
            return;
        }
        let mut imported_count = 0;
        for entry in std::fs::read_dir(&run_dir).unwrap().flatten() {
            let manifest = existing_manifest_in(&entry.path());
            if !manifest.is_file() {
                continue;
            }
            let preview = read_generation_manifest_impl(&manifest.to_string_lossy())
                .unwrap_or_else(|e| panic!("{}: {e}", entry.path().display()));
            assert!(
                !preview
                    .issues
                    .iter()
                    .any(|issue| issue.kind != "unsafePath"),
                "{}: unexpected issues {:?}",
                entry.path().display(),
                preview.issues
            );
            let imported = import_generation_manifest_impl(&manifest.to_string_lossy()).unwrap();
            assert_eq!(&imported.glb_bytes[0..4], b"glTF");
            assert!(!imported.image_bytes.is_empty());
            imported_count += 1;
        }
        assert_eq!(imported_count, 10, "expected exactly ten cases");

        // The CLI evidence run must import too, with its cutout/log artifacts
        // attached and hashed.
        let cli_dir = run_dir
            .parent()
            .unwrap_or(run_dir.as_path())
            .join("cli-evidence");
        if !cli_dir.is_dir() {
            eprintln!("cli-evidence run not present; skipping artifact assertions");
            return;
        }
        for entry in std::fs::read_dir(&cli_dir).unwrap().flatten() {
            let manifest = existing_manifest_in(&entry.path());
            if !manifest.is_file() {
                continue;
            }
            let preview = read_generation_manifest_impl(&manifest.to_string_lossy())
                .unwrap_or_else(|e| panic!("{}: {e}", entry.path().display()));
            assert!(
                preview.manifest.cutout.is_some(),
                "expected cutout attachment"
            );
            assert!(preview.manifest.log.is_some(), "expected log attachment");
            assert!(
                preview.manifest.files_entry("cutout").is_some()
                    && preview.manifest.files_entry("log").is_some(),
                "{}: artifact file entries missing",
                entry.path().display()
            );
            assert!(import_generation_manifest_impl(&manifest.to_string_lossy()).is_ok());
        }
    }
}
