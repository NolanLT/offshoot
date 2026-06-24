import { diffLines } from "diff";
import type { ChangedFile, DeltaOp } from "../shared/protocol";

/**
 * Compute backward delta ops for ONE file: how to walk disk back to baseline.
 * `old` content is always the baseline side. New is never stored.
 *
 * Edits are paired (a removed group immediately followed by an added group) into
 * `editLine` ops where they line up; leftovers fall back to del/add.
 */
export function computeLineOps(
  file: string,
  baseline: string,
  disk: string
): DeltaOp[] {
  const ops: DeltaOp[] = [];
  const parts = diffLines(baseline, disk);

  let baseLine = 1; // 1-based line in baseline
  let diskLine = 1; // 1-based line in disk

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lines = splitLines(part.value);
    const count = part.count ?? lines.length;

    if (!part.added && !part.removed) {
      baseLine += count;
      diskLine += count;
      continue;
    }

    if (part.removed) {
      // Look ahead: a following "added" group means these are edits.
      const next = parts[i + 1];
      if (next && next.added) {
        const addLines = splitLines(next.value);
        const pairCount = Math.min(lines.length, addLines.length);
        // paired edits: disk line was edited; old = baseline line
        for (let k = 0; k < pairCount; k++) {
          ops.push({ type: "editLine", file, line: diskLine + k, old: lines[k] });
        }
        // leftover removed (baseline had more) => deleted on disk
        for (let k = pairCount; k < lines.length; k++) {
          ops.push({ type: "delLine", file, line: diskLine + pairCount, old: lines[k] });
        }
        // leftover added (disk has more) => added on disk
        for (let k = pairCount; k < addLines.length; k++) {
          ops.push({ type: "addLine", file, line: diskLine + k });
        }
        baseLine += lines.length;
        diskLine += addLines.length;
        i++; // consume the added part too
        continue;
      }
      // pure deletion on disk: re-insert old at this disk position
      for (const l of lines) {
        ops.push({ type: "delLine", file, line: diskLine, old: l });
      }
      baseLine += count;
      continue;
    }

    if (part.added) {
      // pure addition on disk: remove these lines to go back
      for (let k = 0; k < lines.length; k++) {
        ops.push({ type: "addLine", file, line: diskLine + k });
      }
      diskLine += count;
      continue;
    }
  }

  return ops;
}

/** Line/char counts + kind for the sidebar summary. */
export function summarizeFile(
  file: string,
  baseline: string,
  disk: string,
  kind: ChangedFile["kind"]
): ChangedFile {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(baseline, disk)) {
    const c = part.count ?? splitLines(part.value).length;
    if (part.added) added += c;
    else if (part.removed) removed += c;
  }
  return { file, added, removed, kind };
}

function splitLines(value: string): string[] {
  // Drop the trailing empty element produced by a final newline so counts match
  // `part.count` from the diff library.
  const lines = value.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
