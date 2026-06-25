import * as vscode from "vscode";
import type { Controller } from "../controller";
import type { ToExt, ToWebview, SidebarState } from "../shared/protocol";

/** Hosts the React sidebar (built to dist/webview) and bridges postMessage. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "offshoot.sidebar";

  /** The currently-live view, updated on each resolve. Badge + messages always
   *  target this one, so a stale/disposed view can never receive (or strand)
   *  the icon badge. */
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Controller
  ) {
    // Register the poster once; it routes to whatever the current view is.
    this.controller.setPoster((state) => this.render(state));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
    };
    webview.html = this.html(webview);

    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });

    webview.onDidReceiveMessage((msg: ToExt) => {
      void this.controller.handleMessage(msg);
    });

    // Push current state (and badge) as soon as the view is live.
    this.controller.refresh();
  }

  private render(state: SidebarState) {
    const view = this.view;
    if (!view) return;
    try {
      const msg: ToWebview = { type: "state", state };
      void view.webview.postMessage(msg);
    } catch {
      // view was disposed between checks; ignore
    }
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.css"));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${style}" />
  <title>Offshoot</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${script}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
