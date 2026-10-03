# Security policy

Thanks for helping keep this project safe. The plugin can read and store OpenCode Go / Go Plus API keys and reuses the Codex CLI sign-in, so treat any credential exposure seriously.

## Reporting a vulnerability

Do not open a public issue for a suspected security problem. Report it privately through the security advisory form:

https://github.com/jn-s3s/opencode-tui-quota-usage/security/advisories/new

If that form is unavailable, email the maintainer listed in `package.json`. The maintainer reviews the report and works with you on a fix and a disclosure timeline before any public advisory is published.

## What to include

- The affected version and where the problem lives, for example a credential path or an endpoint call.
- Steps to reproduce, without pasting a real API key, token or `auth.json` contents.
- A proof of concept that stays within accounts you control.

## Scope

This policy covers the plugin code in this repository. It does not cover the third-party usage endpoints the plugin reads, whose availability and response shape can change.

## Disclosure

Reports are handled privately. Please hold public details until a fix ships, so users are not exposed while the issue is still open.
