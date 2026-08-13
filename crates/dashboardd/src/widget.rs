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
pub struct WidgetVariant {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frontend_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetDescriptor {
    pub id: WidgetId,
    pub name: String,
    pub variants: Vec<WidgetVariant>,
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

    pub fn frontend(&self, variant_id: &str) -> Option<&Path> {
        self.descriptor
            .variants
            .iter()
            .position(|variant| variant.id == variant_id)
            .map(|index| self.frontends[index].as_path())
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
    backend: PathBuf,
    variants: Vec<VariantFile>,
}

#[derive(Debug, Deserialize)]
struct VariantFile {
    id: String,
    name: String,
    width: u32,
    height: u32,
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
    if manifest.id.is_empty() || manifest.name.is_empty() || manifest.variants.is_empty() {
        return Err(invalid_manifest(
            &manifest_path,
            "id, name, and variants must not be empty",
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

    let mut ids = std::collections::HashSet::new();
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
        });
        frontends.push(frontend);
    }

    Ok(WidgetConfig {
        descriptor: WidgetDescriptor {
            id: manifest.id,
            name: manifest.name,
            variants,
        },
        backend,
        frontends,
    })
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
            r#"{"schema_version":2,"id":"cpu","name":"CPU","backend":"backend","variants":[{"id":"full","name":"Full","width":3,"height":3,"frontend":"full.js"}]}"#,
        )
        .unwrap();
        fs::write(cpu.join("backend"), "executable").unwrap();
        fs::write(cpu.join("full.js"), "export function mount() {}").unwrap();

        let widgets = WidgetsManager::discover(&root).unwrap();
        let config = widgets.get("cpu").unwrap();

        assert_eq!(widgets.len(), 1);
        assert_eq!(config.descriptor.variants[0].id, "full");
        assert_eq!(config.descriptor.variants[0].width, 3);
        assert_eq!(
            config.descriptor.variants[0].frontend_url,
            "/widgets/cpu/variants/full/frontend.js"
        );
        assert_eq!(config.frontend("full"), Some(cpu.join("full.js").as_path()));
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
