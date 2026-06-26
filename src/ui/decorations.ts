import * as vscode from "vscode";
import type { Engine } from "../engine/engine";

/**
 * Option C — paint changes directly in the working editor while a PR is in
 * Review mode, so you see them without opening a diff tab:
 *   - added lines   -> green line background + gutter
 *   - modified lines-> blue (modified) line background + gutter
 * Deletions aren't painted in the working editor (the text is gone from disk);
 * the on-demand split diff (Option A) is where removed lines are surfaced.
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

  // Modified lines: blue, distinct from added (green).
  private readonly modifiedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editorGutter.modifiedBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorGutter.modifiedBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.modifiedBackground")
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
  }
}
