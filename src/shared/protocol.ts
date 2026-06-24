// Shared message/data shapes used by BOTH the extension host and the React
// webview. Keep this file dependency-free (no vscode, no node) so Vite can
// bundle it into the webview unchanged.

export type PRStatus = "open";

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

export interface SidebarState {
  hasWorkspace: boolean;
  prs: PRMeta[];
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
  | { type: "commit"; id: string }
  | { type: "revert"; id: string }
  | { type: "commitSelection"; id: string }
  | { type: "recapture"; id: string }
  | { type: "discard"; id: string }
  | { type: "revealFolder"; id: string };

// ---- Messages: extension -> webview ----
export type ToWebview = { type: "state"; state: SidebarState };
