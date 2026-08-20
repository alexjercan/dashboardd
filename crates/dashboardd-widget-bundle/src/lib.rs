use std::{
    collections::HashSet,
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const SOURCE_SCHEMA_VERSION: u32 = 3;
pub const RUNTIME_SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Error)]
pub enum WidgetPackageError {
    #[error("{0}")]
    Invalid(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    #[error("invalid JSON in {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid TOML in {path}: {source}")]
    Toml {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub backend: PathBuf,
    pub variants: Vec<SourceVariant>,
    #[serde(default)]
    pub options: Vec<WidgetOption>,
    #[serde(default)]
    pub inputs: Vec<WidgetLinkPort>,
    #[serde(default)]
    pub outputs: Vec<WidgetLinkPort>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceVariant {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frontend: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_frontend: Option<PathBuf>,
    #[serde(default)]
    pub focus: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub backend: PathBuf,
    pub variants: Vec<RuntimeVariant>,
    pub options: Vec<WidgetOption>,
    pub inputs: Vec<WidgetLinkPort>,
    pub outputs: Vec<WidgetLinkPort>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeVariant {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frontend: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_frontend: Option<PathBuf>,
    pub focus: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetLinkPort {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub link_type: String,
    pub variants: Vec<String>,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub variants: Vec<String>,
    pub default: Value,
    #[serde(flatten)]
    pub kind: WidgetOptionKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WidgetOptionKind {
    Boolean,
    Text {
        multiline: bool,
    },
    Integer {
        minimum: i64,
        maximum: i64,
        step: u64,
    },
    Select {
        choices: Vec<WidgetOptionChoice>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetOptionChoice {
    pub value: String,
    pub name: String,
}

#[derive(Debug)]
pub struct CheckedBundle {
    pub directory: PathBuf,
    pub manifest: RuntimeManifest,
    pub backend: PathBuf,
    pub frontends: Vec<PathBuf>,
    pub launch_frontends: Vec<Option<PathBuf>>,
}

pub fn read_source_manifest(path: &Path) -> Result<SourceManifest, WidgetPackageError> {
    let source = read_to_string(path)?;
    let mut ignored = Vec::new();
    let deserializer =
        toml::Deserializer::parse(&source).map_err(|source| WidgetPackageError::Toml {
            path: path.to_path_buf(),
            source,
        })?;
    let manifest: SourceManifest =
        serde_ignored::deserialize(deserializer, |field| ignored.push(field.to_string())).map_err(
            |source| WidgetPackageError::Toml {
                path: path.to_path_buf(),
                source,
            },
        )?;
    reject_ignored(path, ignored)?;
    validate_source_manifest(path, &manifest)?;
    Ok(manifest)
}

pub fn check_bundle(directory: &Path) -> Result<CheckedBundle, WidgetPackageError> {
    check_bundle_at(directory, true)
}

fn check_bundle_at(
    directory: &Path,
    require_matching_directory: bool,
) -> Result<CheckedBundle, WidgetPackageError> {
    if !directory.is_dir() {
        return Err(invalid(format!(
            "widget bundle is not a directory: {}",
            directory.display()
        )));
    }
    let manifest_path = directory.join("widget.json");
    let source = read_to_string(&manifest_path)?;
    let mut ignored = Vec::new();
    let mut deserializer = serde_json::Deserializer::from_str(&source);
    let manifest: RuntimeManifest = serde_ignored::deserialize(&mut deserializer, |field| {
        ignored.push(field.to_string());
    })
    .map_err(|source| WidgetPackageError::Json {
        path: manifest_path.clone(),
        source,
    })?;
    reject_ignored(&manifest_path, ignored)?;
    validate_runtime_manifest(&manifest_path, &manifest)?;

    if require_matching_directory
        && directory.file_name().and_then(|name| name.to_str()) != Some(&manifest.id)
    {
        return Err(invalid(format!(
            "bundle directory name must match widget id {:?}",
            manifest.id
        )));
    }

    let backend = directory.join(&manifest.backend);
    require_readable_file(&backend, "declared backend")?;
    require_executable(&backend)?;
    let frontends = manifest
        .variants
        .iter()
        .map(|variant| {
            let frontend = directory.join(&variant.frontend);
            require_readable_file(&frontend, "declared frontend")?;
            Ok(frontend)
        })
        .collect::<Result<Vec<_>, WidgetPackageError>>()?;

    let launch_frontends = manifest
        .variants
        .iter()
        .map(|variant| {
            variant
                .launch_frontend
                .as_ref()
                .map(|path| {
                    let frontend = directory.join(path);
                    require_readable_file(&frontend, "declared launch frontend")?;
                    Ok(frontend)
                })
                .transpose()
        })
        .collect::<Result<Vec<_>, WidgetPackageError>>()?;

    Ok(CheckedBundle {
        directory: directory.to_path_buf(),
        manifest,
        backend,
        frontends,
        launch_frontends,
    })
}

pub fn pack(manifest_path: &Path, output: &Path) -> Result<CheckedBundle, WidgetPackageError> {
    if output.exists() {
        return Err(invalid(format!(
            "output already exists: {}",
            output.display()
        )));
    }
    let source = read_source_manifest(manifest_path)?;
    if output.file_name().and_then(|name| name.to_str()) != Some(&source.id) {
        return Err(invalid(format!(
            "output directory name must match widget id {:?}",
            source.id
        )));
    }
    let source_directory = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let backend_source = source_directory.join(&source.backend);
    require_readable_file(&backend_source, "backend artifact")?;
    require_executable(&backend_source)?;
    for variant in &source.variants {
        require_readable_file(
            &source_directory.join(&variant.frontend),
            "frontend artifact",
        )?;
        if let Some(frontend) = &variant.launch_frontend {
            require_readable_file(&source_directory.join(frontend), "launch frontend artifact")?;
        }
    }

    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| io_error("create output parent", source))?;
    let staging = staging_directory(output);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|source| io_error("remove stale staging", source))?;
    }

    let result = pack_into(&source, source_directory, &staging)
        .and_then(|()| check_bundle_at(&staging, false))
        .and_then(|_| {
            fs::rename(&staging, output)
                .map_err(|source| io_error("install widget bundle", source))?;
            check_bundle(output)
        });
    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn pack_into(
    source: &SourceManifest,
    source_directory: &Path,
    output: &Path,
) -> Result<(), WidgetPackageError> {
    fs::create_dir_all(output.join("bin"))
        .and_then(|()| fs::create_dir_all(output.join("frontend")))
        .map_err(|source| io_error("create widget bundle", source))?;

    let backend = PathBuf::from("bin").join(&source.id);
    copy_file(
        &source_directory.join(&source.backend),
        &output.join(&backend),
        true,
    )?;
    let variants = source
        .variants
        .iter()
        .map(|variant| {
            let frontend = PathBuf::from("frontend").join(format!("{}.js", variant.id));
            copy_file(
                &source_directory.join(&variant.frontend),
                &output.join(&frontend),
                false,
            )?;
            let launch_frontend = variant
                .launch_frontend
                .as_ref()
                .map(|source| {
                    let target =
                        PathBuf::from("frontend").join(format!("{}-launch.js", variant.id));
                    copy_file(&source_directory.join(source), &output.join(&target), false)?;
                    Ok(target)
                })
                .transpose()?;
            Ok(RuntimeVariant {
                id: variant.id.clone(),
                name: variant.name.clone(),
                width: variant.width,
                height: variant.height,
                frontend,
                launch_frontend,
                focus: variant.focus,
            })
        })
        .collect::<Result<Vec<_>, WidgetPackageError>>()?;
    let manifest = RuntimeManifest {
        schema_version: RUNTIME_SCHEMA_VERSION,
        id: source.id.clone(),
        name: source.name.clone(),
        description: source.description.clone(),
        backend,
        variants,
        options: source.options.clone(),
        inputs: source.inputs.clone(),
        outputs: source.outputs.clone(),
    };
    let encoded = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).expect("runtime manifest is serializable")
    );
    fs::write(output.join("widget.json"), encoded)
        .map_err(|source| io_error("write runtime manifest", source))?;
    set_file_mode(&output.join("widget.json"), false)?;
    Ok(())
}

fn validate_source_manifest(
    path: &Path,
    manifest: &SourceManifest,
) -> Result<(), WidgetPackageError> {
    if manifest.schema_version != SOURCE_SCHEMA_VERSION {
        return Err(invalid_manifest(path, "unsupported schema_version"));
    }
    validate_metadata(
        ManifestMetadata::source(path, manifest),
        manifest.variants.iter().map(|variant| VariantMetadata {
            id: &variant.id,
            name: &variant.name,
            width: variant.width,
            height: variant.height,
        }),
    )?;
    validate_relative_path(path, "backend", &manifest.backend)?;
    for variant in &manifest.variants {
        validate_relative_path(path, "frontend", &variant.frontend)?;
        if let Some(frontend) = &variant.launch_frontend {
            validate_relative_path(path, "launch_frontend", frontend)?;
        }
    }
    Ok(())
}

fn validate_runtime_manifest(
    path: &Path,
    manifest: &RuntimeManifest,
) -> Result<(), WidgetPackageError> {
    if manifest.schema_version != RUNTIME_SCHEMA_VERSION {
        return Err(invalid_manifest(path, "unsupported schema_version"));
    }
    validate_metadata(
        ManifestMetadata::runtime(path, manifest),
        manifest.variants.iter().map(|variant| VariantMetadata {
            id: &variant.id,
            name: &variant.name,
            width: variant.width,
            height: variant.height,
        }),
    )?;
    validate_relative_path(path, "backend", &manifest.backend)?;
    for variant in &manifest.variants {
        validate_relative_path(path, "frontend", &variant.frontend)?;
        if let Some(frontend) = &variant.launch_frontend {
            validate_relative_path(path, "launch_frontend", frontend)?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct ManifestMetadata<'a> {
    path: &'a Path,
    id: &'a str,
    name: &'a str,
    description: &'a str,
    options: &'a [WidgetOption],
    inputs: &'a [WidgetLinkPort],
    outputs: &'a [WidgetLinkPort],
}

impl<'a> ManifestMetadata<'a> {
    fn source(path: &'a Path, manifest: &'a SourceManifest) -> Self {
        Self {
            path,
            id: &manifest.id,
            name: &manifest.name,
            description: &manifest.description,
            options: &manifest.options,
            inputs: &manifest.inputs,
            outputs: &manifest.outputs,
        }
    }

    fn runtime(path: &'a Path, manifest: &'a RuntimeManifest) -> Self {
        Self {
            path,
            id: &manifest.id,
            name: &manifest.name,
            description: &manifest.description,
            options: &manifest.options,
            inputs: &manifest.inputs,
            outputs: &manifest.outputs,
        }
    }
}

#[derive(Clone, Copy)]
struct VariantMetadata<'a> {
    id: &'a str,
    name: &'a str,
    width: u32,
    height: u32,
}

fn validate_metadata<'a>(
    metadata: ManifestMetadata<'_>,
    variants: impl Iterator<Item = VariantMetadata<'a>>,
) -> Result<(), WidgetPackageError> {
    if !valid_id(metadata.id, b'-')
        || metadata.name.trim().is_empty()
        || metadata.description.trim().is_empty()
    {
        return Err(invalid_manifest(
            metadata.path,
            "id must use kebab case; name and description must not be empty",
        ));
    }
    let variants = variants.collect::<Vec<_>>();
    if variants.is_empty() {
        return Err(invalid_manifest(
            metadata.path,
            "variants must not be empty",
        ));
    }
    let mut variant_ids = HashSet::new();
    if variants.iter().any(|variant| {
        !valid_id(variant.id, b'-')
            || variant.name.trim().is_empty()
            || variant.width == 0
            || variant.height == 0
            || !variant_ids.insert(variant.id)
    }) {
        return Err(invalid_manifest(
            metadata.path,
            "variants require unique IDs, names, and positive sizes",
        ));
    }
    validate_options(metadata.path, metadata.options, &variant_ids)?;
    validate_ports(
        metadata.path,
        metadata.inputs,
        metadata.outputs,
        &variant_ids,
    )
}

fn validate_options(
    path: &Path,
    options: &[WidgetOption],
    variant_ids: &HashSet<&str>,
) -> Result<(), WidgetPackageError> {
    let mut ids = HashSet::new();
    for option in options {
        if !valid_id(&option.id, b'_')
            || option.name.trim().is_empty()
            || option.description.trim().is_empty()
            || !ids.insert(option.id.as_str())
            || option
                .variants
                .iter()
                .any(|variant| !variant_ids.contains(variant.as_str()))
            || !valid_option_default(option)
        {
            return Err(invalid_manifest(
                path,
                "options require unique IDs, names, descriptions, known variants, and valid defaults",
            ));
        }
    }
    Ok(())
}

fn valid_option_default(option: &WidgetOption) -> bool {
    match &option.kind {
        WidgetOptionKind::Boolean => option.default.is_boolean(),
        WidgetOptionKind::Text { .. } => option.default.is_string(),
        WidgetOptionKind::Integer {
            minimum,
            maximum,
            step,
        } => {
            *step != 0
                && minimum <= maximum
                && option.default.as_i64().is_some_and(|value| {
                    value >= *minimum
                        && value <= *maximum
                        && ((i128::from(value) - i128::from(*minimum)) as u128)
                            .is_multiple_of(u128::from(*step))
                })
        }
        WidgetOptionKind::Select { choices } => {
            let mut values = HashSet::new();
            !choices.is_empty()
                && choices.iter().all(|choice| {
                    !choice.value.is_empty()
                        && !choice.name.trim().is_empty()
                        && values.insert(choice.value.as_str())
                })
                && option
                    .default
                    .as_str()
                    .is_some_and(|default| values.contains(default))
        }
    }
}

fn validate_ports(
    path: &Path,
    inputs: &[WidgetLinkPort],
    outputs: &[WidgetLinkPort],
    variant_ids: &HashSet<&str>,
) -> Result<(), WidgetPackageError> {
    let mut ids = HashSet::new();
    for port in inputs.iter().chain(outputs) {
        if !valid_id(&port.id, b'_')
            || port.name.trim().is_empty()
            || port.link_type.trim().is_empty()
            || !ids.insert(port.id.as_str())
            || port
                .variants
                .iter()
                .any(|variant| !variant_ids.contains(variant.as_str()))
        {
            return Err(invalid_manifest(
                path,
                "link ports require unique IDs, names, types, and known variants",
            ));
        }
    }
    if outputs.iter().any(|port| port.required) {
        return Err(invalid_manifest(
            path,
            "output link ports cannot be required",
        ));
    }
    Ok(())
}

fn validate_relative_path(
    manifest: &Path,
    label: &str,
    path: &Path,
) -> Result<(), WidgetPackageError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid_manifest(
            manifest,
            &format!("{label} must be a relative path inside the widget directory"),
        ));
    }
    Ok(())
}

fn valid_id(value: &str, separator: u8) -> bool {
    !value.is_empty()
        && !value.starts_with(char::from(separator))
        && !value.ends_with(char::from(separator))
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == separator)
        && !value
            .as_bytes()
            .windows(2)
            .any(|pair| pair == [separator; 2])
}

fn require_readable_file(path: &Path, label: &str) -> Result<(), WidgetPackageError> {
    if !path.is_file() {
        return Err(invalid(format!("{label} must exist: {}", path.display())));
    }
    File::open(path).map(|_| ()).map_err(|source| {
        io_error(
            format!("{label} is not readable: {}", path.display()),
            source,
        )
    })
}

#[cfg(unix)]
fn require_executable(path: &Path) -> Result<(), WidgetPackageError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .map_err(|source| io_error("read backend permissions", source))?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        return Err(invalid(format!(
            "declared backend is not executable: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_executable(_path: &Path) -> Result<(), WidgetPackageError> {
    Ok(())
}

fn copy_file(
    source: &Path,
    destination: &Path,
    executable: bool,
) -> Result<(), WidgetPackageError> {
    fs::copy(source, destination)
        .map_err(|error| io_error(format!("copy artifact {}", source.display()), error))?;
    set_file_mode(destination, executable)
}

#[cfg(unix)]
fn set_file_mode(path: &Path, executable: bool) -> Result<(), WidgetPackageError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|source| io_error("set bundle artifact permissions", source))
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _executable: bool) -> Result<(), WidgetPackageError> {
    Ok(())
}

fn staging_directory(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("widget");
    output.with_file_name(format!(".{name}.dashboardd-widget-{}", std::process::id()))
}

fn read_to_string(path: &Path) -> Result<String, WidgetPackageError> {
    fs::read_to_string(path).map_err(|source| io_error(format!("read {}", path.display()), source))
}

fn reject_ignored(path: &Path, ignored: Vec<String>) -> Result<(), WidgetPackageError> {
    if ignored.is_empty() {
        Ok(())
    } else {
        Err(invalid_manifest(
            path,
            &format!("unknown field {}", ignored[0]),
        ))
    }
}

fn invalid_manifest(path: &Path, message: &str) -> WidgetPackageError {
    invalid(format!(
        "invalid widget manifest {}: {message}",
        path.display()
    ))
}

fn invalid(message: String) -> WidgetPackageError {
    WidgetPackageError::Invalid(message)
}

fn io_error(context: impl Into<String>, source: io::Error) -> WidgetPackageError {
    WidgetPackageError::Io {
        context: context.into(),
        source,
    }
}
