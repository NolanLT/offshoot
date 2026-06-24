import type { ToExt } from "../../src/shared/protocol";

interface VsCodeApi {
  postMessage(msg: ToExt): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function send(msg: ToExt) {
  vscode.postMessage(msg);
}
