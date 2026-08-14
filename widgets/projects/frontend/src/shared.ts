export type ProjectSelection = {
  project_id: string;
  project: string;
  worktree_id: string;
  worktree: string;
};

export type WorktreeDescriptor = {
  worktree_id: string;
  worktree: string;
  primary: boolean;
};

export type ProjectSummary = ProjectSelection & {
  primary: boolean;
  git: boolean;
  tatr: boolean;
  branch: string | null;
  clean: boolean | null;
  change_count: number;
  ahead: number;
  behind: number;
  open_tasks: number;
  in_progress_tasks: number;
  latest_commit_unix: number | null;
  latest_commit_summary: string | null;
  worktrees?: WorktreeDescriptor[];
};

export type Change = {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "untracked";
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
};

export type Branch = {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  latest_commit_unix: number | null;
  latest_commit_summary: string | null;
};

export type ProjectDetails = ProjectSummary & {
  changes: Change[];
  branches: Branch[];
};

export function parseSelection(value: unknown): ProjectSelection | null {
  if (
    !isRecord(value) ||
    typeof value.project_id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.worktree_id !== "string" ||
    typeof value.worktree !== "string"
  )
    return null;
  return {
    project_id: value.project_id,
    project: value.project,
    worktree_id: value.worktree_id,
    worktree: value.worktree,
  };
}

export function parseSummary(value: unknown): ProjectSummary | null {
  const selection = parseSelection(value);
  if (
    !selection ||
    !isRecord(value) ||
    typeof value.primary !== "boolean" ||
    typeof value.git !== "boolean" ||
    typeof value.tatr !== "boolean" ||
    (value.branch !== null && typeof value.branch !== "string") ||
    (value.clean !== null && typeof value.clean !== "boolean") ||
    !nonNegativeInteger(value.change_count) ||
    !nonNegativeInteger(value.ahead) ||
    !nonNegativeInteger(value.behind) ||
    !nonNegativeInteger(value.open_tasks) ||
    !nonNegativeInteger(value.in_progress_tasks) ||
    (value.latest_commit_unix !== null &&
      !nonNegativeInteger(value.latest_commit_unix)) ||
    (value.latest_commit_summary !== null &&
      typeof value.latest_commit_summary !== "string")
  )
    return null;
  const worktrees =
    value.worktrees === undefined
      ? undefined
      : Array.isArray(value.worktrees)
        ? value.worktrees.map(parseWorktree)
        : null;
  if (worktrees === null || worktrees?.some((worktree) => worktree === null))
    return null;
  return {
    ...selection,
    primary: value.primary,
    git: value.git,
    tatr: value.tatr,
    branch: value.branch,
    clean: value.clean,
    change_count: value.change_count,
    ahead: value.ahead,
    behind: value.behind,
    open_tasks: value.open_tasks,
    in_progress_tasks: value.in_progress_tasks,
    latest_commit_unix: value.latest_commit_unix,
    latest_commit_summary: value.latest_commit_summary,
    worktrees: worktrees as WorktreeDescriptor[] | undefined,
  };
}

export function parseDetails(value: unknown): ProjectDetails | null {
  const summary = parseSummary(value);
  if (!summary || !isRecord(value)) return null;
  if (!Array.isArray(value.changes) || !Array.isArray(value.branches))
    return null;
  const changes = value.changes.map(parseChange);
  const branches = value.branches.map(parseBranch);
  if (changes.some((change) => change === null)) return null;
  if (branches.some((branch) => branch === null)) return null;
  return {
    ...summary,
    changes: changes as Change[],
    branches: branches as Branch[],
  };
}

function parseWorktree(value: unknown): WorktreeDescriptor | null {
  if (
    !isRecord(value) ||
    typeof value.worktree_id !== "string" ||
    typeof value.worktree !== "string" ||
    typeof value.primary !== "boolean"
  )
    return null;
  return {
    worktree_id: value.worktree_id,
    worktree: value.worktree,
    primary: value.primary,
  };
}

function parseChange(value: unknown): Change | null {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !["added", "modified", "deleted", "renamed", "untracked"].includes(
      value.kind as string,
    ) ||
    typeof value.staged !== "boolean" ||
    typeof value.unstaged !== "boolean" ||
    (value.additions !== null && !nonNegativeInteger(value.additions)) ||
    (value.deletions !== null && !nonNegativeInteger(value.deletions))
  )
    return null;
  return value as Change;
}

function parseBranch(value: unknown): Branch | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.current !== "boolean" ||
    (value.upstream !== null && typeof value.upstream !== "string") ||
    !nonNegativeInteger(value.ahead) ||
    !nonNegativeInteger(value.behind) ||
    (value.latest_commit_unix !== null &&
      !nonNegativeInteger(value.latest_commit_unix)) ||
    (value.latest_commit_summary !== null &&
      typeof value.latest_commit_summary !== "string")
  )
    return null;
  return value as Branch;
}

export function relativeTime(timestamp: number | null): string {
  if (timestamp === null) return "No commits";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function createViewId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(12));
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
