import * as vscode from "vscode";
import type { Engine } from "../engine/engine";
import type { DecorationManager } from "./decorations";

/**
 * A clickable "↔ Offshoot diff" lens at the top of each changed region while a
 * PR is in Review mode — the genuine click trigger for Layer 2 (split diff).
 */
export class OffshootCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private engine: Engine, private decorations: DecorationManager) {}

  refresh() {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const prId = this.decorations.prId;
    if (!prId || document.uri.scheme !== "file") return [];
    const rel = this.engine.rel(document.uri.fsPath);
    if (rel.startsWith("..")) return [];

    let ranges: Array<[number, number]>;
    try {
      ranges = this.engine.changedLineRanges(prId, rel);
    } catch {
      return [];
    }
    return ranges.map(([a]) => {
      const line = Math.max(0, Math.min(a - 1, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, {
        title: "↔ Offshoot diff",
        command: "offshoot.openDiffForFile",
        arguments: [prId, rel]
      });
    });
  }
}
