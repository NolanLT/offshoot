import * as vscode from "vscode";
import type { Engine } from "../engine/engine";

type HunkAction = (
  kind: "commit" | "revert",
  prId: string,
  file: string,
  start: number,
  end: number
) => void;

/**
 * A custom diff view in a WebviewPanel (opened to the right). Renders the
 * baseline-vs-disk diff as grouped red (removed) / green (added) blocks, styled
 * like the editor, scroll-synced to the file's editor on the left, with a
 * Revert button on each red block and a Commit button on each green block.
 */
export class DiffPanel {
  private panel?: vscode.WebviewPanel;
  private file?: string;
  private prId?: string;
  private scrollSub?: vscode.Disposable;

  constructor(
    private engine: Engine,
    private workspaceRoot: string,
    private onHunk: HunkAction
  ) {}

  show(prId: string, file: string) {
    this.prId = prId;
    this.file = file;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "offshoot.diff",
        `Offshoot Diff`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.scrollSub?.dispose();
        this.scrollSub = undefined;
      });
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    }

    this.panel.title = `Diff: ${file.split("/").pop()}`;
    this.post();
    this.wireScroll();
    // sync to the current editor position once
    const ed = this.editorFor(file);
    if (ed) this.syncFromEditor(ed);
  }

  /** Re-send the diff (e.g. after a save changed it) if this file is showing. */
  refresh(prId: string, file: string) {
    if (this.panel && this.prId === prId && this.file === file) this.post();
  }

  private post() {
    if (!this.panel || !this.prId || !this.file) return;
    try {
      const diff = this.engine.fileDiff(this.prId, this.file);
      void this.panel.webview.postMessage({ type: "diff", diff });
    } catch {
      /* ignore */
    }
  }

  private onMessage(m: { type: string; start?: number; end?: number; line?: number }) {
    if (!this.file || !this.prId) return;
    if (m.type === "commitHunk" && m.start != null && m.end != null) {
      this.onHunk("commit", this.prId, this.file, m.start, m.end);
    } else if (m.type === "revertHunk" && m.start != null && m.end != null) {
      this.onHunk("revert", this.prId, this.file, m.start, m.end);
    }
  }

  // ---- scroll sync (editor drives the panel) ----
  private wireScroll() {
    this.scrollSub?.dispose();
    this.scrollSub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (this.file && this.editorMatches(e.textEditor, this.file)) {
        this.syncFromEditor(e.textEditor);
      }
    });
  }

  private syncFromEditor(editor: vscode.TextEditor) {
    const top = editor.visibleRanges[0]?.start.line ?? 0;
    void this.panel?.webview.postMessage({ type: "scrollTo", diskLine: top + 1 });
  }

  private editorFor(file: string): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => this.editorMatches(e, file));
  }
  private editorMatches(editor: vscode.TextEditor, file: string): boolean {
    if (editor.document.uri.scheme !== "file") return false;
    return this.engine.rel(editor.document.uri.fsPath) === file;
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceStr();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }
  #scroll { height: 100vh; overflow: auto; }
  .line { display: flex; white-space: pre; }
  .ln {
    flex: 0 0 auto; width: 3.5em; padding: 0 0.8em 0 0;
    text-align: right; user-select: none;
    color: var(--vscode-editorLineNumber-foreground);
    opacity: 0.7;
  }
  .code { flex: 1 1 auto; padding-right: 7em; }
  .block { position: relative; }
  .block.del { background: color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 16%, transparent); }
  .block.add { background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 16%, transparent); }
  .block.del .code::before { content: "-"; position: absolute; left: 3.5em; opacity: 0.5; }
  .block.add .code::before { content: "+"; position: absolute; left: 3.5em; opacity: 0.5; }
  .hunk-btn {
    position: absolute; top: 2px; right: 6px;
    font-family: var(--vscode-font-family); font-size: 11px;
    border-radius: 4px; padding: 1px 8px; cursor: pointer;
    background: transparent; border: 1px solid var(--btn); color: var(--btn);
  }
  .hunk-btn:hover { background: color-mix(in srgb, var(--btn) 18%, transparent); }
  .revert { --btn: var(--vscode-charts-red, #f14c4c); }
  .commit { --btn: var(--vscode-charts-green, #3fb950); }
  .empty { padding: 14px; opacity: 0.6; }
</style></head>
<body>
  <div id="scroll"><div id="rows"></div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const scroller = document.getElementById("scroll");
    const rowsEl = document.getElementById("rows");
    let suppress = false;

    function lineEl(kind, lineNo, text) {
      const div = document.createElement("div");
      div.className = "line " + kind;
      if (lineNo != null) div.dataset.line = lineNo;
      const ln = document.createElement("span");
      ln.className = "ln"; ln.textContent = lineNo != null ? lineNo : "";
      const code = document.createElement("span");
      code.className = "code"; code.textContent = text.length ? text : " ";
      div.appendChild(ln); div.appendChild(code);
      return div;
    }

    function render(diff) {
      rowsEl.innerHTML = "";
      const rows = diff.rows;
      if (!rows.length) {
        const d = document.createElement("div");
        d.className = "empty"; d.textContent = "No changes in this file.";
        rowsEl.appendChild(d); return;
      }
      let i = 0;
      while (i < rows.length) {
        const r = rows[i];
        if (r.kind === "context") {
          rowsEl.appendChild(lineEl("context", r.diskLine, r.text));
          i++; continue;
        }
        const kind = r.kind, hunk = r.hunk;
        const block = document.createElement("div");
        block.className = "block " + kind;
        while (i < rows.length && rows[i].kind === kind && rows[i].hunk === hunk) {
          const rr = rows[i];
          block.appendChild(lineEl(kind, rr.kind === "add" ? rr.diskLine : null, rr.text));
          i++;
        }
        const h = diff.hunks[hunk];
        const btn = document.createElement("button");
        btn.className = "hunk-btn " + (kind === "del" ? "revert" : "commit");
        btn.textContent = kind === "del" ? "↩ Revert" : "✓ Commit";
        btn.onclick = () => vscode.postMessage({
          type: kind === "del" ? "revertHunk" : "commitHunk", start: h.start, end: h.end
        });
        block.appendChild(btn);
        rowsEl.appendChild(block);
      }
    }

    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (m.type === "diff") render(m.diff);
      else if (m.type === "scrollTo") {
        const el = rowsEl.querySelector('[data-line="' + m.diskLine + '"]');
        if (el) { suppress = true; scroller.scrollTop = el.offsetTop; setTimeout(() => suppress = false, 80); }
      }
    });
  </script>
</body></html>`;
  }
}

function nonceStr(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}
