//! Durable dashboard composition storage.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use dashboard_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

const SCHEMA_VERSION: u32 = 2;

pub type DashboardId = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub column: u32,
    pub row: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedInstance {
    pub id: InstanceId,
    pub widget_id: WidgetId,
    pub variant_id: String,
    pub position: Position,
    #[serde(default)]
    pub options: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DashboardLink {
    pub source_instance_id: InstanceId,
    pub source_port: String,
    pub target_instance_id: InstanceId,
    pub target_port: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedDashboard {
    pub id: DashboardId,
    pub name: String,
    #[serde(default)]
    pub instances: Vec<PersistedInstance>,
    #[serde(default)]
    pub links: Vec<DashboardLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashboardStateFile {
    pub schema_version: u32,
    pub dashboards: Vec<PersistedDashboard>,
    #[serde(default)]
    pub widget_state: BTreeMap<WidgetId, Value>,
}

#[derive(Deserialize)]
struct LegacyDashboardStateFile {
    schema_version: u32,
    instances: Vec<PersistedInstance>,
    #[serde(default)]
    links: Vec<DashboardLink>,
    #[serde(default)]
    widget_state: BTreeMap<WidgetId, Value>,
}

impl DashboardStateFile {
    pub fn new(dashboards: Vec<PersistedDashboard>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            dashboards,
            widget_state: BTreeMap::new(),
        }
    }

    pub fn with_widget_state(mut self, widget_state: BTreeMap<WidgetId, Value>) -> Self {
        self.widget_state = widget_state;
        self
    }
}

#[derive(Debug)]
pub struct StateStore {
    path: PathBuf,
    temporary_sequence: AtomicU64,
}

impl StateStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            temporary_sequence: AtomicU64::new(1),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> io::Result<Option<DashboardStateFile>> {
        let source = match fs::read_to_string(&self.path) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let value: Value = serde_json::from_str(&source)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let version = value
            .get("schema_version")
            .and_then(Value::as_u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing schema_version"))?;
        let state = match version {
            1 => {
                let legacy: LegacyDashboardStateFile = serde_json::from_value(value)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                debug_assert_eq!(legacy.schema_version, 1);
                let migrated = DashboardStateFile::new(vec![PersistedDashboard {
                    id: "dashboard-1".into(),
                    name: "Main".into(),
                    instances: legacy.instances,
                    links: legacy.links,
                }])
                .with_widget_state(legacy.widget_state);
                self.save(&migrated)?;
                migrated
            }
            version if version == u64::from(SCHEMA_VERSION) => serde_json::from_value(value)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
            version => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported schema_version {version}"),
                ));
            }
        };
        Ok(Some(state))
    }

    pub fn save(&self, state: &DashboardStateFile) -> io::Result<()> {
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let sequence = self.temporary_sequence.fetch_add(1, Ordering::Relaxed);
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "invalid state file name")
            })?;
        let temporary = parent.join(format!(
            ".{file_name}.tmp-{}-{sequence}",
            std::process::id()
        ));
        let result = write_and_replace(&temporary, &self.path, parent, state);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn write_and_replace(
    temporary: &Path,
    destination: &Path,
    parent: &Path,
    state: &DashboardStateFile,
) -> io::Result<()> {
    let source = serde_json::to_vec_pretty(state)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary)?;
    file.write_all(&source)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, destination)?;
    sync_directory(parent)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "scufris-state-{label}-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ))
    }

    fn persisted_instance() -> PersistedInstance {
        PersistedInstance {
            id: "cpu-7".into(),
            widget_id: "cpu".into(),
            variant_id: "full".into(),
            position: Position { column: 3, row: 2 },
            options: BTreeMap::from([("enabled".into(), Value::Bool(true))]),
        }
    }

    #[test]
    fn missing_state_is_empty_and_saved_state_round_trips() {
        let path = temporary_path("round-trip");
        let store = StateStore::new(path.clone());
        assert_eq!(store.load().unwrap(), None);
        let state = DashboardStateFile::new(vec![PersistedDashboard {
            id: "dashboard-1".into(),
            name: "Main".into(),
            instances: vec![persisted_instance()],
            links: vec![],
        }]);

        store.save(&state).unwrap();

        assert_eq!(store.load().unwrap(), Some(state));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_state_migrates_and_preserves_widget_state() {
        let path = temporary_path("legacy");
        fs::write(
            &path,
            r#"{"schema_version":1,"instances":[],"links":[],"widget_state":{"projects":{"pins":[]}}}"#,
        )
        .unwrap();

        let state = StateStore::new(path.clone()).load().unwrap().unwrap();

        assert_eq!(state.schema_version, 2);
        assert_eq!(state.dashboards[0].name, "Main");
        assert_eq!(
            state.widget_state["projects"],
            serde_json::json!({"pins": []})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap()["schema_version"],
            2
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn version_two_can_store_zero_dashboards() {
        let path = temporary_path("empty");
        let store = StateStore::new(path.clone());
        store.save(&DashboardStateFile::new(vec![])).unwrap();

        assert!(store.load().unwrap().unwrap().dashboards.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_state_fails_to_load() {
        let path = temporary_path("invalid");
        fs::write(&path, r#"{"schema_version":2}"#).unwrap();

        let error = StateStore::new(path.clone()).load().unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_file(path).unwrap();
    }
}
