use std::{
    env,
    error::Error,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct SourceManifest {
    id: String,
    name: String,
    backend: BackendSource,
    frontend: FrontendSource,
}

#[derive(Debug, Deserialize)]
struct BackendSource {
    package: String,
}

#[derive(Debug, Deserialize)]
struct FrontendSource {
    workspace: String,
    entry: PathBuf,
}

#[derive(Serialize)]
struct RuntimeManifest<'a> {
    schema_version: u32,
    id: &'a str,
    name: &'a str,
    backend: String,
    frontend: String,
}

#[derive(Clone, Copy)]
enum ArtifactMode {
    Link,
    Copy,
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask is in the repository root");
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("widget")
        || args.get(1).map(String::as_str) != Some("prepare")
    {
        return Err(usage().into());
    }

    let all = args.iter().any(|arg| arg == "--all");
    let mode = if args.iter().any(|arg| arg == "--copy") {
        ArtifactMode::Copy
    } else {
        ArtifactMode::Link
    };
    let release = args.iter().any(|arg| arg == "--release");
    let names: Vec<_> = args[2..]
        .iter()
        .filter(|arg| !arg.starts_with("--"))
        .cloned()
        .collect();
    if all == (names.len() == 1) {
        return Err(usage().into());
    }

    let widget_directories = if all {
        source_widget_directories(root)?
    } else {
        vec![root.join("widgets").join(&names[0])]
    };
    for directory in widget_directories {
        prepare(root, &directory, mode, release)?;
    }
    Ok(())
}

fn prepare(
    root: &Path,
    widget_directory: &Path,
    mode: ArtifactMode,
    release: bool,
) -> Result<(), Box<dyn Error>> {
    let source = fs::read_to_string(widget_directory.join("widget.toml"))?;
    let manifest: SourceManifest = toml::from_str(&source)?;
    validate_manifest(root, widget_directory, &manifest)?;

    let mut cargo = Command::new("cargo");
    cargo.args(["build", "-p", &manifest.backend.package]);
    if release {
        cargo.arg("--release");
    }
    run(root, &mut cargo)?;

    run(
        root,
        Command::new("npm").args(["run", "build", "-w", &manifest.frontend.workspace]),
    )?;

    let profile = if release { "release" } else { "debug" };
    let backend_name = manifest.backend.package.replace('-', "_");
    let backend = root.join("target").join(profile).join(backend_name);
    let frontend = widget_directory.join("frontend/dist/frontend.js");
    require_file(
        &backend,
        "backend build did not produce the declared package",
    )?;
    require_file(&frontend, "frontend build did not produce frontend.js")?;

    let output = root.join(".build/widgets").join(&manifest.id);
    fs::create_dir_all(output.join("bin"))?;
    fs::create_dir_all(output.join("frontend"))?;
    install(&backend, &output.join("bin").join(&manifest.id), mode)?;
    install(&frontend, &output.join("frontend/frontend.js"), mode)?;

    let runtime = RuntimeManifest {
        schema_version: 1,
        id: &manifest.id,
        name: &manifest.name,
        backend: format!("bin/{}", manifest.id),
        frontend: "frontend/frontend.js".into(),
    };
    fs::write(
        output.join("widget.json"),
        format!("{}\n", serde_json::to_string_pretty(&runtime)?),
    )?;
    require_file(&output.join(runtime.backend), "runtime backend is missing")?;
    require_file(
        &output.join(runtime.frontend),
        "runtime frontend is missing",
    )?;
    println!("prepared {} in {}", manifest.id, output.display());
    Ok(())
}

fn validate_manifest(
    root: &Path,
    widget_directory: &Path,
    manifest: &SourceManifest,
) -> Result<(), Box<dyn Error>> {
    if !valid_name(&manifest.id) {
        return Err("widget id must contain lowercase ASCII letters, digits, or hyphens".into());
    }
    if widget_directory.file_name().and_then(|name| name.to_str()) != Some(&manifest.id) {
        return Err("widget id must match its source directory".into());
    }
    if manifest.name.trim().is_empty() || !valid_name(&manifest.backend.package) {
        return Err("widget name and backend package must be valid".into());
    }
    if !manifest.frontend.workspace.starts_with("@scufris/") {
        return Err("frontend workspace must use the @scufris scope".into());
    }
    if manifest.frontend.entry.is_absolute()
        || manifest
            .frontend
            .entry
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("frontend entry must stay inside the frontend workspace".into());
    }
    require_file(
        &widget_directory
            .join("frontend")
            .join(&manifest.frontend.entry),
        "frontend entry does not exist",
    )?;

    let package_source = fs::read_to_string(widget_directory.join("frontend/package.json"))?;
    let package: serde_json::Value = serde_json::from_str(&package_source)?;
    if package["name"] != manifest.frontend.workspace {
        return Err("frontend workspace does not match frontend/package.json".into());
    }
    let cargo_source = fs::read_to_string(widget_directory.join("Cargo.toml"))?;
    let cargo: toml::Value = toml::from_str(&cargo_source)?;
    if cargo["package"]["name"].as_str() != Some(&manifest.backend.package) {
        return Err("backend package does not match Cargo.toml".into());
    }
    if !root.join("package.json").is_file() {
        return Err("root npm workspace is missing".into());
    }
    Ok(())
}

fn source_widget_directories(root: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut directories = fs::read_dir(root.join("widgets"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("widget.toml").is_file())
        .collect::<Vec<_>>();
    directories.sort();
    Ok(directories)
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn run(root: &Path, command: &mut Command) -> Result<(), Box<dyn Error>> {
    let display = format!("{command:?}");
    let status = command.current_dir(root).status()?;
    if !status.success() {
        return Err(format!("command failed: {display}").into());
    }
    Ok(())
}

fn install(source: &Path, destination: &Path, mode: ArtifactMode) -> Result<(), Box<dyn Error>> {
    if destination.symlink_metadata().is_ok() {
        fs::remove_file(destination)?;
    }
    match mode {
        ArtifactMode::Copy => {
            fs::copy(source, destination)?;
        }
        ArtifactMode::Link => {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::canonicalize(source)?, destination)?;
            #[cfg(not(unix))]
            fs::copy(source, destination)?;
        }
    }
    Ok(())
}

fn require_file(path: &Path, message: &str) -> Result<(), Box<dyn Error>> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("{message}: {}", path.display()).into())
    }
}

fn usage() -> &'static str {
    "usage: cargo xtask widget prepare <id>|--all [--copy] [--release]"
}
