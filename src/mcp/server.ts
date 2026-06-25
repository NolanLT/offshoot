// Offshoot MCP server — exposes the (VS Code-independent) Engine to an AI over
// MCP/stdio. Operates on the SAME out-of-project storage the extension uses
// (resolveStorageDir), so PRs opened/committed here are the ones shown in the
// VS Code sidebar (which watches that folder and refreshes live).
//
// Workspace selection: --workspace <path> arg, else OFFSHOOT_WORKSPACE env,
// else process.cwd().
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Engine } from "../engine/engine";
import { resolveStorageDir } from "../engine/storagePath";

function resolveWorkspace(): string {
  const argIdx = process.argv.indexOf("--workspace");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return path.resolve(process.argv[argIdx + 1]);
  if (process.env.OFFSHOOT_WORKSPACE) return path.resolve(process.env.OFFSHOOT_WORKSPACE);
  return process.cwd();
}

const workspaceRoot = resolveWorkspace();
const engine = new Engine(workspaceRoot, resolveStorageDir(workspaceRoot));

const ok = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }]
});
const fail = (msg: string) => ({
  content: [{ type: "text" as const, text: `Error: ${msg}` }],
  isError: true
});

function nextId(): string {
  const ids = engine.storage.listPrIds();
  let n = 1;
  while (ids.includes(`pr${n}`)) n++;
  return `pr${n}`;
}
function abs(file: string) {
  return path.join(workspaceRoot, ...file.split("/"));
}

const server = new McpServer({ name: "offshoot", version: "0.1.0" });

server.tool(
  "offshoot_list_prs",
  "List all open Offshoot PRs in this workspace with their change counts.",
  {},
  async () => {
    const prs = engine.listPRs().map((m) => {
      let changeCount = 0;
      try {
        changeCount = engine.prView(m.id).changedFiles.length;
      } catch {
        /* ignore */
      }
      return { ...m, changeCount };
    });
    return ok({ workspaceRoot, prs });
  }
);

server.tool(
  "offshoot_open_pr",
  "Open a new PR. A title is required. Returns the PR id.",
  {
    title: z.string().min(1, "A PR title is required."),
    notes: z.string().optional(),
    id: z.string().optional()
  },
  async ({ title, notes, id }) => {
    const t = title.trim();
    if (!t) return fail("A PR title is required (Error #14).");
    const prId = id?.trim() || nextId();
    try {
      const meta = engine.openPR(prId, t, notes ?? "");
      return ok({ opened: meta });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "offshoot_track_files",
  "Snapshot the current on-disk content of files as the PR baseline BEFORE you " +
    "edit/create them, so Offshoot can compute the diff. Call this first in a " +
    "headless flow. Existing files are baselined at their current content; " +
    "paths that don't exist yet are marked as new (added on revert => deleted).",
  { id: z.string(), files: z.array(z.string()).min(1) },
  async ({ id, files }) => {
    if (!engine.storage.prExists(id)) return fail(`PR ${id} not found.`);
    for (const file of files) {
      try {
        if (fs.existsSync(abs(file))) {
          engine.noteEdit(id, file, fs.readFileSync(abs(file), "utf8"));
        } else {
          engine.noteCreate(id, file);
        }
      } catch (e) {
        return fail(`Failed to track ${file}: ${(e as Error).message}`);
      }
    }
    engine.recordChange(id);
    return ok({ tracked: files });
  }
);

server.tool(
  "offshoot_changed_files",
  "List the files changed in a PR (baseline vs current disk), with kind and counts.",
  { id: z.string() },
  async ({ id }) => {
    if (!engine.storage.prExists(id)) return fail(`PR ${id} not found.`);
    try {
      engine.recordChange(id);
      return ok(engine.prView(id));
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "offshoot_pr_diff",
  "Get the baseline (old) and current (new) content of one changed file in a PR.",
  { id: z.string(), file: z.string() },
  async ({ id, file }) => {
    if (!engine.storage.prExists(id)) return fail(`PR ${id} not found.`);
    const baseline = engine.baselineContent(id, file);
    const current = fs.existsSync(abs(file)) ? fs.readFileSync(abs(file), "utf8") : null;
    return ok({ file, baseline, current });
  }
);

server.tool(
  "offshoot_commit",
  "Commit a PR: make its changes permanent and delete its baseline (irreversible).",
  { id: z.string() },
  async ({ id }) => {
    try {
      engine.commit(id);
      return ok({ committed: id });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "offshoot_revert",
  "Revert a PR: overwrite the workspace files back to the PR baseline, then close it.",
  { id: z.string() },
  async ({ id }) => {
    try {
      engine.revert(id);
      return ok({ reverted: id });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "offshoot_revert_file",
  "Revert a single file in a PR to its baseline. Closes the PR if nothing remains.",
  { id: z.string(), file: z.string() },
  async ({ id, file }) => {
    if (!engine.storage.prExists(id)) return fail(`PR ${id} not found.`);
    try {
      engine.revertFile(id, file);
      if (engine.touchedFiles(id).length === 0) engine.storage.deletePR(id);
      return ok({ revertedFile: file, prClosed: !engine.storage.prExists(id) });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "offshoot_recapture",
  "Reset a PR's baseline to the current disk state (loses the prior change record). " +
    "Optionally scope to a single file.",
  { id: z.string(), file: z.string().optional() },
  async ({ id, file }) => {
    if (!engine.storage.prExists(id)) return fail(`PR ${id} not found.`);
    try {
      engine.recapture(id, file);
      return ok({ recaptured: id, file: file ?? "(all)" });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  console.error(`Offshoot MCP server ready (workspace: ${workspaceRoot})`);
}

main().catch((err) => {
  console.error("Offshoot MCP server failed:", err);
  process.exit(1);
});
