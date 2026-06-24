// Standalone self-test for the engine (no VS Code). Bundled+run by selftest.mjs.
// Simulates the VS Code event flow: noteEdit/noteCreate/noteDelete on disk
// changes, recordChange on save, then reconstruct/commit/revert/snippet.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Engine } from "../src/engine/engine";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}
function eq(a: unknown, b: unknown, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "offshoot-test-"));
}
function write(root: string, rel: string, content: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// --- Test 1: edit an existing file, reconstruct, commit, revert ---
(function editFlow() {
  console.log("edit / reconstruct / revert:");
  const root = tmp();
  write(root, "a.txt", "one\ntwo\nthree\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");

  // user edits line 2; controller captured prior content first
  e.noteEdit("pr1", "a.txt", "one\ntwo\nthree\n");
  write(root, "a.txt", "one\nTWO\nthree\n");
  e.recordChange("pr1");

  const view = e.prView("pr1");
  eq(view.changedFiles.length, 1, "one changed file");
  eq(view.changedFiles[0].kind, "modified", "kind modified");

  const base = e.reconstructBaseline("pr1");
  eq(base.get("a.txt"), "one\ntwo\nthree\n", "baseline reconstructs original");

  // revert restores disk
  e.revert("pr1");
  eq(read(root, "a.txt"), "one\ntwo\nthree\n", "revert restored disk");
  ok(!e.storage.prExists("pr1"), "pr folder gone after revert");
})();

// --- Test 2: commit makes disk permanent (folder deleted) ---
(function commitFlow() {
  console.log("commit:");
  const root = tmp();
  write(root, "a.txt", "x\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "a.txt", "x\n");
  write(root, "a.txt", "y\n");
  e.recordChange("pr1");
  e.commit("pr1");
  ok(!e.storage.prExists("pr1"), "commit deletes pr folder");
  eq(read(root, "a.txt"), "y\n", "disk unchanged by commit");
})();

// --- Test 3: added file -> revert deletes it ---
(function addFile() {
  console.log("added file:");
  const root = tmp();
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteCreate("pr1", "new.txt");
  write(root, "new.txt", "hello\n");
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles[0].kind, "added", "kind added");
  e.revert("pr1");
  ok(!fs.existsSync(path.join(root, "new.txt")), "revert deletes added file");
})();

// --- Test 4: deleted file -> revert recreates it ---
(function delFile() {
  console.log("deleted file:");
  const root = tmp();
  write(root, "gone.txt", "keep me\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteDelete("pr1", "gone.txt", "keep me\n");
  fs.rmSync(path.join(root, "gone.txt"));
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles[0].kind, "deleted", "kind deleted");
  e.revert("pr1");
  eq(read(root, "gone.txt"), "keep me\n", "revert recreates deleted file");
})();

// --- Test 5: overlap detection ---
(function overlap() {
  console.log("overlap:");
  const root = tmp();
  write(root, "shared.txt", "a\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.openPR("pr2", "t", "n");
  e.noteEdit("pr1", "shared.txt", "a\n");
  e.noteEdit("pr2", "shared.txt", "a\n");
  write(root, "shared.txt", "b\n");
  e.recordChange("pr1");
  e.recordChange("pr2");
  eq(e.overlappingPRs("pr1", ["shared.txt"]), ["pr2"], "pr2 overlaps pr1");
})();

// --- Test 6: snippet commit finalizes only selected lines ---
(function snippet() {
  console.log("snippet commit:");
  const root = tmp();
  write(root, "s.txt", "L1\nL2\nL3\nL4\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "s.txt", "L1\nL2\nL3\nL4\n");
  // edit line 1 and line 4
  write(root, "s.txt", "X1\nL2\nL3\nX4\n");
  e.recordChange("pr1");
  // commit only line 1 (selection lines 1-1)
  e.commitSelection("pr1", "s.txt", 1, 1);
  // baseline for s.txt should now have X1 (committed) but still L4 for line 4
  const base = e.reconstructBaseline("pr1");
  eq(base.get("s.txt"), "X1\nL2\nL3\nL4\n", "snippet finalized line1, kept line4 change");
  const view = e.prView("pr1");
  ok(view.changedFiles.length === 1, "still one open change (line 4)");
})();

// --- Test 7: re-capture resets baseline to now ---
(function recapture() {
  console.log("re-capture:");
  const root = tmp();
  write(root, "r.txt", "orig\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "r.txt", "orig\n");
  write(root, "r.txt", "changed\n");
  e.recordChange("pr1");
  e.recapture("pr1");
  eq(e.prView("pr1").changedFiles.length, 0, "no changes after re-capture");
  const base = e.reconstructBaseline("pr1");
  eq(base.get("r.txt"), undefined, "baseline now equals disk (file untracked)");
})();

// --- Test 8: no-op edit is pruned ---
(function pruneNoop() {
  console.log("prune no-op:");
  const root = tmp();
  write(root, "p.txt", "same\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "p.txt", "same\n");
  write(root, "p.txt", "diff\n");
  e.recordChange("pr1");
  write(root, "p.txt", "same\n"); // revert by hand
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles.length, 0, "identical-to-baseline file pruned");
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
