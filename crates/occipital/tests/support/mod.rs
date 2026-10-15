use std::{
    ffi::OsStr,
    fs,
    io::ErrorKind,
    ops::Deref,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

pub struct CaseDir(PathBuf);

impl CaseDir {
    pub fn new(label: &str) -> Self {
        let root =
            PathBuf::from(std::env::var_os("TIDY_TEST_ROOT").expect("TIDY_TEST_ROOT is required"));
        assert!(root.is_absolute(), "TIDY_TEST_ROOT must be absolute");
        let root = fs::canonicalize(root).expect("TIDY_TEST_ROOT must exist");
        assert!(root.is_dir(), "TIDY_TEST_ROOT must be a directory");
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = root.join(format!(
                "{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test case directory: {error}"),
            }
        }
    }

    pub fn command(&self, executable: impl AsRef<OsStr>) -> Command {
        let executable = Path::new(executable.as_ref());
        assert!(executable.is_absolute(), "test executable must be absolute");
        let mut command = Command::new(executable);
        command.env_clear().current_dir(&self.0);
        for (name, directory) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("APPDATA", "config"),
            ("LOCALAPPDATA", "data"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("TMPDIR", "tmp"),
            ("TMP", "tmp"),
            ("TEMP", "tmp"),
        ] {
            let path = self.0.join(directory);
            fs::create_dir_all(&path).unwrap();
            command.env(name, path);
        }
        command.env("TIDY_TEST_ROOT", &self.0);
        #[cfg(windows)]
        {
            let system_root = PathBuf::from(
                std::env::var_os("TIDY_TEST_SYSTEMROOT").expect("TIDY_TEST_SYSTEMROOT is required"),
            );
            assert!(system_root.is_absolute() && system_root.is_dir());
            command.env("SystemRoot", &system_root);
            command.env("TIDY_TEST_SYSTEMROOT", system_root);
        }
        command
    }
}

impl Deref for CaseDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for CaseDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for CaseDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
