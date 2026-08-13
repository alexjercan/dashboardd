//! Installed widget definitions and backend process lifecycle.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use dashboard_protocol::{InstanceId, ServerToWidget, WidgetId, WidgetToServer};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{broadcast, mpsc},
    task::JoinHandle,
};
use utoipa::ToSchema;

use crate::event::{DashboardError, DashboardEvent};

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

    if manifest.id.is_empty() || manifest.name.is_empty() {
        return Err(invalid_manifest(
            &manifest_path,
            "id and name must not be empty",
        ));
    }
    if manifest.frontend.is_absolute()
        || manifest
            .frontend
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid_manifest(
            &manifest_path,
            "frontend must be a relative path inside the widget directory",
        ));
    }

    let frontend = widget_directory.join(manifest.frontend);
    if !frontend.is_file() {
        return Err(invalid_manifest(
            &manifest_path,
            "declared frontend file does not exist",
        ));
    }

    let frontend_url = format!("/widgets/{}/frontend.js", manifest.id);
    Ok(WidgetConfig {
        descriptor: WidgetDescriptor {
            id: manifest.id,
            name: manifest.name,
            frontend_url,
        },
        backend: widget_directory.join(manifest.backend),
        frontend,
    })
}

fn invalid_manifest(path: &Path, message: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("invalid widget manifest {}: {message}", path.display()),
    )
}

pub struct WidgetBackend {
    commands: mpsc::UnboundedSender<ServerToWidget>,
    task: Option<JoinHandle<()>>,
}

impl WidgetBackend {
    pub fn send(&self, message: ServerToWidget) -> Result<(), ServerToWidget> {
        self.commands.send(message).map_err(|error| error.0)
    }

    pub async fn shutdown(mut self) {
        let _ = self.commands.send(ServerToWidget::Shutdown {});
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for WidgetBackend {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

pub fn start_backend(
    config: Arc<WidgetConfig>,
    instance_id: InstanceId,
    events: broadcast::Sender<DashboardEvent>,
) -> WidgetBackend {
    let (commands_tx, commands_rx) = mpsc::unbounded_channel();
    let task_instance_id = instance_id.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = run_backend(&config, &task_instance_id, &events, commands_rx).await {
            let _ = events.send(DashboardEvent::InstanceError {
                instance_id: Some(task_instance_id),
                error: DashboardError {
                    code: "backend_failed".into(),
                    message: error.to_string(),
                },
            });
        }
    });

    WidgetBackend {
        commands: commands_tx,
        task: Some(task),
    }
}

async fn run_backend(
    config: &WidgetConfig,
    instance_id: &str,
    events: &broadcast::Sender<DashboardEvent>,
    mut commands: mpsc::UnboundedReceiver<ServerToWidget>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut child = Command::new(&config.backend)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("widget backend stdin is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("widget backend stdout is unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    write_backend_message(
        &mut stdin,
        ServerToWidget::Initialize {
            instance_id: instance_id.into(),
            widget_id: config.descriptor.id.clone(),
        },
    )
    .await?;

    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break };
                let shutdown = matches!(command, ServerToWidget::Shutdown {});
                write_backend_message(&mut stdin, command).await?;
                if shutdown {
                    break;
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                handle_backend_message(config, events, &line)?;
            }
        }
    }

    drop(stdin);
    let status = child.wait().await?;
    if !status.success() {
        return Err(format!("widget backend exited with {status}").into());
    }

    Ok(())
}

async fn write_backend_message(
    stdin: &mut ChildStdin,
    message: ServerToWidget,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let encoded = dashboard_protocol::serialize(message)?;
    stdin.write_all(encoded.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

fn handle_backend_message(
    config: &WidgetConfig,
    events: &broadcast::Sender<DashboardEvent>,
    line: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match dashboard_protocol::parse::<WidgetToServer>(line)? {
        WidgetToServer::Ready { widget_id } if widget_id == config.descriptor.id => {}
        WidgetToServer::Update {
            instance_id,
            payload,
        } => {
            let _ = events.send(DashboardEvent::WidgetUpdate {
                instance_id,
                payload,
            });
        }
        WidgetToServer::Error { instance_id, error } => {
            let _ = events.send(DashboardEvent::InstanceError {
                instance_id,
                error: error.into(),
            });
        }
        WidgetToServer::Ready { widget_id } => {
            return Err(format!("backend announced unexpected widget id {widget_id}").into());
        }
    }
    Ok(())
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
            r#"{"id":"cpu","name":"CPU","backend":"backend","frontend":"frontend.js"}"#,
        )
        .unwrap();
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
            r#"{"id":"cpu","name":"CPU","backend":"backend","frontend":"../frontend.js"}"#,
        )
        .unwrap();

        let error = WidgetsManager::discover(&root).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_dir_all(root).unwrap();
    }
}
