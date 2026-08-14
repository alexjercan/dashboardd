//! Read-only Tatr task widget backend.

mod filter;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    error::Error,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::SystemTime,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use dashboard_protocol::{ServerToWidget, WidgetToServer};
use filter::Expr;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::{Duration, Instant, interval_at, timeout};

const WIDGET_ID: &str = "tatr-tasks";
const UPDATE_INTERVAL: Duration = Duration::from_secs(2);
const GIT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_GIT_OUTPUT: u64 = 1024 * 1024;
const MAX_WORKTREES: usize = 16;
const MAX_VIEWS: usize = 64;
const MAX_TEXT_ARTIFACT_BYTES: u64 = 256 * 1024;
const MAX_IMAGE_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 200;
const MAX_ARTIFACT_DEPTH: usize = 32;
const MAX_ARTIFACT_PATH_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Status {
    Open,
    InProgress,
    Closed,
}

impl Status {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "OPEN" => Some(Self::Open),
            "IN_PROGRESS" => Some(Self::InProgress),
            "CLOSED" => Some(Self::Closed),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "OPEN",
            Self::InProgress => "IN_PROGRESS",
            Self::Closed => "CLOSED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Task {
    id: String,
    project_id: String,
    project: String,
    worktree_id: String,
    worktree: String,
    title: String,
    status: Status,
    priority: u32,
    tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Snapshot {
    tasks: Vec<Task>,
}

#[derive(Debug, Clone, Copy)]
enum Sort {
    Created,
    Priority,
    Title,
}

struct Settings {
    root: PathBuf,
    recursive: bool,
    filter: Option<Expr>,
    sort: Sort,
}

#[derive(Default)]
struct Loader {
    cache: HashMap<PathBuf, CachedTask>,
}

#[derive(Clone)]
struct CachedTask {
    length: u64,
    modified: Option<SystemTime>,
    task: Task,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectSelection {
    project_id: String,
    project: String,
    worktree_id: String,
    worktree: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskSelection {
    project_id: String,
    project: String,
    worktree_id: String,
    worktree: String,
    task_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ArtifactKind {
    Markdown,
    Html,
    Text,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ArtifactDescriptor {
    path: String,
    kind: ArtifactKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DetailsSnapshot {
    project_id: String,
    project: String,
    worktree_id: String,
    worktree: String,
    task_id: String,
    artifact: String,
    artifacts: Vec<ArtifactDescriptor>,
    kind: ArtifactKind,
    content: String,
    media_type: Option<String>,
}

enum Runtime {
    Full {
        instance_id: String,
        settings: Settings,
        loader: Loader,
        views: HashMap<String, FullView>,
    },
    Details {
        instance_id: String,
        settings: Settings,
        views: HashMap<String, DetailView>,
    },
}

struct FullView {
    selection: Option<ProjectSelection>,
    project_path: Option<PathBuf>,
    previous: Option<Result<Value, String>>,
}

struct DetailView {
    selection: TaskSelection,
    project_path: PathBuf,
    artifact: String,
    previous: Option<Result<Value, String>>,
}

impl Runtime {
    fn instance_id(&self) -> &str {
        match self {
            Self::Full { instance_id, .. } | Self::Details { instance_id, .. } => instance_id,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut runtime: Option<Runtime> = None;
    let mut updates = interval_at(Instant::now(), UPDATE_INTERVAL);

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
                Some(line) => match dashboard_protocol::parse::<ServerToWidget>(&line) {
                    Ok(ServerToWidget::Initialize { instance_id, widget_id, variant_id, options }) if widget_id == WIDGET_ID => {
                        match (Settings::from_options(&options), variant_id.as_str()) {
                            (Ok(settings), "full") => runtime = Some(Runtime::Full {
                                instance_id,
                                settings,
                                loader: Loader::default(),
                                views: HashMap::new(),
                            }),
                            (Ok(settings), "details") => runtime = Some(Runtime::Details {
                                instance_id,
                                settings,
                                views: HashMap::new(),
                            }),
                            (Ok(_), _) => write_error(&mut stdout, Some(instance_id), "invalid_variant", "unsupported Tatr Tasks variant".into()).await?,
                            (Err(message), _) => write_error(&mut stdout, Some(instance_id), "invalid_options", message).await?,
                        }
                    }
                    Ok(ServerToWidget::Message { instance_id, payload }) => {
                        let handled = if let Some(active) = runtime.as_mut()
                            && instance_id == active.instance_id()
                        {
                            handle_command(&mut stdout, active, &payload).await?
                        } else {
                            false
                        };
                        if !handled {
                            write_error(
                                &mut stdout,
                                Some(instance_id),
                                "invalid_command",
                                "unsupported Tatr Tasks command".into(),
                            ).await?;
                        }
                    }
                    Ok(ServerToWidget::Ping { nonce }) => write_message(
                        &mut stdout,
                        WidgetToServer::Pong { nonce },
                    ).await?,
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_error(
                        &mut stdout,
                        runtime.as_ref().map(|runtime| runtime.instance_id().into()),
                        "invalid_message",
                        error.to_string(),
                    ).await?,
                },
                None => break,
            },
            _ = updates.tick(), if runtime.is_some() => {
                publish_runtime(
                    &mut stdout,
                    runtime.as_mut().expect("runtime is checked"),
                    false,
                ).await?;
            }
        }
    }
    Ok(())
}

impl Settings {
    fn from_options(options: &BTreeMap<String, Value>) -> Result<Self, String> {
        let root = options
            .get("root")
            .and_then(Value::as_str)
            .ok_or("root must be text")?;
        let root = expand_root(root)?;
        let recursive = options
            .get("recursive")
            .and_then(Value::as_bool)
            .ok_or("recursive must be Boolean")?;
        let filter = options
            .get("filter")
            .and_then(Value::as_str)
            .map(filter::compile)
            .transpose()
            .map_err(|error| format!("invalid filter: {error}"))?
            .flatten();
        let sort = match options.get("sort").and_then(Value::as_str) {
            None | Some("priority") => Sort::Priority,
            Some("created") => Sort::Created,
            Some("title") => Sort::Title,
            _ => return Err("sort must be created, priority, or title".into()),
        };
        Ok(Self {
            root,
            recursive,
            filter,
            sort,
        })
    }
}

impl Loader {
    fn load(
        &mut self,
        settings: &Settings,
        selected: Option<(&ProjectSelection, &Path)>,
    ) -> Result<Snapshot, String> {
        if !settings.root.is_dir() {
            return Err("Tatr root is unavailable".into());
        }
        let projects = selected
            .map(|(_, path)| vec![path.to_path_buf()])
            .map_or_else(|| discover_projects(&settings.root, settings.recursive), Ok)?;
        let mut seen = HashSet::new();
        let mut tasks = Vec::new();
        for project in projects {
            let project_name = selected
                .map(|(selection, _)| selection.project.clone())
                .unwrap_or_else(|| project_name(&settings.root, &project));
            let identity = selected
                .map(|(selection, _)| selection.clone())
                .unwrap_or_else(|| default_project_selection(&project_name, &project));
            let entries = sorted_entries(&project.join("tasks"))
                .map_err(|_| format!("Could not read tasks for project {project_name:?}"))?;
            for entry in entries {
                let id = entry.file_name().to_string_lossy().into_owned();
                if !valid_task_id(&id) || !entry.path().is_dir() {
                    continue;
                }
                let path = entry.path().join("TASK.md");
                let metadata = fs::metadata(&path).map_err(|_| {
                    format!("Task {id:?} in project {project_name:?} is unreadable")
                })?;
                seen.insert(path.clone());
                let modified = metadata.modified().ok();
                let task = if let Some(cached) = self.cache.get(&path).filter(|cached| {
                    cached.length == metadata.len()
                        && cached.modified == modified
                        && cached.task.project_id == identity.project_id
                        && cached.task.project == identity.project
                        && cached.task.worktree_id == identity.worktree_id
                        && cached.task.worktree == identity.worktree
                }) {
                    cached.task.clone()
                } else {
                    let source = fs::read_to_string(&path).map_err(|_| {
                        format!("Task {id:?} in project {project_name:?} is unreadable")
                    })?;
                    let task = parse_task(&source, id.clone(), &identity).map_err(|error| {
                        format!("Invalid task {id:?} in project {project_name:?}: {error}")
                    })?;
                    self.cache.insert(
                        path,
                        CachedTask {
                            length: metadata.len(),
                            modified,
                            task: task.clone(),
                        },
                    );
                    task
                };
                if settings
                    .filter
                    .as_ref()
                    .is_none_or(|expression| filter::evaluate(expression, &task))
                {
                    tasks.push(task);
                }
            }
        }
        self.cache.retain(|path, _| seen.contains(path));
        sort_tasks(&mut tasks, settings.sort);
        Ok(Snapshot { tasks })
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
    if !path.is_absolute() {
        return Err("root must be absolute or start with ~/".into());
    }
    Ok(path)
}

fn discover_projects(root: &Path, recursive: bool) -> Result<Vec<PathBuf>, String> {
    if !recursive {
        return root
            .join("tasks")
            .is_dir()
            .then(|| vec![root.to_path_buf()])
            .ok_or_else(|| "Tatr root does not contain a tasks directory".into());
    }
    let mut projects = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        if directory.join("tasks").is_dir() {
            projects.push(directory.clone());
        }
        for entry in sorted_entries(&directory).map_err(|_| "Could not scan Tatr root")? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.')
                || matches!(name.as_ref(), "node_modules" | "target" | "build" | "dist")
            {
                continue;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push(entry.path());
            }
        }
    }
    projects.sort();
    Ok(projects)
}

fn sorted_entries(path: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn project_name(root: &Path, project: &Path) -> String {
    project
        .strip_prefix(root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| relative.to_string_lossy().into_owned())
        .or_else(|| {
            project
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "project".into())
}

fn default_project_selection(project: &str, path: &Path) -> ProjectSelection {
    ProjectSelection {
        project_id: opaque_id("project", path),
        project: project.into(),
        worktree_id: opaque_id("worktree", path),
        worktree: "Primary".into(),
    }
}

async fn resolve_selected_project(
    settings: &Settings,
    selection: &ProjectSelection,
) -> Result<PathBuf, String> {
    for candidate in discover_projects(&settings.root, settings.recursive)? {
        let candidate_name = project_name(&settings.root, &candidate);
        let canonical = match candidate.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        let git = canonical.join(".git").is_dir() || canonical.join(".git").is_file();
        if !git {
            let fallback = default_project_selection(&candidate_name, &canonical);
            if fallback == *selection {
                return Ok(canonical);
            }
            continue;
        }
        let common = run_git(
            &canonical,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await
        .ok()
        .and_then(|output| {
            PathBuf::from(String::from_utf8_lossy(&output).trim())
                .canonicalize()
                .ok()
        });
        let listing = run_git(&canonical, &["worktree", "list", "--porcelain", "-z"])
            .await
            .ok();
        let (Some(common), Some(listing)) = (common, listing) else {
            continue;
        };
        let common_id = opaque_id("project", &common);
        let fallback_id = opaque_id("project", &canonical);
        if selection.project_id != common_id && selection.project_id != fallback_id {
            continue;
        }
        for path in parse_worktree_paths(&listing)
            .into_iter()
            .take(MAX_WORKTREES)
        {
            let Ok(path) = path.canonicalize() else {
                continue;
            };
            if opaque_id("worktree", &path) == selection.worktree_id && path.join("tasks").is_dir()
            {
                return Ok(path);
            }
        }
    }
    Err("Selected project worktree is unavailable".into())
}

fn parse_worktree_paths(output: &[u8]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut path = None;
    let mut prunable = false;
    for field in output.split(|byte| *byte == 0) {
        if field.is_empty() {
            if !prunable && let Some(path) = path.take() {
                paths.push(path);
            }
            path = None;
            prunable = false;
        } else if let Some(value) = field.strip_prefix(b"worktree ") {
            path = Some(PathBuf::from(String::from_utf8_lossy(value).as_ref()));
        } else if field.starts_with(b"prunable") {
            prunable = true;
        }
    }
    paths
}

fn opaque_id(kind: &str, path: &Path) -> String {
    format!(
        "{kind}-{}",
        &blake3::hash(path.as_os_str().as_encoded_bytes()).to_hex()[..20]
    )
}

fn valid_task_id(value: &str) -> bool {
    value.len() == 15
        && value.as_bytes()[8] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit())
}

fn parse_task(source: &str, id: String, selection: &ProjectSelection) -> Result<Task, String> {
    let (title_line, rest) = source
        .split_once('\n')
        .ok_or("title must end with a newline")?;
    let title = title_line
        .strip_prefix("# ")
        .ok_or("title must start with '# '")?
        .to_string();
    let (status_line, rest) = next_metadata_line(rest).ok_or("missing status")?;
    let status = Status::parse(
        status_line
            .strip_prefix("- STATUS: ")
            .ok_or("invalid status field")?,
    )
    .ok_or("status must be OPEN, IN_PROGRESS, or CLOSED")?;
    let (priority_line, rest) = next_metadata_line(rest).ok_or("missing priority")?;
    let priority = priority_line
        .strip_prefix("- PRIORITY: ")
        .ok_or("invalid priority field")?
        .parse::<u32>()
        .map_err(|_| "priority must be a non-negative integer")?;
    let (tags_line, _) = next_metadata_line(rest).ok_or("missing tags")?;
    let tags = tags_line
        .strip_prefix("- TAGS: ")
        .ok_or("invalid tags field")?
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect();
    Ok(Task {
        id,
        project_id: selection.project_id.clone(),
        project: selection.project.clone(),
        worktree_id: selection.worktree_id.clone(),
        worktree: selection.worktree.clone(),
        title,
        status,
        priority,
        tags,
    })
}

fn next_metadata_line(source: &str) -> Option<(&str, &str)> {
    source
        .trim_start_matches(char::is_whitespace)
        .split_once('\n')
}

fn sort_tasks(tasks: &mut [Task], sort: Sort) {
    tasks.sort_by(|left, right| match sort {
        Sort::Created => left.id.cmp(&right.id),
        Sort::Priority => right.priority.cmp(&left.priority),
        Sort::Title => left.title.cmp(&right.title),
    });
}

fn parse_project_selection(payload: &Value) -> Option<ProjectSelection> {
    let project_id = payload.get("project_id")?.as_str()?;
    let project = payload.get("project")?.as_str()?;
    let worktree_id = payload.get("worktree_id")?.as_str()?;
    let worktree = payload.get("worktree")?.as_str()?;
    if [project_id, project, worktree_id, worktree]
        .iter()
        .any(|value| value.is_empty() || value.len() > 256)
    {
        return None;
    }
    Some(ProjectSelection {
        project_id: project_id.into(),
        project: project.into(),
        worktree_id: worktree_id.into(),
        worktree: worktree.into(),
    })
}

fn parse_selection(payload: &Value) -> Option<TaskSelection> {
    let selection = parse_project_selection(payload)?;
    let task_id = payload.get("task_id")?.as_str()?;
    if !valid_task_id(task_id) {
        return None;
    }
    Some(TaskSelection {
        project_id: selection.project_id,
        project: selection.project,
        worktree_id: selection.worktree_id,
        worktree: selection.worktree,
        task_id: task_id.into(),
    })
}

fn load_details(
    project: &Path,
    selection: &TaskSelection,
    selected_artifact: &str,
) -> Result<DetailsSnapshot, String> {
    let task_directory = resolve_task_directory(project, selection)?;
    let artifacts = list_artifacts(&task_directory)?;
    let descriptor = artifacts
        .iter()
        .find(|artifact| artifact.path == selected_artifact)
        .cloned()
        .ok_or_else(|| "Selected artifact is unavailable".to_string())?;
    let path = task_directory.join(Path::new(&descriptor.path));
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Selected artifact is unavailable".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Selected artifact must be a regular file".into());
    }
    let canonical_path =
        fs::canonicalize(&path).map_err(|_| "Selected artifact is unavailable".to_string())?;
    if !canonical_path.starts_with(&task_directory) {
        return Err("Selected artifact escapes the task directory".into());
    }
    let bytes =
        fs::read(&canonical_path).map_err(|_| "Selected artifact is unreadable".to_string())?;
    let (content, media_type) = match descriptor.kind {
        ArtifactKind::Image => (
            BASE64.encode(bytes),
            Some(image_media_type(&descriptor.path).to_string()),
        ),
        ArtifactKind::Markdown | ArtifactKind::Html | ArtifactKind::Text => {
            let content = String::from_utf8(bytes)
                .map_err(|_| "Selected artifact is not valid UTF-8 text".to_string())?;
            if descriptor.path == "TASK.md" {
                parse_task(
                    &content,
                    selection.task_id.clone(),
                    &ProjectSelection {
                        project_id: selection.project_id.clone(),
                        project: selection.project.clone(),
                        worktree_id: selection.worktree_id.clone(),
                        worktree: selection.worktree.clone(),
                    },
                )
                .map_err(|error| format!("Selected TASK.md is invalid: {error}"))?;
            }
            (content, None)
        }
    };
    Ok(DetailsSnapshot {
        project_id: selection.project_id.clone(),
        project: selection.project.clone(),
        worktree_id: selection.worktree_id.clone(),
        worktree: selection.worktree.clone(),
        task_id: selection.task_id.clone(),
        artifact: descriptor.path.clone(),
        artifacts,
        kind: descriptor.kind,
        content,
        media_type,
    })
}

fn resolve_task_directory(project: &Path, selection: &TaskSelection) -> Result<PathBuf, String> {
    let project = fs::canonicalize(project)
        .map_err(|_| "Selected task project is unavailable".to_string())?;
    let tasks = fs::canonicalize(project.join("tasks"))
        .map_err(|_| "Selected task project has no tasks directory".to_string())?;
    let task = project.join("tasks").join(&selection.task_id);
    let metadata =
        fs::symlink_metadata(&task).map_err(|_| "Selected task is unavailable".to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("Selected task must be a regular directory".into());
    }
    let task = fs::canonicalize(task).map_err(|_| "Selected task is unavailable".to_string())?;
    if !task.starts_with(tasks) {
        return Err("Selected task escapes its project".into());
    }
    Ok(task)
}

fn list_artifacts(task_directory: &Path) -> Result<Vec<ArtifactDescriptor>, String> {
    let mut artifacts = Vec::new();
    let task_path = task_directory.join("TASK.md");
    if let Some(kind) = classify_artifact(&task_path)? {
        artifacts.push(ArtifactDescriptor {
            path: "TASK.md".into(),
            kind,
        });
    }
    collect_artifacts(task_directory, Path::new(""), &mut artifacts)?;
    Ok(artifacts)
}

fn collect_artifacts(
    task_directory: &Path,
    relative_directory: &Path,
    artifacts: &mut Vec<ArtifactDescriptor>,
) -> Result<(), String> {
    if artifacts.len() >= MAX_ARTIFACTS
        || relative_directory.components().count() >= MAX_ARTIFACT_DEPTH
    {
        return Ok(());
    }
    let directory = task_directory.join(relative_directory);
    for entry in sorted_entries(&directory).map_err(|_| "Could not list task artifacts")? {
        if artifacts.len() >= MAX_ARTIFACTS {
            break;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let relative = relative_directory.join(&name);
        if relative == Path::new("TASK.md") {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|_| "Could not inspect task artifact")?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_artifacts(task_directory, &relative, artifacts)?;
        } else if file_type.is_file()
            && let Some(kind) = classify_artifact(&entry.path())?
        {
            let Some(path) = relative
                .to_str()
                .filter(|path| path.len() <= MAX_ARTIFACT_PATH_BYTES)
            else {
                continue;
            };
            artifacts.push(ArtifactDescriptor {
                path: path.replace(std::path::MAIN_SEPARATOR, "/"),
                kind,
            });
        }
    }
    Ok(())
}

fn classify_artifact(path: &Path) -> Result<Option<ArtifactKind>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Could not inspect task artifact")?;
    if !metadata.file_type().is_file() {
        return Ok(None);
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match extension.as_str() {
        "md" | "markdown" if metadata.len() <= MAX_TEXT_ARTIFACT_BYTES => {
            Some(ArtifactKind::Markdown)
        }
        "html" | "htm" if metadata.len() <= MAX_TEXT_ARTIFACT_BYTES => Some(ArtifactKind::Html),
        "png" | "jpg" | "jpeg" | "gif" | "webp"
            if metadata.len() <= MAX_IMAGE_ARTIFACT_BYTES
                && valid_image_artifact(path, &extension) =>
        {
            Some(ArtifactKind::Image)
        }
        "svg" | "pdf" | "mp4" | "mov" | "avi" | "zip" | "gz" | "xz" | "bz2" | "7z" | "tar" => None,
        _ if metadata.len() <= MAX_TEXT_ARTIFACT_BYTES => fs::read(path)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(|_| ArtifactKind::Text),
        _ => None,
    };
    Ok(kind)
}

fn valid_image_artifact(path: &Path, extension: &str) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 12];
    let Ok(length) = file.read(&mut header) else {
        return false;
    };
    let header = &header[..length];
    match extension {
        "png" => header.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => header.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a"),
        "webp" => header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}

fn image_media_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn parse_artifact(payload: &Value) -> Option<String> {
    let artifact = payload.get("artifact")?.as_str()?;
    let path = Path::new(artifact);
    (!artifact.is_empty()
        && artifact.len() <= MAX_ARTIFACT_PATH_BYTES
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_))))
    .then(|| artifact.into())
}

async fn handle_command(
    stdout: &mut tokio::io::Stdout,
    runtime: &mut Runtime,
    payload: &Value,
) -> Result<bool, Box<dyn Error>> {
    match runtime {
        Runtime::Full {
            settings, views, ..
        } => {
            let Some(view_id) = parse_view_id(payload) else {
                return Ok(false);
            };
            match payload.get("command").and_then(Value::as_str) {
                Some("open_view") => {
                    limit_views(views, &view_id);
                    views.entry(view_id).or_insert(FullView {
                        selection: None,
                        project_path: None,
                        previous: None,
                    });
                    publish_runtime(stdout, runtime, true).await?;
                    Ok(true)
                }
                Some("select_project") => {
                    let Some(selection) = parse_project_selection(payload) else {
                        return Ok(false);
                    };
                    let project_path = resolve_selected_project(settings, &selection).await.ok();
                    limit_views(views, &view_id);
                    let view = views.entry(view_id).or_insert(FullView {
                        selection: None,
                        project_path: None,
                        previous: None,
                    });
                    view.selection = Some(selection);
                    view.project_path = project_path;
                    view.previous = None;
                    publish_runtime(stdout, runtime, true).await?;
                    Ok(true)
                }
                Some("clear_project") => {
                    limit_views(views, &view_id);
                    let view = views.entry(view_id).or_insert(FullView {
                        selection: None,
                        project_path: None,
                        previous: None,
                    });
                    view.selection = None;
                    view.project_path = None;
                    view.previous = None;
                    publish_runtime(stdout, runtime, true).await?;
                    Ok(true)
                }
                Some("refresh") => {
                    publish_runtime(stdout, runtime, true).await?;
                    Ok(true)
                }
                Some("release_view") => Ok(views.remove(&view_id).is_some()),
                _ => Ok(false),
            }
        }
        Runtime::Details {
            instance_id,
            settings,
            views,
        } if payload.get("command").and_then(Value::as_str) == Some("select_task") => {
            let Some(view_id) = parse_view_id(payload) else {
                return Ok(false);
            };
            let Some(selection) = parse_selection(payload) else {
                return Ok(false);
            };
            let project_path = resolve_selected_project(
                settings,
                &ProjectSelection {
                    project_id: selection.project_id.clone(),
                    project: selection.project.clone(),
                    worktree_id: selection.worktree_id.clone(),
                    worktree: selection.worktree.clone(),
                },
            )
            .await
            .unwrap_or_default();
            limit_views(views, &view_id);
            views.insert(
                view_id.clone(),
                DetailView {
                    selection,
                    project_path,
                    artifact: "TASK.md".into(),
                    previous: None,
                },
            );
            publish_detail(stdout, instance_id, &view_id, views, true).await?;
            Ok(true)
        }
        Runtime::Details {
            instance_id, views, ..
        } if payload.get("command").and_then(Value::as_str) == Some("select_artifact") => {
            let Some(view_id) = parse_view_id(payload) else {
                return Ok(false);
            };
            let Some(selection) = parse_selection(payload) else {
                return Ok(false);
            };
            let Some(artifact) = parse_artifact(payload) else {
                return Ok(false);
            };
            let Some(view) = views.get_mut(&view_id) else {
                return Ok(false);
            };
            if view.selection != selection {
                return Ok(false);
            }
            view.artifact = artifact;
            view.previous = None;
            publish_detail(stdout, instance_id, &view_id, views, true).await?;
            Ok(true)
        }
        Runtime::Details { views, .. }
            if payload.get("command").and_then(Value::as_str) == Some("release_view") =>
        {
            let Some(view_id) = parse_view_id(payload) else {
                return Ok(false);
            };
            views.remove(&view_id);
            Ok(true)
        }
        _ => Ok(false),
    }
}

async fn publish_runtime(
    stdout: &mut tokio::io::Stdout,
    runtime: &mut Runtime,
    force: bool,
) -> Result<(), Box<dyn Error>> {
    match runtime {
        Runtime::Full {
            instance_id,
            settings,
            loader,
            views,
        } => {
            let view_ids = views.keys().cloned().collect::<Vec<_>>();
            for view_id in view_ids {
                let Some(view) = views.get_mut(&view_id) else {
                    continue;
                };
                let selected = view.selection.as_ref().zip(view.project_path.as_deref());
                let current = if view.selection.is_some() && selected.is_none() {
                    Err("Selected project worktree is unavailable".into())
                } else {
                    loader.load(settings, selected).and_then(|snapshot| {
                        serde_json::to_value(snapshot).map_err(|error| error.to_string())
                    })
                };
                if force || view.previous.as_ref() != Some(&current) {
                    let payload = match &current {
                        Ok(payload) => {
                            let mut payload = payload.clone();
                            payload["view_id"] = Value::String(view_id.clone());
                            payload
                        }
                        Err(message) => serde_json::json!({
                            "view_id": view_id,
                            "error": {"code": "tasks_unavailable", "message": message}
                        }),
                    };
                    write_message(
                        stdout,
                        WidgetToServer::Update {
                            instance_id: instance_id.clone(),
                            payload,
                        },
                    )
                    .await?;
                    view.previous = Some(current);
                }
            }
        }
        Runtime::Details {
            instance_id, views, ..
        } => {
            let view_ids = views.keys().cloned().collect::<Vec<_>>();
            for view_id in view_ids {
                publish_detail(stdout, instance_id, &view_id, views, force).await?;
            }
        }
    }
    Ok(())
}

async fn publish_detail(
    stdout: &mut tokio::io::Stdout,
    instance_id: &str,
    view_id: &str,
    views: &mut HashMap<String, DetailView>,
    force: bool,
) -> Result<(), Box<dyn Error>> {
    let Some(view) = views.get_mut(view_id) else {
        return Ok(());
    };
    let current = load_details(&view.project_path, &view.selection, &view.artifact)
        .and_then(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string()));
    if force || view.previous.as_ref() != Some(&current) {
        let payload = match &current {
            Ok(payload) => {
                let mut payload = payload.clone();
                payload["view_id"] = Value::String(view_id.into());
                payload
            }
            Err(message) => serde_json::json!({
                "view_id": view_id,
                "error": {"code": "artifact_unavailable", "message": message}
            }),
        };
        write_message(
            stdout,
            WidgetToServer::Update {
                instance_id: instance_id.into(),
                payload,
            },
        )
        .await?;
        view.previous = Some(current);
    }
    Ok(())
}

fn limit_views<T>(views: &mut HashMap<String, T>, view_id: &str) {
    if !views.contains_key(view_id)
        && views.len() >= MAX_VIEWS
        && let Some(expired) = views.keys().next().cloned()
    {
        views.remove(&expired);
    }
}

fn parse_view_id(payload: &Value) -> Option<String> {
    let view_id = payload.get("view_id")?.as_str()?;
    (!view_id.is_empty() && view_id.len() <= 64 && view_id.is_ascii()).then(|| view_id.into())
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

async fn write_error(
    stdout: &mut tokio::io::Stdout,
    instance_id: Option<String>,
    code: &str,
    message: String,
) -> Result<(), Box<dyn Error>> {
    write_message(
        stdout,
        WidgetToServer::Error {
            instance_id,
            error: dashboard_protocol::ErrorData {
                code: code.into(),
                message,
            },
        },
    )
    .await
}

async fn write_message(
    stdout: &mut tokio::io::Stdout,
    message: WidgetToServer,
) -> Result<(), Box<dyn Error>> {
    stdout
        .write_all(dashboard_protocol::serialize(message)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_selection(project: &str, path: &Path) -> ProjectSelection {
        default_project_selection(project, path)
    }

    #[test]
    fn parses_strict_task_metadata_without_the_body() {
        let selection = ProjectSelection {
            project_id: "project-test".into(),
            project: "scufris".into(),
            worktree_id: "worktree-test".into(),
            worktree: "Primary".into(),
        };
        let task = parse_task(
            "# Add widget\n\n- STATUS: IN_PROGRESS\n- PRIORITY: 100\n- TAGS: widget, rust\n\nSecret body\n",
            "20260814-120000".into(),
            &selection,
        )
        .unwrap();

        assert_eq!(task.title, "Add widget");
        assert_eq!(task.status, Status::InProgress);
        assert_eq!(task.tags, ["widget", "rust"]);
        assert!(!serde_json::to_string(&task).unwrap().contains("Secret"));
        assert!(parse_task("# Bad\n- STATUS: MAYBE\n", "id".into(), &selection).is_err());
    }

    #[test]
    fn expands_home_and_rejects_relative_roots() {
        let home = PathBuf::from(env::var_os("HOME").unwrap());
        assert_eq!(expand_root("~/personal").unwrap(), home.join("personal"));
        assert!(expand_root("personal").is_err());
    }

    #[test]
    fn lists_and_loads_private_task_artifacts_with_format_and_path_guards() {
        let root = env::temp_dir().join(format!("scufris-tatr-details-{}", std::process::id()));
        write_task(
            &root.join("scufris"),
            "20260814-150000",
            "Linked details",
            "OPEN",
            100,
        );
        let task = root.join("scufris/tasks/20260814-150000");
        fs::create_dir_all(task.join("research")).unwrap();
        fs::write(
            task.join("research/notes.md"),
            "# Notes\n\n[raw](../summary.txt)",
        )
        .unwrap();
        fs::write(task.join("summary.txt"), "plain text").unwrap();
        fs::write(
            task.join("report.html"),
            "<h1>Report</h1><script>bad()</script>",
        )
        .unwrap();
        fs::write(task.join("result.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
        fs::write(task.join("blocked.svg"), "<svg></svg>").unwrap();
        fs::write(task.join("binary.bin"), [0xff, 0xfe, 0xfd]).unwrap();
        fs::write(task.join(".secret.txt"), "secret").unwrap();
        fs::File::create(task.join("oversized.md"))
            .unwrap()
            .set_len(MAX_TEXT_ARTIFACT_BYTES + 1)
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", task.join("linked.txt")).unwrap();
        let identity = project_selection("scufris", &root.join("scufris"));
        let selection = TaskSelection {
            project_id: identity.project_id,
            project: identity.project,
            worktree_id: identity.worktree_id,
            worktree: identity.worktree,
            task_id: "20260814-150000".into(),
        };
        let project = root.join("scufris");

        let details = load_details(&project, &selection, "TASK.md").unwrap();
        assert_eq!(details.artifact, "TASK.md");
        assert_eq!(details.kind, ArtifactKind::Markdown);
        assert!(details.content.contains("# Linked details"));
        assert_eq!(
            details
                .artifacts
                .iter()
                .map(|artifact| artifact.path.as_str())
                .collect::<Vec<_>>(),
            [
                "TASK.md",
                "report.html",
                "research/notes.md",
                "result.png",
                "summary.txt",
            ]
        );
        assert!(
            !serde_json::to_string(&details)
                .unwrap()
                .contains(root.to_string_lossy().as_ref())
        );
        let text = load_details(&project, &selection, "summary.txt").unwrap();
        assert_eq!(text.kind, ArtifactKind::Text);
        assert_eq!(text.content, "plain text");
        let image = load_details(&project, &selection, "result.png").unwrap();
        assert_eq!(image.kind, ArtifactKind::Image);
        assert_eq!(image.media_type.as_deref(), Some("image/png"));
        assert_eq!(
            BASE64.decode(image.content).unwrap(),
            b"\x89PNG\r\n\x1a\nfixture"
        );
        assert!(load_details(&project, &selection, "../TASK.md").is_err());
        assert!(load_details(&root.join("missing"), &selection, "TASK.md").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn resolves_linked_worktree_tasks_by_opaque_identity() {
        let root = env::temp_dir().join(format!("scufris-tatr-worktree-{}", std::process::id()));
        let project = root.join("sample");
        write_task(&project, "20260814-170000", "Primary task", "OPEN", 1);
        let run = |directory: &Path, arguments: &[&str]| {
            let status = std::process::Command::new("git")
                .args(arguments)
                .current_dir(directory)
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&project, &["init", "-q", "-b", "main"]);
        run(&project, &["config", "user.name", "Fixture"]);
        run(
            &project,
            &["config", "user.email", "fixture@example.invalid"],
        );
        run(&project, &["add", "."]);
        run(&project, &["commit", "-q", "-m", "Initial"]);
        let worktree = root.join(".worktrees/feature");
        fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        let worktree_arg = worktree.to_string_lossy();
        run(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature/tasks",
                worktree_arg.as_ref(),
            ],
        );
        write_task(
            &worktree,
            "20260814-170000",
            "Worktree task",
            "IN_PROGRESS",
            2,
        );
        let common = project.join(".git").canonicalize().unwrap();
        let worktree = worktree.canonicalize().unwrap();
        let selection = ProjectSelection {
            project_id: opaque_id("project", &common),
            project: "sample".into(),
            worktree_id: opaque_id("worktree", &worktree),
            worktree: "feature/tasks".into(),
        };
        let settings = Settings {
            root: root.clone(),
            recursive: true,
            filter: None,
            sort: Sort::Priority,
        };

        let resolved = resolve_selected_project(&settings, &selection)
            .await
            .unwrap();
        assert_eq!(resolved, worktree);
        let snapshot = Loader::default()
            .load(&settings, Some((&selection, &resolved)))
            .unwrap();
        assert_eq!(snapshot.tasks[0].title, "Worktree task");
        assert_eq!(snapshot.tasks[0].worktree_id, selection.worktree_id);
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains(root.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn limits_artifact_lists_and_validates_artifact_commands() {
        let root = env::temp_dir().join(format!("scufris-tatr-limit-{}", std::process::id()));
        write_task(&root, "20260814-160000", "Many artifacts", "OPEN", 1);
        let task = root.join("tasks/20260814-160000");
        for index in 0..MAX_ARTIFACTS + 10 {
            fs::write(task.join(format!("artifact-{index:03}.txt")), "text").unwrap();
        }
        let artifacts = list_artifacts(&task).unwrap();
        assert_eq!(artifacts.len(), MAX_ARTIFACTS);
        assert_eq!(artifacts[0].path, "TASK.md");
        assert!(parse_artifact(&serde_json::json!({"artifact": "notes/file.md"})).is_some());
        assert!(parse_artifact(&serde_json::json!({"artifact": "../file.md"})).is_none());
        assert!(parse_artifact(&serde_json::json!({"artifact": "/file.md"})).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recursively_loads_filters_and_sorts_projects_without_exposing_root() {
        let root = env::temp_dir().join(format!("scufris-tatr-{}", std::process::id()));
        write_task(&root.join("one"), "20260814-120000", "First", "OPEN", 20);
        write_task(
            &root.join("nested/two"),
            "20260814-130000",
            "Second",
            "IN_PROGRESS",
            100,
        );
        write_task(
            &root.join("nested/two"),
            "20260814-140000",
            "Closed",
            "CLOSED",
            200,
        );
        let settings = Settings {
            root: root.clone(),
            recursive: true,
            filter: filter::compile(":status in [OPEN, IN_PROGRESS]").unwrap(),
            sort: Sort::Priority,
        };

        let snapshot = Loader::default().load(&settings, None).unwrap();

        assert_eq!(snapshot.tasks.len(), 2);
        assert_eq!(snapshot.tasks[0].title, "Second");
        assert_eq!(snapshot.tasks[0].project, "nested/two");
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains(root.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn write_task(project: &Path, id: &str, title: &str, status: &str, priority: u32) {
        let directory = project.join("tasks").join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("TASK.md"),
            format!(
                "# {title}\n\n- STATUS: {status}\n- PRIORITY: {priority}\n- TAGS: test\n\nBody\n"
            ),
        )
        .unwrap();
    }
}
