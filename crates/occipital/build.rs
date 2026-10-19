mod vocabulary_build;

use std::fmt::Write;

fn main() {
    for path in [
        "build.rs",
        "vocabulary_build.rs",
        "Cargo.toml",
        "../../Cargo.lock",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let names = vocabulary_build::extract(&two_face::syntax::extra_newlines());
    let mut generated = format!(
        "pub const ASSET_REVISION: &str = {:?};\npub const ASSET_FINGERPRINT: &str = {:?};\npub const FINGERPRINT: &str = {:?};\npub const SCOPE_COUNT: usize = {};\nstatic NAMES: &[&str] = &[\n",
        vocabulary_build::ASSET_REVISION,
        vocabulary_build::asset_fingerprint(vocabulary_build::ASSET_REVISION),
        vocabulary_build::fingerprint(vocabulary_build::ASSET_REVISION, &names),
        names.len(),
    );
    for name in names {
        writeln!(generated, "{name:?},").unwrap();
    }
    generated.push_str("];\n");
    let path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("vocabulary.rs");
    std::fs::write(path, generated).unwrap();
}
