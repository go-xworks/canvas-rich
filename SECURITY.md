# Security Policy

> **English** · [简体中文](SECURITY.zh-CN.md)

## Supported Versions

This project is in early, active development. Security fixes target only the latest commit on the `main` branch.

| Version | Security support |
| --- | --- |
| `main` (latest) | ✅ |
| Historical tags / older commits | ❌ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public issues.**

Use GitHub's [Security Advisories](https://github.com/go-xworks/canvas-rich/security/advisories/new) for private reporting, or contact the maintainer [@go-xworks](https://github.com/go-xworks) via GitHub direct message. Please include where possible:

- The affected files / modules and version (commit SHA);
- Reproduction steps and a minimal reproducible example;
- An impact assessment (data leakage / injection / denial of service, etc.) and possible remediation directions.

We will acknowledge receipt as soon as possible and, after assessment, coordinate a fix and disclosure timeline.

## Security Design Notes

canvas-rich is a pure front-end editor engine: it makes no network requests of its own and executes no remote code, but it does process user/external content. The following defenses are built in:

- **URL protocol filtering** (`src/shared/url.ts`): media `src` is allowlisted per scenario; inline link `href` uses a dangerous-protocol denylist (rejecting `javascript:` / `vbscript:` / `data:` / `file:`), shared across import, overlays, export, and cell write-back.
- **iframe sandboxing**: embedded web-page overlays use `sandbox`, with `allow-same-origin` removed.
- **Export escaping**: HTML export escapes text and attributes; style-related mark values (color / font family / font size) are allowlist-filtered to prevent CSS injection.
- **Persistence validation**: localStorage draft / template deserialization validates structure block by block, falling back safely on corrupted data.
- **CSP-friendly**: shell styles are externalized (`src/styles/shell.css`), so hosts can enable a strict CSP that does not rely on `style-src 'unsafe-inline'`.

If you find an issue that bypasses any of the defenses above, please report it through the channels described above.
