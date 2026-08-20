use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

use dashboardd_desktop_control::{Command, DirectInput, Outcome, Presentation};
use dashboardd_runtime::WidgetDescriptor;
use serde::Serialize;
use serde_json::Value;
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    image::Image,
    menu::{MenuBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
};

use crate::service::{DesktopService, DraftSnapshot};

#[derive(Clone)]
pub struct LauncherService {
    inner: Arc<LauncherState>,
}

struct LauncherState {
    next_dialog_id: AtomicU64,
    actions: BTreeMap<String, LaunchSpec>,
    dialogs: Mutex<BTreeMap<String, LaunchSpec>>,
}

#[derive(Clone)]
struct LaunchSpec {
    title: String,
    widget_id: String,
    variant_id: String,
    prompts: Vec<InputPrompt>,
    custom: bool,
}

#[derive(Clone, Serialize)]
pub struct InputPrompt {
    id: String,
    name: String,
    #[serde(rename = "type")]
    input_type: String,
}

#[derive(Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum LaunchDialog {
    Json {
        title: String,
        inputs: Vec<InputPrompt>,
    },
    Custom {
        title: String,
        draft: Box<DraftSnapshot>,
    },
}

impl LauncherService {
    pub fn new(widgets: &[WidgetDescriptor]) -> Self {
        let mut actions = BTreeMap::new();
        let mut action_index = 0usize;
        for widget in widgets {
            for variant in &widget.variants {
                actions.insert(
                    format!("widget-{action_index}"),
                    LaunchSpec {
                        title: format!("{} - {}", widget.name, variant.name),
                        widget_id: widget.id.to_string(),
                        variant_id: variant.id.clone(),
                        prompts: required_prompts(widget, &variant.id),
                        custom: variant.launch_frontend,
                    },
                );
                action_index += 1;
            }
        }
        Self {
            inner: Arc::new(LauncherState {
                next_dialog_id: AtomicU64::new(1),
                actions,
                dialogs: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    pub fn install_tray(
        &self,
        app: &AppHandle,
        desktop: DesktopService,
        widgets: &[WidgetDescriptor],
    ) -> tauri::Result<()> {
        let mut open_widgets = SubmenuBuilder::new(app, "Open Widget");
        let mut action_index = 0usize;
        for widget in widgets {
            let mut variants = SubmenuBuilder::new(app, &widget.name);
            for variant in &widget.variants {
                variants = variants.text(format!("launch:widget-{action_index}"), &variant.name);
                action_index += 1;
            }
            open_widgets = open_widgets.item(&variants.build()?);
        }
        let menu = MenuBuilder::new(app)
            .item(&open_widgets.build()?)
            .separator()
            .text("quit", "Quit")
            .build()?;
        let launchers = self.clone();
        TrayIconBuilder::with_id("dashboardd-desktop")
            .tooltip("Dashboardd")
            .icon(tray_icon()?)
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(move |app, event| {
                if event.id.as_ref() == "quit" {
                    let _ = desktop.execute(app, Command::Quit);
                    return;
                }
                let Some(action_id) = event.id.as_ref().strip_prefix("launch:") else {
                    return;
                };
                let Some(spec) = launchers.inner.actions.get(action_id).cloned() else {
                    return;
                };
                if spec.prompts.is_empty() {
                    let app = app.clone();
                    let desktop = desktop.clone();
                    thread::spawn(move || {
                        let response = desktop.execute(&app, open_command(spec, BTreeMap::new()));
                        if let Outcome::Failed { error } = response.outcome {
                            eprintln!("dashboardd-desktop: tray launch failed: {}", error.message);
                        }
                    });
                } else if let Err(error) = launchers.open_dialog(app, desktop.clone(), spec) {
                    eprintln!("dashboardd-desktop: cannot open launch dialog: {error}");
                }
            })
            .build(app)?;
        Ok(())
    }

    fn open_dialog(
        &self,
        app: &AppHandle,
        desktop: DesktopService,
        spec: LaunchSpec,
    ) -> Result<(), String> {
        let label = format!(
            "launcher-{}",
            self.inner.next_dialog_id.fetch_add(1, Ordering::Relaxed)
        );
        self.inner
            .dialogs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(label.clone(), spec.clone());
        let height = if spec.custom {
            680.0
        } else {
            (190.0 + spec.prompts.len() as f64 * 150.0).min(760.0)
        };
        let window =
            WebviewWindowBuilder::new(app, &label, WebviewUrl::App("launcher.html".into()))
                .title(&spec.title)
                .inner_size(520.0, height)
                .resizable(true)
                .decorations(true)
                .build()
                .map_err(|error| error.to_string());
        let window = match window {
            Ok(window) => window,
            Err(error) => {
                self.remove_dialog(&label);
                return Err(error);
            }
        };
        let launchers = self.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                launchers.remove_dialog(&label);
                let desktop = desktop.clone();
                let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    desktop.cancel_draft(&label).await;
                });
            }
        });
        Ok(())
    }

    fn remove_dialog(&self, label: &str) {
        self.inner
            .dialogs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(label);
    }
}

#[tauri::command]
pub async fn launcher_initialize(
    window: WebviewWindow,
    launchers: State<'_, LauncherService>,
    desktop: State<'_, DesktopService>,
) -> Result<LaunchDialog, String> {
    let spec = launchers
        .inner
        .dialogs
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(window.label())
        .cloned()
        .ok_or_else(|| "launch dialog was not found".to_owned())?;
    if spec.custom {
        let draft = desktop
            .prepare_draft(window.label(), &spec.widget_id, &spec.variant_id)
            .await?;
        Ok(LaunchDialog::Custom {
            title: spec.title,
            draft: Box::new(draft),
        })
    } else {
        Ok(LaunchDialog::Json {
            title: spec.title,
            inputs: spec.prompts,
        })
    }
}

#[tauri::command]
pub fn launcher_subscribe(
    window: WebviewWindow,
    desktop: State<'_, DesktopService>,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<(), String> {
    desktop.subscribe_draft(window.label(), on_event)
}

#[tauri::command]
pub async fn launcher_send(
    window: WebviewWindow,
    desktop: State<'_, DesktopService>,
    payload: Value,
) -> Result<(), String> {
    desktop.send_draft(window.label(), payload).await
}

#[tauri::command]
pub async fn launcher_complete(
    window: WebviewWindow,
    inputs: BTreeMap<String, DirectInput>,
    launchers: State<'_, LauncherService>,
    desktop: State<'_, DesktopService>,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let desktop = desktop.inner().clone();
    let response =
        tauri::async_runtime::spawn_blocking(move || desktop.complete_draft(&app, &label, inputs))
            .await
            .map_err(|error| error.to_string())?;
    match response.outcome {
        Outcome::Ok { .. } => {
            launchers.remove_dialog(window.label());
            window.close().map_err(|error| error.to_string())
        }
        Outcome::Failed { error } => Err(error.message),
    }
}

#[tauri::command]
pub async fn launcher_submit(
    window: WebviewWindow,
    values: BTreeMap<String, Value>,
    launchers: State<'_, LauncherService>,
    desktop: State<'_, DesktopService>,
) -> Result<(), String> {
    let spec = launchers
        .inner
        .dialogs
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(window.label())
        .cloned()
        .ok_or_else(|| "launch dialog was not found".to_owned())?;
    let expected = spec
        .prompts
        .iter()
        .map(|prompt| prompt.id.as_str())
        .collect::<BTreeSet<_>>();
    let supplied = values.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if supplied != expected {
        return Err("all prompted inputs are required".into());
    }
    let command = open_command(spec, values);
    let app = window.app_handle().clone();
    let desktop = desktop.inner().clone();
    let response = tauri::async_runtime::spawn_blocking(move || desktop.execute(&app, command))
        .await
        .map_err(|error| error.to_string())?;
    match response.outcome {
        Outcome::Ok { .. } => {
            launchers.remove_dialog(window.label());
            window.close().map_err(|error| error.to_string())
        }
        Outcome::Failed { error } => Err(error.message),
    }
}

#[tauri::command]
pub fn launcher_cancel(
    window: WebviewWindow,
    launchers: State<'_, LauncherService>,
) -> Result<(), String> {
    launchers.remove_dialog(window.label());
    window.close().map_err(|error| error.to_string())
}

fn open_command(spec: LaunchSpec, values: BTreeMap<String, Value>) -> Command {
    let input_types = spec
        .prompts
        .iter()
        .map(|prompt| (prompt.id.as_str(), prompt.input_type.as_str()))
        .collect::<BTreeMap<_, _>>();
    let inputs = values
        .into_iter()
        .map(|(id, value)| {
            let input_type = input_types
                .get(id.as_str())
                .expect("submitted launcher input was validated")
                .to_string();
            (id, DirectInput { input_type, value })
        })
        .collect();
    Command::Open {
        widget_id: spec.widget_id,
        variant_id: spec.variant_id,
        options: BTreeMap::new(),
        inputs,
        presentation: Presentation::Focus,
    }
}

fn required_prompts(widget: &WidgetDescriptor, variant_id: &str) -> Vec<InputPrompt> {
    widget
        .inputs
        .iter()
        .filter(|port| port.required && port.variants.iter().any(|id| id == variant_id))
        .map(|port| InputPrompt {
            id: port.id.clone(),
            name: port.name.clone(),
            input_type: port.link_type.clone(),
        })
        .collect()
}

fn tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/dashboardd-32.png"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dashboardd_runtime::{WidgetLinkPort, WidgetVariant};

    #[test]
    fn generated_actions_prompt_for_required_inputs() {
        let widget = WidgetDescriptor {
            id: "sample".parse().unwrap(),
            name: "Sample".into(),
            description: String::new(),
            variants: vec![WidgetVariant {
                id: "details".into(),
                name: "Details".into(),
                width: 1,
                height: 1,
                frontend_url: String::new(),
                launch_frontend: true,
                focus: true,
            }],
            options: vec![],
            inputs: vec![WidgetLinkPort {
                id: "artifact".into(),
                name: "Artifact".into(),
                link_type: "artifact/v1".into(),
                variants: vec!["details".into()],
                required: true,
            }],
            outputs: vec![],
        };
        let service = LauncherService::new(&[widget]);
        let action = &service.inner.actions["widget-0"];
        assert_eq!(action.prompts[0].input_type, "artifact/v1");
        assert!(action.custom);
    }
}
