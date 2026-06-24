import * as vscode from "vscode";
import type { Engine } from "../engine/engine";

/**
 * Layer 1 — yellow change markers in the working editor while a PR is in Review
 * mode. Clicking a marked line is what opens the split diff (handled by the
 * controller via a selection listener).
 */
export class DecorationManager {
  private readonly deco = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255,255,0,0.20)",
    isWholeLine: true,
    overviewRulerColor: "rgba(255,255,0,0.7)",
    overviewRulerLane: vscode.OverviewRulerLane.Left
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
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.deco, []);
    }
  }

  /** Re-apply to all visible editors (after a save or an editor becomes visible). */
  applyToAll() {
    if (!this.reviewingPr) return;
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  apply(editor: vscode.TextEditor) {
    if (!this.reviewingPr) {
      editor.setDecorations(this.deco, []);
      return;
    }
    const file = this.relForEditor(editor);
    if (!file) {
      editor.setDecorations(this.deco, []);
      return;
    }
    let ranges: vscode.Range[];
    try {
      ranges = this.engine.changedLineRanges(this.reviewingPr, file).map(([a, b]) => {
        const start = Math.max(0, a - 1);
        const end = Math.max(0, b - 1);
        const lastLine = editor.document.lineCount - 1;
        return new vscode.Range(
          Math.min(start, lastLine),
          0,
          Math.min(end, lastLine),
          0
        );
      });
    } catch {
      ranges = [];
    }
    editor.setDecorations(this.deco, ranges);
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
    this.deco.dispose();
  }
}
