//! Durable package-wide widget state storage.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use dashboardd_widget_protocol::WidgetId;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const SCHEMA_VERSION: u32 = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeStateFile {
    pub schema_version: u32,
    #[serde(default)]
    pub widget_state: BTreeMap<WidgetId, Value>,
}

impl RuntimeStateFile {
    pub fn with_widget_state(widget_state: BTreeMap<WidgetId, Value>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            widget_state,
        }
    }
}

impl Default for RuntimeStateFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            widget_state: BTreeMap::new(),
        }
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

    pub fn load(&self) -> io::Result<RuntimeStateFile> {
        let source = match fs::read_to_string(&self.path) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(RuntimeStateFile::default());
            }
            Err(error) => return Err(error),
        };
        let value: Value = serde_json::from_str(&source)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let version = value
            .get("schema_version")
            .and_then(Value::as_u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing schema_version"))?;
        if version != u64::from(SCHEMA_VERSION) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported schema_version {version}"),
            ));
        }
        serde_json::from_value(value)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn save(&self, state: &RuntimeStateFile) -> io::Result<()> {
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
    state: &RuntimeStateFile,
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
            "dashboardd-runtime-state-{label}-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ))
    }

    #[test]
    fn missing_and_saved_state_round_trip() {
        let path = temporary_path("round-trip");
        let store = StateStore::new(path.clone());
        assert_eq!(store.load().unwrap(), RuntimeStateFile::default());
        let state = RuntimeStateFile {
            schema_version: SCHEMA_VERSION,
            widget_state: BTreeMap::from([("projects".into(), serde_json::json!({"pins": []}))]),
        };
        store.save(&state).unwrap();
        assert_eq!(store.load().unwrap(), state);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn dashboard_composition_state_is_rejected() {
        let path = temporary_path("old");
        fs::write(
            &path,
            r#"{"schema_version":3,"dashboards":[],"widget_state":{}}"#,
        )
        .unwrap();
        let error = StateStore::new(path.clone()).load().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_file(path).unwrap();
    }
}
