use std::{fs, path::Path, process::Command};

use dashboardd_widget_bundle::{check_bundle, pack, read_source_manifest};
use tempfile::TempDir;

#[test]
fn packs_and_checks_a_standalone_bundle() {
    let fixture = Fixture::new();
    let output = fixture.root.path().join("output/example");

    let checked = pack(&fixture.manifest, &output).unwrap();

    assert_eq!(checked.manifest.id, "example");
    assert_eq!(checked.manifest.backend, Path::new("bin/example"));
    assert_eq!(
        checked.manifest.variants[0].frontend,
        Path::new("frontend/summary.js")
    );
    assert_eq!(
        checked.manifest.variants[0].launch_frontend.as_deref(),
        Some(Path::new("frontend/summary-launch.js"))
    );
    assert_eq!(
        fs::read_to_string(&checked.backend).unwrap(),
        "#!/bin/sh\nexit 0\n"
    );
    check_bundle(&output).unwrap();
}

#[test]
fn command_runs_outside_the_dashboardd_repository() {
    let fixture = Fixture::new();
    let output = fixture.root.path().join("example");
    let binary = env!("CARGO_BIN_EXE_dashboardd-widget");

    let pack_status = Command::new(binary)
        .args(["pack", fixture.manifest.to_str().unwrap(), "--output"])
        .arg(&output)
        .current_dir(fixture.root.path())
        .status()
        .unwrap();
    assert!(pack_status.success());
    let check_status = Command::new(binary)
        .args(["check"])
        .arg(&output)
        .current_dir(fixture.root.path())
        .status()
        .unwrap();
    assert!(check_status.success());
}

#[test]
fn produces_deterministic_bundle_contents() {
    let fixture = Fixture::new();
    let first = fixture.root.path().join("first/example");
    let second = fixture.root.path().join("second/example");

    pack(&fixture.manifest, &first).unwrap();
    pack(&fixture.manifest, &second).unwrap();

    for relative in [
        "widget.json",
        "bin/example",
        "frontend/summary.js",
        "frontend/summary-launch.js",
    ] {
        assert_eq!(
            fs::read(first.join(relative)).unwrap(),
            fs::read(second.join(relative)).unwrap()
        );
        assert_eq!(
            fs::metadata(first.join(relative)).unwrap().permissions(),
            fs::metadata(second.join(relative)).unwrap().permissions()
        );
    }
}

#[test]
fn refuses_existing_output() {
    let fixture = Fixture::new();
    let output = fixture.root.path().join("example");
    fs::create_dir(&output).unwrap();

    let error = pack(&fixture.manifest, &output).unwrap_err();

    assert!(error.to_string().contains("output already exists"));
}

#[test]
fn rejects_source_traversal_and_unknown_fields() {
    let fixture = Fixture::new();
    let source = fs::read_to_string(&fixture.manifest).unwrap();
    fs::write(
        &fixture.manifest,
        source.replace("backend = \"dist/backend\"", "backend = \"../backend\""),
    )
    .unwrap();
    assert!(
        read_source_manifest(&fixture.manifest)
            .unwrap_err()
            .to_string()
            .contains("relative path")
    );

    let fixture = Fixture::new();
    fs::write(
        &fixture.manifest,
        format!(
            "{}\nunknown = true\n",
            fs::read_to_string(&fixture.manifest).unwrap()
        ),
    )
    .unwrap();
    assert!(
        read_source_manifest(&fixture.manifest)
            .unwrap_err()
            .to_string()
            .contains("unknown field")
    );
}

#[test]
fn rejects_runtime_traversal_and_missing_artifacts() {
    let fixture = Fixture::new();
    let output = fixture.root.path().join("example");
    pack(&fixture.manifest, &output).unwrap();
    let manifest = output.join("widget.json");
    let source = fs::read_to_string(&manifest).unwrap();
    fs::write(
        &manifest,
        source.replace("\"bin/example\"", "\"../example\""),
    )
    .unwrap();
    assert!(
        check_bundle(&output)
            .unwrap_err()
            .to_string()
            .contains("relative path")
    );

    fs::write(&manifest, source).unwrap();
    fs::remove_file(output.join("frontend/summary.js")).unwrap();
    assert!(
        check_bundle(&output)
            .unwrap_err()
            .to_string()
            .contains("declared frontend must exist")
    );
}

#[test]
fn rejects_bundle_name_mismatch_and_non_executable_backend() {
    let fixture = Fixture::new();
    let output = fixture.root.path().join("example");
    pack(&fixture.manifest, &output).unwrap();
    let renamed = fixture.root.path().join("other");
    fs::rename(&output, &renamed).unwrap();
    assert!(
        check_bundle(&renamed)
            .unwrap_err()
            .to_string()
            .contains("directory name")
    );

    fs::rename(&renamed, &output).unwrap();
    set_executable(&output.join("bin/example"), false);
    assert!(
        check_bundle(&output)
            .unwrap_err()
            .to_string()
            .contains("not executable")
    );
}

struct Fixture {
    root: TempDir,
    manifest: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir_all(project.join("dist")).unwrap();
        fs::write(project.join("dist/backend"), "#!/bin/sh\nexit 0\n").unwrap();
        set_executable(&project.join("dist/backend"), true);
        fs::write(
            project.join("dist/summary.js"),
            "export function mount() {}\n",
        )
        .unwrap();
        fs::write(
            project.join("dist/summary-launch.js"),
            "export function mount() {}\n",
        )
        .unwrap();
        let manifest = project.join("widget.toml");
        fs::write(
            &manifest,
            r#"schema_version = 3
id = "example"
name = "Example"
description = "External widget fixture"
backend = "dist/backend"

[[variants]]
id = "summary"
name = "Summary"
width = 3
height = 2
frontend = "dist/summary.js"
launch_frontend = "dist/summary-launch.js"
focus = false
"#,
        )
        .unwrap();
        Self { root, manifest }
    }
}

#[cfg(unix)]
fn set_executable(path: &Path, executable: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(not(unix))]
fn set_executable(_path: &Path, _executable: bool) {}
