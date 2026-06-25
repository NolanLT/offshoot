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
   selected** to finalize just the lines you've selected. You can also revert a
   single file from the changes list, and edit a PR's title/notes (✎).
6. While a PR is active, jump between changed regions in the current file with
   **Alt+PageDown** / **Alt+PageUp** (Offshoot: Go to Next/Previous Change).

Offshoot never tracks `.offshoot/`, `.git/`, or `node_modules/`. Add a
`.offshootignore` file at the workspace root (one glob per line) to exclude more.

## Storage

Everything lives under `.offshoot/` at the workspace root. Each open PR is a
self-contained folder (`meta.json`, `deltas.json`, cached baseline of touched
files). Committing a PR deletes its folder; nothing else persists.

## Guards

Before any disk-writing operation, Offshoot runs a guard. When a situation has
more than one valid fix (overlapping PRs, unsaved buffers, a missing file, a
content mismatch), it surfaces a dialog with real action buttons instead of
silently refusing. Data-losing choices say so in their label and ask to confirm.

## Error reference

When a guard stops an operation, Offshoot shows a modal titled
**“Offshoot (Error #N): …”** with buttons for every genuine fix plus Cancel.
Buttons that lose data say so and ask to confirm. Use this table to debug:

| #  | Meaning | Choices offered |
|----|---------|-----------------|
| 1  | Miscellaneous / unspecified failure | Retry · Cancel |
| 2  | PR not found (bad id) | Refresh PR list · Cancel |
| 3  | Line out of range — stored deltas no longer line up | Re-capture (loses record) · Discard PR · Reveal folder · Cancel |
| 4  | Content mismatch — a line changed outside this PR | Keep disk · Force baseline · Re-capture · Cancel |
| 5  | PR id already exists | Open existing PR · Use a different id · Cancel |
| 6  | No active PR | Open a new PR · Select an existing PR · Cancel |
| 7  | PR folder missing / closed | Remove from list · Cancel |
| 8  | `meta.json` unreadable | Reveal folder · Discard PR · Cancel |
| 9  | `deltas.json` unreadable | Re-capture (loses record) · Discard PR · Reveal folder · Cancel |
| 10 | Unsaved changes in affected files | Save & continue · Discard & continue · Cancel |
| 11 | File no longer exists | Skip this file · Recreate from baseline · Cancel |
| 12 | Overlap with other open PR(s) on the same file | one Commit button per overlapping PR · Commit all overlapping · Cancel |
| 13 | No diff in the selected region | Choose another selection · Cancel |
| 14 | A PR title is required (tried to open a PR with no title) | Type a title in the box → Enter to open · Esc to cancel |

Every error offers at least one real action plus Cancel; choosing a fix re-runs
the guard before touching disk, so a fix can’t create a new inconsistency.

## Out of scope (by design)

Merge logic, commit history, branch graphs, stacked/dependent PRs, network, and
Git interop. Offshoot is a tight draft/checkpoint-and-review tool, not a full VCS.
