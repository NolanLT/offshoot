import * as fs from "node:fs";
import * as path from "node:path";
import type { Deltas, PRMeta } from "../shared/protocol";

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
  private baselineFilePath(id: string, file: string) {
    return path.join(this.baselineDir(id), file);
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
  readMeta(id: string): PRMeta {
    const raw = fs.readFileSync(this.metaPath(id), "utf8");
    return JSON.parse(raw) as PRMeta;
  }
  writeMeta(meta: PRMeta) {
    fs.mkdirSync(this.prDir(meta.id), { recursive: true });
    fs.writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
  }

  // ---- deltas ----
  readDeltas(id: string): Deltas {
    const p = this.deltasPath(id);
    if (!fs.existsSync(p)) return { ops: [] };
    return JSON.parse(fs.readFileSync(p, "utf8")) as Deltas;
  }
  writeDeltas(id: string, deltas: Deltas) {
    fs.mkdirSync(this.prDir(id), { recursive: true });
    fs.writeFileSync(this.deltasPath(id), JSON.stringify(deltas, null, 2));
  }

  // ---- baseline index ----
  readBaselineIndex(id: string): BaselineIndex {
    const p = this.baselineIndexPath(id);
    if (!fs.existsSync(p)) return { files: {} };
    return JSON.parse(fs.readFileSync(p, "utf8")) as BaselineIndex;
  }
  writeBaselineIndex(id: string, idx: BaselineIndex) {
    fs.mkdirSync(this.prDir(id), { recursive: true });
    fs.writeFileSync(this.baselineIndexPath(id), JSON.stringify(idx, null, 2));
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
    fs.writeFileSync(p, content);
  }
  removeBaselineFile(id: string, file: string) {
    const p = this.baselineFilePath(id, file);
    if (fs.existsSync(p)) fs.rmSync(p);
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
    fs.writeFileSync(this.activePath(), JSON.stringify({ id }, null, 2));
  }

  // ---- destroy a PR ----
  deletePR(id: string) {
    const dir = this.prDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (this.readActive() === id) this.writeActive(null);
  }
}
