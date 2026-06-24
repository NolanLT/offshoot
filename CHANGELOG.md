# Changelog

All notable changes to Offshoot are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial implementation.
  - Backward-snapshot engine: `openPR`, baseline capture on edit/create/delete,
    `recordChange`, `reconstructBaseline`, `commit`, `revert`, re-capture, and
    partial/snippet commits.
  - Guard & resolution layer with the full Error #1–#13 list, each surfacing
    genuine action buttons plus Cancel.
  - React 19 + Vite sidebar (Webview View): open/select PRs, changed-file list,
    Review / Commit selection / Commit / Revert.
  - Yellow change markers in Review mode and native red/green split diff via a
    `offshoot-baseline:` content provider, triggered from the sidebar or a
    CodeLens on each changed region.

## [0.0.1]

- Project scaffolding.
