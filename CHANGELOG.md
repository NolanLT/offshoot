# Changelog

All notable changes to Offshoot are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1]

### Fixed

- **Line-ending (CRLF/LF) differences are no longer counted as changes.** A
  baseline and disk content that differed only in line endings made every line
  look changed (e.g. editing one line of a two-line file reported +2/−2). All
  diffing now normalizes EOL like Git does, so counts, in-editor decorations,
  the split diff, and change detection are correct; an EOL-only difference shows
  as no change.

### Changed

- Normalized the commit/revert edge cases: `commitSelection` and
  `revertSelection` now both refuse binary files and preserve the file's own EOL
  on output; the baseline served to the split diff matches the disk's EOL.

## [0.3.0]

### Added

- **Revert Selected** — like Commit Selected, but reverts only the selected lines
  back to baseline (sidebar button, editor context menu, `Offshoot: Revert
  Selection` command), leaving the rest of the PR's changes intact.

### Changed

- The Changes list is now a **collapsible folder tree** — files are grouped under
  their directories. Replaced the A/D/M letter tags with a **kind-colored
  background** (green added / red deleted / yellow modified) that begins at the
  text (indentation is no longer tinted) and stops before the +/− counts. Files
  show their basename, left-to-right.
- **Folder-level actions read as one row:** a folder whose files are all added or
  all deleted shows as a single colored, collapsed folder entry you can expand;
  mixed folders stay open and neutral. (A file touched directly and via a folder
  op is still a single entry — no duplication.)
- Selection buttons reordered: Revert Selected (red) on the left, Commit Selected
  (blue) on the right.

## [0.2.1]

### Added

- **Folder add/delete tracking.** Deleting a folder now captures every file
  inside it (recursively) before removal, so revert restores the whole tree;
  adding a folder tracks its files, and revert removes them and prunes the
  now-empty folders. Folder events report only the folder path, so Offshoot
  expands them to their contained files.

### Fixed

- Deleting a folder no longer creates a bogus entry for the folder path (which
  could recreate an empty file on revert). Directory paths are never line-diffed.

## [0.2.0]

### Added

- **Track add/delete of any file, including images and other binaries.** A new
  image added during a PR is removed on revert; a deleted file (text or binary)
  is restored byte-for-byte. Offshoot captures a file's exact bytes just before
  deletion (`onWillDeleteFiles`) and stores binary baselines as raw bytes.
  Binary file *content* changes (pixels) are intentionally not tracked — only
  add and delete.

### Notes

- Deletions are captured when performed through VS Code (Explorer/editor). A file
  deleted entirely outside VS Code can't be restored (its bytes are already gone).

## [0.1.1]

### Added

- **Portable MCP server.** A `bin` entry + `prepare` build let the MCP server
  run straight from GitHub with no local path:
  `claude mcp add offshoot --scope user -- npx -y github:NolanLT/offshoot`
  (pin a release with `#v0.1.1`). The bundled `dist/mcp/server.cjs` is
  self-contained.
- Status bar now also shows total additions ($(add)) and total removals
  ($(remove)) across all open PRs, alongside the PR count.

### Changed

- Status bar uses the built-in `$(repo-forked)` codicon instead of a custom
  glyph — VS Code's status bar only renders codicons, not contributed icon
  fonts. Removed the unused icon-font build (font, script, and dev deps); the
  activity-bar icon still uses the Offshoot SVG.

## [0.1.0]

### Added

- **AI control via an MCP server** (`dist/mcp/server.cjs`). Exposes tools to
  list/open/inspect/commit/revert PRs over MCP, reusing the editor-independent
  engine. Register with `claude mcp add offshoot -- node <…>/dist/mcp/server.cjs`.
  Tools: `offshoot_list_prs`, `offshoot_open_pr`, `offshoot_track_files`,
  `offshoot_changed_files`, `offshoot_pr_diff`, `offshoot_commit`,
  `offshoot_revert`, `offshoot_revert_file`, `offshoot_recapture`.
- A status-bar item showing the Offshoot fork glyph + open-PR count (replaces the
  unreliable activity-bar badge); click to open the view. Glyph ships as a
  contributed icon font (`npm run font`).

### Changed

- **Storage location is now deterministic and shared.** PR data lives at
  `~/.offshoot/<workspace-hash>` (outside any project, isolated per workspace),
  which both the extension and the MCP server compute identically so they
  operate on the same PRs. The sidebar watches it and refreshes when the MCP
  changes things.

### Fixed

- `recordChange` no longer prunes a tracked file's baseline when it momentarily
  matches disk, so baselines captured ahead of an edit (the MCP flow) survive.

## [0.0.5]

### Changed

- **PR data now lives outside the project.** Offshoot stores its baselines in
  VS Code's per-workspace extension storage instead of a `.offshoot/` folder at
  the project root, so nothing is ever committed or deployed with your code and
  no third-party project needs any ignore rules. (You can delete any leftover
  `.offshoot/` folders from earlier versions.)

### Added

- Error #14: opening a PR with no title now prompts for one in an input box
  (Enter to open, Esc to cancel) instead of silently doing nothing.

### Fixed

- The activity-bar badge now clears after committing/reverting the last open PR
  without needing a window reload — the provider keeps a single live-view
  reference, registers its poster once, and re-asserts the cleared badge across
  ticks to work around a VS Code repaint quirk.

## [0.0.4]

### Fixed

- Reverting a PR's last remaining change via the per-file revert now closes the
  now-empty PR, so it no longer lingers in the list or keeps the icon badge.

### Changed

- Moved the PR rename (✎) button onto each open-PR row (hover-revealed, left of
  the change count) instead of the action panel, so it no longer overflows.
- PR titles and changed-file names now truncate with an ellipsis to the sidebar
  width (no horizontal scrollbar); the full title/path shows on hover.
- The per-file Revert button now sits before the +added/−removed counts.
- Notifications and dialogs now show the PR number (e.g. “PR 1”) instead of
  “#pr1”, and the review notification reflects the in-editor highlighting
  (green added / blue modified / red removed) rather than the old “yellow”
  wording.

## [0.0.3]

### Added

- **Confirmation dialogs** before Commit and Revert, each showing a summary
  (file count, +added/−removed) and warning that the action can't be undone.
- **Activity-bar badge** showing the number of open PRs.
- **Default-ignore** of `.offshoot/`, `.git/`, and `node_modules/`, plus an
  optional `.offshootignore` file (one simple glob per line) so noise is never
  tracked.
- **Revert a single file** to its baseline from the changes list, leaving the
  rest of the PR open.
- **Edit a PR's title and notes** after it's been opened.
- **Per-PR change count** shown on the right of each row in the open-PR list.
- **Go to Next/Previous Change** commands (`Alt+PageDown` / `Alt+PageUp` while a
  PR is active) to jump between changed regions in the current file.

### Changed

- Inline removed-text decoration no longer uses strikethrough; its hover shows
  the full removed block numbered like editor lines, plus a link to the diff.

### Documentation

- Added the full Error #1–#13 reference table to the README.

## [0.0.2]

### Added

- **In-editor review decorations.** While reviewing, changes are painted
  directly in the working editor: green for added lines, blue for modified, and
  for deletions the removed text is shown inline in red (italic, struck-through)
  since it is no longer on disk. Hovering a deletion reveals the full removed
  block and a link to the split diff.
- **Search box** for filtering open PRs by id or title.
- **Collapsible sections** with a rotating chevron — the open-PR list and the
  selected PR's changes both collapse, and the state persists across reloads.

### Changed

- Theme-reactive UI: all colors now come from VS Code theme variables, so the
  sidebar follows the active light/dark/high-contrast theme automatically.
- Sidebar restyle: card boxes replaced with separator lines; stroke-style
  buttons (green = add/commit, blue = commit-selected, red = revert, yellow =
  review toggle) that tint on hover and darken on press.
- The split diff opens as a reused preview tab in the active editor group.
- Review now opens the changed files so the markers are immediately visible.
- All feedback (successes and errors) goes through native VS Code notifications.
- PR ids display as bare numbers; refined wording and the activity-bar icon now
  fills its space.

## [0.0.1]

### Added

- Initial release.
  - Backward-snapshot engine: `openPR`, baseline capture on edit/create/delete,
    `recordChange`, `reconstructBaseline`, `commit`, `revert`, re-capture, and
    partial/snippet commits.
  - Guard & resolution layer with the full Error #1–#13 list, each surfacing
    genuine action buttons plus Cancel.
  - React 19 + Vite sidebar (Webview View): open/select PRs, changed-file list,
    Review / Commit selection / Commit / Revert.
  - Native red/green split diff via a `offshoot-baseline:` content provider, plus
    a CodeLens on each changed region.
