//! Installed widget definitions discovered from the filesystem.

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
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
    Text {
        #[serde(default)]
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
            WidgetOptionKind::Text { .. } => value.is_string(),
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
    let checked = dashboardd_widget::check_bundle(widget_directory)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let manifest = checked.manifest;
    let widget_id = manifest.id.clone();
    Ok(WidgetConfig {
        descriptor: WidgetDescriptor {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            variants: manifest
                .variants
                .into_iter()
                .map(|variant| WidgetVariant {
                    frontend_url: format!(
                        "/widgets/{widget_id}/variants/{}/frontend.js",
                        variant.id
                    ),
                    id: variant.id,
                    name: variant.name,
                    width: variant.width,
                    height: variant.height,
                    focus: variant.focus,
                })
                .collect(),
            options: manifest.options.into_iter().map(Into::into).collect(),
            inputs: manifest.inputs.into_iter().map(Into::into).collect(),
            outputs: manifest.outputs.into_iter().map(Into::into).collect(),
        },
        backend: checked.backend,
        frontends: checked.frontends,
    })
}

impl From<dashboardd_widget::WidgetLinkPort> for WidgetLinkPort {
    fn from(port: dashboardd_widget::WidgetLinkPort) -> Self {
        Self {
            id: port.id,
            name: port.name,
            link_type: port.link_type,
            variants: port.variants,
            required: port.required,
        }
    }
}

impl From<dashboardd_widget::WidgetOption> for WidgetOption {
    fn from(option: dashboardd_widget::WidgetOption) -> Self {
        Self {
            id: option.id,
            name: option.name,
            description: option.description,
            variants: option.variants,
            default: option.default,
            kind: option.kind.into(),
        }
    }
}

impl From<dashboardd_widget::WidgetOptionKind> for WidgetOptionKind {
    fn from(kind: dashboardd_widget::WidgetOptionKind) -> Self {
        match kind {
            dashboardd_widget::WidgetOptionKind::Boolean => Self::Boolean,
            dashboardd_widget::WidgetOptionKind::Text { multiline } => Self::Text { multiline },
            dashboardd_widget::WidgetOptionKind::Integer {
                minimum,
                maximum,
                step,
            } => Self::Integer {
                minimum,
                maximum,
                step,
            },
            dashboardd_widget::WidgetOptionKind::Select { choices } => Self::Select {
                choices: choices.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<dashboardd_widget::WidgetOptionChoice> for WidgetOptionChoice {
    fn from(choice: dashboardd_widget::WidgetOptionChoice) -> Self {
        Self {
            value: choice.value,
            name: choice.name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_widget_variants() {
        let root = std::env::temp_dir().join(format!("dashboardd-widgets-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":2,"id":"cpu","name":"CPU","description":"Processor usage","backend":"backend","variants":[{"id":"full","name":"Full","width":3,"height":3,"frontend":"full.js","focus":true}],"options":[{"id":"root","name":"Root","description":"Project root","variants":["full"],"default":"~/personal","type":"text","multiline":false},{"id":"history_points","name":"History length","description":"Retained samples","variants":["full"],"default":40,"type":"integer","minimum":20,"maximum":120,"step":10}],"inputs":[{"id":"task","name":"Task","type":"task/v1","variants":["full"],"required":true}],"outputs":[{"id":"selection","name":"Selection","type":"task/v1","variants":["full"],"required":false}]}"#,
        )
        .unwrap();
        fs::write(cpu.join("backend"), "executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(cpu.join("backend"), fs::Permissions::from_mode(0o755)).unwrap();
        }
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
        assert!(matches!(
            config.descriptor.options[0].kind,
            WidgetOptionKind::Text { multiline: false }
        ));
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
            std::env::temp_dir().join(format!("dashboardd-invalid-options-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":2,"id":"cpu","name":"CPU","description":"Processor usage","backend":"backend","variants":[{"id":"full","name":"Full","width":3,"height":3,"frontend":"full.js","focus":false}],"options":[{"id":"history_points","name":"History","description":"Samples","variants":["full"],"default":40,"type":"integer","minimum":20,"maximum":120,"step":0}],"inputs":[],"outputs":[]}"#,
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
            std::env::temp_dir().join(format!("dashboardd-invalid-widget-{}", std::process::id()));
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
