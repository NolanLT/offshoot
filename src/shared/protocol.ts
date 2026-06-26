// Shared message/data shapes used by BOTH the extension host and the React
// webview. Keep this file dependency-free (no vscode, no node) so Vite can
// bundle it into the webview unchanged.

export type PRStatus = "open";

/** Display form of a PR id: "pr1" -> "1"; custom ids like "auth" stay "auth".
 *  Used so toasts/labels read "PR 1" rather than "PR #pr1". */
export function prNum(id: string): string {
  return id.replace(/^pr(?=\d)/, "");
}

export interface PRMeta {
  id: string;
  title: string;
  notes: string;
  status: PRStatus;
  created: string; // ISO
}

/** Backward delta ops. Every op describes how to go BACKWARD to the baseline. */
export type DeltaOp =
  | { type: "editLine"; file: string; line: number; old: string }
  | { type: "addLine"; file: string; line: number }
  | { type: "delLine"; file: string; line: number; old: string }
  | { type: "addFile"; file: string }
  | { type: "delFile"; file: string; old: string };

export interface Deltas {
  ops: DeltaOp[];
}

/** One rendered row of the custom diff panel. context = unchanged (aligns with
 *  the editor), del = a baseline line removed (red), add = a disk line added
 *  (green). del/add rows of the same `hunk` render as one grouped block. */
export type DiffRow =
  | { kind: "context"; diskLine: number; text: string }
  | { kind: "del"; hunk: number; text: string }
  | { kind: "add"; hunk: number; diskLine: number; text: string };

/** A changed block, with its disk line range for commit/revert-selection. */
export interface DiffHunk {
  id: number;
  start: number;
  end: number;
}

export interface FileDiff {
  file: string;
  rows: DiffRow[];
  hunks: DiffHunk[];
}

/** A closed-PR entry in the per-workspace history log (no code, just metadata). */
export interface LogEntry {
  id: string;
  title: string;
  notes: string;
  created: string;
  closed: string;
  action: "committed" | "reverted";
  files: number;
  additions: number;
  removals: number;
  /** the changed file paths (for the expandable list). */
  changedFiles: string[];
}

/** A file's change summary for the sidebar. */
export interface ChangedFile {
  file: string;
  added: number;
  removed: number;
  /** "added" = new on disk, "deleted" = gone from disk, "modified" otherwise. */
  kind: "added" | "deleted" | "modified";
}

export interface PRView {
  meta: PRMeta;
  changedFiles: ChangedFile[];
}

/** A PR as shown in the open-PR list, with its change count and line totals. */
export interface PRListItem extends PRMeta {
  changeCount: number;
  additions: number;
  removals: number;
}

export interface SidebarState {
  hasWorkspace: boolean;
  prs: PRListItem[];
  activePrId: string | null;
  selected: PRView | null;
  reviewing: boolean;
  status: { kind: "info" | "error"; text: string } | null;
}

// ---- Messages: webview -> extension ----
export type ToExt =
  | { type: "ready" }
  | { type: "openPR"; id?: string; title: string; notes: string }
  | { type: "selectPR"; id: string }
  | { type: "refresh" }
  | { type: "review"; id: string }
  | { type: "stopReview" }
  | { type: "openFileDiff"; id: string; file: string }
  | { type: "openDiffPanel"; id: string; file: string }
  | { type: "commit"; id: string }
  | { type: "revert"; id: string }
  | { type: "revertFile"; id: string; file: string }
  | { type: "editPR"; id: string }
  | { type: "commitSelection"; id: string }
  | { type: "revertSelection"; id: string }
  | { type: "recapture"; id: string }
  | { type: "discard"; id: string }
  | { type: "revealFolder"; id: string }
  | { type: "openLog" };

// ---- Messages: extension -> webview ----
export type ToWebview = { type: "state"; state: SidebarState };
