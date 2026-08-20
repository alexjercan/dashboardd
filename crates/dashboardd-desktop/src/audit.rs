use std::{
    env, fs,
    fs::OpenOptions,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const LOG_FILE_NAME: &str = "control.jsonl";
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const RETAINED_LOG_FILES: usize = 3;

pub struct AuditLog {
    path: PathBuf,
}

#[derive(Serialize)]
pub struct AuditRecord<'a> {
    pub timestamp: String,
    pub request_id: u64,
    pub command: &'a str,
    pub status: &'a str,
    pub duration_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'a str>,
}

impl AuditLog {
    pub fn open() -> io::Result<Self> {
        let directory = state_directory()?;
        fs::create_dir_all(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            path: directory.join(LOG_FILE_NAME),
        })
    }

    pub fn write(
        &self,
        request_id: u64,
        command: &str,
        status: &str,
        duration_ms: u128,
        surface_id: Option<&str>,
        error_code: Option<&str>,
    ) -> io::Result<()> {
        let record = AuditRecord {
            timestamp: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(io::Error::other)?,
            request_id,
            command,
            status,
            duration_ms,
            surface_id,
            error_code,
        };
        let mut line = serde_json::to_vec(&record).map_err(io::Error::other)?;
        line.push(b'\n');
        self.rotate_if_needed(line.len() as u64)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)?;
        file.write_all(&line)
    }

    fn rotate_if_needed(&self, incoming_bytes: u64) -> io::Result<()> {
        let current_bytes = match fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if current_bytes + incoming_bytes <= MAX_LOG_BYTES {
            return Ok(());
        }
        for index in (1..RETAINED_LOG_FILES).rev() {
            rename_if_present(
                &rotated_path(&self.path, index),
                &rotated_path(&self.path, index + 1),
            )?;
        }
        rename_if_present(&self.path, &rotated_path(&self.path, 1))
    }
}

fn state_directory() -> io::Result<PathBuf> {
    if let Some(path) = env::var_os("XDG_STATE_HOME").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path).join("dashboardd-desktop"));
    }
    let home = env::var_os("HOME")
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "XDG_STATE_HOME or HOME is required",
            )
        })?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("dashboardd-desktop"))
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    path.with_file_name(format!("{LOG_FILE_NAME}.{index}"))
}

fn rename_if_present(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
