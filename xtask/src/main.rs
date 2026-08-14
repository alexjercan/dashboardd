use std::{
    collections::HashSet,
    env,
    error::Error,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct SourceManifest {
    schema_version: u32,
    id: String,
    name: String,
    description: String,
    backend: BackendSource,
    frontend: FrontendSource,
    #[serde(default)]
    options: Vec<OptionSource>,
    #[serde(default)]
    links: LinksSource,
}

#[derive(Debug, Default, Deserialize)]
struct LinksSource {
    #[serde(default)]
    inputs: Vec<LinkPortSource>,
    #[serde(default)]
    outputs: Vec<LinkPortSource>,
}

#[derive(Debug, Deserialize, Serialize)]
struct LinkPortSource {
    id: String,
    name: String,
    #[serde(rename = "type")]
    link_type: String,
    #[serde(default)]
    variants: Vec<String>,
    #[serde(default)]
    required: bool,
}

#[derive(Debug, Deserialize)]
struct BackendSource {
    package: String,
}

#[derive(Debug, Deserialize)]
struct FrontendSource {
    workspace: String,
    variants: Vec<VariantSource>,
}

#[derive(Debug, Deserialize)]
struct VariantSource {
    id: String,
    name: String,
    size: [u32; 2],
    entry: PathBuf,
    #[serde(default)]
    focus: bool,
}

#[derive(Debug, Deserialize)]
struct OptionSource {
    id: String,
    name: String,
    description: String,
    #[serde(default)]
    variants: Vec<String>,
    default: serde_json::Value,
    #[serde(flatten)]
    kind: OptionKindSource,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OptionKindSource {
    Boolean {
        #[serde(rename = "boolean")]
        _boolean: EmptyTable,
    },
    Text {
        #[serde(rename = "text")]
        _text: EmptyTable,
    },
    Integer {
        integer: IntegerOptionSource,
    },
    Select {
        select: SelectOptionSource,
    },
}

#[derive(Debug, Deserialize)]
struct EmptyTable {}

#[derive(Debug, Deserialize)]
struct IntegerOptionSource {
    minimum: i64,
    maximum: i64,
    step: u64,
}

#[derive(Debug, Deserialize)]
struct SelectOptionSource {
    choices: Vec<OptionChoiceSource>,
}

#[derive(Debug, Deserialize, Serialize)]
struct OptionChoiceSource {
    value: String,
    name: String,
}

#[derive(Serialize)]
struct RuntimeManifest<'a> {
    schema_version: u32,
    id: &'a str,
    name: &'a str,
    description: &'a str,
    backend: String,
    variants: Vec<RuntimeVariant<'a>>,
    options: Vec<RuntimeOption<'a>>,
    inputs: &'a [LinkPortSource],
    outputs: &'a [LinkPortSource],
}

#[derive(Serialize)]
struct RuntimeVariant<'a> {
    id: &'a str,
    name: &'a str,
    width: u32,
    height: u32,
    frontend: String,
    focus: bool,
}

#[derive(Serialize)]
struct RuntimeOption<'a> {
    id: &'a str,
    name: &'a str,
    description: &'a str,
    variants: &'a [String],
    default: &'a serde_json::Value,
    #[serde(flatten)]
    kind: RuntimeOptionKind<'a>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RuntimeOptionKind<'a> {
    Boolean,
    Text,
    Integer {
        minimum: i64,
        maximum: i64,
        step: u64,
    },
    Select {
        choices: &'a [OptionChoiceSource],
    },
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
    let backend = root
        .join("target")
        .join(profile)
        .join(&manifest.backend.package);
    require_file(
        &backend,
        "backend build did not produce the declared package",
    )?;

    let output = root.join(".build/widgets").join(&manifest.id);
    if output.exists() {
        fs::remove_dir_all(&output)?;
    }
    fs::create_dir_all(output.join("bin"))?;
    fs::create_dir_all(output.join("frontend"))?;
    install(&backend, &output.join("bin").join(&manifest.id), mode)?;

    let mut variants = Vec::new();
    for variant in &manifest.frontend.variants {
        let frontend = widget_directory
            .join("frontend/dist")
            .join(format!("{}.js", variant.id));
        require_file(&frontend, "frontend build did not produce variant bundle")?;
        let relative = format!("frontend/{}.js", variant.id);
        install(&frontend, &output.join(&relative), mode)?;
        variants.push(RuntimeVariant {
            id: &variant.id,
            name: &variant.name,
            width: variant.size[0],
            height: variant.size[1],
            frontend: relative,
            focus: variant.focus,
        });
    }

    let options = manifest
        .options
        .iter()
        .map(|option| RuntimeOption {
            id: &option.id,
            name: &option.name,
            description: &option.description,
            variants: &option.variants,
            default: &option.default,
            kind: match &option.kind {
                OptionKindSource::Boolean { .. } => RuntimeOptionKind::Boolean,
                OptionKindSource::Text { .. } => RuntimeOptionKind::Text,
                OptionKindSource::Integer { integer } => RuntimeOptionKind::Integer {
                    minimum: integer.minimum,
                    maximum: integer.maximum,
                    step: integer.step,
                },
                OptionKindSource::Select { select } => RuntimeOptionKind::Select {
                    choices: &select.choices,
                },
            },
        })
        .collect();
    let runtime = RuntimeManifest {
        schema_version: 2,
        id: &manifest.id,
        name: &manifest.name,
        description: &manifest.description,
        backend: format!("bin/{}", manifest.id),
        variants,
        options,
        inputs: &manifest.links.inputs,
        outputs: &manifest.links.outputs,
    };
    fs::write(
        output.join("widget.json"),
        format!("{}\n", serde_json::to_string_pretty(&runtime)?),
    )?;
    require_file(&output.join(&runtime.backend), "runtime backend is missing")?;
    for variant in &runtime.variants {
        require_file(
            &output.join(&variant.frontend),
            "runtime frontend is missing",
        )?;
    }
    println!("prepared {} in {}", manifest.id, output.display());
    Ok(())
}

fn validate_manifest(
    root: &Path,
    widget_directory: &Path,
    manifest: &SourceManifest,
) -> Result<(), Box<dyn Error>> {
    if manifest.schema_version != 1 {
        return Err("source widget schema_version must be 1".into());
    }
    if !valid_name(&manifest.id) {
        return Err("widget id must contain lowercase ASCII letters, digits, or hyphens".into());
    }
    if widget_directory.file_name().and_then(|name| name.to_str()) != Some(&manifest.id) {
        return Err("widget id must match its source directory".into());
    }
    if manifest.name.trim().is_empty()
        || manifest.description.trim().is_empty()
        || !valid_name(&manifest.backend.package)
    {
        return Err("widget name and backend package must be valid".into());
    }
    if !manifest.frontend.workspace.starts_with("@scufris/") {
        return Err("frontend workspace must use the @scufris scope".into());
    }
    if manifest.frontend.variants.is_empty() {
        return Err("frontend must declare at least one variant".into());
    }
    let mut variant_ids = HashSet::new();
    for variant in &manifest.frontend.variants {
        if !valid_name(&variant.id)
            || !variant_ids.insert(&variant.id)
            || variant.name.trim().is_empty()
            || variant.size[0] == 0
            || variant.size[1] == 0
        {
            return Err("variants must have unique valid IDs, names, and positive sizes".into());
        }
        if variant.entry.is_absolute()
            || variant
                .entry
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("frontend entry must stay inside the frontend workspace".into());
        }
        require_file(
            &widget_directory.join("frontend").join(&variant.entry),
            "frontend entry does not exist",
        )?;
    }
    let mut option_ids = HashSet::new();
    for option in &manifest.options {
        if !valid_option_id(&option.id)
            || !option_ids.insert(&option.id)
            || option.name.trim().is_empty()
            || option.description.trim().is_empty()
            || option
                .variants
                .iter()
                .any(|variant| !variant_ids.contains(variant))
        {
            return Err(
                "options require unique valid IDs, names, descriptions, and known variants".into(),
            );
        }
        match &option.kind {
            OptionKindSource::Boolean { .. } if !option.default.is_boolean() => {
                return Err(format!("option {} requires a Boolean default", option.id).into());
            }
            OptionKindSource::Text { .. } if !option.default.is_string() => {
                return Err(format!("option {} requires a text default", option.id).into());
            }
            OptionKindSource::Integer { integer } => {
                let Some(default) = option.default.as_i64() else {
                    return Err(format!("option {} requires an integer default", option.id).into());
                };
                if integer.minimum > integer.maximum
                    || integer.step == 0
                    || default < integer.minimum
                    || default > integer.maximum
                    || !((i128::from(default) - i128::from(integer.minimum)) as u128)
                        .is_multiple_of(u128::from(integer.step))
                {
                    return Err(format!(
                        "option {} has invalid integer constraints or default",
                        option.id
                    )
                    .into());
                }
            }
            OptionKindSource::Select { select } => {
                let Some(default) = option.default.as_str() else {
                    return Err(format!("option {} requires a string default", option.id).into());
                };
                let mut values = HashSet::new();
                if select.choices.is_empty()
                    || select.choices.iter().any(|choice| {
                        choice.value.is_empty()
                            || choice.name.trim().is_empty()
                            || !values.insert(choice.value.as_str())
                    })
                    || !values.contains(default)
                {
                    return Err(
                        format!("option {} has invalid choices or default", option.id).into(),
                    );
                }
            }
            _ => {}
        }
    }

    let mut port_ids = HashSet::new();
    for port in manifest
        .links
        .inputs
        .iter()
        .chain(manifest.links.outputs.iter())
    {
        if !valid_option_id(&port.id)
            || !port_ids.insert(&port.id)
            || port.name.trim().is_empty()
            || port.link_type.trim().is_empty()
            || port
                .variants
                .iter()
                .any(|variant| !variant_ids.contains(variant))
        {
            return Err(
                "link ports require unique valid IDs, names, types, and known variants".into(),
            );
        }
    }

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

fn valid_option_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && !value.starts_with('_')
        && !value.ends_with('_')
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
    "usage: cargo xtask widget prepare (--all | <widget-id>) [--copy] [--release]"
}
