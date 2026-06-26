import * as vscode from "vscode";
import type { Engine } from "../engine/engine";

export const BASELINE_SCHEME = "offshoot-baseline";

/**
 * Serves the reconstructed baseline ("old", red side) for the native split
 * diff. URI shape: offshoot-baseline:/<file>?pr=<prId>
 * The path carries the file (so the editor shows a sensible title + language);
 * the query carries the PR id.
 */
export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private engine: Engine) {}

  static uriFor(prId: string, file: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: BASELINE_SCHEME,
      path: "/" + file,
      query: `pr=${encodeURIComponent(prId)}`
    });
  }

  refresh(prId: string, file: string) {
    this._onDidChange.fire(BaselineContentProvider.uriFor(prId, file));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const prId = params.get("pr") ?? "";
    const file = uri.path.replace(/^\//, "");
    try {
      return this.engine.baselineContent(prId, file);
    } catch {
      return "";
    }
  }
}
