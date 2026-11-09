# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-09

### Added

- Antigravity quota section showing Gemini, Claude/GPT, and Argon usage windows as percent-left meters with reset countdowns, disabled by default until enabled with `/quota-antigravity`.
- Token discovery and automatic account switching for Antigravity, resolving active accounts from `opencode-antigravity-auth` configuration or falling back to the Antigravity CLI keyring session and token cache.
- Event-driven account synchronization with OpenCode `/connect` Google credentials on `credential.switched` and `credential.updated`.
- Per-account rate limit backoff and cooldown tracking for Antigravity requests returning HTTP 429.
- Command palette action "Toggle Antigravity section" to collapse or expand the Antigravity display.
- Custom OAuth client overrides via `OPENCODE_ANTIGRAVITY_CLIENT_ID` and `OPENCODE_ANTIGRAVITY_CLIENT_SECRET`.

### Changed

- The sidebar no longer renders a list of other disabled providers when at least one provider is active. If all providers are off, the sidebar displays a single "No providers enabled" message to prevent text overflow on narrow terminals.
- Switching accounts now clears cached Antigravity usage state immediately and deduplicates credential updates during polling.

### Security

- Updated `@opencode/plugin` to 2.2.5, `@opentui/core` and `@opentui/solid` to 0.8.2, `solid-js` to 1.9.18, and updated transitive dependencies to resolve security advisories.

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

[Unreleased]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jn-s3s/opencode-tui-quota-usage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jn-s3s/opencode-tui-quota-usage/releases/tag/v0.1.0
