import * as vscode from "vscode";
import * as fs from "node:fs";
import { Engine } from "./engine/engine";
import { Errors, OffshootError, type Resolution } from "./engine/errors";
import { BaselineContentProvider } from "./ui/baselineProvider";
import { DecorationManager } from "./ui/decorations";
import { resolve as resolveDialog, info, error as showError } from "./ui/dialogs";
import { IgnoreMatcher } from "./engine/ignore";
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

  private post: ((state: SidebarState) => void) | null = null;
  private status: SidebarState["status"] = null;
  /** current editor content, before each change, for baseline capture. */
  private lastContent = new Map<string, string>();
  private ignore: IgnoreMatcher;

  constructor(readonly workspaceRoot: string, ctx: vscode.ExtensionContext) {
    this.engine = new Engine(workspaceRoot);
    this.baselineProvider = new BaselineContentProvider(this.engine);
    this.decorations = new DecorationManager(this.engine, workspaceRoot);
    this.ignore = new IgnoreMatcher(workspaceRoot);

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
      vscode.workspace.onDidCreateFiles((e) => this.onCreate(e)),
      vscode.workspace.onDidDeleteFiles((e) => this.onDelete(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorations.applyToAll())
    );

    this.syncContextKey();
  }

  // ---------------- webview wiring ----------------
  setPoster(fn: (state: SidebarState) => void) {
    this.post = fn;
  }

  buildState(): SidebarState {
    const prs: PRListItem[] = this.engine.listPRs().map((meta) => {
      let changeCount = 0;
      try {
        changeCount = this.engine.prView(meta.id).changedFiles.length;
      } catch {
        /* leave 0 */
      }
      return { ...meta, changeCount };
    });
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
      reviewing,
      status: this.status
    };
  }

  refresh() {
    if (this.post) this.post(this.buildState());
    this.syncContextKey();
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

  private onChange(e: vscode.TextDocumentChangeEvent) {
    const file = this.tracked(e.document.uri);
    if (!file) return;
    const key = e.document.uri.toString();
    const prior = this.lastContent.get(key);
    if (prior !== undefined) {
      for (const prId of this.openPrIds()) {
        try {
          this.engine.noteEdit(prId, file, prior);
        } catch {
          /* ignore capture errors */
        }
      }
    }
    this.lastContent.set(key, e.document.getText());
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
    this.refresh();
  }

  private onCreate(e: vscode.FileCreateEvent) {
    let any = false;
    for (const uri of e.files) {
      const file = this.tracked(uri);
      if (!file) continue;
      for (const prId of this.openPrIds()) {
        try {
          this.engine.noteCreate(prId, file);
          any = true;
        } catch {
          /* ignore */
        }
      }
    }
    if (any) {
      for (const prId of this.openPrIds()) this.safeRecord(prId);
      this.refresh();
    }
  }

  private onDelete(e: vscode.FileDeleteEvent) {
    let any = false;
    for (const uri of e.files) {
      const file = this.tracked(uri);
      if (!file) continue;
      const prior = this.lastContent.get(uri.toString()) ?? "";
      for (const prId of this.openPrIds()) {
        try {
          this.engine.noteDelete(prId, file, prior);
          any = true;
        } catch {
          /* ignore */
        }
      }
    }
    if (any) {
      for (const prId of this.openPrIds()) this.safeRecord(prId);
      this.refresh();
    }
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
        case "recapture":
          this.engine.recapture(msg.id);
          this.setStatus("info", `PR #${msg.id} re-captured (baseline reset to now).`);
          this.refresh();
          break;
        case "discard":
          this.engine.commit(msg.id);
          this.setStatus("info", `PR #${msg.id} discarded.`);
          this.refresh();
          break;
        case "revealFolder":
          await this.revealFolder(msg.id);
          break;
      }
    } catch (err) {
      await this.handleError(err);
    }
  }

  // ---------------- commands ----------------
  private async cmdOpenPR(title: string, notes: string, id?: string) {
    const prId = id?.trim() || this.nextId();
    try {
      this.engine.openPR(prId, title.trim() || prId, notes);
      this.decorations.stop();
      this.setStatus("info", `Opened PR #${prId}.`);
      this.refresh();
    } catch (err) {
      await this.handleError(err);
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

    // Open the changed files so the yellow markers + diff lenses are actually
    // visible — otherwise Review looks like it did nothing.
    const view = this.engine.prView(id);
    const openable = view.changedFiles.filter((f) => f.kind !== "deleted");
    for (const f of openable) {
      const uri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        ...f.file.split("/")
      );
      try {
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch {
        /* file may be unopenable; skip */
      }
    }
    this.decorations.applyToAll();

    if (openable.length === 0) {
      this.setStatus(
        "info",
        `Review on for ${id}: no editable changed files yet. Edit and save a file to see markers.`
      );
    } else {
      this.setStatus(
        "info",
        `Reviewing ${openable.length} file(s): yellow lines mark changes — click the “↔ Offshoot diff” lens or a file in the panel to see the split diff.`
      );
    }
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
    if (!this.engine.storage.prExists(prId)) throw Errors.prNotFound(prId);
    const meta = this.engine.storage.readMeta(prId);
    if (
      !(await this.confirm(
        `Commit PR ${prId} — “${meta.title}”?  (${this.summary(prId)})\n\nThis deletes the baseline and cannot be undone.`,
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
        this.decorations.reviewing && this.decorations.prId === prId && this.decorations.stop();
        this.setStatus("info", `Committed PR #${prId}. Changes are now permanent.`);
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
    if (!this.engine.storage.prExists(prId)) throw Errors.prNotFound(prId);
    const meta = this.engine.storage.readMeta(prId);
    if (
      !(await this.confirm(
        `Revert PR ${prId} — “${meta.title}” to baseline?  (${this.summary(prId)})\n\nThis overwrites the current files on disk.`,
        "Revert"
      ))
    )
      return;
    const files = this.engine.touchedFiles(prId);
    let ignoreOverlap = false;

    for (;;) {
      try {
        await this.checkUnsaved(files);
        if (!ignoreOverlap) this.checkOverlap(prId, files);
        this.engine.revert(prId);
        this.decorations.reviewing && this.decorations.prId === prId && this.decorations.stop();
        this.setStatus("info", `Reverted PR #${prId} to baseline.`);
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
    if (!this.engine.storage.prExists(prId)) throw Errors.prNotFound(prId);
    if (
      !(await this.confirm(
        `Revert ${file} to baseline in PR ${prId}?\n\nThis overwrites the file on disk.`,
        "Revert File"
      ))
    )
      return;
    let ignoreOverlap = false;
    for (;;) {
      try {
        await this.checkUnsaved([file]);
        if (!ignoreOverlap) this.checkOverlap(prId, [file]);
        this.engine.revertFile(prId, file);
        if (this.decorations.reviewing && this.decorations.prId === prId) {
          this.baselineProvider.refresh(prId, file);
          this.decorations.applyToAll();
        }
        this.setStatus("info", `Reverted ${file} to baseline.`);
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
    if (!this.engine.storage.prExists(prId)) throw Errors.prNotFound(prId);
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
    this.setStatus("info", `Updated PR ${prId}.`);
    this.refresh();
  }

  /** Move the cursor to the next/prev changed region of the active PR in the
   *  current file (dir > 0 = next, dir < 0 = previous; wraps around). */
  jumpChange(dir: 1 | -1) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const activePr = this.engine.storage.readActive();
    if (!activePr) {
      void info("No active PR.");
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
      void info(`No changes in this file for PR ${activePr}.`);
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

  private async cmdCommitSelection(prId: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void showError("Open a file and select the region to commit.");
      return;
    }
    const file = this.relFor(editor.document.uri);
    if (!file) {
      void showError("The active file is outside the workspace.");
      return;
    }
    const sel = editor.selection;
    const start = sel.start.line + 1;
    const end = sel.end.line + 1;

    const confirm = await vscode.window.showWarningMessage(
      `Commit lines ${start}-${end} of ${file} in PR #${prId}? Those lines become permanent.`,
      { modal: true },
      "Commit selection"
    );
    if (confirm !== "Commit selection") return;

    for (;;) {
      try {
        this.checkOverlap(prId, [file]);
        this.engine.commitSelection(prId, file, start, end);
        if (editor.document.isDirty) await editor.document.save();
        this.setStatus("info", `Committed selection in ${file}.`);
        if (this.decorations.reviewing) {
          this.baselineProvider.refresh(prId, file);
          this.decorations.applyToAll();
        }
        this.refresh();
        return;
      } catch (err) {
        const res = await this.resolveOr(err);
        if (!res) return;
        const done = await this.applyResolution(res, prId, {});
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

  private checkOverlap(prId: string, files: string[]) {
    const overlapping = this.engine.overlappingPRs(prId, files);
    if (overlapping.length) {
      // surface the first shared file in the message
      const shared = files.find((f) =>
        overlapping.some((oid) =>
          Object.keys(this.engine.storage.readBaselineIndex(oid).files).includes(f)
        )
      );
      throw Errors.overlap(shared ?? files[0], prId, overlapping);
    }
  }

  // ---------------- resolution ----------------
  private async resolveOr(err: unknown): Promise<Resolution | null> {
    if (err instanceof OffshootError) return resolveDialog(err);
    await this.handleError(err);
    return null;
  }

  /** Apply a chosen resolution. Returns true if the operation is fully done
   *  (no further retry); false to loop the guard again. */
  private async applyResolution(
    res: Resolution,
    prId: string,
    hooks: { setIgnoreOverlap?: () => void }
  ): Promise<boolean> {
    switch (res.id) {
      case "cancel":
        return true;
      case "retry":
        return false;
      case "refreshList":
      case "removeFromList":
        this.refresh();
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
        this.engine.recapture((res.data as string) ?? prId);
        this.setStatus("info", `Re-captured PR #${(res.data as string) ?? prId}.`);
        this.refresh();
        return false;
      case "discard":
        this.engine.commit((res.data as string) ?? prId);
        this.setStatus("info", `Discarded PR #${(res.data as string) ?? prId}.`);
        this.refresh();
        return true;
      case "revealFolder":
        await this.revealFolder((res.data as string) ?? prId);
        return true;
      case "commitOverlap": {
        const target = res.data as string;
        this.engine.commit(target);
        this.refresh();
        // if we committed the PR under operation, we're done; else loop to retry
        return target === prId;
      }
      case "commitAllOverlap": {
        for (const id of res.data as string[]) {
          if (this.engine.storage.prExists(id)) this.engine.commit(id);
        }
        this.refresh();
        return true;
      }
      case "forceBaseline":
        hooks.setIgnoreOverlap?.();
        return false;
      case "keepDisk":
      case "skipFile":
        hooks.setIgnoreOverlap?.();
        return false;
      case "chooseSelection":
        return true;
      default:
        return true;
    }
  }

  private async revealFolder(prId: string) {
    const dir = vscode.Uri.file(this.engine.storage.prDir(prId));
    await vscode.commands.executeCommand("revealFileInOS", dir);
  }

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
