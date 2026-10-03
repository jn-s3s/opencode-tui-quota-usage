# Contributing

Thanks for helping improve `opencode-tui-quota-usage`. This is a read-only OpenCode V2 CLI/TUI plugin, so keep changes small, focused and reversible.

## Requirements

- Node.js 26.4.0 or newer, the version `package.json` requires through `engines`.
- npm, so installs follow the committed `package-lock.json`.
- An OpenCode V2 CLI with TUI plugin support to exercise the sidebar by hand.

## Setup

```bash
npm ci
npm run build
```

`npm run build` bundles `src/tui.tsx` into `dist/tui.js`, the file the package exports. Rebuild after source changes.

## Quality checks

Run the same checks CI runs before opening a pull request:

```bash
npm run check
npm run build
npm pack --dry-run
```

`npm run check` chains the linter (`oxlint`), `tsc --noEmit`, `prettier --check` and the Vitest suite. To run one step, or to fix formatting:

```bash
npm run lint          # oxlint
npm run typecheck     # tsc --noEmit
npm test              # vitest run tests
npm run format        # rewrite files with Prettier
```

## Tests

Tests live under `tests/` and use synthetic JSON, fake fetches and stubbed TUI behavior, so they need no live credentials or network access. Never add a real API key, token or `auth.json` contents to a test.

## Pull requests

- Work from the branch template in `.github/pull_request_template.md` and tick each checklist item.
- Update `README.md` and code comments whenever behavior changes.
- Link the issues a pull request resolves so reviewers keep the context.
