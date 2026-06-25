# Changelog

All notable changes to Offshoot are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
