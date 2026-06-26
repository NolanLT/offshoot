import * as vscode from "vscode";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import less from "highlight.js/lib/languages/less";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import type { Engine } from "../engine/engine";

for (const [name, lang] of Object.entries({
  typescript, javascript, json, css, scss, less, xml, markdown, python, rust,
  go, java, c, cpp, csharp, bash, yaml, sql, php, ruby
})) {
  hljs.registerLanguage(name, lang as never);
}

type HunkAction = (
  kind: "commit" | "revert",
  prId: string,
  file: string,
  start: number,
  end: number
) => void;

/**
 * A custom diff view in a WebviewPanel (opened to the right). Renders the
 * baseline-vs-disk diff as grouped red (removed) / green (added) blocks,
 * syntax-highlighted and styled like the editor (indent guides, line numbers),
 * scroll-synced to the file's editor on the left, with a Revert button on each
 * red block and a Commit button on each green block.
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
        "Offshoot Diff",
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
    const ed = this.editorFor(file);
    if (ed) this.syncFromEditor(ed);
  }

  refresh(prId: string, file: string) {
    if (this.panel && this.prId === prId && this.file === file) this.post();
  }

  private post() {
    if (!this.panel || !this.prId || !this.file) return;
    try {
      const diff = this.engine.fileDiff(this.prId, this.file);
      const lang = langFor(this.file);
      const tab = this.tabSizeFor(this.file, diff.rows);
      const rows = diff.rows.map((r) => ({
        kind: r.kind,
        line: r.kind === "del" ? null : r.diskLine,
        hunk: r.kind === "context" ? null : r.hunk,
        indent: indentLevels(r.text, tab),
        html: highlight(r.text, lang)
      }));
      void this.panel.webview.postMessage({ type: "diff", rows, hunks: diff.hunks, tab });
    } catch {
      /* ignore */
    }
  }

  /** Indent unit for this file: the open editor's tab size, else auto-detected
   *  from the content's smallest indent step, else 4. */
  private tabSizeFor(file: string, rows: { text: string }[]): number {
    const ed = this.editorFor(file);
    const t = ed && typeof ed.options.tabSize === "number" ? ed.options.tabSize : 0;
    if (t >= 2) return t;
    let min = 0;
    for (const r of rows) {
      const m = r.text.match(/^ +/);
      if (m && (min === 0 || m[0].length < min)) min = m[0].length;
    }
    return min === 2 || min === 4 ? min : 4;
  }

  private onMessage(m: { type: string; start?: number; end?: number }) {
    if (!this.file || !this.prId) return;
    if (m.type === "commitHunk" && m.start != null && m.end != null) {
      this.onHunk("commit", this.prId, this.file, m.start, m.end);
    } else if (m.type === "revertHunk" && m.start != null && m.end != null) {
      this.onHunk("revert", this.prId, this.file, m.start, m.end);
    }
  }

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
  .line { display: flex; white-space: pre; position: relative; }
  /* gutter is ch-based so indent guides line up exactly with the character grid */
  .ln {
    flex: 0 0 auto; width: 5ch; padding: 0 1ch 0 0;
    text-align: right; user-select: none;
    color: var(--vscode-editorLineNumber-foreground); opacity: 0.65;
  }
  .code { flex: 1 1 auto; padding-right: 7em; }
  .guide {
    position: absolute; top: 0; bottom: 0; width: 1px;
    background: var(--vscode-editorIndentGuide-background, rgba(128,128,128,0.25));
  }
  .block { position: relative; }
  .block.del { background: color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 14%, transparent); }
  .block.add { background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 14%, transparent); }
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
  /* syntax colors — Dark+ on dark themes, Light+ on light themes (the panel bg
     follows the active theme, so colors must too) */
  .vscode-dark .hljs-keyword,.vscode-dark .hljs-built_in,.vscode-dark .hljs-literal,.vscode-dark .hljs-meta,.vscode-dark .hljs-tag,.vscode-dark .hljs-name,.vscode-dark .hljs-symbol { color: #569cd6; }
  .vscode-dark .hljs-string,.vscode-dark .hljs-regexp { color: #ce9178; }
  .vscode-dark .hljs-comment,.vscode-dark .hljs-quote { color: #6a9955; }
  .vscode-dark .hljs-number { color: #b5cea8; }
  .vscode-dark .hljs-title,.vscode-dark .hljs-title.function_ { color: #dcdcaa; }
  .vscode-dark .hljs-title.class_,.vscode-dark .hljs-type { color: #4ec9b0; }
  .vscode-dark .hljs-attr,.vscode-dark .hljs-attribute,.vscode-dark .hljs-variable,.vscode-dark .hljs-template-variable,.vscode-dark .hljs-property { color: #9cdcfe; }
  .vscode-dark .hljs-selector-tag,.vscode-dark .hljs-selector-class,.vscode-dark .hljs-selector-id { color: #d7ba7d; }

  .vscode-light .hljs-keyword,.vscode-light .hljs-built_in,.vscode-light .hljs-literal,.vscode-light .hljs-meta,.vscode-light .hljs-tag,.vscode-light .hljs-name,.vscode-light .hljs-symbol { color: #0000ff; }
  .vscode-light .hljs-string,.vscode-light .hljs-regexp { color: #a31515; }
  .vscode-light .hljs-comment,.vscode-light .hljs-quote { color: #008000; }
  .vscode-light .hljs-number { color: #098658; }
  .vscode-light .hljs-title,.vscode-light .hljs-title.function_ { color: #795e26; }
  .vscode-light .hljs-title.class_,.vscode-light .hljs-type { color: #267f99; }
  .vscode-light .hljs-attr,.vscode-light .hljs-attribute,.vscode-light .hljs-variable,.vscode-light .hljs-template-variable,.vscode-light .hljs-property { color: #001080; }
  .vscode-light .hljs-selector-tag,.vscode-light .hljs-selector-class,.vscode-light .hljs-selector-id { color: #800000; }
  .hljs-comment,.hljs-quote { font-style: italic; }
</style></head>
<body>
  <div id="scroll"><div id="rows"></div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const scroller = document.getElementById("scroll");
    const rowsEl = document.getElementById("rows");
    let suppress = false;
    let tab = 4;

    function lineEl(row) {
      const div = document.createElement("div");
      div.className = "line " + row.kind;
      if (row.line != null) div.dataset.line = row.line;
      const ln = document.createElement("span");
      ln.className = "ln"; ln.textContent = row.line != null ? row.line : "";
      div.appendChild(ln);
      // indent guides at each indent level's left edge; gutter is 6ch wide
      // (5ch number + 1ch pad), so column 0 of the code is at 6ch — guides sit at
      // the start of each indent level (one ch left so the rule hugs the column).
      for (let k = 1; k <= row.indent; k++) {
        const g = document.createElement("div");
        g.className = "guide";
        g.style.left = (5 + (k - 1) * tab) + "ch";
        div.appendChild(g);
      }
      const code = document.createElement("span");
      code.className = "code hljs";
      code.innerHTML = row.html.length ? row.html : " ";
      div.appendChild(code);
      return div;
    }

    function render(rows, hunks) {
      rowsEl.innerHTML = "";
      if (!rows.length) {
        const d = document.createElement("div");
        d.className = "empty"; d.textContent = "No changes in this file.";
        rowsEl.appendChild(d); return;
      }
      let i = 0;
      while (i < rows.length) {
        const r = rows[i];
        if (r.kind === "context") { rowsEl.appendChild(lineEl(r)); i++; continue; }
        const kind = r.kind, hunk = r.hunk;
        const block = document.createElement("div");
        block.className = "block " + kind;
        while (i < rows.length && rows[i].kind === kind && rows[i].hunk === hunk) {
          block.appendChild(lineEl(rows[i])); i++;
        }
        const h = hunks[hunk];
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
      if (m.type === "diff") { tab = m.tab || 4; rowsEl.style.tabSize = tab; render(m.rows, m.hunks); }
      else if (m.type === "scrollTo") {
        const el = rowsEl.querySelector('[data-line="' + m.diskLine + '"]');
        if (el) { suppress = true; scroller.scrollTop = el.offsetTop; setTimeout(() => suppress = false, 80); }
      }
    });
  </script>
</body></html>`;
  }
}

// ---- helpers ----
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", json: "json", css: "css", scss: "scss",
  less: "less", html: "xml", xml: "xml", svg: "xml", md: "markdown",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c",
  cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp", sh: "bash", bash: "bash",
  yml: "yaml", yaml: "yaml", sql: "sql", php: "php", rb: "ruby"
};

function langFor(file: string): string | undefined {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const lang = EXT_LANG[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function highlight(text: string, lang?: string): string {
  if (!text) return "";
  if (!lang) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

/** Number of indent-guide levels for a line, from its leading whitespace. */
function indentLevels(text: string, tab: number): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width++;
    else if (ch === "\t") width += tab;
    else break;
  }
  return Math.floor(width / tab);
}

function nonceStr(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}
