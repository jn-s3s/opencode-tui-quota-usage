# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-04

### Fixed

- The sidebar header read the plugin name and version from hardcoded constants, so it kept showing `0.1.0` after the package had moved to `0.2.0`. Both values are now read from `package.json` at build time, so the header tracks the released version automatically.

## [0.2.0] - 2026-10-04

### Changed

- Renamed the TUI setup guidance command from `/quota-providers` to `/quota-help`.
- A disabled provider is now hidden from the sidebar instead of appearing as a section marked `Disabled · /quota-<provider>`. One hint row names every provider that is currently off, so a hidden provider can still be turned back on.
- Added a persistent right-aligned `/quota-help for help` footer to the sidebar.
- A successful refresh now carries forward `plan`, `activeUntil` and `accessEndsAt` from the previous snapshot instead of clearing them. Carried-over values keep their original fetch time and render with a `(stale)` suffix once older than 5 minutes, so a subscription boundary whose follow-up lookup keeps failing is no longer shown as current.

## [0.1.0] - 2026-10-04

### Added

- Read-only quota usage sidebar for the OpenCode V2 CLI/TUI, bundled from `src/tui.tsx` into `dist/tui.js` and loaded as a CLI-only plugin through `~/.config/opencode/cli.json`.
- OpenCode Go / Go Plus quota section showing 5h, Weekly and Monthly windows as percent-left meters with a reset countdown, disabled by default until enabled with `/quota-opencode`.
- Codex quota section showing 5h and Weekly windows, read from the Codex CLI `auth.json` and enabled separately with `/quota-codex`.
- Windows Credential Manager storage for the Go API key, with an environment fallback (`OPENCODE_QUOTA_GO_API_KEY`) and an optional org ID (`OPENCODE_QUOTA_GO_ORG_ID`) for best-effort plan and access status.
- TUI commands `/quota-usage` for sidebar visibility, `/quota-providers` for setup guidance and `/quota-opencode-key` for Go credential and org ID management.
- Independently collapsible provider sections, a refresh for enabled providers every 2 minutes, a 30 second countdown clock and warning or critical thresholds at 45% and 10% left.

[Unreleased]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jn-s3s/opencode-tui-quota-usage/releases/tag/v0.1.0
