//! Installed widget definitions discovered from the filesystem.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use dashboard_protocol::WidgetId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetDescriptor {
    pub id: WidgetId,
    pub name: String,
    pub frontend_url: String,
}

#[derive(Debug)]
pub struct WidgetConfig {
    pub descriptor: WidgetDescriptor,
    pub backend: PathBuf,
    pub frontend: PathBuf,
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
    backend: PathBuf,
    frontend: PathBuf,
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
        for widget in &widgets {
            tracing::debug!(
                widget_id = %widget.descriptor.id,
                backend = %widget.backend.display(),
                frontend = %widget.frontend.display(),
                "discovered widget"
            );
        }

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

    if manifest.schema_version != 1 {
        return Err(invalid_manifest(
            &manifest_path,
            "unsupported schema_version",
        ));
    }
    if manifest.id.is_empty() || manifest.name.is_empty() {
        return Err(invalid_manifest(
            &manifest_path,
            "id and name must not be empty",
        ));
    }
    for (label, path) in [
        ("backend", &manifest.backend),
        ("frontend", &manifest.frontend),
    ] {
        if path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(invalid_manifest(
                &manifest_path,
                &format!("{label} must be a relative path inside the widget directory"),
            ));
        }
    }

    let backend = widget_directory.join(manifest.backend);
    let frontend = widget_directory.join(manifest.frontend);
    if !backend.is_file() || !frontend.is_file() {
        return Err(invalid_manifest(
            &manifest_path,
            "declared backend and frontend files must exist",
        ));
    }

    let frontend_url = format!("/widgets/{}/frontend.js", manifest.id);
    Ok(WidgetConfig {
        descriptor: WidgetDescriptor {
            id: manifest.id,
            name: manifest.name,
            frontend_url,
        },
        backend,
        frontend,
    })
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
    fn discovers_and_gets_widget_configs() {
        let root = std::env::temp_dir().join(format!("scufris-widgets-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":1,"id":"cpu","name":"CPU","backend":"backend","frontend":"frontend.js"}"#,
        )
        .unwrap();
        fs::write(cpu.join("backend"), "executable").unwrap();
        fs::write(cpu.join("frontend.js"), "export function mount() {}").unwrap();

        let widgets = WidgetsManager::discover(&root).unwrap();
        let config = widgets.get("cpu").unwrap();

        assert_eq!(widgets.len(), 1);
        assert_eq!(widgets.list(), vec![config.descriptor.clone()]);
        assert_eq!(config.descriptor.frontend_url, "/widgets/cpu/frontend.js");
        assert_eq!(config.backend, cpu.join("backend"));
        assert_eq!(config.frontend, cpu.join("frontend.js"));
        assert!(widgets.get("missing").is_none());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_frontend_paths_outside_the_widget_directory() {
        let root =
            std::env::temp_dir().join(format!("scufris-invalid-widget-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":1,"id":"cpu","name":"CPU","backend":"backend","frontend":"../frontend.js"}"#,
        )
        .unwrap();

        let error = WidgetsManager::discover(&root).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_dir_all(root).unwrap();
    }
}
