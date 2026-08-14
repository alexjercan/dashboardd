//! Read-only Tatr task widget backend.

mod filter;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use dashboard_protocol::{ServerToWidget, WidgetToServer};
use filter::Expr;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{Duration, Instant, interval_at};

const WIDGET_ID: &str = "tatr-tasks";
const UPDATE_INTERVAL: Duration = Duration::from_secs(2);

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
    project: String,
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut runtime: Option<(String, Settings, Loader)> = None;
    let mut previous: Option<Result<Snapshot, String>> = None;
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
                    Ok(ServerToWidget::Initialize { instance_id, widget_id, options }) if widget_id == WIDGET_ID => {
                        match Settings::from_options(&options) {
                            Ok(settings) => runtime = Some((instance_id, settings, Loader::default())),
                            Err(message) => write_error(&mut stdout, Some(instance_id), "invalid_options", message).await?,
                        }
                    }
                    Ok(ServerToWidget::Message { instance_id, payload }) => {
                        if let Some((active_id, settings, loader)) = runtime.as_mut()
                            && instance_id == *active_id
                            && payload.get("command").and_then(Value::as_str) == Some("refresh")
                        {
                            let current = loader.load(settings);
                            publish_result(
                                &mut stdout,
                                active_id,
                                current,
                                &mut previous,
                                true,
                            ).await?;
                        } else {
                            write_error(
                                &mut stdout,
                                Some(instance_id),
                                "invalid_command",
                                "unsupported Tatr Tasks command".into(),
                            ).await?;
                        }
                    }
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_error(
                        &mut stdout,
                        runtime.as_ref().map(|(id, _, _)| id.clone()),
                        "invalid_message",
                        error.to_string(),
                    ).await?,
                },
                None => break,
            },
            _ = updates.tick(), if runtime.is_some() => {
                let (instance_id, settings, loader) = runtime.as_mut().expect("runtime is checked");
                let current = loader.load(settings);
                publish_result(
                    &mut stdout,
                    instance_id,
                    current,
                    &mut previous,
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
        let filter_source = options
            .get("filter")
            .and_then(Value::as_str)
            .ok_or("filter must be text")?;
        let filter =
            filter::compile(filter_source).map_err(|error| format!("invalid filter: {error}"))?;
        let sort = match options.get("sort").and_then(Value::as_str) {
            Some("created") => Sort::Created,
            Some("priority") => Sort::Priority,
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
    fn load(&mut self, settings: &Settings) -> Result<Snapshot, String> {
        if !settings.root.is_dir() {
            return Err("Tatr root is unavailable".into());
        }
        let projects = discover_projects(&settings.root, settings.recursive)?;
        let mut seen = HashSet::new();
        let mut tasks = Vec::new();
        for project in projects {
            let project_name = project_name(&settings.root, &project);
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
                let task = if let Some(cached) = self
                    .cache
                    .get(&path)
                    .filter(|cached| cached.length == metadata.len() && cached.modified == modified)
                {
                    cached.task.clone()
                } else {
                    let source = fs::read_to_string(&path).map_err(|_| {
                        format!("Task {id:?} in project {project_name:?} is unreadable")
                    })?;
                    let task =
                        parse_task(&source, id.clone(), project_name.clone()).map_err(|error| {
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

fn valid_task_id(value: &str) -> bool {
    value.len() == 15
        && value.as_bytes()[8] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit())
}

fn parse_task(source: &str, id: String, project: String) -> Result<Task, String> {
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
        project,
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

async fn publish_result(
    stdout: &mut tokio::io::Stdout,
    instance_id: &str,
    current: Result<Snapshot, String>,
    previous: &mut Option<Result<Snapshot, String>>,
    force: bool,
) -> Result<(), Box<dyn Error>> {
    if force || previous.as_ref() != Some(&current) {
        match &current {
            Ok(snapshot) => {
                write_message(
                    stdout,
                    WidgetToServer::Update {
                        instance_id: instance_id.into(),
                        payload: serde_json::to_value(snapshot)?,
                    },
                )
                .await?
            }
            Err(message) => {
                write_error(
                    stdout,
                    Some(instance_id.into()),
                    "tasks_unavailable",
                    message.clone(),
                )
                .await?
            }
        }
        *previous = Some(current);
    }
    Ok(())
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

    #[test]
    fn parses_strict_task_metadata_without_the_body() {
        let task = parse_task(
            "# Add widget\n\n- STATUS: IN_PROGRESS\n- PRIORITY: 100\n- TAGS: widget, rust\n\nSecret body\n",
            "20260814-120000".into(),
            "scufris".into(),
        )
        .unwrap();

        assert_eq!(task.title, "Add widget");
        assert_eq!(task.status, Status::InProgress);
        assert_eq!(task.tags, ["widget", "rust"]);
        assert!(!serde_json::to_string(&task).unwrap().contains("Secret"));
        assert!(parse_task("# Bad\n- STATUS: MAYBE\n", "id".into(), "p".into()).is_err());
    }

    #[test]
    fn expands_home_and_rejects_relative_roots() {
        let home = PathBuf::from(env::var_os("HOME").unwrap());
        assert_eq!(expand_root("~/personal").unwrap(), home.join("personal"));
        assert!(expand_root("personal").is_err());
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

        let snapshot = Loader::default().load(&settings).unwrap();

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
