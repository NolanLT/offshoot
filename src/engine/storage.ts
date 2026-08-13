import * as fs from "node:fs";
import * as path from "node:path";
import type { Deltas, LogEntry, PRMeta } from "../shared/protocol";
import { Errors } from "./errors";

/** Write via a temp file + rename so a crash mid-write can never leave a
 *  half-written meta.json / baseline.json behind (rename is atomic on both
 *  NTFS and POSIX). Falls back to a direct write if rename isn't possible. */
function writeAtomic(p: string, data: string | Buffer): void {
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    fs.writeFileSync(p, data);
  }
}

// Per-file baseline bookkeeping. `existed` = the file was present on disk when
// it was first touched in this PR (false => it was created during the PR, so
// reverting deletes it). `deleted` = the file has since been removed from disk
// (its full old content is kept so revert can recreate it).
export interface BaselineEntry {
  existed: boolean;
  deleted: boolean;
  /** baseline content is raw bytes (e.g. a deleted image), not text. */
  binary?: boolean;
}

export interface BaselineIndex {
  files: Record<string, BaselineEntry>;
}

/**
 * Owns all reads/writes under `.offshoot/`. Knows nothing about VS Code.
 * Baseline content of each touched file is cached under the PR's `baseline/`
 * dir; this is the source of truth for the "old" side. deltas.json is derived
 * from baseline-vs-disk and serves the sidebar's change summary.
 */
export class Storage {
  readonly root: string; // the Offshoot data dir (kept OUTSIDE the project)
  constructor(root: string) {
    this.root = root;
  }

  // ---- paths ----
  private prsDir() {
    return path.join(this.root, "prs");
  }
  prDir(id: string) {
    return path.join(this.prsDir(), id);
  }
  private metaPath(id: string) {
    return path.join(this.prDir(id), "meta.json");
  }
  private deltasPath(id: string) {
    return path.join(this.prDir(id), "deltas.json");
  }
  private baselineDir(id: string) {
    return path.join(this.prDir(id), "baseline");
  }
  private baselineIndexPath(id: string) {
    return path.join(this.prDir(id), "baseline.json");
  }
  /** Baseline cache path for `file`. Defense in depth: even though callers
   *  normalize, a `..` segment here would write outside the storage dir. */
  private baselineFilePath(id: string, file: string) {
    const dir = this.baselineDir(id);
    const p = path.resolve(dir, file);
    const root = path.resolve(dir);
    if (p !== root && !p.startsWith(root + path.sep)) {
      throw Errors.pathOutsideWorkspace(file);
    }
    return p;
  }
  private activePath() {
    return path.join(this.root, "active.json");
  }

  // ---- pr existence / listing ----
  prExists(id: string): boolean {
    return fs.existsSync(this.prDir(id));
  }

  listPrIds(): string[] {
    const dir = this.prsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  // ---- meta ----
  hasMeta(id: string): boolean {
    return fs.existsSync(this.metaPath(id));
  }
  /** @throws Error #8 if meta.json is missing or not parseable — the dialog
   *  offers Reveal folder / Discard, which is the only way out of a corrupt PR. */
  readMeta(id: string): PRMeta {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), "utf8")) as PRMeta;
    } catch {
      throw Errors.metaUnreadable(id);
    }
  }
  writeMeta(meta: PRMeta) {
    fs.mkdirSync(this.prDir(meta.id), { recursive: true });
    writeAtomic(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
  }

  // ---- deltas ----
  /** @throws Error #9 if deltas.json exists but is corrupt. A missing file is
   *  normal (no changes recorded yet) and returns empty. */
  readDeltas(id: string): Deltas {
    const p = this.deltasPath(id);
    if (!fs.existsSync(p)) return { ops: [] };
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Deltas;
    } catch {
      throw Errors.deltasUnreadable(id);
    }
  }
  writeDeltas(id: string, deltas: Deltas) {
    fs.mkdirSync(this.prDir(id), { recursive: true });
    writeAtomic(this.deltasPath(id), JSON.stringify(deltas, null, 2));
  }

  // ---- baseline index ----
  /** @throws Error #9 if baseline.json is corrupt. This one matters most: it is
   *  the record of what the PR touched, so failing loudly beats silently
   *  reporting "no changes" for a PR that has them. */
  readBaselineIndex(id: string): BaselineIndex {
    const p = this.baselineIndexPath(id);
    if (!fs.existsSync(p)) return { files: {} };
    try {
      const idx = JSON.parse(fs.readFileSync(p, "utf8")) as BaselineIndex;
      if (!idx || typeof idx !== "object" || typeof idx.files !== "object") {
        throw new Error("shape");
      }
      return idx;
    } catch {
      throw Errors.deltasUnreadable(id, "baseline.json");
    }
  }
  writeBaselineIndex(id: string, idx: BaselineIndex) {
    fs.mkdirSync(this.prDir(id), { recursive: true });
    writeAtomic(this.baselineIndexPath(id), JSON.stringify(idx, null, 2));
  }

  // ---- baseline content ----
  hasBaselineFile(id: string, file: string): boolean {
    return fs.existsSync(this.baselineFilePath(id, file));
  }
  readBaselineFile(id: string, file: string): string {
    return fs.readFileSync(this.baselineFilePath(id, file), "utf8");
  }
  /** Raw bytes — for binary baselines (e.g. a deleted image). */
  readBaselineFileBytes(id: string, file: string): Buffer {
    return fs.readFileSync(this.baselineFilePath(id, file));
  }
  writeBaselineFile(id: string, file: string, content: string | Buffer) {
    const p = this.baselineFilePath(id, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeAtomic(p, content);
  }
  removeBaselineFile(id: string, file: string) {
    const p = this.baselineFilePath(id, file);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // ---- history log (closed PRs) ----
  private logPath() {
    return path.join(this.root, "log.json");
  }
  readLog(): LogEntry[] {
    const p = this.logPath();
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as LogEntry[];
    } catch {
      return [];
    }
  }
  writeLog(entries: LogEntry[]) {
    fs.mkdirSync(this.root, { recursive: true });
    writeAtomic(this.logPath(), JSON.stringify(entries, null, 2));
  }

  // ---- active pointer ----
  readActive(): string | null {
    const p = this.activePath();
    if (!fs.existsSync(p)) return null;
    try {
      return (JSON.parse(fs.readFileSync(p, "utf8")) as { id: string | null }).id;
    } catch {
      return null;
    }
  }
  writeActive(id: string | null) {
    fs.mkdirSync(this.root, { recursive: true });
    writeAtomic(this.activePath(), JSON.stringify({ id }, null, 2));
  }

  // ---- destroy a PR ----
  deletePR(id: string) {
    const dir = this.prDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (this.readActive() === id) this.writeActive(null);
  }
}
