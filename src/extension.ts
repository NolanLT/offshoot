import * as vscode from "vscode";
import { Controller } from "./controller";
import { SidebarProvider } from "./ui/sidebarProvider";

export function activate(ctx: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // Register a minimal view that explains the requirement.
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        SidebarProvider.viewId,
        new NoWorkspaceProvider()
      )
    );
    return;
  }

  const controller = new Controller(folder.uri.fsPath, ctx);
  const sidebar = new SidebarProvider(ctx.extensionUri, controller);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true }
    }),

    vscode.commands.registerCommand("offshoot.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("offshoot.openPR", async () => {
      const title = await vscode.window.showInputBox({ prompt: "PR title" });
      if (title === undefined) return;
      const notes =
        (await vscode.window.showInputBox({ prompt: "Notes (optional)" })) ?? "";
      await controller.handleMessage({ type: "openPR", title, notes });
    }),
    vscode.commands.registerCommand("offshoot.commitSelection", () => {
      const active = controller.engine.storage.readActive();
      if (!active) {
        void vscode.window.showWarningMessage("Offshoot: No active PR.");
        return;
      }
      void controller.handleMessage({ type: "commitSelection", id: active });
    }),
    vscode.commands.registerCommand("offshoot.revertSelection", () => {
      const active = controller.engine.storage.readActive();
      if (!active) {
        void vscode.window.showWarningMessage("Offshoot: No active PR.");
        return;
      }
      void controller.handleMessage({ type: "revertSelection", id: active });
    }),
    vscode.commands.registerCommand("offshoot.toggleReview", () => {
      if (controller.decorations.reviewing) {
        void controller.handleMessage({ type: "stopReview" });
      } else {
        const active = controller.engine.storage.readActive();
        if (active) void controller.handleMessage({ type: "review", id: active });
      }
    }),
    vscode.commands.registerCommand(
      "offshoot.openDiffForFile",
      (prId: string, file: string) =>
        controller.handleMessage({ type: "openDiffPanel", id: prId, file })
    ),
    vscode.commands.registerCommand("offshoot.nextChange", () =>
      controller.jumpChange(1)
    ),
    vscode.commands.registerCommand("offshoot.prevChange", () =>
      controller.jumpChange(-1)
    )
  );
}

export function deactivate() {
  /* nothing persistent to tear down; disk is the source of truth */
}

/** Fallback sidebar shown when no folder is open. */
class NoWorkspaceProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: false };
    view.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)">
      <h3>Offshoot</h3>
      <p>Open a folder to start tracking PRs. Offshoot stores its data under <code>.offshoot/</code> at the workspace root.</p>
    </body></html>`;
  }
}
