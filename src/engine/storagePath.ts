import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Deterministic per-workspace storage location, OUTSIDE any project tree, that
 * BOTH the VS Code extension and the standalone MCP server compute identically
 * from the workspace path. Lives under ~/.offshoot/<hash> so:
 *   - nothing is ever written into (or deployed with) the project,
 *   - each workspace is isolated (own hash subfolder — no cross-project bleed),
 *   - the MCP server can find the same data the extension uses, with no pointer
 *     file or VS Code-internal path knowledge.
 */
export function resolveStorageDir(workspaceRoot: string): string {
  // Normalize so the extension and MCP agree regardless of how the path was
  // passed (Windows is case-insensitive; collapse to lowercase there).
  const resolved = path.resolve(workspaceRoot);
  const norm = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".offshoot", hash);
}
