// End-to-end smoke test of the Offshoot MCP server over real stdio MCP.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "mcp", "server.cjs");

let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.error("  ✗", m)));
const data = (res) => JSON.parse(res.content[0].text);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "offshoot-mcp-"));
fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, "--workspace", ws]
});
const client = new Client({ name: "offshoot-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
ok(tools.tools.some((t) => t.name === "offshoot_open_pr"), "exposes offshoot_open_pr");

const call = (name, args) => client.callTool({ name, arguments: args });

// empty title should error (Error #14)
const bad = await call("offshoot_open_pr", { title: "" });
ok(bad.isError === true, "empty title rejected");

const opened = data(await call("offshoot_open_pr", { title: "Test PR" }));
const id = opened.opened.id;
ok(id === "pr1", `opened PR (${id})`);

await call("offshoot_track_files", { id, files: ["a.txt"] });
fs.writeFileSync(path.join(ws, "a.txt"), "ONE\ntwo\n"); // edit after baseline

const changed = data(await call("offshoot_changed_files", { id }));
ok(changed.changedFiles.length === 1, "one changed file");
ok(changed.changedFiles[0].kind === "modified", "kind modified");

const diff = data(await call("offshoot_pr_diff", { id, file: "a.txt" }));
ok(diff.baseline === "one\ntwo\n", "diff baseline is pre-edit content");
ok(diff.current === "ONE\ntwo\n", "diff current is disk content");

const reverted = data(await call("offshoot_revert", { id }));
ok(reverted.reverted === id, "revert returned");
ok(fs.readFileSync(path.join(ws, "a.txt"), "utf8") === "one\ntwo\n", "file restored to baseline");

const list = data(await call("offshoot_list_prs", {}));
ok(list.prs.length === 0, "no PRs after revert");

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
