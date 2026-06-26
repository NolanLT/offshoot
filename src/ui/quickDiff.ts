import * as vscode from "vscode";
import type { Engine } from "../engine/engine";
import { BaselineContentProvider } from "./baselineProvider";

/**
 * Registers a VS Code QuickDiffProvider so the editor shows native dirty-diff
 * gutter bars (green/blue/red) against the PR baseline, with the built-in inline
 * change peek (old above new) and a "Revert Change" action — all in one tab.
 *
 * The "original" for a file is its baseline served via the `offshoot-baseline:`
 * content provider (baseline if edited, else current content = no diff). We
 * provide an original for every workspace file while a PR is active; the content
 * provider decides whether there's actually a difference.
 */
export class QuickDiff {
  private readonly scm: vscode.SourceControl;

  constructor(private engine: Engine, workspaceRoot: string, ctx: vscode.ExtensionContext) {
    this.scm = vscode.scm.createSourceControl(
      "offshoot",
      "Offshoot",
      vscode.Uri.file(workspaceRoot)
    );
    this.scm.quickDiffProvider = {
      provideOriginalResource: (uri) => this.original(uri)
    };
    ctx.subscriptions.push(this.scm);
  }

  private original(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== "file") return undefined;
    const activePr = this.engine.storage.readActive();
    if (!activePr || !this.engine.storage.prExists(activePr)) return undefined;
    const rel = this.engine.rel(uri.fsPath);
    if (rel.startsWith("..")) return undefined;
    return BaselineContentProvider.uriFor(activePr, rel);
  }
}
