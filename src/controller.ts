import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { Engine } from "./engine/engine";
import { Errors, OffshootError, type Resolution } from "./engine/errors";
import { BaselineContentProvider } from "./ui/baselineProvider";
import { DiffPanel } from "./ui/diffPanel";
import { LogPanel } from "./ui/logPanel";
import { DecorationManager } from "./ui/decorations";
import { resolve as resolveDialog, info, error as showError } from "./ui/dialogs";
import { IgnoreMatcher } from "./engine/ignore";
import { resolveStorageDir } from "./engine/storagePath";
import { prNum } from "./shared/protocol";
import type { SidebarState, ToExt, PRListItem } from "./shared/protocol";

/**
 * Orchestrates the whole extension: owns the Engine, captures baselines from
 * VS Code edit events, runs the Section 6 guard with interactive resolution,
 * and pushes state to the sidebar webview.
 */
export class Controller {
  readonly engine: Engine;
  readonly baselineProvider: BaselineContentProvider;
  readonly decorations: DecorationManager;
  private diffPanel: DiffPanel;
  private logPanel: LogPanel;

  private post: ((state: SidebarState) => void) | null = null;
  /** current editor content, before each change, for baseline capture. */
  private lastContent = new Map<string, string>();
  private ignore: IgnoreMatcher;
  private statusBar: vscode.StatusBarItem;
  private cleanedWhenEmpty = false;
  private askedToOpenPr = false;
  /** Ids the sidebar was last told about. Lets us tell "the PR you clicked has
   *  since vanished from disk" (#7 — Remove from list) apart from "unknown id"
   *  (#2 — Refresh PR list), which need different resolutions. */
  private lastPrIds = new Set<string>();
  /** Original pre-edit content of files touched while NO PR was open, so the
   *  edit that prompted "open a PR?" isn't lost — the next PR opened absorbs
   *  these as its baselines. Keyed by rel path; first (earliest) value wins. */
  private orphanBaselines = new Map<string, string>();

  constructor(readonly workspaceRoot: string, ctx: vscode.ExtensionContext) {
    // Keep PR data OUTSIDE the project, at a deterministic location the
    // standalone MCP server can also compute (see resolveStorageDir). This is
    // what lets AI control (v0.1.0) share the same PRs as the extension.
    const storageDir = resolveStorageDir(workspaceRoot);
    this.engine = new Engine(workspaceRoot, storageDir);
    this.baselineProvider = new BaselineContentProvider(this.engine);
    this.decorations = new DecorationManager(this.engine, workspaceRoot);
    this.diffPanel = new DiffPanel(this.engine, workspaceRoot, (kind, prId, file, start, end) => {
      if (kind === "commit") void this.commitRange(prId, file, start, end);
      else void this.revertRange(prId, file, start, end);
    });
    this.logPanel = new LogPanel(
      this.engine,
      async () => {
        const ok = await vscode.window.showWarningMessage(
          "Delete the entire PR history for this workspace?",
          { modal: true },
          "Clear history"
        );
        if (ok !== "Clear history") return;
        this.engine.clearLog();
        this.logPanel.refresh();
      },
      (index) => {
        this.engine.deleteLogEntry(index);
        this.logPanel.refresh();
      }
    );
    this.ignore = new IgnoreMatcher(workspaceRoot);

    // Status-bar item: open-PR count, click to open the Offshoot view.
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "offshoot.sidebar.focus";
    ctx.subscriptions.push(this.statusBar);

    // seed tracker for already-open docs
    for (const doc of vscode.workspace.textDocuments) this.seed(doc);

    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        "offshoot-baseline",
        this.baselineProvider
      ),
      this.decorations,
      vscode.workspace.onDidOpenTextDocument((d) => this.seed(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
      vscode.workspace.onWillDeleteFiles((e) => this.onWillDelete(e)),
      vscode.workspace.onDidCreateFiles((e) => this.onCreate(e)),
      vscode.workspace.onDidDeleteFiles((e) => this.onDelete(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorations.applyToAll())
    );

    // Watch the (out-of-project) storage dir so changes made by the MCP server
    // — open / commit / revert from an AI — refresh the UI live. Debounced
    // because a single save writes several files.
    const storeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(storageDir), "**/*")
    );
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onStoreChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (this.decorations.reviewing) this.decorations.applyToAll();
        this.refresh();
      }, 150);
    };
    storeWatcher.onDidCreate(onStoreChange);
    storeWatcher.onDidChange(onStoreChange);
    storeWatcher.onDidDelete(onStoreChange);
    ctx.subscriptions.push(storeWatcher);

    // Initialize the status bar (and context key) immediately on activation,
    // before the view is ever opened.
    this.refresh();
  }

  // ---------------- webview wiring ----------------
  setPoster(fn: (state: SidebarState) => void) {
    this.post = fn;
  }

  buildState(): SidebarState {
    const prs: PRListItem[] = this.engine.listPRs().map((meta) => {
      let changeCount = 0;
      let additions = 0;
      let removals = 0;
      try {
        const cf = this.engine.prView(meta.id).changedFiles;
        changeCount = cf.length;
        additions = cf.reduce((s, f) => s + f.added, 0);
        removals = cf.reduce((s, f) => s + f.removed, 0);
      } catch {
        /* leave 0 */
      }
      return { ...meta, changeCount, additions, removals };
    });
    this.lastPrIds = new Set(prs.map((p) => p.id));
    const activePrId = this.engine.storage.readActive();
    const reviewing = this.decorations.reviewing;
    const selectedId = reviewing ? this.decorations.prId : activePrId;
    let selected: SidebarState["selected"] = null;
    if (selectedId && this.engine.storage.prExists(selectedId)) {
      try {
        selected = this.engine.prView(selectedId);
      } catch {
        selected = null;
      }
    }
    return {
      hasWorkspace: true,
      prs,
      activePrId,
      selected,
      reviewing
    };
  }

  refresh() {
    const state = this.buildState();
    // When no valid PRs remain, clear any residual/orphaned storage — once per
    // empty period — then rebuild if it actually cleaned something.
    if (state.prs.length === 0) {
      if (!this.cleanedWhenEmpty) {
        this.cleanedWhenEmpty = true;
        if (this.engine.cleanResidualStorage()) {
          this.refresh();
          return;
        }
      }
    } else {
      this.cleanedWhenEmpty = false;
    }
    if (this.post) this.post(state);
    const additions = state.prs.reduce((s, p) => s + p.additions, 0);
    const removals = state.prs.reduce((s, p) => s + p.removals, 0);
    this.updateStatusBar(state.prs.length, additions, removals);
    this.syncContextKey();
  }

  private updateStatusBar(n: number, additions: number, removals: number) {
    this.statusBar.text = `$(repo-forked) ${n} $(add) ${additions} $(remove) ${removals}`;
    this.statusBar.tooltip =
      `Offshoot — ${n} open PR${n === 1 ? "" : "s"}, ` +
      `+${additions} / −${removals} across all PRs. Click to open.`;
    this.statusBar.show();
  }

  // Feedback goes through native VS Code notifications (the custom popups the
  // user sees), not an inline status box.
  private setStatus(kind: "info" | "error", text: string) {
    if (kind === "error") void showError(text);
    else void info(text);
  }

  private syncContextKey() {
    void vscode.commands.executeCommand(
      "setContext",
      "offshoot.hasActivePR",
      this.engine.storage.readActive() !== null
    );
  }

  // ---------------- event handlers ----------------
  private seed(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== "file") return;
    const key = doc.uri.toString();
    if (!this.lastContent.has(key)) this.lastContent.set(key, doc.getText());
  }

  private relFor(uri: vscode.Uri): string | null {
    if (uri.scheme !== "file") return null;
    const rel = this.engine.rel(uri.fsPath);
    return rel.startsWith("..") ? null : rel;
  }

  /** relFor, but excludes ignored paths (.offshoot, .git, node_modules, and
   *  anything in .offshootignore) so they're never tracked. */
  private tracked(uri: vscode.Uri): string | null {
    const rel = this.relFor(uri);
    if (!rel || this.ignore.ignores(rel)) return null;
    return rel;
  }

  private openPrIds(): string[] {
    return this.engine.storage.listPrIds();
  }

  /** Guard every command that names a PR. #7 when the sidebar is showing a PR
   *  whose folder is gone (stale row → Remove from list); #2 otherwise. */
  private requirePr(prId: string): void {
    if (this.engine.storage.prExists(prId)) return;
    throw this.lastPrIds.has(prId)
      ? Errors.folderMissing(prId)
      : Errors.prNotFound(prId);
  }

  /** Surface Error #6 (no active PR) with its Open new / Select existing
   *  buttons, instead of a dead-end warning toast. */
  async reportNoActivePR(): Promise<void> {
    await this.handleError(Errors.noActivePR());
  }

  /** QuickPick over the open PRs — the "Select an existing PR" resolution. */
  private async pickPR(): Promise<string | undefined> {
    const items = this.engine.listPRs().map((m) => ({
      label: `PR ${prNum(m.id)}`,
      description: m.title,
      id: m.id
    }));
    if (items.length === 0) return undefined;
    const picked = await vscode.window.showQuickPick(items, {
      title: "Select a PR"
    });
    return picked?.id;
  }

  private openEditorFor(file: string): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.scheme === "file" && this.relFor(e.document.uri) === file
    );
  }

  /** If a per-file/selection op left the PR with no remaining changes, close it
   *  (it just holds an empty baseline, counts toward the badge, and clutters the
   *  list). Returns true if the PR was closed. `verb` is woven into the status. */
  private closeIfEmpty(prId: string, verb: string): boolean {
    if (this.engine.touchedFiles(prId).length > 0) return false;
    if (this.decorations.prId === prId) this.decorations.stop();
    this.engine.storage.deletePR(prId);
    this.setStatus(
      "info",
      `${verb}; PR ${prNum(prId)} had no remaining changes and was closed.`
    );
    return true;
  }

  /** Refresh decorations, the diff panel, and the sidebar after a per-file op. */
  private afterFileMutation(prId: string, file: string) {
    if (this.decorations.reviewing) {
      this.baselineProvider.refresh(prId, file);
      this.decorations.applyToAll();
    }
    this.diffPanel.refresh(prId, file);
    this.refresh();
  }

  /** Open the file (left) and the custom diff panel (right). */
  private async openDiffPanel(prId: string, file: string) {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), ...file.split("/"));
    try {
      await vscode.window.showTextDocument(uri, {
        viewColumn: vscode.ViewColumn.One,
        preview: false
      });
    } catch {
      /* file may not exist on disk (deleted) — panel still shows baseline */
    }
    this.diffPanel.show(prId, file);
  }

  /** Resync the in-memory pre-edit snapshot to disk for files the engine just
   *  rewrote (revert). Without this, a later PR captures a stale baseline. */
  private syncLastContent(files: string[]) {
    for (const file of files) {
      const uri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        ...file.split("/")
      );
      try {
        this.lastContent.set(uri.toString(), fs.readFileSync(uri.fsPath, "utf8"));
      } catch {
        this.lastContent.delete(uri.toString()); // file removed by the revert
      }
    }
  }

  private onChange(e: vscode.TextDocumentChangeEvent) {
    const file = this.tracked(e.document.uri);
    if (!file) return;
    const key = e.document.uri.toString();
    const prior = this.lastContent.get(key);
    const prs = this.openPrIds();
    if (prs.length === 0) {
      // editing with no PR to capture into — remember the original content so the
      // edit isn't lost, then offer to open a PR (once per session). The next PR
      // opened replays these as baselines.
      if (prior !== undefined && !this.orphanBaselines.has(file)) {
        this.orphanBaselines.set(file, prior);
      }
      this.maybeOfferOpenPr();
    } else if (prior !== undefined) {
      // Capture into the ACTIVE (selected) PR only — not every open PR — so PRs
      // stay independent. Editing the same file under a different PR later is the
      // legitimate overlap case, surfaced by the guard (#12) at commit/revert.
      const target = this.captureTarget(prs);
      if (target) {
        try {
          this.engine.noteEdit(target, file, prior);
        } catch {
          /* ignore capture errors */
        }
      }
    }
    this.lastContent.set(key, e.document.getText());
  }

  /** Which PR an edit is captured into: the active (selected) one. If the active
   *  pointer is stale/unset but PRs exist, adopt one so edits land somewhere
   *  predictable and the sidebar reflects it. */
  private captureTarget(prs: string[]): string | null {
    if (prs.length === 0) return null;
    const active = this.engine.storage.readActive();
    if (active && prs.includes(active)) return active;
    const fallback = prs[prs.length - 1];
    this.engine.storage.writeActive(fallback);
    return fallback;
  }

  /** Offer to open a PR the first time the user edits without one (this
   *  workspace session). Clicking the button runs the normal open-PR flow,
   *  which prompts for a title. */
  private maybeOfferOpenPr() {
    if (this.askedToOpenPr) return;
    this.askedToOpenPr = true;
    void vscode.window
      .showInformationMessage("Offshoot: you're editing without an open PR.", "Open PR")
      .then((pick) => {
        if (pick === "Open PR") void this.cmdOpenPR("", "");
      });
  }

  private onSave(doc: vscode.TextDocument) {
    const relRaw = this.relFor(doc.uri);
    if (relRaw === ".offshootignore") this.ignore.reload();
    const file = this.tracked(doc.uri);
    if (!file) return;
    this.lastContent.set(doc.uri.toString(), doc.getText());
    for (const prId of this.openPrIds()) {
      try {
        this.engine.recordChange(prId);
      } catch {
        /* ignore */
      }
    }
    if (this.decorations.reviewing) {
      this.baselineProvider.refresh(this.decorations.prId!, file);
      this.decorations.applyToAll();
    }
    const activePr = this.engine.storage.readActive();
    if (activePr) this.diffPanel.refresh(activePr, file);
    this.refresh();
  }

  /** Expand a created/deleted URI to the tracked files it represents: a file →
   *  itself; a folder → every (non-ignored) file within it, recursively. Folders
   *  are implicit — we track their files, not the folder path itself. */
  private expandToFiles(uri: vscode.Uri): Array<{ rel: string; abs: string }> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(uri.fsPath);
    } catch {
      return [];
    }
    const out: Array<{ rel: string; abs: string }> = [];
    const consider = (absFile: string) => {
      const rel = this.tracked(vscode.Uri.file(absFile));
      if (rel) out.push({ rel, abs: absFile });
    };
    if (stat.isDirectory()) for (const f of walkFiles(uri.fsPath)) consider(f);
    else consider(uri.fsPath);
    return out;
  }

  private onCreate(e: vscode.FileCreateEvent) {
    let any = false;
    for (const uri of e.files) {
      for (const { rel } of this.expandToFiles(uri)) {
        for (const prId of this.openPrIds()) {
          try {
            this.engine.noteCreate(prId, rel);
            any = true;
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (any) {
      for (const prId of this.openPrIds()) this.safeRecord(prId);
      this.refresh();
    }
  }

  /** Capture exact bytes of every file BEFORE deletion (they still exist here) —
   *  recursing into folders — so revert can restore them, binaries included.
   *  Runs for deletions initiated through VS Code. */
  private onWillDelete(e: vscode.FileWillDeleteEvent) {
    for (const uri of e.files) {
      for (const { rel, abs } of this.expandToFiles(uri)) {
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(abs);
        } catch {
          continue;
        }
        for (const prId of this.openPrIds()) {
          try {
            this.engine.noteDelete(prId, rel, bytes);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private onDelete(_e: vscode.FileDeleteEvent) {
    // Bytes were already captured in onWillDelete (pre-deletion); now the files
    // are gone, so recompute deltas and refresh.
    for (const prId of this.openPrIds()) this.safeRecord(prId);
    this.refresh();
  }

  private safeRecord(prId: string) {
    try {
      this.engine.recordChange(prId);
    } catch {
      /* ignore */
    }
  }

  // ---------------- message dispatch ----------------
  async handleMessage(msg: ToExt) {
    try {
      switch (msg.type) {
        case "ready":
          this.refresh();
          break;
        case "refresh":
          this.ignore.reload();
          this.refresh();
          break;
        case "openPR":
          await this.cmdOpenPR(msg.title, msg.notes, msg.id);
          break;
        case "selectPR":
          this.engine.storage.writeActive(msg.id);
          this.refresh();
          break;
        case "review":
          await this.cmdReview(msg.id);
          break;
        case "stopReview":
          this.decorations.stop();
          this.refresh();
          break;
        case "openFileDiff":
          await this.openFileDiff(msg.id, msg.file);
          break;
        case "openDiffPanel":
          await this.openDiffPanel(msg.id, msg.file);
          break;
        case "commit":
          await this.cmdCommit(msg.id);
          break;
        case "revert":
          await this.cmdRevert(msg.id);
          break;
        case "revertFile":
          await this.cmdRevertFile(msg.id, msg.file);
          break;
        case "editPR":
          await this.cmdEditPR(msg.id);
          break;
        case "commitSelection":
          await this.cmdCommitSelection(msg.id);
          break;
        case "revertSelection":
          await this.cmdRevertSelection(msg.id);
          break;
        case "recapture":
          this.engine.recapture(msg.id);
          this.setStatus("info", `PR ${prNum(msg.id)} re-captured (baseline reset to now).`);
          this.refresh();
          break;
        case "discard":
          this.engine.commit(msg.id);
          this.setStatus("info", `PR ${prNum(msg.id)} discarded.`);
          this.refresh();
          break;
        case "revealFolder":
          await this.revealFolder(msg.id);
          break;
        case "openLog":
          this.logPanel.show();
          break;
      }
    } catch (err) {
      await this.handleError(err);
    }
  }

  // ---------------- commands ----------------
  private async cmdOpenPR(title: string, notes: string, id?: string) {
    let finalTitle = title.trim();
    if (!finalTitle) {
      // Error #14: a PR title is required. Surface a box to type one, with
      // submit (Enter) / cancel (Esc) and inline validation that blocks empty.
      const entered = await vscode.window.showInputBox({
        title: "Open Pull Request — title required (Offshoot Error #14)",
        prompt: "Enter a title for the new Pull Request.",
        placeHolder: "e.g. Refactor auth flow",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "A PR title is required.")
      });
      if (entered === undefined || !entered.trim()) return; // cancelled
      finalTitle = entered.trim();
    }
    // Loop so Error #5's "Use a different id" can feed a new id back in.
    let prId = id?.trim() || this.nextId();
    for (;;) {
      try {
        this.engine.openPR(prId, finalTitle, notes);
        this.absorbOrphanBaselines(prId);
        this.decorations.stop();
        this.setStatus("info", `Opened PR ${prNum(prId)}.`);
        this.refresh();
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return;
        const done = await this.applyResolution(res, prId, {
          setId: (v) => (prId = v)
        });
        if (done) return;
      }
    }
  }

  /** Seed a freshly opened PR with baselines for files the user edited before
   *  any PR existed, so those changes are captured (and revertable) rather than
   *  silently adopted as the new baseline. Mirrors the MCP "track ahead of edit"
   *  flow: recordChange keeps a baseline even if it currently matches disk. */
  private absorbOrphanBaselines(prId: string) {
    if (this.orphanBaselines.size === 0) return;
    for (const [file, original] of this.orphanBaselines) {
      try {
        this.engine.noteEdit(prId, file, original);
      } catch {
        /* ignore capture errors */
      }
    }
    this.orphanBaselines.clear();
    try {
      this.engine.recordChange(prId);
    } catch {
      /* ignore */
    }
  }

  private nextId(): string {
    const ids = this.engine.storage.listPrIds();
    let n = 1;
    while (ids.includes(`pr${n}`)) n++;
    return `pr${n}`;
  }

  private async cmdReview(id: string) {
    if (!this.engine.storage.prExists(id)) {
      void this.handleError(Errors.prNotFound(id));
      return;
    }
    this.engine.storage.writeActive(id);
    this.decorations.start(id);

    // Open the first changed file alongside the custom diff panel; apply the
    // in-editor decorations to whatever's open.
    const view = this.engine.prView(id);
    const first = view.changedFiles[0];
    if (first) {
      await this.openDiffPanel(id, first.file);
      this.setStatus(
        "info",
        `Reviewing PR ${prNum(id)}: ${view.changedFiles.length} changed file(s).`
      );
    } else {
      this.setStatus("info", `Reviewing PR ${prNum(id)}: no changes yet.`);
    }
    this.decorations.applyToAll();
    this.refresh();
  }

  private async openFileDiff(prId: string, file: string) {
    const oldUri = BaselineContentProvider.uriFor(prId, file);
    const newUri = vscode.Uri.joinPath(
      vscode.Uri.file(this.workspaceRoot),
      ...file.split("/")
    );
    const exists = fs.existsSync(newUri.fsPath);
    const title = `${file} (baseline ↔ disk)`;
    // Open in the active editor group as a preview tab so it reuses one tab
    // instead of piling up a new tab per click.
    const opts: vscode.TextDocumentShowOptions = {
      preview: true,
      viewColumn: vscode.ViewColumn.Active
    };
    if (exists) {
      await vscode.commands.executeCommand("vscode.diff", oldUri, newUri, title, opts);
    } else {
      // file deleted on disk: show baseline against an empty doc
      const empty = vscode.Uri.from({ scheme: "offshoot-baseline", path: "/__empty__", query: "pr=__none__" });
      await vscode.commands.executeCommand("vscode.diff", oldUri, empty, title, opts);
    }
  }

  /** Short "N file(s), +A/−R" summary for confirm dialogs. */
  private summary(prId: string): string {
    try {
      const cf = this.engine.prView(prId).changedFiles;
      const a = cf.reduce((s, f) => s + f.added, 0);
      const r = cf.reduce((s, f) => s + f.removed, 0);
      return `${cf.length} file${cf.length === 1 ? "" : "s"}, +${a}/−${r}`;
    } catch {
      return "no changes";
    }
  }

  private async confirm(message: string, action: string): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      action
    );
    return pick === action;
  }

  private async cmdCommit(prId: string) {
    this.requirePr(prId);
    const meta = this.engine.storage.readMeta(prId);
    if (
      !(await this.confirm(
        `Commit PR ${prNum(prId)} — “${meta.title}”?  (${this.summary(prId)})\n\nThis deletes the baseline and cannot be undone.`,
        "Commit"
      ))
    )
      return;
    const files = this.engine.touchedFiles(prId);
    let ignoreOverlap = false;

    for (;;) {
      try {
        await this.checkUnsaved(files);
        if (!ignoreOverlap) this.checkOverlap(prId, files);
        this.engine.commit(prId);
        this.logPanel.refresh();
        this.decorations.reviewing && this.decorations.prId === prId && this.decorations.stop();
        this.setStatus("info", `Committed PR ${prNum(prId)}. Changes are now permanent.`);
        this.refresh();
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return; // cancelled
        const done = await this.applyResolution(res, prId, {
          setIgnoreOverlap: () => (ignoreOverlap = true)
        });
        if (done) return;
      }
    }
  }

  private async cmdRevert(prId: string) {
    this.requirePr(prId);
    const meta = this.engine.storage.readMeta(prId);
    if (
      !(await this.confirm(
        `Revert PR ${prNum(prId)} — “${meta.title}” to baseline?  (${this.summary(prId)})\n\nThis overwrites the current files on disk.`,
        "Revert"
      ))
    )
      return;
    const files = this.engine.touchedFiles(prId);
    let ignoreOverlap = false;

    for (;;) {
      try {
        await this.checkUnsaved(files);
        if (!ignoreOverlap) this.checkOverlap(prId, files, "revert");
        this.engine.revert(prId);
        this.logPanel.refresh();
        this.syncLastContent(files);
        this.decorations.reviewing && this.decorations.prId === prId && this.decorations.stop();
        this.setStatus("info", `Reverted PR ${prNum(prId)} to baseline.`);
        this.refresh();
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return;
        const done = await this.applyResolution(res, prId, {
          setIgnoreOverlap: () => (ignoreOverlap = true)
        });
        if (done) return;
      }
    }
  }

  private async cmdRevertFile(prId: string, file: string) {
    this.requirePr(prId);
    if (
      !(await this.confirm(
        `Revert ${file} to baseline in PR ${prNum(prId)}?\n\nThis overwrites the file on disk.`,
        "Revert File"
      ))
    )
      return;
    let ignoreOverlap = false;
    for (;;) {
      try {
        await this.checkUnsaved([file]);
        if (!ignoreOverlap) this.checkOverlap(prId, [file], "revert");
        this.engine.revertFile(prId, file);
        this.syncLastContent([file]);
        if (this.decorations.reviewing && this.decorations.prId === prId) {
          this.baselineProvider.refresh(prId, file);
          this.decorations.applyToAll();
        }
        if (!this.closeIfEmpty(prId, `Reverted ${file}`)) {
          this.setStatus("info", `Reverted ${file} to baseline.`);
        }
        this.refresh();
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return;
        const done = await this.applyResolution(res, prId, {
          setIgnoreOverlap: () => (ignoreOverlap = true)
        });
        if (done) return;
      }
    }
  }

  private async cmdEditPR(prId: string) {
    this.requirePr(prId);
    const meta = this.engine.storage.readMeta(prId);
    const title = await vscode.window.showInputBox({
      prompt: "PR title",
      value: meta.title
    });
    if (title === undefined) return; // cancelled
    const notes =
      (await vscode.window.showInputBox({
        prompt: "Notes (optional)",
        value: meta.notes
      })) ?? meta.notes;
    this.engine.editMeta(prId, title.trim() || meta.title, notes);
    this.setStatus("info", `Updated PR ${prNum(prId)}.`);
    this.refresh();
  }

  /** Move the cursor to the next/prev changed region of the active PR in the
   *  current file (dir > 0 = next, dir < 0 = previous; wraps around). */
  jumpChange(dir: 1 | -1) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const activePr = this.engine.storage.readActive();
    if (!activePr) {
      void this.reportNoActivePR();
      return;
    }
    const file = this.relFor(editor.document.uri);
    if (!file) return;
    let ranges: Array<[number, number]> = [];
    try {
      ranges = this.engine.changedLineRanges(activePr, file);
    } catch {
      ranges = [];
    }
    if (ranges.length === 0) {
      void info(`No changes in this file for PR ${prNum(activePr)}.`);
      return;
    }
    const starts = ranges.map((r) => r[0] - 1).sort((a, b) => a - b);
    const cur = editor.selection.active.line;
    let target: number;
    if (dir > 0) {
      target = starts.find((s) => s > cur) ?? starts[0];
    } else {
      const before = starts.filter((s) => s < cur);
      target = before.length ? before[before.length - 1] : starts[starts.length - 1];
    }
    const line = Math.min(target, editor.document.lineCount - 1);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /** Read the active editor's file + selected line range, or null with an error. */
  private editorSelection(): { file: string; start: number; end: number } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void showError("Open a file and select the region first.");
      return null;
    }
    const file = this.relFor(editor.document.uri);
    if (!file) {
      void showError("The active file is outside the workspace.");
      return null;
    }
    return { file, start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 };
  }

  private async cmdCommitSelection(prId: string) {
    const sel = this.editorSelection();
    if (sel) await this.commitRange(prId, sel.file, sel.start, sel.end);
  }

  private async cmdRevertSelection(prId: string) {
    const sel = this.editorSelection();
    if (sel) await this.revertRange(prId, sel.file, sel.start, sel.end);
  }

  /** Commit a specific disk line range of a file (used by both the editor
   *  selection command and the diff panel's per-hunk Commit button). */
  async commitRange(prId: string, file: string, start: number, end: number) {
    const confirm = await vscode.window.showWarningMessage(
      `Commit lines ${start}-${end} of ${file} in PR ${prNum(prId)}? Those lines become permanent.`,
      { modal: true },
      "Commit selection"
    );
    if (confirm !== "Commit selection") return;

    for (;;) {
      try {
        this.requirePr(prId);
        this.checkFilePresent(prId, file);
        this.checkOverlap(prId, [file]);
        this.engine.commitSelection(prId, file, start, end);
        const ed = this.openEditorFor(file);
        if (ed?.document.isDirty) await ed.document.save();
        if (!this.closeIfEmpty(prId, `Committed selection in ${file}`)) {
          this.setStatus("info", `Committed selection in ${file}.`);
        }
        this.afterFileMutation(prId, file);
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return;
        const done = await this.applyResolution(res, prId, {});
        if (done) return;
      }
    }
  }

  /** Revert a specific disk line range of a file to baseline. */
  async revertRange(prId: string, file: string, start: number, end: number) {
    const confirm = await vscode.window.showWarningMessage(
      `Revert lines ${start}-${end} of ${file} in PR ${prNum(prId)} to baseline? Those lines are overwritten on disk.`,
      { modal: true },
      "Revert selection"
    );
    if (confirm !== "Revert selection") return;

    let ignoreOverlap = false;
    for (;;) {
      try {
        this.requirePr(prId);
        const ed = this.openEditorFor(file);
        if (ed?.document.isDirty) await ed.document.save();
        this.checkFilePresent(prId, file);
        if (!ignoreOverlap) this.checkOverlap(prId, [file], "revert");
        this.engine.revertSelection(prId, file, start, end);
        this.syncLastContent([file]);
        if (!this.closeIfEmpty(prId, `Reverted selection in ${file}`)) {
          this.setStatus("info", `Reverted selection in ${file}.`);
        }
        this.afterFileMutation(prId, file);
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return;
        const done = await this.applyResolution(res, prId, {
          setIgnoreOverlap: () => (ignoreOverlap = true)
        });
        if (done) return;
      }
    }
  }

  // ---------------- guard checks ----------------
  private async checkUnsaved(files: string[]) {
    const dirty = vscode.workspace.textDocuments.filter(
      (d) => d.isDirty && d.uri.scheme === "file" && files.includes(this.relFor(d.uri) ?? "")
    );
    if (dirty.length) {
      throw Errors.unsavedChanges(dirty.map((d) => this.relFor(d.uri)!));
    }
  }

  /** #11 — a line-range op needs the file to be on disk. It can be gone if it
   *  was deleted outside VS Code after the diff panel rendered. */
  private checkFilePresent(prId: string, file: string) {
    if (!this.engine.missingFiles(prId).includes(file)) return;
    throw Errors.fileMissing(file, this.engine.storage.hasBaselineFile(prId, file));
  }

  private checkOverlap(prId: string, files: string[], op: "commit" | "revert" = "commit") {
    const overlapping = this.engine.overlappingPRs(prId, files);
    if (overlapping.length) {
      // surface the first shared file in the message
      const shared = files.find((f) =>
        overlapping.some((oid) =>
          Object.keys(this.engine.storage.readBaselineIndex(oid).files).includes(f)
        )
      );
      const f = shared ?? files[0];
      throw op === "revert"
        ? Errors.overlapRevert(f, prId, overlapping)
        : Errors.overlap(f, prId, overlapping);
    }
  }

  // ---------------- resolution ----------------
  private async resolveOr(err: unknown): Promise<Resolution | null> {
    if (err instanceof OffshootError) return resolveDialog(err);
    await this.handleError(err);
    return null;
  }

  /** Apply a chosen resolution. Returns true if the operation is fully done
   *  (no further retry); false to loop the guard again. Every ResolutionId the
   *  error catalogue can produce must have a case here — a missing one silently
   *  turns a dialog button into a no-op. */
  private async applyResolution(
    res: Resolution,
    prId: string,
    hooks: {
      setIgnoreOverlap?: () => void;
      /** #5 — retry opening the PR under a different id. */
      setId?: (id: string) => void;
    }
  ): Promise<boolean> {
    const target = (res.data as string) || prId;
    switch (res.id) {
      case "cancel":
        return true;
      case "retry":
        return false;
      case "refreshList":
        this.refresh();
        return true;
      case "removeFromList": {
        // The row pointed at a PR that is no longer on disk: drop every stale
        // reference to it, not just the list row.
        if (target && !this.engine.storage.prExists(target)) {
          if (this.engine.storage.readActive() === target) {
            this.engine.storage.writeActive(null);
          }
          if (this.decorations.prId === target) this.decorations.stop();
        }
        this.engine.cleanResidualStorage();
        this.refresh();
        return true;
      }
      case "openExisting": {
        if (!target || !this.engine.storage.prExists(target)) {
          this.refresh();
          return true;
        }
        this.engine.storage.writeActive(target);
        this.setStatus("info", `Selected PR ${prNum(target)}.`);
        this.refresh();
        return true;
      }
      case "useDifferentId": {
        const entered = await vscode.window.showInputBox({
          title: "Open Pull Request — choose a different id",
          value: this.nextId(),
          ignoreFocusOut: true,
          validateInput: (v) => {
            const t = v.trim();
            if (!t) return "An id is required.";
            if (this.engine.storage.prExists(t)) return `PR ${prNum(t)} already exists.`;
            return null;
          }
        });
        if (!entered?.trim()) return true; // cancelled
        hooks.setId?.(entered.trim());
        return false; // retry the open with the new id
      }
      case "openNew":
        await this.cmdOpenPR("", "");
        return true;
      case "selectExisting": {
        const picked = await this.pickPR();
        if (picked) {
          this.engine.storage.writeActive(picked);
          this.setStatus("info", `Selected PR ${prNum(picked)}.`);
          this.refresh();
        }
        return true;
      }
      case "recreate": {
        // #11 — the file vanished from disk; put it back from the baseline and
        // retry the operation that needed it.
        if (!target) return true;
        this.engine.restoreFile(prId, target);
        this.syncLastContent([target]);
        this.afterFileMutation(prId, target);
        return false;
      }
      case "skipFile":
        // #11 — leave the missing file alone, which means abandoning the
        // per-file operation that tripped over it.
        return true;
      case "save": {
        for (const d of vscode.workspace.textDocuments) {
          if (d.isDirty && d.uri.scheme === "file") await d.save();
        }
        return false;
      }
      case "discardBuffers": {
        for (const d of vscode.workspace.textDocuments) {
          if (d.isDirty && d.uri.scheme === "file") {
            await vscode.window.showTextDocument(d);
            await vscode.commands.executeCommand("workbench.action.files.revert");
          }
        }
        return false;
      }
      case "recapture":
        this.engine.recapture(target);
        this.setStatus("info", `Re-captured PR ${prNum(target)}.`);
        this.refresh();
        return false;
      case "discard":
        this.engine.commit(target);
        this.setStatus("info", `Discarded PR ${prNum(target)}.`);
        this.refresh();
        return true;
      case "revealFolder":
        await this.revealFolder(target);
        return true;
      case "commitOverlap": {
        this.engine.commit(target);
        this.logPanel.refresh();
        this.refresh();
        // if we committed the PR under operation, we're done; else loop to retry
        return target === prId;
      }
      case "commitAllOverlap": {
        for (const id of res.data as string[]) {
          if (this.engine.storage.prExists(id)) this.engine.commit(id);
        }
        this.logPanel.refresh();
        this.refresh();
        return true;
      }
      case "forceBaseline":
        hooks.setIgnoreOverlap?.();
        return false;
      case "chooseSelection":
        return true;
    }
  }

  private async revealFolder(prId: string) {
    const dir = vscode.Uri.file(this.engine.storage.prDir(prId));
    await vscode.commands.executeCommand("revealFileInOS", dir);
  }

  /** Terminal error path: for errors raised outside a command's guard loop.
   *  Resolutions that ask for a retry have nothing to retry here, so the choice
   *  is applied once and the result discarded — commands that can meaningfully
   *  retry (commit/revert/open/selection) run their own loop instead. */
  private async handleError(err: unknown) {
    if (err instanceof OffshootError) {
      const res = await resolveDialog(err);
      if (res) await this.applyResolution(res, "", {});
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      this.refresh();
    }
  }
}

/** Recursively list all files (absolute paths) under a directory. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
