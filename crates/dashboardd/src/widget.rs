//! Installed widget definitions discovered from the filesystem.

use std::{
    collections::{BTreeMap, HashSet},
    fs, io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use dashboard_protocol::WidgetId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetVariant {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frontend_url: String,
    pub focus: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetDescriptor {
    pub id: WidgetId,
    pub name: String,
    pub description: String,
    pub variants: Vec<WidgetVariant>,
    pub options: Vec<WidgetOption>,
    pub inputs: Vec<WidgetLinkPort>,
    pub outputs: Vec<WidgetLinkPort>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetLinkPort {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub link_type: String,
    pub variants: Vec<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub variants: Vec<String>,
    pub default: Value,
    #[serde(flatten)]
    pub kind: WidgetOptionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WidgetOptionKind {
    Boolean,
    Text,
    Integer {
        minimum: i64,
        maximum: i64,
        step: u64,
    },
    Select {
        choices: Vec<WidgetOptionChoice>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetOptionChoice {
    pub value: String,
    pub name: String,
}

#[derive(Debug)]
pub struct WidgetConfig {
    pub descriptor: WidgetDescriptor,
    pub backend: PathBuf,
    pub frontends: Vec<PathBuf>,
}

impl WidgetConfig {
    pub fn variant(&self, variant_id: &str) -> Option<&WidgetVariant> {
        self.descriptor
            .variants
            .iter()
            .find(|variant| variant.id == variant_id)
    }

    pub fn input(&self, variant_id: &str, port_id: &str) -> Option<&WidgetLinkPort> {
        self.descriptor
            .inputs
            .iter()
            .find(|port| port.id == port_id && port.applies_to(variant_id))
    }

    pub fn output(&self, variant_id: &str, port_id: &str) -> Option<&WidgetLinkPort> {
        self.descriptor
            .outputs
            .iter()
            .find(|port| port.id == port_id && port.applies_to(variant_id))
    }

    pub fn frontend(&self, variant_id: &str) -> Option<&Path> {
        self.descriptor
            .variants
            .iter()
            .position(|variant| variant.id == variant_id)
            .map(|index| self.frontends[index].as_path())
    }

    pub fn normalize_options(
        &self,
        variant_id: &str,
        supplied: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let active: Vec<_> = self
            .descriptor
            .options
            .iter()
            .filter(|option| option.applies_to(variant_id))
            .collect();
        if let Some(id) = supplied
            .keys()
            .find(|id| !active.iter().any(|option| option.id == id.as_str()))
        {
            return Err(format!("unknown or inapplicable option {id:?}"));
        }
        let mut normalized = BTreeMap::new();
        for option in active {
            let value = supplied.get(&option.id).unwrap_or(&option.default);
            option.validate_value(value)?;
            normalized.insert(option.id.clone(), value.clone());
        }
        Ok(normalized)
    }
}

impl WidgetLinkPort {
    fn applies_to(&self, variant_id: &str) -> bool {
        self.variants.is_empty() || self.variants.iter().any(|variant| variant == variant_id)
    }
}

impl WidgetOption {
    fn applies_to(&self, variant_id: &str) -> bool {
        self.variants.is_empty() || self.variants.iter().any(|variant| variant == variant_id)
    }

    fn validate_value(&self, value: &Value) -> Result<(), String> {
        let valid = match &self.kind {
            WidgetOptionKind::Boolean => value.is_boolean(),
            WidgetOptionKind::Text => value.is_string(),
            WidgetOptionKind::Integer {
                minimum,
                maximum,
                step,
            } => {
                *step != 0
                    && minimum <= maximum
                    && value.as_i64().is_some_and(|value| {
                        value >= *minimum
                            && value <= *maximum
                            && ((i128::from(value) - i128::from(*minimum)) as u128)
                                .is_multiple_of(u128::from(*step))
                    })
            }
            WidgetOptionKind::Select { choices } => value
                .as_str()
                .is_some_and(|value| choices.iter().any(|choice| choice.value == value)),
        };
        valid
            .then_some(())
            .ok_or_else(|| format!("invalid value for option {:?}", self.id))
    }
}

#[derive(Clone, Debug, Default)]
pub struct WidgetsManager {
    widgets: Arc<Vec<Arc<WidgetConfig>>>,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    schema_version: u32,
    id: String,
    name: String,
    description: String,
    backend: PathBuf,
    variants: Vec<VariantFile>,
    #[serde(default)]
    options: Vec<WidgetOption>,
    #[serde(default)]
    inputs: Vec<WidgetLinkPort>,
    #[serde(default)]
    outputs: Vec<WidgetLinkPort>,
}

#[derive(Debug, Deserialize)]
struct VariantFile {
    id: String,
    name: String,
    width: u32,
    height: u32,
    frontend: PathBuf,
    #[serde(default)]
    focus: bool,
}

impl WidgetsManager {
    pub fn discover(root: &Path) -> io::Result<Self> {
        let mut directories = fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
        directories.sort_by_key(fs::DirEntry::file_name);
        let widgets = directories
            .into_iter()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| read_config(&entry.path()).map(Arc::new))
            .collect::<io::Result<Vec<_>>>()?;
        Ok(Self {
            widgets: Arc::new(widgets),
        })
    }

    pub fn len(&self) -> usize {
        self.widgets.len()
    }

    pub fn list(&self) -> Vec<WidgetDescriptor> {
        self.widgets
            .iter()
            .map(|widget| widget.descriptor.clone())
            .collect()
    }

    pub fn get(&self, widget_id: &str) -> Option<Arc<WidgetConfig>> {
        self.widgets
            .iter()
            .find(|widget| widget.descriptor.id == widget_id)
            .cloned()
    }
}

fn read_config(widget_directory: &Path) -> io::Result<WidgetConfig> {
    let manifest_path = widget_directory.join("widget.json");
    let source = fs::read_to_string(&manifest_path)?;
    let manifest: ManifestFile = serde_json::from_str(&source).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "invalid widget manifest {}: {error}",
                manifest_path.display()
            ),
        )
    })?;

    if manifest.schema_version != 2 {
        return Err(invalid_manifest(
            &manifest_path,
            "unsupported schema_version",
        ));
    }
    if manifest.id.is_empty()
        || manifest.name.is_empty()
        || manifest.description.is_empty()
        || manifest.variants.is_empty()
    {
        return Err(invalid_manifest(
            &manifest_path,
            "id, name, description, and variants must not be empty",
        ));
    }
    validate_path(&manifest_path, "backend", &manifest.backend)?;
    let backend = widget_directory.join(&manifest.backend);
    if !backend.is_file() {
        return Err(invalid_manifest(
            &manifest_path,
            "declared backend must exist",
        ));
    }

    let mut ids = HashSet::new();
    let mut variants = Vec::new();
    let mut frontends = Vec::new();
    for variant in manifest.variants {
        validate_path(&manifest_path, "frontend", &variant.frontend)?;
        if variant.id.is_empty()
            || variant.name.is_empty()
            || variant.width == 0
            || variant.height == 0
            || !ids.insert(variant.id.clone())
        {
            return Err(invalid_manifest(
                &manifest_path,
                "variants require unique IDs, names, and positive sizes",
            ));
        }
        let frontend = widget_directory.join(&variant.frontend);
        if !frontend.is_file() {
            return Err(invalid_manifest(
                &manifest_path,
                "declared frontend must exist",
            ));
        }
        variants.push(WidgetVariant {
            frontend_url: format!(
                "/widgets/{}/variants/{}/frontend.js",
                manifest.id, variant.id
            ),
            id: variant.id,
            name: variant.name,
            width: variant.width,
            height: variant.height,
            focus: variant.focus,
        });
        frontends.push(frontend);
    }

    validate_options(&manifest_path, &manifest.options, &ids)?;
    validate_ports(&manifest_path, &manifest.inputs, &manifest.outputs, &ids)?;
    Ok(WidgetConfig {
        descriptor: WidgetDescriptor {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            variants,
            options: manifest.options,
            inputs: manifest.inputs,
            outputs: manifest.outputs,
        },
        backend,
        frontends,
    })
}

fn validate_options(
    manifest: &Path,
    options: &[WidgetOption],
    variant_ids: &HashSet<String>,
) -> io::Result<()> {
    let mut option_ids = HashSet::new();
    for option in options {
        if option.id.is_empty()
            || option.name.trim().is_empty()
            || option.description.trim().is_empty()
            || !option_ids.insert(&option.id)
            || option
                .variants
                .iter()
                .any(|variant| !variant_ids.contains(variant))
            || option.validate_value(&option.default).is_err()
        {
            return Err(invalid_manifest(
                manifest,
                "options require unique IDs, names, descriptions, known variants, and valid defaults",
            ));
        }
        match &option.kind {
            WidgetOptionKind::Integer {
                minimum,
                maximum,
                step,
            } if minimum > maximum || *step == 0 => {
                return Err(invalid_manifest(
                    manifest,
                    "invalid integer option constraints",
                ));
            }
            WidgetOptionKind::Select { choices } => {
                let mut values = HashSet::new();
                if choices.is_empty()
                    || choices.iter().any(|choice| {
                        choice.value.is_empty()
                            || choice.name.trim().is_empty()
                            || !values.insert(&choice.value)
                    })
                {
                    return Err(invalid_manifest(manifest, "invalid select option choices"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_ports(
    manifest: &Path,
    inputs: &[WidgetLinkPort],
    outputs: &[WidgetLinkPort],
    variant_ids: &HashSet<String>,
) -> io::Result<()> {
    let mut ids = HashSet::new();
    for port in inputs.iter().chain(outputs) {
        if port.id.is_empty()
            || port.name.trim().is_empty()
            || port.link_type.trim().is_empty()
            || !ids.insert(&port.id)
            || port
                .variants
                .iter()
                .any(|variant| !variant_ids.contains(variant))
        {
            return Err(invalid_manifest(
                manifest,
                "link ports require unique IDs, names, types, and known variants",
            ));
        }
    }
    if outputs.iter().any(|port| port.required) {
        return Err(invalid_manifest(
            manifest,
            "output link ports cannot be required",
        ));
    }
    Ok(())
}

fn validate_path(manifest: &Path, label: &str, path: &Path) -> io::Result<()> {
    if path.is_absolute()
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

fn invalid_manifest(path: &Path, message: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("invalid widget manifest {}: {message}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_widget_variants() {
        let root = std::env::temp_dir().join(format!("scufris-widgets-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":2,"id":"cpu","name":"CPU","description":"Processor usage","backend":"backend","variants":[{"id":"full","name":"Full","width":3,"height":3,"frontend":"full.js","focus":true}],"options":[{"id":"root","name":"Root","description":"Project root","variants":["full"],"default":"~/personal","type":"text"},{"id":"history_points","name":"History length","description":"Retained samples","variants":["full"],"default":40,"type":"integer","minimum":20,"maximum":120,"step":10}],"inputs":[{"id":"task","name":"Task","type":"task/v1","variants":["full"],"required":true}],"outputs":[{"id":"selection","name":"Selection","type":"task/v1","variants":["full"],"required":false}]}"#,
        )
        .unwrap();
        fs::write(cpu.join("backend"), "executable").unwrap();
        fs::write(cpu.join("full.js"), "export function mount() {}").unwrap();

        let widgets = WidgetsManager::discover(&root).unwrap();
        let config = widgets.get("cpu").unwrap();

        assert_eq!(widgets.len(), 1);
        assert_eq!(config.descriptor.variants[0].id, "full");
        assert_eq!(config.descriptor.variants[0].width, 3);
        assert!(config.descriptor.variants[0].focus);
        assert_eq!(
            config.descriptor.variants[0].frontend_url,
            "/widgets/cpu/variants/full/frontend.js"
        );
        assert_eq!(config.frontend("full"), Some(cpu.join("full.js").as_path()));
        assert_eq!(config.input("full", "task").unwrap().link_type, "task/v1");
        assert!(config.input("missing", "task").is_none());
        assert_eq!(
            config.output("full", "selection").unwrap().link_type,
            "task/v1"
        );
        assert_eq!(
            config.normalize_options("full", &BTreeMap::new()).unwrap(),
            BTreeMap::from([
                ("history_points".into(), Value::from(40)),
                ("root".into(), Value::from("~/personal")),
            ])
        );
        assert_eq!(
            config
                .normalize_options(
                    "full",
                    &BTreeMap::from([("history_points".into(), Value::from(80))]),
                )
                .unwrap()["history_points"],
            Value::from(80)
        );
        assert!(
            config
                .normalize_options(
                    "full",
                    &BTreeMap::from([("history_points".into(), Value::from(25))]),
                )
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_option_manifests() {
        let root =
            std::env::temp_dir().join(format!("scufris-invalid-options-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":2,"id":"cpu","name":"CPU","description":"Processor usage","backend":"backend","variants":[{"id":"full","name":"Full","width":3,"height":3,"frontend":"full.js"}],"options":[{"id":"history_points","name":"History","description":"Samples","variants":["full"],"default":40,"type":"integer","minimum":20,"maximum":120,"step":0}]}"#,
        )
        .unwrap();
        fs::write(cpu.join("backend"), "executable").unwrap();
        fs::write(cpu.join("full.js"), "export function mount() {}").unwrap();

        let error = WidgetsManager::discover(&root).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_version_one_manifests() {
        let root =
            std::env::temp_dir().join(format!("scufris-invalid-widget-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":1,"id":"cpu","name":"CPU","backend":"backend","frontend":"frontend.js"}"#,
        )
        .unwrap();

        let error = WidgetsManager::discover(&root).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_dir_all(root).unwrap();
    }
}
