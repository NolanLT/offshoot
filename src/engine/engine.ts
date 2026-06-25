import * as fs from "node:fs";
import * as path from "node:path";
import { diffLines } from "diff";
import type {
  ChangedFile,
  Deltas,
  DeltaOp,
  PRMeta,
  PRView
} from "../shared/protocol";
import { Storage, type BaselineIndex, type BaselineEntry } from "./storage";
import { computeLineOps, summarizeFile } from "./diff";
import { Errors } from "./errors";

/** Result of reconstructing the pre-PR state: file -> content, or null = the
 *  file did not exist at baseline (revert should delete it). */
export type BaselineMap = Map<string, string | null>;

/**
 * The pure-ish core. Holds disk truth (workspaceRoot) + Storage. VS Code event
 * handlers feed it baseline captures (noteEdit/noteCreate/noteDelete); the
 * command layer calls openPR / recordChange / reconstruct / commit / revert.
 */
export class Engine {
  readonly workspaceRoot: string;
  readonly storage: Storage;

  /**
   * @param workspaceRoot the project root (disk = source of truth lives here)
   * @param storageDir    where Offshoot keeps its PR data. Defaults to
   *   `<workspaceRoot>/.offshoot` (used by tests); the extension passes its
   *   private storage dir so nothing ever lands inside the project.
   */
  constructor(workspaceRoot: string, storageDir?: string) {
    this.workspaceRoot = workspaceRoot;
    this.storage = new Storage(storageDir ?? path.join(workspaceRoot, ".offshoot"));
  }

  // ---------- helpers ----------
  private abs(file: string): string {
    return path.join(this.workspaceRoot, file);
  }
  private diskExists(file: string): boolean {
    return fs.existsSync(this.abs(file));
  }
  private readDisk(file: string): string {
    return fs.readFileSync(this.abs(file), "utf8");
  }

  /** Relative POSIX path used as the storage key for a file. */
  rel(absPath: string): string {
    return path.relative(this.workspaceRoot, absPath).split(path.sep).join("/");
  }

  // ---------- openPR ----------
  openPR(id: string, title: string, notes: string): PRMeta {
    if (this.storage.prExists(id)) throw Errors.idExists(id);
    const meta: PRMeta = {
      id,
      title,
      notes,
      status: "open",
      created: new Date().toISOString()
    };
    this.storage.writeMeta(meta);
    this.storage.writeDeltas(id, { ops: [] });
    this.storage.writeBaselineIndex(id, { files: {} });
    this.storage.writeActive(id);
    return meta;
  }

  // ---------- baseline capture (called from VS Code events) ----------
  /** First edit of an existing file: stash its pre-edit content as baseline.
   *  Accepts bytes so binaries (images) tracked ahead of a delete keep exact
   *  content; binary files are never line-diffed (we don't track pixel changes). */
  noteEdit(prId: string, file: string, priorContent: string | Buffer) {
    const idx = this.storage.readBaselineIndex(prId);
    if (idx.files[file]) return; // already captured
    const buf = Buffer.isBuffer(priorContent)
      ? priorContent
      : Buffer.from(priorContent, "utf8");
    idx.files[file] = { existed: true, deleted: false, binary: isBinaryBuffer(buf) };
    this.storage.writeBaselineFile(prId, file, buf);
    this.storage.writeBaselineIndex(prId, idx);
  }

  /** A file created after openPR: baseline is "did not exist". */
  noteCreate(prId: string, file: string) {
    const idx = this.storage.readBaselineIndex(prId);
    if (idx.files[file]) return;
    idx.files[file] = { existed: false, deleted: false };
    this.storage.writeBaselineIndex(prId, idx);
  }

  /** A file deleted from disk: keep its full old content (bytes, so images work)
   *  for recreation on revert. Pass the file's content captured BEFORE deletion. */
  noteDelete(prId: string, file: string, priorContent: string | Buffer) {
    const buf = Buffer.isBuffer(priorContent)
      ? priorContent
      : Buffer.from(priorContent, "utf8");
    const binary = isBinaryBuffer(buf);
    const idx = this.storage.readBaselineIndex(prId);
    const entry = idx.files[file];
    if (!entry) {
      // never touched before: it existed at baseline, now gone
      idx.files[file] = { existed: true, deleted: true, binary };
      this.storage.writeBaselineFile(prId, file, buf);
    } else {
      entry.deleted = true;
      if (entry.existed && !this.storage.hasBaselineFile(prId, file)) {
        entry.binary = binary;
        this.storage.writeBaselineFile(prId, file, buf);
      }
    }
    this.storage.writeBaselineIndex(prId, idx);
  }

  // ---------- recordChange ----------
  /** Recompute deltas.json from baseline-vs-disk for every touched file, and
   *  prune entries that no longer represent a real change. */
  recordChange(prId: string): void {
    const idx = this.storage.readBaselineIndex(prId);
    const ops: DeltaOp[] = [];
    let changed = false;

    for (const [file, entry] of Object.entries(idx.files)) {
      const exists = this.diskExists(file);

      // created then deleted, or deleted-but-never-existed => no net change
      if (!entry.existed && (entry.deleted || !exists)) {
        delete idx.files[file];
        this.storage.removeBaselineFile(prId, file);
        changed = true;
        continue;
      }

      if (entry.existed && entry.deleted && !exists) {
        // binary deleted files keep their bytes in the baseline, not deltas
        ops.push({
          type: "delFile",
          file,
          old: entry.binary ? "<binary>" : this.storage.readBaselineFile(prId, file)
        });
        continue;
      }

      if (!entry.existed && exists) {
        ops.push({ type: "addFile", file });
        // line-level adds only for text; binaries (e.g. images) are file-level
        if (!isBinaryOnDisk(this.abs(file))) {
          for (const op of computeLineOps(file, "", this.readDisk(file))) ops.push(op);
        }
        continue;
      }

      // binary file still present: we don't track content/pixel changes, only
      // add/delete — so emit nothing (keep the baseline in case it's deleted).
      if (entry.binary) continue;

      // existed, present on disk: real line diff. If it currently matches the
      // baseline we emit no ops, but KEEP the entry + baseline — the file may
      // have been tracked ahead of an edit (MCP flow), or edited back to
      // baseline (it just won't be listed by prView). Pruning here would drop a
      // captured baseline before it's used.
      const baseline = this.storage.hasBaselineFile(prId, file)
        ? this.storage.readBaselineFile(prId, file)
        : "";
      const disk = exists ? this.readDisk(file) : "";
      if (baseline === disk) continue;
      for (const op of computeLineOps(file, baseline, disk)) ops.push(op);
    }

    if (changed) this.storage.writeBaselineIndex(prId, idx);
    this.storage.writeDeltas(prId, { ops });
  }

  // ---------- reconstructBaseline ----------
  reconstructBaseline(prId: string): BaselineMap {
    const idx = this.storage.readBaselineIndex(prId);
    const map: BaselineMap = new Map();
    for (const [file, entry] of Object.entries(idx.files)) {
      if (!entry.existed) {
        map.set(file, null); // delete on revert
      } else {
        map.set(
          file,
          this.storage.hasBaselineFile(prId, file)
            ? this.storage.readBaselineFile(prId, file)
            : ""
        );
      }
    }
    return map;
  }

  /** Baseline ("old") content of a single file for the diff view. */
  baselineContent(prId: string, file: string): string {
    const idx = this.storage.readBaselineIndex(prId);
    const entry = idx.files[file];
    if (!entry || !entry.existed) return "";
    return this.storage.hasBaselineFile(prId, file)
      ? this.storage.readBaselineFile(prId, file)
      : "";
  }

  // ---------- prDiff / view ----------
  prView(prId: string): PRView {
    const meta = this.storage.readMeta(prId);
    const idx = this.storage.readBaselineIndex(prId);
    const changedFiles: ChangedFile[] = [];

    for (const [file, entry] of Object.entries(idx.files)) {
      const exists = this.diskExists(file);
      if (!entry.existed && (entry.deleted || !exists)) continue;

      if (entry.existed && entry.deleted && !exists) {
        if (entry.binary) {
          changedFiles.push({ file, added: 0, removed: 0, kind: "deleted" });
        } else {
          const baseline = this.storage.hasBaselineFile(prId, file)
            ? this.storage.readBaselineFile(prId, file)
            : "";
          changedFiles.push(summarizeFile(file, baseline, "", "deleted"));
        }
        continue;
      }
      if (!entry.existed && exists) {
        if (isBinaryOnDisk(this.abs(file))) {
          changedFiles.push({ file, added: 0, removed: 0, kind: "added" });
        } else {
          changedFiles.push(summarizeFile(file, "", this.readDisk(file), "added"));
        }
        continue;
      }
      if (entry.binary) continue; // present binary: not a tracked change
      const baseline = this.storage.hasBaselineFile(prId, file)
        ? this.storage.readBaselineFile(prId, file)
        : "";
      const disk = exists ? this.readDisk(file) : "";
      if (baseline === disk) continue;
      changedFiles.push(summarizeFile(file, baseline, disk, "modified"));
    }

    changedFiles.sort((a, b) => a.file.localeCompare(b.file));
    return { meta, changedFiles };
  }

  /** Per-line classification for in-editor red/green/blue decorations.
   *  `added`/`modified` are disk line numbers (1-based). `deleted` carries the
   *  old text removed at each disk position so it can be shown inline in red. */
  decorationData(
    prId: string,
    file: string
  ): {
    added: number[];
    modified: number[];
    deleted: Array<{ line: number; texts: string[] }>;
  } {
    const deltas = this.storage.readDeltas(prId);
    const added: number[] = [];
    const modified: number[] = [];
    const delMap = new Map<number, string[]>();
    for (const op of deltas.ops) {
      if (op.file !== file) continue;
      if (op.type === "addLine") added.push(op.line);
      else if (op.type === "editLine") modified.push(op.line);
      else if (op.type === "delLine") {
        const arr = delMap.get(op.line) ?? [];
        arr.push(op.old);
        delMap.set(op.line, arr);
      }
    }
    const deleted = [...delMap.entries()]
      .map(([line, texts]) => ({ line, texts }))
      .sort((a, b) => a.line - b.line);
    return { added, modified, deleted };
  }

  /** Disk-coordinate line ranges that changed, for review markers / lenses. */
  changedLineRanges(prId: string, file: string): Array<[number, number]> {
    const deltas = this.storage.readDeltas(prId);
    const lines = new Set<number>();
    for (const op of deltas.ops) {
      if (op.file !== file) continue;
      if (op.type === "editLine" || op.type === "addLine" || op.type === "delLine") {
        lines.add(op.line);
      }
    }
    return collapseRanges([...lines].sort((a, b) => a - b));
  }

  // ---------- commit ----------
  commit(prId: string): void {
    if (!this.storage.prExists(prId)) throw Errors.prNotFound(prId);
    this.storage.deletePR(prId);
  }

  /** Write one file back to its PR baseline (delete if it was added; restore
   *  raw bytes for binary baselines like images; else restore text). */
  private restoreBaseline(prId: string, file: string, entry: BaselineEntry): void {
    const abs = this.abs(file);
    if (!entry.existed) {
      if (fs.existsSync(abs)) fs.rmSync(abs); // was created in this PR
      this.pruneEmptyDirs(abs); // remove folders that the add introduced
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (entry.binary && this.storage.hasBaselineFile(prId, file)) {
      fs.writeFileSync(abs, this.storage.readBaselineFileBytes(prId, file));
    } else {
      const content = this.storage.hasBaselineFile(prId, file)
        ? this.storage.readBaselineFile(prId, file)
        : "";
      fs.writeFileSync(abs, content);
    }
  }

  /** Remove now-empty parent folders up to (but not including) the workspace
   *  root — so reverting an added folder leaves no empty shell behind. */
  private pruneEmptyDirs(absFile: string): void {
    const root = path.resolve(this.workspaceRoot);
    let dir = path.dirname(path.resolve(absFile));
    while (dir.length > root.length && dir.startsWith(root)) {
      try {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } catch {
        break;
      }
    }
  }

  // ---------- revert ----------
  revert(prId: string): void {
    if (!this.storage.prExists(prId)) throw Errors.prNotFound(prId);
    const idx = this.storage.readBaselineIndex(prId);
    for (const [file, entry] of Object.entries(idx.files)) {
      this.restoreBaseline(prId, file, entry);
    }
    this.storage.deletePR(prId);
  }

  // ---------- revert a single file ----------
  /** Restore just one file to its baseline, then drop it from the PR. */
  revertFile(prId: string, file: string): void {
    const idx = this.storage.readBaselineIndex(prId);
    const entry = idx.files[file];
    if (!entry) return;
    this.restoreBaseline(prId, file, entry);
    delete idx.files[file];
    this.storage.removeBaselineFile(prId, file);
    this.storage.writeBaselineIndex(prId, idx);
    this.recordChange(prId);
  }

  // ---------- edit metadata ----------
  editMeta(prId: string, title: string, notes: string): void {
    const meta = this.storage.readMeta(prId);
    meta.title = title;
    meta.notes = notes;
    this.storage.writeMeta(meta);
  }

  // ---------- re-capture (full or scoped to one file) ----------
  recapture(prId: string, onlyFile?: string): void {
    const idx = this.storage.readBaselineIndex(prId);
    if (onlyFile) {
      if (idx.files[onlyFile]) {
        delete idx.files[onlyFile];
        this.storage.removeBaselineFile(prId, onlyFile);
        this.storage.writeBaselineIndex(prId, idx);
      }
    } else {
      // reset baseline to "now": drop every entry + cached baseline content
      for (const file of Object.keys(idx.files)) {
        this.storage.removeBaselineFile(prId, file);
      }
      this.storage.writeBaselineIndex(prId, { files: {} });
    }
    this.recordChange(prId);
  }

  // ---------- snippet / partial commit ----------
  /**
   * Finalize the changed lines of `file` that fall within disk line range
   * [selStart, selEnd] (1-based, inclusive). The new baseline adopts disk for
   * the committed regions; everything else stays an open change. Throws #13 if
   * the selection contains no diff.
   */
  commitSelection(prId: string, file: string, selStart: number, selEnd: number): void {
    const idx = this.storage.readBaselineIndex(prId);
    const entry = idx.files[file];
    if (!entry) throw Errors.noDiffInSelection();

    const baseline = this.baselineContent(prId, file);
    const disk = this.diskExists(file) ? this.readDisk(file) : "";

    const { newBaseline, committedAny } = snippetBaseline(
      baseline,
      disk,
      selStart,
      selEnd
    );
    if (!committedAny) throw Errors.noDiffInSelection();

    // Re-anchor only this file: write the new baseline (existed files only).
    if (entry.existed && !entry.deleted) {
      this.storage.writeBaselineFile(prId, file, newBaseline);
    } else if (!entry.existed) {
      // a newly-added file: committing part of it just shrinks what's tracked.
      // Treat the committed lines as permanent by promoting baseline to include
      // them — but an added file's baseline is "nonexistent", so committing the
      // whole selection effectively keeps disk; nothing to store. Recompute.
    }
    // recordChange prunes the file if nothing remains (skips re-anchor when no
    // remaining changes, per Section 9).
    this.recordChange(prId);
  }

  // ---------- listing for sidebar ----------
  listPRs(): PRMeta[] {
    const metas: PRMeta[] = [];
    for (const id of this.storage.listPrIds()) {
      try {
        metas.push(this.storage.readMeta(id));
      } catch {
        // unreadable meta: surfaced via Error #8 when interacted with; skip here
      }
    }
    metas.sort((a, b) => b.created.localeCompare(a.created)); // newest first
    return metas;
  }

  /** All other open PRs that also touch any file in `files` (Error #12 scan). */
  overlappingPRs(prId: string, files: string[]): string[] {
    const set = new Set(files);
    const out: string[] = [];
    for (const id of this.storage.listPrIds()) {
      if (id === prId) continue;
      let idx: BaselineIndex;
      try {
        idx = this.storage.readBaselineIndex(id);
      } catch {
        continue;
      }
      if (Object.keys(idx.files).some((f) => set.has(f))) out.push(id);
    }
    return out.sort();
  }

  touchedFiles(prId: string): string[] {
    return Object.keys(this.storage.readBaselineIndex(prId).files);
  }
}

// ---------- module helpers ----------

/** Heuristic: a NUL byte in the first 8 KB means treat it as binary. */
function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Binary check straight from disk; treats unreadable paths (e.g. a directory)
 *  as binary so they're never line-diffed. */
function isBinaryOnDisk(absPath: string): boolean {
  try {
    return isBinaryBuffer(fs.readFileSync(absPath));
  } catch {
    return true;
  }
}

function collapseRanges(sorted: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Build a new baseline where regions overlapping [selStart, selEnd] (disk
 * coords, 1-based inclusive) are finalized to disk. Returns committedAny=false
 * if the selection covers no changed region.
 */
function snippetBaseline(
  baseline: string,
  disk: string,
  selStart: number,
  selEnd: number
): { newBaseline: string; committedAny: boolean } {
  const parts = diffLines(baseline, disk);
  const out: string[] = [];
  let diskLine = 1;
  let committedAny = false;
  const overlaps = (a: number, b: number) => a <= selEnd && b >= selStart;

  for (const part of parts) {
    const lines = splitLines(part.value);
    const count = lines.length;

    if (!part.added && !part.removed) {
      out.push(...lines);
      diskLine += count;
    } else if (part.removed) {
      // deletion sits at the current disk position (zero width on disk)
      if (overlaps(diskLine, diskLine)) {
        committedAny = true; // finalize: baseline drops these lines
      } else {
        out.push(...lines); // keep as an open change
      }
    } else {
      // added on disk: occupies disk lines [diskLine, diskLine+count-1]
      if (overlaps(diskLine, diskLine + count - 1)) {
        committedAny = true;
        out.push(...lines); // finalize: baseline adopts disk lines
      }
      // else: keep change -> baseline omits them
      diskLine += count;
    }
  }

  const trailing = disk.endsWith("\n") ? "\n" : "";
  return { newBaseline: out.length ? out.join("\n") + trailing : "", committedAny };
}
