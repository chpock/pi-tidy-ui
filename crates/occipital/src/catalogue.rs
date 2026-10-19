//! Daemon-owned filesystem catalogue. Only startup/explicit refresh reads files;
//! source requests resolve opaque IDs from an immutable snapshot, never paths.
//!
//! Keep one Catalogue (and its non-resettable Admission) for the process lifetime.
//! Workers retain snapshot profiles only within their own in-flight/lease budgets.
use crate::{
    admission::{Admission, Counters, Limits},
    profile::{Profile, ASSETS},
};
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

// Derived from G1's 128KiB definition/64 lifetime attempt bounds and the engine's
// 16 installed-profile slots. These are fixed component limits, not JSON settings.
pub const MAX_CUSTOM_THEMES: usize = 16;
pub const MAX_THEME_BYTES: usize = 128 * 1024;
pub const MAX_CATALOGUE_BYTES: usize = MAX_CUSTOM_THEMES * MAX_THEME_BYTES;
pub const MAX_CONFIG_BYTES: usize = 16 * 1024;
pub const MAX_DIRECTORIES: usize = 8;
pub const MAX_DIRECTORY_ENTRIES: usize = 1024;
pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_LABEL_BYTES: usize = 128;

/// Source-free, constant-size diagnostics. Never expose OS errors, file contents,
/// selectors or filesystem paths in the public catalogue/control response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Diagnostic {
    RootUnavailable,
    ConfigRead,
    ConfigInvalid,
    ConfigLimit,
    DirectoryRead,
    EnumerationLimit,
    PathEscape,
    PathLimit,
    DuplicateId,
    ThemeRead,
    ThemeLimit,
    CatalogueLimit,
    ThemeAdmission,
    RevisionLimit,
}
impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::RootUnavailable => {
                "OS configuration root unavailable; bundled themes remain usable"
            }
            Self::ConfigRead => "theme configuration could not be read",
            Self::ConfigInvalid => "invalid theme configuration",
            Self::ConfigLimit => "theme configuration limit exceeded",
            Self::DirectoryRead => "configured theme directory could not be read",
            Self::EnumerationLimit => "theme directory enumeration limit exceeded",
            Self::PathEscape => "theme path escapes its configured root",
            Self::PathLimit => "theme path limit exceeded",
            Self::DuplicateId => "ambiguous duplicate theme identity",
            Self::ThemeRead => "theme definition could not be read",
            Self::ThemeLimit => "theme file limit exceeded",
            Self::CatalogueLimit => "theme catalogue limit exceeded",
            Self::ThemeAdmission => "theme definition admission failed",
            Self::RevisionLimit => "theme catalogue revision exhausted",
        })
    }
}
impl std::error::Error for Diagnostic {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Descriptor {
    pub id: String,
    pub label: String,
    pub fingerprint: String,
}
struct Entry {
    descriptor: Descriptor,
    // Bundled themes remain lazy through Profile::resolve's bounded native cache.
    profile: Option<Arc<Profile>>,
}
pub struct Snapshot {
    revision: u64,
    entries: BTreeMap<String, Entry>,
}
impl Snapshot {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn descriptors(&self) -> impl Iterator<Item = &Descriptor> {
        self.entries.values().map(|entry| &entry.descriptor)
    }
    /// Only admitted external definitions are published into workers. Bundled
    /// profiles remain lazy; metadata must not materialize every native theme.
    pub fn custom_profiles(&self) -> Vec<Arc<Profile>> {
        self.entries
            .values()
            .filter_map(|entry| entry.profile.clone())
            .collect()
    }
    /// No ID-to-path conversion. Returned Arcs share immutable theme definitions.
    pub fn profile(&self, id: &str) -> Option<Arc<Profile>> {
        let entry = self.entries.get(id)?;
        entry.profile.clone().or_else(|| Profile::resolve(id).ok())
    }
    fn bundled() -> Self {
        let mut entries = BTreeMap::new();
        for id in Profile::bundled_names() {
            let label = id[8..].to_owned();
            let fingerprint = format!("{:x}", Sha256::digest(format!("{ASSETS}:{id}").as_bytes()));
            entries.insert(
                id.clone(),
                Entry {
                    descriptor: Descriptor {
                        id,
                        label,
                        fingerprint,
                    },
                    profile: None,
                },
            );
        }
        Self {
            revision: 0,
            entries,
        }
    }
}

pub struct Catalogue {
    config: Option<PathBuf>,
    snapshot: Arc<Snapshot>,
    admission: Admission,
    diagnostic: Option<Diagnostic>,
    observed_default: bool,
    // Only failed admissions, at most one digest per charged lifetime attempt.
    // No successful retired-definition cache; dropping a Theme cannot undo interning.
    failed_definitions: HashSet<[u8; 32]>,
}
impl Catalogue {
    /// Explicit launch configuration may be relative; anchor it once at startup.
    /// With no override, use the platform resolver, never a cwd fallback.
    pub fn new(config: Option<PathBuf>) -> Self {
        match config {
            Some(config) => Self::load(Some(config)),
            None => Self::from_os_root(dirs::config_dir()),
        }
    }
    /// Platform-resolution seam: root is the OS config directory, before appending
    /// `occipital`. `None` deliberately leaves only the bundled baseline.
    pub fn from_os_root(root: Option<PathBuf>) -> Self {
        Self::load(
            root.filter(|root| root.is_absolute())
                .map(|root| root.join("occipital/config.json")),
        )
    }
    fn load(config: Option<PathBuf>) -> Self {
        let mut catalogue = Self {
            config,
            snapshot: Arc::new(Snapshot::bundled()),
            admission: Admission::new(Limits::default()),
            diagnostic: None,
            observed_default: false,
            failed_definitions: HashSet::new(),
        };
        let _ = catalogue.refresh();
        catalogue
    }
    pub fn config_path(&self) -> Option<&Path> {
        self.config.as_deref()
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.clone()
    }
    pub fn diagnostic(&self) -> Option<Diagnostic> {
        self.diagnostic
    }
    pub fn admission_counters(&self) -> Counters {
        self.admission.counters()
    }
    /// Transactional publication. A no-change refresh preserves Arc and revision;
    /// failures preserve the entire last-valid snapshot and cumulative gate charges.
    pub fn refresh(&mut self) -> Result<Arc<Snapshot>, Diagnostic> {
        let result = self.build();
        match result {
            Ok((candidate, observed)) => {
                self.observed_default |= observed;
                self.diagnostic = None;
                if !self.snapshot.descriptors().eq(candidate.descriptors()) {
                    let revision = self
                        .snapshot
                        .revision
                        .checked_add(1)
                        .ok_or(Diagnostic::RevisionLimit);
                    match revision {
                        Ok(revision) => {
                            self.snapshot = Arc::new(Snapshot {
                                revision,
                                ..candidate
                            })
                        }
                        Err(error) => {
                            self.diagnostic = Some(error);
                            return Err(error);
                        }
                    }
                }
                Ok(self.snapshot())
            }
            Err(error) => {
                self.diagnostic = Some(error);
                Err(error)
            }
        }
    }
    fn build(&mut self) -> Result<(Snapshot, bool), Diagnostic> {
        let config = self.config.as_ref().ok_or(Diagnostic::RootUnavailable)?;
        check_path(config)?;
        let absolute = std::path::absolute(config).map_err(|_| Diagnostic::ConfigRead)?;
        check_path(&absolute)?;
        // Freeze relative launch paths after the first lookup, even on failure.
        self.config = Some(absolute.clone());
        let parent = absolute.parent().ok_or(Diagnostic::ConfigRead)?;
        let bytes = match read_bounded(
            &absolute,
            MAX_CONFIG_BYTES,
            Diagnostic::ConfigRead,
            Diagnostic::ConfigLimit,
        ) {
            Ok(bytes) => Some(bytes),
            Err(ReadError::Missing) => None,
            Err(ReadError::Diagnostic(error)) => return Err(error),
        };
        if bytes.as_ref().is_some_and(|bytes| {
            bytes
                .iter()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace())
                != Some(b'{')
        }) {
            return Err(Diagnostic::ConfigInvalid);
        }
        let config: Config = bytes
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|_| Diagnostic::ConfigInvalid)?
            .unwrap_or_default();
        let default = config.theme_directories.is_none();
        let directories = config
            .theme_directories
            .map(|dirs| dirs.0)
            .unwrap_or_else(|| vec!["themes".to_owned()]);
        let mut roots = HashSet::new();
        let mut files = BTreeMap::new();
        let mut visited = 0usize;
        let mut observed = false;
        for directory in directories {
            let path = Path::new(&directory);
            check_path(path)?;
            if path.as_os_str().is_empty()
                || path.components().any(|c| matches!(c, Component::ParentDir))
            {
                return Err(Diagnostic::PathEscape);
            }
            let joined = parent.join(path);
            check_path(&joined)?;
            let root = match fs::canonicalize(&joined) {
                Ok(root) => root,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && default
                        && !self.observed_default
                        && fs::symlink_metadata(&joined)
                            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    continue
                }
                Err(_) => return Err(Diagnostic::DirectoryRead),
            };
            check_path(&root)?;
            if path.is_relative() {
                let base = fs::canonicalize(parent).map_err(|_| Diagnostic::DirectoryRead)?;
                if !root.starts_with(&base) {
                    return Err(Diagnostic::PathEscape);
                }
            }
            if !roots.insert(root.clone()) {
                return Err(Diagnostic::DuplicateId);
            }
            let entries = fs::read_dir(&root).map_err(|_| Diagnostic::DirectoryRead)?;
            observed |= default;
            for entry in entries {
                visited += 1;
                if visited > MAX_DIRECTORY_ENTRIES {
                    return Err(Diagnostic::EnumerationLimit);
                }
                let entry = entry.map_err(|_| Diagnostic::DirectoryRead)?;
                let file = entry.path();
                check_path(&file)?;
                if file
                    .extension()
                    .is_none_or(|extension| extension != "tmTheme")
                {
                    continue;
                }
                let kind = entry.file_type().map_err(|_| Diagnostic::ThemeRead)?;
                if kind.is_symlink() {
                    return Err(Diagnostic::PathEscape);
                }
                if !kind.is_file() {
                    if kind.is_dir() {
                        continue;
                    }
                    return Err(Diagnostic::ThemeRead);
                }
                let filename = entry.file_name();
                let filename = filename.to_str().ok_or(Diagnostic::PathLimit)?;
                let id = custom_id(&root, filename);
                if files.contains_key(&id) {
                    return Err(Diagnostic::DuplicateId);
                }
                if files.len() >= MAX_CUSTOM_THEMES {
                    return Err(Diagnostic::CatalogueLimit);
                }
                let label = bounded_label(
                    file.file_stem()
                        .and_then(|stem| stem.to_str())
                        .ok_or(Diagnostic::PathLimit)?,
                );
                files.insert(id, (file, label));
            }
        }
        // Bound the entire raw candidate before any plist parsing/interning. A
        // single read is capped even if the file grows after metadata inspection.
        let mut definitions = Vec::with_capacity(files.len());
        let mut bytes_used = 0usize;
        for (id, (file, label)) in files {
            let bytes = read_bounded(
                &file,
                MAX_THEME_BYTES,
                Diagnostic::ThemeRead,
                Diagnostic::ThemeLimit,
            )
            .map_err(|error| match error {
                ReadError::Missing => Diagnostic::ThemeRead,
                ReadError::Diagnostic(error) => error,
            })?;
            bytes_used = bytes_used
                .checked_add(bytes.len())
                .filter(|&total| total <= MAX_CATALOGUE_BYTES)
                .ok_or(Diagnostic::CatalogueLimit)?;
            definitions.push((id, label, bytes));
        }
        let mut candidate = Snapshot::bundled();
        for (id, label, bytes) in definitions {
            let hash = Sha256::digest(&bytes);
            let fingerprint = format!("{hash:x}");
            let digest: [u8; 32] = hash.into();
            let reused = self
                .snapshot
                .entries
                .get(&id)
                .filter(|entry| entry.descriptor.fingerprint == fingerprint)
                .and_then(|entry| entry.profile.clone());
            let profile = if let Some(profile) = reused {
                profile
            } else {
                if self.failed_definitions.contains(&digest) {
                    return Err(Diagnostic::ThemeAdmission);
                }
                let before = self.admission.counters().attempts;
                let admitted = self.admission.admit(&bytes).map(Arc::new);
                let theme = match admitted {
                    Ok(theme) => theme,
                    Err(_) => {
                        if self.admission.counters().attempts > before {
                            self.failed_definitions.insert(digest);
                        }
                        return Err(Diagnostic::ThemeAdmission);
                    }
                };
                Profile::native(id.clone(), fingerprint.clone(), theme)
                    .map_err(|_| Diagnostic::ThemeAdmission)?
            };
            candidate.entries.insert(
                id.clone(),
                Entry {
                    descriptor: Descriptor {
                        id,
                        label,
                        fingerprint,
                    },
                    profile: Some(profile),
                },
            );
        }
        Ok((candidate, observed))
    }
}
fn custom_id(root: &Path, filename: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"occipital-custom-v1\0");
    hash.update(root.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(filename.as_bytes());
    // 224-bit opaque identity: 7+56 bytes fits v1's 64-byte identity envelope.
    let hash = format!("{:x}", hash.finalize());
    format!("custom:{}", &hash[..56])
}
fn bounded_label(text: &str) -> String {
    let mut label = String::new();
    for ch in text.chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        if label.len() + ch.len_utf8() > MAX_LABEL_BYTES {
            break;
        }
        label.push(ch);
    }
    label
}
fn check_path(path: &Path) -> Result<(), Diagnostic> {
    if path.as_os_str().as_encoded_bytes().len() > MAX_PATH_BYTES {
        Err(Diagnostic::PathLimit)
    } else {
        Ok(())
    }
}
enum ReadError {
    Missing,
    Diagnostic(Diagnostic),
}
fn read_bounded(
    path: &Path,
    cap: usize,
    read: Diagnostic,
    limit: Diagnostic,
) -> Result<Vec<u8>, ReadError> {
    // Do not open directories/devices/FIFOs; opening a FIFO could block refresh.
    let kind = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadError::Missing
        } else {
            ReadError::Diagnostic(read)
        }
    })?;
    if !kind.is_file() {
        return Err(ReadError::Diagnostic(read));
    }
    let file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadError::Missing
        } else {
            ReadError::Diagnostic(read)
        }
    })?;
    let metadata = file.metadata().map_err(|_| ReadError::Diagnostic(read))?;
    if !metadata.is_file() {
        return Err(ReadError::Diagnostic(read));
    }
    if metadata.len() > cap as u64 {
        return Err(ReadError::Diagnostic(limit));
    }
    // Fixed allocation prevents read_to_end's geometric spare capacity from
    // exceeding the catalogue's raw-buffer bound when a file grows mid-read.
    let mut bytes = vec![0; cap + 1];
    let mut reader = file.take((cap + 1) as u64);
    let mut used = 0;
    while used < bytes.len() {
        let count = match reader.read(&mut bytes[used..]) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ReadError::Diagnostic(read)),
        };
        if count == 0 {
            break;
        }
        used += count;
    }
    if used > cap {
        return Err(ReadError::Diagnostic(limit));
    }
    bytes.truncate(used);
    Ok(bytes)
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default, deserialize_with = "present_directories")]
    theme_directories: Option<Directories>,
}
fn present_directories<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Directories>, D::Error> {
    Directories::deserialize(deserializer).map(Some)
}
struct Directories(Vec<String>);
impl<'de> Deserialize<'de> for Directories {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Bounded;
        impl<'de> Visitor<'de> for Bounded {
            type Value = Directories;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded theme-directory list")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut dirs = Vec::new();
                for _ in 0..MAX_DIRECTORIES {
                    let Some(dir) = seq.next_element::<String>()? else {
                        return Ok(Directories(dirs));
                    };
                    if dir.len() > MAX_PATH_BYTES {
                        return Err(de::Error::custom("theme-directory limit exceeded"));
                    }
                    dirs.push(dir);
                }
                // Check excess entries without allocating another String/tree.
                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom("theme-directory limit exceeded"));
                }
                Ok(Directories(dirs))
            }
        }
        deserializer.deserialize_seq(Bounded)
    }
}
