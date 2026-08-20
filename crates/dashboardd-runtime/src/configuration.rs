//! Read-only user configuration and effective public theme.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tokio::{sync::broadcast, task::JoinHandle};

use crate::{
    event::{RuntimeErrorData, RuntimeEvent},
    instance::InstanceManager,
};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UserConfiguration {
    pub theme: ThemeOverrides,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ThemeOverrides {
    pub fonts: FontOverrides,
    pub canvas: Option<String>,
    pub surface: Option<String>,
    pub selection: Option<String>,
    pub text: Option<String>,
    pub text_bright: Option<String>,
    pub text_muted: Option<String>,
    pub text_dim: Option<String>,
    pub accent: Option<String>,
    pub border: Option<String>,
    pub success: Option<String>,
    pub danger: Option<String>,
    pub secondary: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FontOverrides {
    pub sans: Option<String>,
    pub mono: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeFonts {
    pub sans: String,
    pub mono: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Theme {
    pub fonts: ThemeFonts,
    pub canvas: String,
    pub surface: String,
    pub selection: String,
    pub text: String,
    pub text_bright: String,
    pub text_muted: String,
    pub text_dim: String,
    pub accent: String,
    pub border: String,
    pub success: String,
    pub danger: String,
    pub secondary: String,
}

#[derive(Clone)]
pub struct ThemeManager(Arc<RwLock<Theme>>);

impl ThemeManager {
    pub fn new(theme: Theme) -> Self {
        Self(Arc::new(RwLock::new(theme)))
    }

    pub fn current(&self) -> Theme {
        self.0.read().expect("theme lock is not poisoned").clone()
    }

    fn replace(&self, theme: Theme) {
        *self.0.write().expect("theme lock is not poisoned") = theme;
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            fonts: ThemeFonts {
                sans: "Iosevka".into(),
                mono: "Iosevka".into(),
            },
            canvas: "#181818".into(),
            surface: "#282828".into(),
            selection: "#453d41".into(),
            text: "#e4e4ef".into(),
            text_bright: "#f4f4ff".into(),
            text_muted: "#65737e".into(),
            text_dim: "#535057".into(),
            accent: "#ffdd33".into(),
            border: "#96a6c8".into(),
            success: "#73c936".into(),
            danger: "#f43841".into(),
            secondary: "#9e95c7".into(),
        }
    }
}

impl ThemeOverrides {
    pub fn effective(&self) -> Result<Theme, String> {
        let defaults = Theme::default();
        Ok(Theme {
            fonts: ThemeFonts {
                sans: family("sans", self.fonts.sans.as_ref(), defaults.fonts.sans)?,
                mono: family("mono", self.fonts.mono.as_ref(), defaults.fonts.mono)?,
            },
            canvas: color("canvas", self.canvas.as_ref(), defaults.canvas)?,
            surface: color("surface", self.surface.as_ref(), defaults.surface)?,
            selection: color("selection", self.selection.as_ref(), defaults.selection)?,
            text: color("text", self.text.as_ref(), defaults.text)?,
            text_bright: color(
                "text_bright",
                self.text_bright.as_ref(),
                defaults.text_bright,
            )?,
            text_muted: color("text_muted", self.text_muted.as_ref(), defaults.text_muted)?,
            text_dim: color("text_dim", self.text_dim.as_ref(), defaults.text_dim)?,
            accent: color("accent", self.accent.as_ref(), defaults.accent)?,
            border: color("border", self.border.as_ref(), defaults.border)?,
            success: color("success", self.success.as_ref(), defaults.success)?,
            danger: color("danger", self.danger.as_ref(), defaults.danger)?,
            secondary: color("secondary", self.secondary.as_ref(), defaults.secondary)?,
        })
    }
}

pub fn load(path: &Path) -> Result<UserConfiguration, String> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
    };
    let configuration: UserConfiguration = toml::from_str(&source)
        .map_err(|error| format!("invalid configuration {}: {error}", path.display()))?;
    configuration.theme.effective()?;
    Ok(configuration)
}

pub fn watch(
    path: PathBuf,
    themes: ThemeManager,
    instances: InstanceManager,
    mut shutdown: broadcast::Receiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut watcher = match notify::recommended_watcher(move |event| {
            let _ = events_tx.send(event);
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                publish_error(
                    &instances,
                    format!("could not watch configuration: {error}"),
                );
                return;
            }
        };
        let mut watch_root = nearest_watch_root(&path);
        if let Err(error) = watcher.watch(&watch_root, RecursiveMode::NonRecursive) {
            publish_error(
                &instances,
                format!("could not watch configuration: {error}"),
            );
            return;
        }
        tracing::info!(path = %path.display(), root = %watch_root.display(), "watching user configuration");
        let mut had_error = false;
        loop {
            tokio::select! {
                _ = shutdown.recv() => break,
                event = events_rx.recv() => {
                    let Some(event) = event else { break };
                    let event = match event {
                        Ok(event) => event,
                        Err(error) => {
                            let message = format!("configuration watch failed: {error}");
                            tracing::error!(%message);
                            publish_error(&instances, message);
                            had_error = true;
                            continue;
                        }
                    };
                    let parent = path.parent().unwrap_or_else(|| Path::new("."));
                    if !event.paths.iter().any(|changed| {
                        changed == &path || parent.starts_with(changed)
                    }) {
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    while events_rx.try_recv().is_ok() {}
                    let next_root = nearest_watch_root(&path);
                    if next_root != watch_root {
                        let _ = watcher.unwatch(&watch_root);
                        if let Err(error) = watcher.watch(&next_root, RecursiveMode::NonRecursive) {
                            let message = format!("could not watch configuration: {error}");
                            tracing::error!(%message);
                            publish_error(&instances, message);
                            had_error = true;
                            continue;
                        }
                        watch_root = next_root;
                    }
                    match load(&path)
                        .and_then(|configuration| configuration.theme.effective())
                    {
                        Ok(theme) => {
                            let changed = themes.current() != theme;
                            themes.replace(theme.clone());
                            if changed || had_error {
                                tracing::info!(path = %path.display(), "reloaded user theme");
                                instances.publish(RuntimeEvent::ThemeUpdated {
                                    theme: Box::new(theme),
                                });
                            }
                            had_error = false;
                        }
                        Err(error) => {
                            let message = format!("Configuration reload failed: {error}");
                            tracing::error!(path = %path.display(), %error, "could not reload user configuration");
                            publish_error(&instances, message);
                            had_error = true;
                        }
                    }
                }
            }
        }
    })
}

fn nearest_watch_root(path: &Path) -> PathBuf {
    path.ancestors()
        .find(|candidate| candidate.is_dir())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn publish_error(instances: &InstanceManager, message: String) {
    instances.publish(RuntimeEvent::ConfigurationError {
        error: RuntimeErrorData {
            code: "invalid_configuration".into(),
            message,
        },
    });
}

fn family(name: &str, override_value: Option<&String>, default: String) -> Result<String, String> {
    let Some(value) = override_value else {
        return Ok(default);
    };
    if !value.is_empty()
        && value.trim() == value
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'_' | b'-'))
    {
        Ok(value.clone())
    } else {
        Err(format!(
            "theme.fonts.{name} must contain only ASCII letters, digits, spaces, underscores, or hyphens"
        ))
    }
}

fn color(name: &str, override_value: Option<&String>, default: String) -> Result<String, String> {
    let Some(value) = override_value else {
        return Ok(default);
    };
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(format!(
            "theme.{name} must be a six-digit hexadecimal color"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_uses_defaults() {
        let path = std::env::temp_dir().join(format!(
            "dashboardd-missing-config-{}-{}.toml",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let configuration = load(&path).unwrap();
        assert_eq!(configuration.theme.effective().unwrap(), Theme::default());
        assert_eq!(configuration.theme.effective().unwrap(), Theme::default());
    }

    #[test]
    fn parses_theme() {
        let configuration: UserConfiguration = toml::from_str(
            r##"
[theme]
accent = "#AABBCC"

[theme.fonts]
sans = "Iosevka Term"
mono = "Iosevka Term Mono"
"##,
        )
        .unwrap();
        let theme = configuration.theme.effective().unwrap();
        assert_eq!(theme.accent, "#aabbcc");
        assert_eq!(theme.fonts.sans, "Iosevka Term");
        assert_eq!(theme.fonts.mono, "Iosevka Term Mono");
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_colors() {
        assert!(toml::from_str::<UserConfiguration>("unknown = true").is_err());
        let configuration: UserConfiguration =
            toml::from_str("[theme]\naccent = 'yellow'").unwrap();
        assert!(configuration.theme.effective().is_err());
        let configuration: UserConfiguration =
            toml::from_str("[theme.fonts]\nmono = 'Iosevka; monospace'").unwrap();
        assert!(configuration.theme.effective().is_err());
    }
}
