import * as vscode from "vscode";
import type { Engine } from "../engine/engine";

/**
 * Option C — paint changes directly in the working editor while a PR is in
 * Review mode, so you see them without opening a diff tab:
 *   - added lines   -> green line background + gutter
 *   - modified lines-> blue (modified) line background + gutter
 *   - deleted lines -> red marker AND the removed text shown inline in red
 *     (italic, struck through) at the spot it was removed — since the text is
 *     gone from disk, this is how "red" is surfaced.
 * The on-demand split diff (Option A) remains the precise comparison.
 */
export class DecorationManager {
  private readonly addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorGutter.addedBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.addedBackground")
  });

  // Modified lines are shown green (added) too — no blue.
  private readonly modifiedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorGutter.addedBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.addedBackground")
  });

  // Base type for deletions; per-range render options carry the inline red text.
  private readonly deletedDeco = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorGutter.deletedBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: "1px 0 0 0",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.deletedBackground")
  });

  private reviewingPr: string | null = null;

  constructor(private engine: Engine, private workspaceRoot: string) {}

  get reviewing(): boolean {
    return this.reviewingPr !== null;
  }
  get prId(): string | null {
    return this.reviewingPr;
  }

  start(prId: string) {
    this.reviewingPr = prId;
    this.applyToAll();
  }

  stop() {
    this.reviewingPr = null;
    for (const editor of vscode.window.visibleTextEditors) this.clear(editor);
  }

  applyToAll() {
    if (!this.reviewingPr) return;
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
  }

  private clear(editor: vscode.TextEditor) {
    editor.setDecorations(this.addedDeco, []);
    editor.setDecorations(this.modifiedDeco, []);
    editor.setDecorations(this.deletedDeco, []);
  }

  apply(editor: vscode.TextEditor) {
    if (!this.reviewingPr) {
      this.clear(editor);
      return;
    }
    const file = this.relForEditor(editor);
    if (!file) {
      this.clear(editor);
      return;
    }

    const lastLine = Math.max(0, editor.document.lineCount - 1);
    const lineRange = (n: number) => {
      const l = Math.min(Math.max(0, n - 1), lastLine);
      return new vscode.Range(l, 0, l, 0);
    };

    let data;
    try {
      data = this.engine.decorationData(this.reviewingPr, file);
    } catch {
      this.clear(editor);
      return;
    }

    editor.setDecorations(this.addedDeco, data.added.map(lineRange));
    editor.setDecorations(this.modifiedDeco, data.modified.map(lineRange));

    const prId = this.reviewingPr;
    const delOpts: vscode.DecorationOptions[] = data.deleted.map((d) => {
      const joined = d.texts.join(" ⏎ ");
      const truncated = joined.length > 50;
      const text = truncated ? joined.slice(0, 49) + "…" : joined;
      const more = truncated || d.texts.length > 1 ? " (hover for full)" : "";
      const label = `  ⟵ removed: ${text || "(blank line)"}${more}`;

      // Hover reveals the complete removed block (numbered like editor lines for
      // positioning) + a clickable link to the diff, since the ghost text itself
      // can't take a click.
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.supportThemeIcons = true;
      const last = d.line + d.texts.length - 1;
      const width = String(last).length;
      const numbered = d.texts
        .map((t, i) => String(d.line + i).padStart(width, " ") + "  " + t)
        .join("\n");
      md.appendCodeblock(numbered, languageFor(file));
      const args = encodeURIComponent(JSON.stringify([prId, file]));
      md.appendMarkdown(`\n[↔ Open split diff](command:offshoot.openDiffForFile?${args})`);

      return {
        range: lineRange(d.line),
        hoverMessage: md,
        renderOptions: {
          after: {
            contentText: label,
            color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
            fontStyle: "italic"
          }
        }
      };
    });
    editor.setDecorations(this.deletedDeco, delOpts);
  }

  /** Is `editor` showing a file with changes in the reviewed PR? */
  fileForReviewedEditor(editor: vscode.TextEditor): string | null {
    if (!this.reviewingPr) return null;
    const file = this.relForEditor(editor);
    if (!file) return null;
    const ranges = this.engine.changedLineRanges(this.reviewingPr, file);
    return ranges.length ? file : null;
  }

  private relForEditor(editor: vscode.TextEditor): string | null {
    if (editor.document.uri.scheme !== "file") return null;
    const rel = this.engine.rel(editor.document.uri.fsPath);
    if (rel.startsWith("..")) return null;
    return rel;
  }

  dispose() {
    this.addedDeco.dispose();
    this.modifiedDeco.dispose();
    this.deletedDeco.dispose();
  }
}

/** Best-effort language id from a file extension, for hover code blocks. */
function languageFor(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    json: "json",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    sh: "shellscript",
    yml: "yaml",
    yaml: "yaml"
  };
  return map[ext] ?? "";
}
