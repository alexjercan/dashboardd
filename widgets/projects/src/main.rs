//! Read-only local project and Git metadata widget backend.

use std::{
    collections::{BTreeMap, HashMap},
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use dashboardd_widget_protocol::{ServerToWidget, WidgetToServer};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    task::JoinSet,
    time::{Duration, Instant, interval_at, timeout},
};

const WIDGET_ID: &str = "projects";
const TICK_INTERVAL: Duration = Duration::from_secs(1);
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(60);
const LIST_INTERVAL: Duration = Duration::from_secs(15);
const TILE_INTERVAL: Duration = Duration::from_secs(5);
const FOCUS_INTERVAL: Duration = Duration::from_secs(3);
const GIT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_GIT_OUTPUT: u64 = 1024 * 1024;
const MAX_PROJECTS: usize = 200;
const MAX_WORKTREES: usize = 16;
const MAX_GIT_CONCURRENCY: usize = 8;
const MAX_CHANGES: usize = 500;
const MAX_BRANCHES: usize = 200;
const MAX_DOCUMENTS: usize = 32;
const MAX_DOCUMENT_BYTES: u64 = 128 * 1024;
const MAX_VIEWS: usize = 64;

#[derive(Clone)]
struct Settings {
    roots: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
struct ProjectLocation {
    project_id: String,
    name: String,
    worktree_id: String,
    worktree: String,
    primary: bool,
    path: PathBuf,
    git: bool,
    tatr: bool,
}

#[derive(Clone, Debug)]
struct ProjectGroup {
    id: String,
    name: String,
    worktrees: Vec<ProjectLocation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct WorktreeDescriptor {
    worktree_id: String,
    worktree: String,
    primary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ProjectSummary {
    project_id: String,
    project: String,
    worktree_id: String,
    worktree: String,
    primary: bool,
    git: bool,
    tatr: bool,
    branch: Option<String>,
    clean: Option<bool>,
    change_count: usize,
    ahead: u32,
    behind: u32,
    open_tasks: usize,
    in_progress_tasks: usize,
    latest_commit_unix: Option<u64>,
    latest_commit_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ProjectListItem {
    #[serde(flatten)]
    summary: ProjectSummary,
    worktrees: Vec<WorktreeDescriptor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ProjectLaunchItem {
    project_id: String,
    project: String,
    worktrees: Vec<WorktreeDescriptor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Change {
    path: String,
    kind: String,
    staged: bool,
    unstaged: bool,
    additions: Option<u32>,
    deletions: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Branch {
    name: String,
    current: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    latest_commit_unix: Option<u64>,
    latest_commit_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ProjectDetails {
    #[serde(flatten)]
    summary: ProjectSummary,
    changes: Vec<Change>,
    branches: Vec<Branch>,
    documents: Vec<String>,
    document: Option<ProjectDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ProjectDocument {
    path: String,
    content: String,
}

#[derive(Default)]
struct DiscoveryCache {
    projects: Vec<ProjectGroup>,
    refreshed_at: Option<Instant>,
}

struct ProjectView {
    project_id: String,
    project: String,
    worktree_id: String,
    worktree: String,
    focused: bool,
    document: Option<String>,
    next_refresh: Instant,
    previous: Option<Result<Value, String>>,
}

struct ListView {
    worktrees: HashMap<String, String>,
    next_refresh: Instant,
    previous: Option<Result<Value, String>>,
}

enum Runtime {
    List {
        instance_id: String,
        settings: Settings,
        discovery: DiscoveryCache,
        summaries: HashMap<String, ProjectSummary>,
        views: HashMap<String, ListView>,
    },
    Project {
        instance_id: String,
        settings: Settings,
        discovery: DiscoveryCache,
        launch_requested: bool,
        views: HashMap<String, ProjectView>,
    },
}

impl Runtime {
    fn instance_id(&self) -> &str {
        match self {
            Self::List { instance_id, .. } | Self::Project { instance_id, .. } => instance_id,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut runtime: Option<Runtime> = None;
    let mut ticks = interval_at(Instant::now(), TICK_INTERVAL);

    write_message(
        &mut stdout,
        WidgetToServer::Ready {
            widget_id: WIDGET_ID.into(),
        },
    )
    .await?;

    loop {
        tokio::select! {
            line = lines.next_line() => match line? {
                Some(line) => match dashboardd_widget_protocol::parse::<ServerToWidget>(&line) {
                    Ok(ServerToWidget::Initialize { instance_id, widget_id, variant_id, options }) if widget_id == WIDGET_ID => {
                        match (Settings::from_options(&options), variant_id.as_str()) {
                            (Ok(settings), "pulse") => runtime = Some(Runtime::List {
                                instance_id,
                                settings,
                                discovery: DiscoveryCache::default(),
                                summaries: HashMap::new(),
                                views: HashMap::new(),
                            }),
                            (Ok(settings), "brief") => runtime = Some(Runtime::Project {
                                instance_id,
                                settings,
                                discovery: DiscoveryCache::default(),
                                launch_requested: false,
                                views: HashMap::new(),
                            }),
                            (Ok(_), _) => write_error(&mut stdout, Some(instance_id), "invalid_variant", "unsupported Projects variant".into()).await?,
                            (Err(message), _) => write_error(&mut stdout, Some(instance_id), "invalid_options", message).await?,
                        }
                    }
                    Ok(ServerToWidget::Message { instance_id, payload }) => {
                        let handled = if let Some(active) = runtime.as_mut()
                            && active.instance_id() == instance_id
                        {
                            handle_command(active, &payload)
                        } else {
                            false
                        };
                        if !handled {
                            write_error(&mut stdout, Some(instance_id), "invalid_command", "unsupported Projects command".into()).await?;
                        }
                    }
                    Ok(ServerToWidget::Ping { nonce }) => write_message(&mut stdout, WidgetToServer::Pong { nonce }).await?,
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_error(
                        &mut stdout,
                        runtime.as_ref().map(|active| active.instance_id().into()),
                        "invalid_message",
                        error.to_string(),
                    ).await?,
                },
                None => break,
            },
            _ = ticks.tick(), if runtime.is_some() => {
                publish_runtime(&mut stdout, runtime.as_mut().expect("runtime exists")).await?;
            }
        }
    }
    Ok(())
}

impl Settings {
    fn from_options(options: &BTreeMap<String, Value>) -> Result<Self, String> {
        let source = options
            .get("roots")
            .and_then(Value::as_str)
            .ok_or("roots must be text")?;
        let roots = source
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(expand_root)
            .collect::<Result<Vec<_>, _>>()?;
        if roots.is_empty() {
            return Err("roots must contain at least one path".into());
        }
        Ok(Self { roots })
    }
}

fn expand_root(value: &str) -> Result<PathBuf, String> {
    let path = if value == "~" {
        PathBuf::from(env::var_os("HOME").ok_or("HOME is unavailable")?)
    } else if let Some(relative) = value.strip_prefix("~/") {
        PathBuf::from(env::var_os("HOME").ok_or("HOME is unavailable")?).join(relative)
    } else {
        PathBuf::from(value)
    };
    path.is_absolute()
        .then_some(path)
        .ok_or_else(|| "roots must be absolute or start with ~/".into())
}

fn handle_command(runtime: &mut Runtime, payload: &Value) -> bool {
    let Some(command) = payload.get("command").and_then(Value::as_str) else {
        return false;
    };
    match runtime {
        Runtime::List {
            discovery, views, ..
        } => {
            let Some(view_id) = valid_identifier(payload.get("view_id")) else {
                return false;
            };
            match command {
                "open_view" => {
                    limit_views(views, view_id);
                    views.insert(
                        view_id.into(),
                        ListView {
                            worktrees: HashMap::new(),
                            next_refresh: Instant::now(),
                            previous: None,
                        },
                    );
                    true
                }
                "select_worktree" => {
                    let Some(view) = views.get_mut(view_id) else {
                        return false;
                    };
                    let Some(project_id) = valid_identifier(payload.get("project_id")) else {
                        return false;
                    };
                    let Some(worktree_id) = valid_identifier(payload.get("worktree_id")) else {
                        return false;
                    };
                    view.worktrees.insert(project_id.into(), worktree_id.into());
                    view.next_refresh = Instant::now();
                    view.previous = None;
                    true
                }
                "refresh" => {
                    let Some(view) = views.get_mut(view_id) else {
                        return false;
                    };
                    discovery.refreshed_at = None;
                    view.next_refresh = Instant::now();
                    view.previous = None;
                    true
                }
                "release_view" => views.remove(view_id).is_some(),
                _ => false,
            }
        }
        Runtime::Project {
            launch_requested,
            views,
            ..
        } => {
            if command == "launch_catalog" {
                *launch_requested = true;
                return true;
            }
            let Some(view_id) = valid_identifier(payload.get("view_id")) else {
                return false;
            };
            match command {
                "select_project" => {
                    let Some(project_id) = valid_identifier(payload.get("project_id")) else {
                        return false;
                    };
                    let Some(project) = payload
                        .get("project")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty() && value.len() <= 256)
                    else {
                        return false;
                    };
                    let Some(worktree_id) = valid_identifier(payload.get("worktree_id")) else {
                        return false;
                    };
                    let Some(worktree) = payload
                        .get("worktree")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty() && value.len() <= 256)
                    else {
                        return false;
                    };
                    limit_views(views, view_id);
                    views.insert(
                        view_id.into(),
                        ProjectView {
                            project_id: project_id.into(),
                            project: project.into(),
                            worktree_id: worktree_id.into(),
                            worktree: worktree.into(),
                            focused: payload
                                .get("focused")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            document: None,
                            next_refresh: Instant::now(),
                            previous: None,
                        },
                    );
                    true
                }
                "set_focus" => {
                    let Some(view) = views.get_mut(view_id) else {
                        return false;
                    };
                    let Some(focused) = payload.get("focused").and_then(Value::as_bool) else {
                        return false;
                    };
                    view.focused = focused;
                    view.next_refresh = Instant::now();
                    true
                }
                "select_document" => {
                    let Some(view) = views.get_mut(view_id) else {
                        return false;
                    };
                    let Some(document) = payload
                        .get("document")
                        .and_then(Value::as_str)
                        .filter(|value| valid_document_path(value))
                    else {
                        return false;
                    };
                    view.document = Some(document.into());
                    view.next_refresh = Instant::now();
                    view.previous = None;
                    true
                }
                "refresh" => {
                    let Some(view) = views.get_mut(view_id) else {
                        return false;
                    };
                    view.next_refresh = Instant::now();
                    true
                }
                "release_view" => views.remove(view_id).is_some(),
                _ => false,
            }
        }
    }
}

fn limit_views<T>(views: &mut HashMap<String, T>, view_id: &str) {
    if !views.contains_key(view_id)
        && views.len() >= MAX_VIEWS
        && let Some(expired) = views.keys().next().cloned()
    {
        views.remove(&expired);
    }
}

fn valid_identifier(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
}

async fn publish_runtime<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    runtime: &mut Runtime,
) -> Result<(), Box<dyn Error>> {
    match runtime {
        Runtime::List {
            instance_id,
            settings,
            discovery,
            summaries,
            views,
        } => {
            refresh_discovery(settings, discovery, false).await;
            let due = views
                .iter()
                .filter(|(_, view)| Instant::now() >= view.next_refresh)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for view_id in due {
                let Some(view) = views.get_mut(&view_id) else {
                    continue;
                };
                view.next_refresh = Instant::now() + LIST_INTERVAL;
                let result = load_summaries(&discovery.projects, &view.worktrees, summaries)
                    .await
                    .and_then(|projects| {
                        serde_json::to_value(json!({
                            "view_id": view_id,
                            "projects": projects
                        }))
                        .map_err(|error| error.to_string())
                    });
                publish_changed(
                    stdout,
                    instance_id,
                    Some(&view_id),
                    &mut view.previous,
                    result,
                )
                .await?;
            }
        }
        Runtime::Project {
            instance_id,
            settings,
            discovery,
            launch_requested,
            views,
        } => {
            refresh_discovery(settings, discovery, false).await;
            if std::mem::take(launch_requested) {
                let projects = launch_catalog(&discovery.projects);
                write_message(
                    stdout,
                    WidgetToServer::Update {
                        instance_id: instance_id.clone(),
                        payload: json!({ "kind": "launch_catalog", "projects": projects }),
                    },
                )
                .await?;
            }
            let due = views
                .iter()
                .filter(|(_, view)| Instant::now() >= view.next_refresh)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for view_id in due {
                let Some(view) = views.get_mut(&view_id) else {
                    continue;
                };
                view.next_refresh = Instant::now()
                    + if view.focused {
                        FOCUS_INTERVAL
                    } else {
                        TILE_INTERVAL
                    };
                let result = match discovery
                    .projects
                    .iter()
                    .find(|project| project.id == view.project_id && project.name == view.project)
                    .and_then(|project| {
                        project.worktrees.iter().find(|worktree| {
                            worktree.worktree_id == view.worktree_id
                                && worktree.worktree == view.worktree
                        })
                    }) {
                    Some(project) => {
                        inspect_project_with_document(project, true, view.document.as_deref())
                            .await
                            .and_then(|details| {
                                serde_json::to_value(
                                    json!({ "view_id": view_id, "details": details }),
                                )
                                .map_err(|error| error.to_string())
                            })
                    }
                    None => Err("Selected project is unavailable".into()),
                };
                publish_changed(
                    stdout,
                    instance_id,
                    Some(&view_id),
                    &mut view.previous,
                    result,
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn launch_catalog(projects: &[ProjectGroup]) -> Vec<ProjectLaunchItem> {
    projects
        .iter()
        .map(|project| ProjectLaunchItem {
            project_id: project.id.clone(),
            project: project.name.clone(),
            worktrees: project
                .worktrees
                .iter()
                .map(|worktree| WorktreeDescriptor {
                    worktree_id: worktree.worktree_id.clone(),
                    worktree: worktree.worktree.clone(),
                    primary: worktree.primary,
                })
                .collect(),
        })
        .collect()
}

async fn refresh_discovery(settings: &Settings, cache: &mut DiscoveryCache, force: bool) {
    if !force
        && cache
            .refreshed_at
            .is_some_and(|at| at.elapsed() < DISCOVERY_INTERVAL)
    {
        return;
    }
    cache.projects = discover_projects(settings).await;
    cache.refreshed_at = Some(Instant::now());
}

#[derive(Clone)]
struct ProjectCandidate {
    name: String,
    path: PathBuf,
    git: bool,
    tatr: bool,
}

fn discover_candidates(settings: &Settings) -> Vec<ProjectCandidate> {
    let mut by_path = BTreeMap::new();
    for configured in &settings.roots {
        let Ok(root) = configured.canonicalize() else {
            continue;
        };
        let Ok(mut entries) =
            fs::read_dir(&root).and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
        else {
            continue;
        };
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with('.') || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if fs::symlink_metadata(entry.path())
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                continue;
            }
            let Ok(path) = entry.path().canonicalize() else {
                continue;
            };
            by_path
                .entry(path.clone())
                .or_insert_with(|| ProjectCandidate {
                    name: name.into(),
                    git: path.join(".git").is_dir() || path.join(".git").is_file(),
                    tatr: path.join("tasks").is_dir(),
                    path,
                });
        }
    }
    by_path.into_values().take(MAX_PROJECTS).collect()
}

async fn discover_projects(settings: &Settings) -> Vec<ProjectGroup> {
    let mut queue = discover_candidates(settings).into_iter();
    let mut running = JoinSet::new();
    let mut discovered = Vec::new();
    loop {
        while running.len() < MAX_GIT_CONCURRENCY {
            let Some(candidate) = queue.next() else {
                break;
            };
            running.spawn(discover_group(candidate));
        }
        let Some(result) = running.join_next().await else {
            break;
        };
        if let Ok(group) = result {
            discovered.push(group);
        }
    }
    discovered.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut groups = BTreeMap::new();
    for group in discovered {
        groups.entry(group.id.clone()).or_insert(group);
    }
    let mut projects = groups.into_values().collect::<Vec<_>>();
    projects.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    projects.truncate(MAX_PROJECTS);
    projects
}

async fn discover_group(candidate: ProjectCandidate) -> ProjectGroup {
    if !candidate.git {
        let project_id = opaque_id("project", &candidate.path);
        return ProjectGroup {
            id: project_id.clone(),
            name: candidate.name.clone(),
            worktrees: vec![ProjectLocation {
                project_id,
                name: candidate.name,
                worktree_id: opaque_id("worktree", &candidate.path),
                worktree: "Primary".into(),
                primary: true,
                path: candidate.path,
                git: false,
                tatr: candidate.tatr,
            }],
        };
    }
    let common = run_git(
        &candidate.path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await
    .ok()
    .and_then(|output| {
        PathBuf::from(String::from_utf8_lossy(&output).trim())
            .canonicalize()
            .ok()
    });
    let listing = run_git(&candidate.path, &["worktree", "list", "--porcelain", "-z"])
        .await
        .ok();
    let Some(common) = common else {
        return fallback_group(candidate);
    };
    let Some(listing) = listing else {
        return fallback_group(candidate);
    };
    let project_id = opaque_id("project", &common);
    let mut worktrees = parse_worktrees(&listing)
        .into_iter()
        .enumerate()
        .filter_map(|(index, parsed)| {
            if parsed.prunable {
                return None;
            }
            let path = parsed.path.canonicalize().ok()?;
            let worktree = if index == 0 {
                "Primary".into()
            } else if let Some(branch) = parsed.branch {
                clean_text(branch.strip_prefix("refs/heads/").unwrap_or(&branch), 256)
            } else {
                format!(
                    "Detached @ {}",
                    parsed.head.chars().take(7).collect::<String>()
                )
            };
            Some(ProjectLocation {
                project_id: project_id.clone(),
                name: candidate.name.clone(),
                worktree_id: opaque_id("worktree", &path),
                worktree,
                primary: index == 0,
                tatr: path.join("tasks").is_dir(),
                path,
                git: true,
            })
        })
        .take(MAX_WORKTREES)
        .collect::<Vec<_>>();
    if worktrees.is_empty() {
        return fallback_group(candidate);
    }
    let name = worktrees
        .first()
        .and_then(|worktree| worktree.path.file_name())
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .unwrap_or(candidate.name);
    for worktree in &mut worktrees {
        worktree.name.clone_from(&name);
    }
    ProjectGroup {
        id: project_id,
        name,
        worktrees,
    }
}

fn fallback_group(candidate: ProjectCandidate) -> ProjectGroup {
    let project_id = opaque_id("project", &candidate.path);
    ProjectGroup {
        id: project_id.clone(),
        name: candidate.name.clone(),
        worktrees: vec![ProjectLocation {
            project_id,
            name: candidate.name,
            worktree_id: opaque_id("worktree", &candidate.path),
            worktree: "Primary".into(),
            primary: true,
            path: candidate.path,
            git: candidate.git,
            tatr: candidate.tatr,
        }],
    }
}

struct ParsedWorktree {
    path: PathBuf,
    head: String,
    branch: Option<String>,
    prunable: bool,
}

fn parse_worktrees(output: &[u8]) -> Vec<ParsedWorktree> {
    let mut worktrees = Vec::new();
    let mut path = None;
    let mut head = String::new();
    let mut branch = None;
    let mut prunable = false;
    for field in output.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(path) = path.take() {
                worktrees.push(ParsedWorktree {
                    path,
                    head: std::mem::take(&mut head),
                    branch: branch.take(),
                    prunable,
                });
            }
            prunable = false;
        } else if let Some(value) = field.strip_prefix(b"worktree ") {
            path = Some(PathBuf::from(String::from_utf8_lossy(value).as_ref()));
        } else if let Some(value) = field.strip_prefix(b"HEAD ") {
            head = String::from_utf8_lossy(value).into_owned();
        } else if let Some(value) = field.strip_prefix(b"branch ") {
            branch = Some(String::from_utf8_lossy(value).into_owned());
        } else if field.starts_with(b"prunable") {
            prunable = true;
        }
    }
    worktrees
}

fn opaque_id(kind: &str, path: &Path) -> String {
    format!(
        "{kind}-{}",
        &blake3::hash(path.as_os_str().as_encoded_bytes()).to_hex()[..20]
    )
}

async fn load_summaries(
    projects: &[ProjectGroup],
    choices: &HashMap<String, String>,
    cache: &mut HashMap<String, ProjectSummary>,
) -> Result<Vec<ProjectListItem>, String> {
    let mut queue = projects.iter().filter_map(|project| {
        let selected = choices.get(&project.id);
        let worktree = selected
            .and_then(|id| {
                project
                    .worktrees
                    .iter()
                    .find(|worktree| &worktree.worktree_id == id)
            })
            .or_else(|| project.worktrees.iter().find(|worktree| worktree.primary))
            .or_else(|| project.worktrees.first())?;
        Some((project.clone(), worktree.clone()))
    });
    let mut running = JoinSet::new();
    let mut summaries = Vec::with_capacity(projects.len());
    loop {
        while running.len() < MAX_GIT_CONCURRENCY {
            let Some((project, worktree)) = queue.next() else {
                break;
            };
            running.spawn(async move {
                let result = inspect_project_with_document(&worktree, false, None)
                    .await
                    .map(|value| value.summary);
                (project, worktree, result)
            });
        }
        let Some(result) = running.join_next().await else {
            break;
        };
        let (project, worktree, result) = result.map_err(|_| "Project inspection failed")?;
        let summary = result.unwrap_or_else(|_| {
            cache
                .get(&worktree.worktree_id)
                .cloned()
                .unwrap_or_else(|| fallback_summary(&worktree))
        });
        cache.insert(worktree.worktree_id, summary.clone());
        summaries.push(ProjectListItem {
            summary,
            worktrees: project
                .worktrees
                .iter()
                .map(|worktree| WorktreeDescriptor {
                    worktree_id: worktree.worktree_id.clone(),
                    worktree: worktree.worktree.clone(),
                    primary: worktree.primary,
                })
                .collect(),
        });
    }
    cache.retain(|id, _| {
        projects.iter().any(|project| {
            project
                .worktrees
                .iter()
                .any(|worktree| &worktree.worktree_id == id)
        })
    });
    summaries.sort_by(|left, right| {
        left.summary
            .project
            .cmp(&right.summary.project)
            .then_with(|| left.summary.project_id.cmp(&right.summary.project_id))
    });
    Ok(summaries)
}

fn fallback_summary(project: &ProjectLocation) -> ProjectSummary {
    let (open_tasks, in_progress_tasks) = task_counts(&project.path);
    ProjectSummary {
        project_id: project.project_id.clone(),
        project: project.name.clone(),
        worktree_id: project.worktree_id.clone(),
        worktree: project.worktree.clone(),
        primary: project.primary,
        git: project.git,
        tatr: project.tatr,
        branch: None,
        clean: None,
        change_count: 0,
        ahead: 0,
        behind: 0,
        open_tasks,
        in_progress_tasks,
        latest_commit_unix: None,
        latest_commit_summary: None,
    }
}

#[cfg(test)]
async fn inspect_project(project: &ProjectLocation) -> Result<ProjectDetails, String> {
    inspect_project_with_document(project, true, None).await
}

async fn inspect_project_with_document(
    project: &ProjectLocation,
    include_documents: bool,
    selected_document: Option<&str>,
) -> Result<ProjectDetails, String> {
    let (open_tasks, in_progress_tasks) = task_counts(&project.path);
    let (documents, document) = if include_documents {
        load_project_documents(&project.path, selected_document)
    } else {
        (Vec::new(), None)
    };
    if !project.git {
        return Ok(ProjectDetails {
            summary: ProjectSummary {
                project_id: project.project_id.clone(),
                project: project.name.clone(),
                worktree_id: project.worktree_id.clone(),
                worktree: project.worktree.clone(),
                primary: project.primary,
                git: false,
                tatr: project.tatr,
                branch: None,
                clean: None,
                change_count: 0,
                ahead: 0,
                behind: 0,
                open_tasks,
                in_progress_tasks,
                latest_commit_unix: None,
                latest_commit_summary: None,
            },
            changes: Vec::new(),
            branches: Vec::new(),
            documents,
            document,
        });
    }

    let status = run_git(
        &project.path,
        &["status", "--porcelain=v2", "--branch", "-z"],
    )
    .await?;
    let mut parsed = parse_status(&status);
    let unstaged = run_git(
        &project.path,
        &["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"],
    )
    .await
    .unwrap_or_default();
    let staged = run_git(
        &project.path,
        &[
            "diff",
            "--cached",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
        ],
    )
    .await
    .unwrap_or_default();
    apply_numstat(&mut parsed.changes, &unstaged, false);
    apply_numstat(&mut parsed.changes, &staged, true);
    parsed
        .changes
        .sort_by(|left, right| left.path.cmp(&right.path));
    let change_count = parsed.changes.len();
    parsed.changes.truncate(MAX_CHANGES);

    let latest = run_git(&project.path, &["log", "-1", "--format=%ct%x00%s"])
        .await
        .unwrap_or_default();
    let (latest_commit_unix, latest_commit_summary) = parse_commit(&latest);
    let branches = run_git(
        &project.path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)%00%(upstream:track)%00%(committerdate:unix)%00%(subject)",
            "refs/heads",
        ],
    )
    .await
    .map(|output| parse_branches(&output))
    .unwrap_or_default();

    Ok(ProjectDetails {
        summary: ProjectSummary {
            project_id: project.project_id.clone(),
            project: project.name.clone(),
            worktree_id: project.worktree_id.clone(),
            worktree: project.worktree.clone(),
            primary: project.primary,
            git: true,
            tatr: project.tatr,
            branch: parsed.branch,
            clean: Some(change_count == 0),
            change_count,
            ahead: parsed.ahead,
            behind: parsed.behind,
            open_tasks,
            in_progress_tasks,
            latest_commit_unix,
            latest_commit_summary,
        },
        changes: parsed.changes,
        branches,
        documents,
        document,
    })
}

fn load_project_documents(
    root: &Path,
    selected_document: Option<&str>,
) -> (Vec<String>, Option<ProjectDocument>) {
    let Ok(root) = root.canonicalize() else {
        return (Vec::new(), None);
    };
    let mut documents = Vec::new();
    collect_project_documents(&root, &root, 0, &mut documents);
    documents.sort_by(|left, right| {
        document_rank(left)
            .cmp(&document_rank(right))
            .then_with(|| left.cmp(right))
    });
    documents.dedup();
    documents.truncate(MAX_DOCUMENTS);
    let selected = selected_document
        .filter(|candidate| documents.iter().any(|path| path == candidate))
        .or_else(|| documents.first().map(String::as_str));
    let document = selected.and_then(|relative| {
        let path = root.join(relative);
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
            return None;
        }
        let content = fs::read_to_string(path).ok()?;
        Some(ProjectDocument {
            path: relative.into(),
            content,
        })
    });
    (documents, document)
}

fn collect_project_documents(
    root: &Path,
    directory: &Path,
    depth: usize,
    values: &mut Vec<String>,
) {
    if values.len() >= MAX_DOCUMENTS || depth > 2 {
        return;
    }
    let Ok(mut entries) =
        fs::read_dir(directory).and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
    else {
        return;
    };
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        if values.len() >= MAX_DOCUMENTS {
            break;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if depth > 0 || entry.file_name() == "docs" {
                collect_project_documents(root, &path, depth + 1, values);
            }
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let extension = path.extension().and_then(|value| value.to_str());
        let root_document = depth == 0
            && matches!(
                name.as_str(),
                "README" | "README.md" | "AGENTS.md" | "CLAUDE.md"
            );
        if !root_document && !matches!(extension, Some("md" | "txt")) {
            continue;
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let Some(relative) = relative.to_str() else {
            continue;
        };
        if valid_document_path(relative) {
            values.push(relative.replace('\\', "/"));
        }
    }
}

fn document_rank(path: &str) -> u8 {
    match path {
        "README.md" | "README" => 0,
        "AGENTS.md" => 1,
        "CLAUDE.md" => 2,
        _ => 3,
    }
}

fn valid_document_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.starts_with('.'))
}

struct ParsedStatus {
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    changes: Vec<Change>,
}

fn parse_status(output: &[u8]) -> ParsedStatus {
    let mut parsed = ParsedStatus {
        branch: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
    };
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0;
    while index < records.len() {
        let record = String::from_utf8_lossy(records[index]);
        if let Some(value) = record.strip_prefix("# branch.head ") {
            parsed.branch = (value != "(detached)").then(|| clean_text(value, 256));
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(ahead) = part.strip_prefix('+').and_then(|value| value.parse().ok()) {
                    parsed.ahead = ahead;
                } else if let Some(behind) =
                    part.strip_prefix('-').and_then(|value| value.parse().ok())
                {
                    parsed.behind = behind;
                }
            }
        } else if record.starts_with("1 ") {
            if let Some(change) = parse_change_record(&record, 8, false) {
                parsed.changes.push(change);
            }
        } else if record.starts_with("2 ") {
            if let Some(change) = parse_change_record(&record, 9, false) {
                parsed.changes.push(change);
            }
            index += 1;
        } else if let Some(path) = record.strip_prefix("? ")
            && valid_relative_display_path(path)
        {
            parsed.changes.push(Change {
                path: path.into(),
                kind: "untracked".into(),
                staged: false,
                unstaged: true,
                additions: None,
                deletions: None,
            });
        }
        index += 1;
    }
    parsed
}

fn parse_change_record(record: &str, path_index: usize, untracked: bool) -> Option<Change> {
    let fields = record.splitn(path_index + 1, ' ').collect::<Vec<_>>();
    let xy = *fields.get(1)?;
    let path = *fields.get(path_index)?;
    if xy.len() != 2 || !valid_relative_display_path(path) {
        return None;
    }
    let bytes = xy.as_bytes();
    let staged = bytes[0] != b'.';
    let unstaged = bytes[1] != b'.';
    let kind = if untracked {
        "untracked"
    } else if xy.contains('R') {
        "renamed"
    } else if xy.contains('D') {
        "deleted"
    } else if xy.contains('A') {
        "added"
    } else {
        "modified"
    };
    Some(Change {
        path: path.into(),
        kind: kind.into(),
        staged,
        unstaged,
        additions: None,
        deletions: None,
    })
}

fn apply_numstat(changes: &mut [Change], output: &[u8], staged: bool) {
    for record in output.split(|byte| *byte == 0) {
        let Ok(record) = std::str::from_utf8(record) else {
            continue;
        };
        let mut fields = record.splitn(3, '\t');
        let (Some(additions), Some(deletions), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Some(change) = changes.iter_mut().find(|change| change.path == path) else {
            continue;
        };
        if change.staged == staged || (!staged && change.unstaged) {
            change.additions = additions.parse().ok();
            change.deletions = deletions.parse().ok();
        }
    }
}

fn parse_commit(output: &[u8]) -> (Option<u64>, Option<String>) {
    let mut fields = output.splitn(2, |byte| *byte == 0);
    let timestamp = fields
        .next()
        .and_then(|value| std::str::from_utf8(value).ok())
        .and_then(|value| value.trim().parse().ok());
    let summary = fields
        .next()
        .map(|value| clean_text(&String::from_utf8_lossy(value), 240))
        .filter(|value| !value.is_empty());
    (timestamp, summary)
}

fn parse_branches(output: &[u8]) -> Vec<Branch> {
    let mut branches = output
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let fields = line.split(|byte| *byte == 0).collect::<Vec<_>>();
            if fields.len() < 6 {
                return None;
            }
            let name = clean_text(&String::from_utf8_lossy(fields[0]), 256);
            if name.is_empty() {
                return None;
            }
            let upstream = clean_text(&String::from_utf8_lossy(fields[1]), 256);
            let track = String::from_utf8_lossy(fields[3]);
            let (ahead, behind) = parse_track(&track);
            Some(Branch {
                name,
                current: fields[2] == b"*",
                upstream: (!upstream.is_empty()).then_some(upstream),
                ahead,
                behind,
                latest_commit_unix: std::str::from_utf8(fields[4])
                    .ok()
                    .and_then(|value| value.parse().ok()),
                latest_commit_summary: Some(clean_text(&String::from_utf8_lossy(fields[5]), 240))
                    .filter(|value| !value.is_empty()),
            })
        })
        .collect::<Vec<_>>();
    branches.truncate(MAX_BRANCHES);
    branches
}

fn parse_track(value: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for word in value.trim_matches(['[', ']']).split([',', ' ']) {
        if let Some(value) = word.strip_prefix("ahead") {
            ahead = value.parse().unwrap_or(0);
        } else if let Some(value) = word.strip_prefix("behind") {
            behind = value.parse().unwrap_or(0);
        }
    }
    // Git separates the label and count with a space.
    let words = value
        .trim_matches(['[', ']'])
        .split([',', ' '])
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    for pair in words.windows(2) {
        match pair[0] {
            "ahead" => ahead = pair[1].parse().unwrap_or(ahead),
            "behind" => behind = pair[1].parse().unwrap_or(behind),
            _ => {}
        }
    }
    (ahead, behind)
}

fn valid_relative_display_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.split('/').any(|component| component == "..")
        && !path.chars().any(char::is_control)
}

fn clean_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn task_counts(project: &Path) -> (usize, usize) {
    let Ok(entries) = fs::read_dir(project.join("tasks")) else {
        return (0, 0);
    };
    let mut open = 0;
    let mut in_progress = 0;
    for entry in entries.flatten().take(1000) {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let task = entry.path().join("TASK.md");
        if !fs::metadata(&task).is_ok_and(|metadata| metadata.len() <= 256 * 1024) {
            continue;
        }
        let Ok(source) = fs::read_to_string(task) else {
            continue;
        };
        match source
            .lines()
            .find_map(|line| line.strip_prefix("- STATUS: "))
        {
            Some("OPEN") => open += 1,
            Some("IN_PROGRESS") => in_progress += 1,
            _ => {}
        }
    }
    (open, in_progress)
}

async fn run_git(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "diff.external=",
            "-c",
            "core.pager=cat",
        ])
        .args(arguments)
        .current_dir(directory)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| "Git is unavailable")?;
    let stdout = child.stdout.take().ok_or("Git stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr is unavailable")?;
    let result = timeout(GIT_TIMEOUT, async {
        let stdout_read = async {
            let mut output = Vec::new();
            stdout
                .take(MAX_GIT_OUTPUT + 1)
                .read_to_end(&mut output)
                .await
                .map(|_| output)
        };
        let stderr_read = async {
            let mut output = Vec::new();
            stderr
                .take(16 * 1024 + 1)
                .read_to_end(&mut output)
                .await
                .map(|_| output)
        };
        let (stdout, stderr, status) = tokio::join!(stdout_read, stderr_read, child.wait());
        (stdout, stderr, status)
    })
    .await
    .map_err(|_| "Git inspection timed out")?;
    let (stdout, _stderr, status) = result;
    let stdout = stdout.map_err(|_| "Could not read Git output")?;
    let status = status.map_err(|_| "Could not wait for Git")?;
    if !status.success() {
        return Err("Git inspection failed".into());
    }
    if stdout.len() as u64 > MAX_GIT_OUTPUT {
        return Err("Git output exceeded the limit".into());
    }
    Ok(stdout)
}

async fn publish_changed<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    instance_id: &str,
    view_id: Option<&str>,
    previous: &mut Option<Result<Value, String>>,
    result: Result<Value, String>,
) -> Result<(), Box<dyn Error>> {
    if previous.as_ref() == Some(&result) {
        return Ok(());
    }
    let payload = match &result {
        Ok(value) => value.clone(),
        Err(message) => json!({
            "view_id": view_id,
            "error": {"code": "projects_unavailable", "message": clean_text(message, 240)}
        }),
    };
    *previous = Some(result);
    write_message(
        stdout,
        WidgetToServer::Update {
            instance_id: instance_id.into(),
            payload,
        },
    )
    .await
}

async fn write_error<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    instance_id: Option<String>,
    code: &str,
    message: String,
) -> Result<(), Box<dyn Error>> {
    write_message(
        stdout,
        WidgetToServer::Error {
            instance_id,
            error: dashboardd_widget_protocol::ErrorData {
                code: code.into(),
                message,
            },
        },
    )
    .await
}

async fn write_message<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    message: WidgetToServer,
) -> Result<(), Box<dyn Error>> {
    stdout
        .write_all(format!("{}\n", dashboardd_widget_protocol::serialize(message)?).as_bytes())
        .await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temporary_root(name: &str) -> PathBuf {
        let root =
            env::temp_dir().join(format!("dashboardd-projects-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn discovers_immediate_visible_projects_and_deduplicates_roots() {
        let root = temporary_root("discover");
        fs::create_dir_all(root.join("alpha/.git")).unwrap();
        fs::create_dir_all(root.join("beta/tasks")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("file"), "not a project").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("alpha"), root.join("linked")).unwrap();
        let settings = Settings {
            roots: vec![root.clone(), root.clone(), root.join("missing")],
        };

        let projects = discover_projects(&settings).await;

        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].name, "alpha");
        assert!(projects[0].worktrees[0].git);
        assert_eq!(projects[1].name, "beta");
        assert!(projects[1].worktrees[0].tatr);
        assert!(!projects[0].id.contains(root.to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn caps_project_discovery_deterministically() {
        let root = temporary_root("limit");
        for index in (0..205).rev() {
            fs::create_dir_all(root.join(format!("project-{index:03}"))).unwrap();
        }
        let projects = discover_projects(&Settings {
            roots: vec![root.clone()],
        })
        .await;

        assert_eq!(projects.len(), MAX_PROJECTS);
        assert_eq!(projects.first().unwrap().name, "project-000");
        assert_eq!(projects.last().unwrap().name, "project-199");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_status_changes_branches_and_task_counts() {
        let status = b"# branch.head main\x00# branch.ab +2 -1\x001 M. N... 100644 100644 100644 a b src/main.rs\x00? notes.txt\x00";
        let parsed = parse_status(status);
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!((parsed.ahead, parsed.behind), (2, 1));
        assert_eq!(parsed.changes.len(), 2);
        assert_eq!(parsed.changes[0].path, "src/main.rs");
        assert!(parsed.changes[0].staged);
        assert_eq!(parsed.changes[1].kind, "untracked");

        let branches = parse_branches(
            b"main\x00origin/main\x00*\x00[ahead 2, behind 1]\x001700000000\x00Work\n",
        );
        assert_eq!(branches.len(), 1);
        assert_eq!((branches[0].ahead, branches[0].behind), (2, 1));
        assert!(branches[0].current);

        let root = temporary_root("tasks");
        for (id, status) in [("1", "OPEN"), ("2", "IN_PROGRESS"), ("3", "CLOSED")] {
            fs::create_dir_all(root.join("tasks").join(id)).unwrap();
            fs::write(
                root.join("tasks").join(id).join("TASK.md"),
                format!("# Task\n\n- STATUS: {status}\n"),
            )
            .unwrap();
        }
        assert_eq!(task_counts(&root), (1, 1));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn inspects_a_git_project_without_exposing_its_path() {
        let root = temporary_root("git");
        let project = root.join("sample");
        fs::create_dir_all(&project).unwrap();
        let run = |arguments: &[&str]| {
            let status = std::process::Command::new("git")
                .args(arguments)
                .current_dir(&project)
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Fixture"]);
        run(&["config", "user.email", "fixture@example.invalid"]);
        let mut file = fs::File::create(project.join("README.md")).unwrap();
        writeln!(file, "fixture").unwrap();
        fs::create_dir(project.join("docs")).unwrap();
        fs::write(project.join("docs/guide.md"), "# Guide\n").unwrap();
        fs::write(project.join(".secret.md"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", project.join("docs/linked.md")).unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "Initial fixture"]);
        writeln!(file, "change").unwrap();
        let canonical = project.canonicalize().unwrap();
        let location = ProjectLocation {
            project_id: opaque_id("project", &canonical),
            name: "sample".into(),
            worktree_id: opaque_id("worktree", &canonical),
            worktree: "Primary".into(),
            primary: true,
            path: canonical,
            git: true,
            tatr: false,
        };

        let details = inspect_project(&location).await.unwrap();
        let payload = serde_json::to_string(&details).unwrap();

        assert_eq!(details.summary.branch.as_deref(), Some("main"));
        assert_eq!(details.summary.change_count, 1);
        assert_eq!(details.changes[0].path, "README.md");
        assert_eq!(details.documents, ["README.md", "docs/guide.md"]);
        assert_eq!(details.document.as_ref().unwrap().path, "README.md");
        assert!(
            details
                .document
                .as_ref()
                .unwrap()
                .content
                .contains("fixture")
        );
        assert!(!payload.contains(".secret.md"));
        assert!(!payload.contains("linked.md"));
        assert!(!payload.contains(root.to_string_lossy().as_ref()));
        assert!(!payload.contains("fixture@example.invalid"));

        let worktree = root.join("sample-worktree");
        let status = std::process::Command::new("git")
            .args(["worktree", "add", "-q", "-b", "feature/worktree"])
            .arg(&worktree)
            .current_dir(&project)
            .status()
            .unwrap();
        assert!(status.success());
        let groups = discover_projects(&Settings {
            roots: vec![root.clone()],
        })
        .await;
        assert_eq!(groups.len(), 1, "linked checkout is grouped with Primary");
        assert_eq!(groups[0].worktrees.len(), 2);
        assert_eq!(groups[0].worktrees[0].worktree, "Primary");
        assert_eq!(groups[0].worktrees[1].worktree, "feature/worktree");
        let catalog = launch_catalog(&groups);
        assert_eq!(catalog[0].project, "sample");
        assert_eq!(catalog[0].worktrees.len(), 2);
        let descriptor = serde_json::to_string(&catalog).unwrap();
        assert!(!descriptor.contains(root.to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_multiline_roots_and_commands() {
        let home = env::var("HOME").unwrap();
        let settings = Settings::from_options(&BTreeMap::from([(
            "roots".into(),
            Value::from(format!("{home}\n~/personal\n\n")),
        )]))
        .unwrap();
        assert_eq!(settings.roots.len(), 2);
        assert!(
            Settings::from_options(&BTreeMap::from([
                ("roots".into(), Value::from("relative"),)
            ]))
            .is_err()
        );

        let mut runtime = Runtime::Project {
            instance_id: "projects-1".into(),
            settings,
            discovery: DiscoveryCache::default(),
            launch_requested: false,
            views: HashMap::new(),
        };
        assert!(handle_command(
            &mut runtime,
            &json!({"command": "launch_catalog"})
        ));
        assert!(handle_command(
            &mut runtime,
            &json!({
                "command": "select_project",
                "view_id": "page-1",
                "project_id": "project-1",
                "project": "sample",
                "worktree_id": "worktree-1",
                "worktree": "Primary"
            })
        ));
        assert!(handle_command(
            &mut runtime,
            &json!({
                "command": "select_document",
                "view_id": "page-1",
                "document": "docs/guide.md"
            })
        ));
        assert!(!handle_command(
            &mut runtime,
            &json!({
                "command": "select_document",
                "view_id": "page-1",
                "document": "../secret"
            })
        ));
        assert!(!handle_command(
            &mut runtime,
            &json!({"command": "select_project", "view_id": "../bad"})
        ));
    }
}
