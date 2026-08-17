use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() -> Result<(), Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask is in the repository root");
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("widget")
        || args.get(1).map(String::as_str) != Some("prepare")
    {
        return Err(usage().into());
    }

    let all = args.iter().any(|arg| arg == "--all");
    let release = args.iter().any(|arg| arg == "--release");
    let names = args[2..]
        .iter()
        .filter(|arg| !arg.starts_with("--"))
        .cloned()
        .collect::<Vec<_>>();
    if all == (names.len() == 1)
        || args
            .iter()
            .any(|arg| arg.starts_with("--") && arg != "--all" && arg != "--release")
    {
        return Err(usage().into());
    }

    let directories = if all {
        source_widget_directories(root)?
    } else {
        vec![root.join("widgets").join(&names[0])]
    };
    for directory in directories {
        prepare(root, &directory, release)?;
    }
    Ok(())
}

fn prepare(root: &Path, widget_directory: &Path, release: bool) -> Result<(), Box<dyn Error>> {
    let manifest_path = widget_directory.join("widget.toml");
    let manifest = dashboardd_widget::read_source_manifest(&manifest_path)?;
    if widget_directory.file_name().and_then(|name| name.to_str()) != Some(&manifest.id) {
        return Err("widget id must match its repository directory".into());
    }

    let mut cargo = Command::new("cargo");
    cargo.args(["build", "-p", &manifest.id]);
    if release {
        cargo.arg("--release");
    }
    run(root, &mut cargo)?;

    let frontend_package = frontend_package_name(widget_directory)?;
    run(
        root,
        Command::new("npm").args(["run", "build", "-w", &frontend_package]),
    )?;

    let profile = if release { "release" } else { "debug" };
    let backend = root.join("target").join(profile).join(format!(
        "{}{}",
        manifest.id,
        env::consts::EXE_SUFFIX
    ));
    if !backend.is_file() {
        return Err(format!("backend build did not produce {}", backend.display()).into());
    }
    let staged_backend = widget_directory.join(&manifest.backend);
    fs::create_dir_all(
        staged_backend
            .parent()
            .expect("backend artifact has a parent directory"),
    )?;
    fs::copy(&backend, &staged_backend)?;

    let output = root.join(".build/widgets").join(&manifest.id);
    if output.exists() {
        fs::remove_dir_all(&output)?;
    }
    let checked = dashboardd_widget::pack(&manifest_path, &output)?;
    println!(
        "prepared {} in {}",
        checked.manifest.id,
        checked.directory.display()
    );
    Ok(())
}

fn frontend_package_name(widget_directory: &Path) -> Result<String, Box<dyn Error>> {
    let path = widget_directory.join("frontend/package.json");
    let source = fs::read_to_string(&path)?;
    let package: serde_json::Value = serde_json::from_str(&source)?;
    package["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("frontend package has no name: {}", path.display()).into())
}

fn source_widget_directories(root: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut directories = fs::read_dir(root.join("widgets"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("widget.toml").is_file())
        .collect::<Vec<_>>();
    directories.sort();
    Ok(directories)
}

fn run(root: &Path, command: &mut Command) -> Result<(), Box<dyn Error>> {
    let display = format!("{command:?}");
    let status = command.current_dir(root).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("command failed: {display}").into())
    }
}

fn usage() -> &'static str {
    "usage: cargo xtask widget prepare (--all | <widget-id>) [--release]"
}
