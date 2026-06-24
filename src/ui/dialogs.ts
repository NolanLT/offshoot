import * as vscode from "vscode";
import { OffshootError, type Resolution } from "../engine/errors";

/**
 * Present an OffshootError as a modal warning with one button per resolution.
 * Returns the chosen Resolution, or null if the user dismissed / chose Cancel.
 * Destructive choices get a second confirm step with an honest warning.
 */
export async function resolve(err: OffshootError): Promise<Resolution | null> {
  const buttons = err.resolutions.filter((r) => r.id !== "cancel");
  const labels = buttons.map((b) => b.label);

  const picked = await vscode.window.showWarningMessage(
    `Offshoot (Error #${err.code}): ${err.message}`,
    { modal: true },
    ...labels
  );
  if (!picked) return null; // Esc / Cancel

  const choice = buttons.find((b) => b.label === picked) ?? null;
  if (!choice) return null;

  if (choice.destructive) {
    const ok = await vscode.window.showWarningMessage(
      `"${choice.label}" cannot be undone and may discard data. Continue?`,
      { modal: true },
      "Yes, continue"
    );
    if (ok !== "Yes, continue") return null;
  }
  return choice;
}

export function info(text: string) {
  return vscode.window.showInformationMessage(`Offshoot: ${text}`);
}

export function error(text: string) {
  return vscode.window.showErrorMessage(`Offshoot: ${text}`);
}
