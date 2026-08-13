//! Durable dashboard composition storage.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use dashboard_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashboardStateFile {
    pub schema_version: u32,
    pub instances: Vec<PersistedInstance>,
}

impl DashboardStateFile {
    pub fn new(instances: Vec<PersistedInstance>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            instances,
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

    pub fn load(&self) -> io::Result<Option<DashboardStateFile>> {
        let source = match fs::read_to_string(&self.path) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let state: DashboardStateFile = serde_json::from_str(&source)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if state.schema_version != SCHEMA_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported schema_version {}", state.schema_version),
            ));
        }
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

    #[test]
    fn missing_state_is_empty_and_saved_state_round_trips() {
        let path = temporary_path("round-trip");
        let store = StateStore::new(path.clone());
        assert_eq!(store.load().unwrap(), None);
        let state = DashboardStateFile::new(vec![PersistedInstance {
            id: "cpu-7".into(),
            widget_id: "cpu".into(),
            variant_id: "full".into(),
            position: Position { column: 3, row: 2 },
        }]);

        store.save(&state).unwrap();

        assert_eq!(store.load().unwrap(), Some(state));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_state_fails_to_load() {
        let path = temporary_path("invalid");
        fs::write(&path, r#"{"schema_version":2,"instances":[]}"#).unwrap();

        let error = StateStore::new(path.clone()).load().unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_file(path).unwrap();
    }
}
