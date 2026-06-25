# Offshoot

A self-contained, ultra-light version control + review tool for VS Code.
**No Git. No GitHub. No network.** Disk is the source of truth.

Offshoot is a *backward* snapshot tool. When you open a PR it captures a baseline
of whatever you touch; as you edit, it stores only what it takes to walk your
changes back. Commit a PR and the baseline is deleted — disk becomes permanent.
Revert a PR and disk is restored to the baseline.

## Core model

- **Disk = truth.** Your real files are always "the new". Offshoot never freezes
  disk or serves a virtual copy.
- **A PR is a backward snapshot of only what changed.** "The new" is never
  stored — it's whatever is on disk. Only the `old` side of touched files is kept.
- **Commit** deletes a PR's stored baseline (irreversible).
- **Revert** overwrites disk with a PR's reconstructed baseline.
- **Multiple PRs** are independent snapshots, keyed by id. They are never
  reconciled against each other.

## Using it

1. Click the Offshoot icon in the Activity Bar.
2. **Open PR** with a title (and optional notes / custom id).
3. Edit and save files — changes are captured automatically against the baseline.
4. **Review** to paint changes directly in the editor — green for added, blue
   for modified, and removed lines shown inline in red (hover for the full text).
   Click a file (or the "↔ Offshoot diff" lens) to open the native split diff.
5. **Commit** to make it permanent, **Revert** to roll back, or **Commit
   selection** to finalize just the lines you've selected.

## Storage

Everything lives under `.offshoot/` at the workspace root. Each open PR is a
self-contained folder (`meta.json`, `deltas.json`, cached baseline of touched
files). Committing a PR deletes its folder; nothing else persists.

## Guards

Before any disk-writing operation, Offshoot runs a guard. When a situation has
more than one valid fix (overlapping PRs, unsaved buffers, a missing file, a
content mismatch), it surfaces a dialog with real action buttons instead of
silently refusing. Data-losing choices say so in their label and ask to confirm.

## Out of scope (by design)

Merge logic, commit history, branch graphs, stacked/dependent PRs, network, and
Git interop. Offshoot is a tight draft/checkpoint-and-review tool, not a full VCS.
