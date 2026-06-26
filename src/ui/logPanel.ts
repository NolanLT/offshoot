import * as vscode from "vscode";
import type { Engine } from "../engine/engine";
import { prNum } from "../shared/protocol";

/**
 * A webview tab showing this workspace's PR history — a metadata-only log of
 * closed PRs (title, notes, id, dates, change/file counts, committed/reverted).
 * No code is stored. Includes per-row delete and a Clear-all button.
 */
export class LogPanel {
  private panel?: vscode.WebviewPanel;

  constructor(
    private engine: Engine,
    private onClear: () => void,
    private onDelete: (index: number) => void
  ) {}

  show() {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "offshoot.log",
        "Offshoot PR History",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m.type === "clear") this.onClear();
        else if (m.type === "delete" && typeof m.index === "number") this.onDelete(m.index);
        else if (m.type === "ready") this.post();
      });
    } else {
      this.panel.reveal();
    }
    this.post();
  }

  /** Re-send the log if the panel is open (after a PR closes or a delete). */
  refresh() {
    if (this.panel) this.post();
  }

  private post() {
    const entries = this.engine.readLog().map((e) => ({ ...e, num: prNum(e.id) }));
    void this.panel?.webview.postMessage({ type: "log", entries });
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceStr();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: transparent; padding: 12px;
  }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  h2 { margin: 0; font-size: 15px; }
  .count { opacity: 0.6; font-size: 12px; }
  .clear {
    margin-left: auto; font-family: inherit; font-size: 12px; cursor: pointer;
    background: transparent; border: 1px solid var(--vscode-charts-red, #f14c4c);
    color: var(--vscode-charts-red, #f14c4c); border-radius: 4px; padding: 3px 10px;
  }
  .clear:hover { background: color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 16%, transparent); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.8; }
  td.num, td.n { font-variant-numeric: tabular-nums; }
  .act { font-size: 11px; border-radius: 999px; padding: 1px 8px; }
  .committed { color: var(--vscode-charts-green, #3fb950); border: 1px solid color-mix(in srgb, var(--vscode-charts-green,#3fb950) 60%, transparent); }
  .reverted { color: var(--vscode-charts-red, #f14c4c); border: 1px solid color-mix(in srgb, var(--vscode-charts-red,#f14c4c) 60%, transparent); }
  .add { color: var(--vscode-charts-green, #3fb950); }
  .del { color: var(--vscode-charts-red, #f14c4c); }
  .notes { opacity: 0.8; max-width: 28em; }
  .x { cursor: pointer; opacity: 0.5; border: none; background: transparent; color: var(--vscode-foreground); font-size: 14px; }
  .x:hover { opacity: 1; color: var(--vscode-charts-red, #f14c4c); }
  .empty { opacity: 0.6; padding: 20px 0; }
</style></head>
<body>
  <div class="head">
    <h2>PR History</h2><span class="count" id="count"></span>
    <button class="clear" id="clear">Clear all</button>
  </div>
  <div id="body"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const body = document.getElementById("body");
    const count = document.getElementById("count");
    document.getElementById("clear").onclick = () => {
      if (confirm("Delete the entire PR history for this workspace?")) vscode.postMessage({ type: "clear" });
    };
    function esc(s){ return (s||"").replace(/[&<>]/g, c => c==="&"?"&amp;":c==="<"?"&lt;":"&gt;"); }
    function fmt(iso){ try { return new Date(iso).toLocaleString(); } catch { return iso; } }
    function render(entries){
      count.textContent = entries.length + (entries.length===1?" PR":" PRs");
      if (!entries.length){ body.innerHTML = '<div class="empty">No closed PRs yet.</div>'; return; }
      let h = '<table><thead><tr><th>#</th><th>Title</th><th></th><th>Files</th><th>+/-</th><th>Opened</th><th>Closed</th><th>Notes</th><th></th></tr></thead><tbody>';
      entries.forEach((e, i) => {
        h += '<tr>'
          + '<td class="num">'+esc(e.num)+'</td>'
          + '<td>'+esc(e.title)+'</td>'
          + '<td><span class="act '+e.action+'">'+e.action+'</span></td>'
          + '<td class="n">'+e.files+'</td>'
          + '<td class="n"><span class="add">+'+e.additions+'</span> <span class="del">-'+e.removals+'</span></td>'
          + '<td>'+fmt(e.created)+'</td>'
          + '<td>'+fmt(e.closed)+'</td>'
          + '<td class="notes">'+esc(e.notes)+'</td>'
          + '<td><button class="x" data-i="'+i+'" title="Delete this entry">✕</button></td>'
          + '</tr>';
      });
      h += '</tbody></table>';
      body.innerHTML = h;
      body.querySelectorAll(".x").forEach(b => b.onclick = () => vscode.postMessage({ type: "delete", index: Number(b.dataset.i) }));
    }
    window.addEventListener("message", ev => { if (ev.data.type === "log") render(ev.data.entries); });
    vscode.postMessage({ type: "ready" });
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
