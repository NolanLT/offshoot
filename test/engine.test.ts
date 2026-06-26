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

// --- Test 9: revert a single file leaves other changes intact ---
(function revertSingleFile() {
  console.log("revert single file:");
  const root = tmp();
  write(root, "a.txt", "A\n");
  write(root, "b.txt", "B\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "a.txt", "A\n");
  e.noteEdit("pr1", "b.txt", "B\n");
  write(root, "a.txt", "A2\n");
  write(root, "b.txt", "B2\n");
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles.length, 2, "two changed files");
  e.revertFile("pr1", "a.txt");
  eq(read(root, "a.txt"), "A\n", "a.txt restored to baseline");
  eq(read(root, "b.txt"), "B2\n", "b.txt change untouched");
  const cf = e.prView("pr1").changedFiles;
  eq(cf.length, 1, "only b.txt remains changed");
  ok(e.storage.prExists("pr1"), "PR still open after single-file revert");
})();

// --- Test 10: editMeta updates title/notes ---
(function editMeta() {
  console.log("edit meta:");
  const root = tmp();
  const e = new Engine(root);
  e.openPR("pr1", "old", "oldnotes");
  e.editMeta("pr1", "new title", "new notes");
  const m = e.storage.readMeta("pr1");
  eq(m.title, "new title", "title updated");
  eq(m.notes, "new notes", "notes updated");
})();

// --- Test 11: delete a binary file -> revert restores exact bytes ---
(function binaryDeleteRevert() {
  console.log("binary delete revert:");
  const root = tmp();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00, 0x42]);
  fs.writeFileSync(path.join(root, "logo.png"), bytes);
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  // simulate onWillDelete capturing bytes before deletion
  e.noteDelete("pr1", "logo.png", bytes);
  fs.rmSync(path.join(root, "logo.png"));
  e.recordChange("pr1");
  const cf = e.prView("pr1").changedFiles;
  eq(cf.length, 1, "one changed file");
  eq(cf[0].kind, "deleted", "kind deleted");
  e.revert("pr1");
  const restored = fs.readFileSync(path.join(root, "logo.png"));
  ok(restored.equals(bytes), "binary file restored with exact bytes");
})();

// --- Test 12: add a binary file -> revert deletes it ---
(function binaryAddRevert() {
  console.log("binary add revert:");
  const root = tmp();
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteCreate("pr1", "new.png");
  fs.writeFileSync(path.join(root, "new.png"), Buffer.from([0x00, 0x10, 0x00, 0x7f]));
  e.recordChange("pr1");
  const cf = e.prView("pr1").changedFiles;
  eq(cf[0].kind, "added", "kind added");
  e.revert("pr1");
  ok(!fs.existsSync(path.join(root, "new.png")), "revert deletes added binary");
})();

// --- Test 13: delete a folder (its files) -> revert restores the tree ---
(function folderDeleteRevert() {
  console.log("folder delete revert:");
  const root = tmp();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/sub/b.ts", "export const b = 2;\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  // simulate onWillDelete capturing every file in the folder before removal
  e.noteDelete("pr1", "src/a.ts", Buffer.from(read(root, "src/a.ts")));
  e.noteDelete("pr1", "src/sub/b.ts", Buffer.from(read(root, "src/sub/b.ts")));
  fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles.length, 2, "two deleted files tracked");
  e.revert("pr1");
  eq(read(root, "src/a.ts"), "export const a = 1;\n", "src/a.ts restored");
  eq(read(root, "src/sub/b.ts"), "export const b = 2;\n", "nested src/sub/b.ts restored");
})();

// --- Test 14: add a folder (its files) -> revert removes files AND folders ---
(function folderAddRevert() {
  console.log("folder add revert:");
  const root = tmp();
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteCreate("pr1", "newdir/x.ts");
  e.noteCreate("pr1", "newdir/deep/y.ts");
  write(root, "newdir/x.ts", "x\n");
  write(root, "newdir/deep/y.ts", "y\n");
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles.length, 2, "two added files");
  e.revert("pr1");
  ok(!fs.existsSync(path.join(root, "newdir/x.ts")), "added file removed");
  ok(!fs.existsSync(path.join(root, "newdir")), "empty added folder pruned");
})();

// --- Test 15: revert selection reverts only selected lines ---
(function revertSelection() {
  console.log("revert selection:");
  const root = tmp();
  write(root, "f.txt", "L1\nL2\nL3\nL4\n");
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "f.txt", "L1\nL2\nL3\nL4\n");
  write(root, "f.txt", "X1\nL2\nL3\nX4\n"); // edited lines 1 and 4
  e.recordChange("pr1");
  // revert only line 1 (disk lines 1-1)
  e.revertSelection("pr1", "f.txt", 1, 1);
  eq(read(root, "f.txt"), "L1\nL2\nL3\nX4\n", "line 1 reverted, line 4 kept");
  const cf = e.prView("pr1").changedFiles;
  eq(cf.length, 1, "line 4 still changed");
})();

// --- Test 16: CRLF baseline vs LF disk, one line edited -> +1/-1 (not +2/-2) ---
(function eolMismatchCounts() {
  console.log("EOL mismatch counts:");
  const root = tmp();
  write(root, "f.txt", "alpha\nbeta\n"); // LF on disk
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "f.txt", "alpha\r\nbeta\r\n"); // baseline captured as CRLF
  write(root, "f.txt", "alpha\nbeta EDIT\n"); // edit one line, LF
  e.recordChange("pr1");
  const cf = e.prView("pr1").changedFiles;
  eq(cf.length, 1, "one changed file");
  eq([cf[0].added, cf[0].removed], [1, 1], "edited one line counts as +1/-1");
})();

// --- Test 17: EOL-only difference is not a change ---
(function eolOnlyNoChange() {
  console.log("EOL-only difference:");
  const root = tmp();
  write(root, "f.txt", "alpha\nbeta\n"); // LF
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "f.txt", "alpha\r\nbeta\r\n"); // baseline CRLF, same content
  e.recordChange("pr1");
  eq(e.prView("pr1").changedFiles.length, 0, "EOL-only diff shows no changes");
})();

// --- Test 18: revert selection preserves the file's CRLF EOL ---
(function revertSelectionEol() {
  console.log("revert selection EOL:");
  const root = tmp();
  write(root, "f.txt", "A\r\nB\r\nC\r\n"); // CRLF file
  const e = new Engine(root);
  e.openPR("pr1", "t", "n");
  e.noteEdit("pr1", "f.txt", "A\r\nB\r\nC\r\n");
  write(root, "f.txt", "A2\r\nB\r\nC2\r\n"); // edit lines 1 and 3
  e.recordChange("pr1");
  e.revertSelection("pr1", "f.txt", 1, 1); // revert line 1 only
  eq(read(root, "f.txt"), "A\r\nB\r\nC2\r\n", "line1 reverted, CRLF preserved, line3 kept");
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
