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
   If you start editing with no PR open, Offshoot offers to open one and remembers
   the original content, so the change that prompted the offer is captured by the
   PR you open (not lost).
4. **Review** to paint changes directly in the editor — green for added and blue
   for modified lines. Removed lines aren't painted in the editor (the text is
   gone from disk); clicking a changed file opens the custom diff panel to the
   right, with grouped red/green hunks and per-hunk Commit/Revert actions.
5. **Commit** to make it permanent, **Revert** to roll back, or **Commit
   selected** to finalize just the lines you've selected. You can also revert a
   single file from the changes list, and edit a PR's title/notes (✎).
6. While a PR is active, jump between changed regions in the current file with
   **Alt+PageDown** / **Alt+PageUp** (Offshoot: Go to Next/Previous Change).

Offshoot never tracks `.offshoot/`, `.git/`, or `node_modules/`. Add a
`.offshootignore` file at the workspace root (one glob per line) to exclude more.

## Storage

Offshoot stores PR data outside the project, under `~/.offshoot/<workspace-hash>`.
This deterministic location is computed from your workspace path, so the
extension and the standalone MCP server both operate on the same PR data.
Each open PR is still a self-contained folder (`meta.json`, `deltas.json`, cached
baseline of touched files); committing a PR deletes its folder and leaves no
extra state behind.

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
| 12 | Committing a PR that overlaps other open PR(s) on the same file | Commit this PR only · one Commit button per overlapping PR · Commit all overlapping · Cancel |
| 13 | No diff in the selected region | Choose another selection · Cancel |
| 14 | A PR title is required (tried to open a PR with no title) | Type a title in the box → Enter to open · Esc to cancel |
| 15 | Reverting a PR that overlaps other open PR(s) on the same file | Revert this PR anyway (overwrites to baseline) · Commit an overlapping PR first · Commit all overlapping first · Cancel |

Every error offers at least one real action plus Cancel; choosing a fix re-runs
the guard before touching disk, so a fix can’t create a new inconsistency.

## AI control (MCP)

Offshoot ships a Model Context Protocol server so an AI agent (e.g. Claude Code)
can drive PRs — open, inspect, commit, and revert — on the same data the VS Code
sidebar shows. The engine is editor-independent, and both the extension and the
MCP server compute the same out-of-project storage location for a workspace, so
they stay in sync (the sidebar watches that folder and refreshes live).

Register it (defaults to the current working directory as the workspace, so it
follows whatever project the session is in):

```bash
# portable — runs straight from GitHub, no local path:
claude mcp add offshoot --scope user -- npx -y github:NolanLT/offshoot
# pin a release:        npx -y github:NolanLT/offshoot#v0.1.1
# or run a local build: node "<path-to-offshoot>/dist/mcp/server.cjs"
# pin a workspace:      node "<path-to-offshoot>/dist/mcp/server.cjs" --workspace "C:/path/to/project"
# or set the workspace via env: OFFSHOOT_WORKSPACE="C:/path/to/project"
```

Tools: `offshoot_list_prs`, `offshoot_open_pr`, `offshoot_track_files`,
`offshoot_changed_files`, `offshoot_pr_diff`, `offshoot_commit`,
`offshoot_revert`, `offshoot_revert_file`, `offshoot_recapture`.

**Headless capture:** because baselines are captured from pre-edit content, an AI
editing files on its own should call `offshoot_track_files` for the files it's
about to change *before* editing them; Offshoot then diffs the post-edit disk
against that baseline. (When you edit in the VS Code editor, the extension
captures baselines automatically — no tracking step needed.)

## Files & images

Adding a file of any type during a PR is undone on revert; deleting a file —
text or binary (e.g. an image) — restores it byte-for-byte, because Offshoot
saves its bytes just before deletion. Binary *content* changes (editing an
image's pixels) are not tracked — only add and delete. **Folders work too:**
deleting a folder restores its whole tree on revert, and reverting an added
folder removes it. Deletions are captured when performed through VS Code.

## Out of scope (by design)

Merge logic, commit history, branch graphs, stacked/dependent PRs, network, and
Git interop. Offshoot is a tight draft/checkpoint-and-review tool, not a full VCS.
