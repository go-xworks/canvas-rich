# Changelog

> **English** · [简体中文](CHANGELOG.zh-CN.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Switched to library mode**: refactored from a monolithic Vite application into an
  importable core library (`src/`) plus an example site (`examples/`), aligned with
  ProseMirror / CodeMirror 6 / Lexical. Added the public entry point `src/index.ts` and
  the factory `createEditor(target, options)` (which builds its own DOM shell inside the
  container and keeps all state in a closure to support multiple instances on one page).

  **BREAKING**: the entry point changes from the `index.html` application to the
  `createEditor` factory; there are no longer any global DOM id conventions.
- The HarfBuzz font path is now resolved via the build `BASE_URL`, supporting deployment
  of the site under a sub-path.
- **Build moved to tsdown** (Rolldown): a single `tsdown` command now emits JS + `.d.ts` + CSS.
  A custom tsdown plugin (`build/tailwind-plugin.ts`) compiles Tailwind v4 and **scopes every
  selector under `.canvas-rich`** (via lightningcss), so the library's utility classes no longer
  leak into or collide with the host page's styles. At runtime the editor shell and all body
  portals are wrapped in a layout-neutral `.canvas-rich` element (`display: contents`).

### Added
- Automatic deployment of the example site to GitHub Pages (`.github/workflows/deploy-pages.yml`).
- Publishable library configuration: `exports` / `types` / `style.css`, library build (tsdown, with heavy dependencies externalized) plus `.d.ts` generation.

## [0.1.0] - 2026-06-12

First open-source baseline. A GPU-rendered canvas rich text editor engine.

### Added
- **Rendering**: glyphs packed into multi-page 2048² atlases, batched compositing via WebGL2 / WebGPU; automatic recovery from context loss.
- **Document and typesetting**: 19 block types + 12 inline marks; block-level incremental layout cache + viewport culling; BiDi bidirectional algorithm; HarfBuzz complex text shaping with script font fallback.
- **Views**: web continuous / word A4 pagination; 50–200% zoom; light / dark theme.
- **Editing**: cross-block selection, word-level navigation, double-click to select a word, drag to move text, undo coalescing, IME composition preview.
- **Tools**: find / replace, rich text clipboard, print / export to PDF, auto-save and draft recovery.
- **Touch**: single-finger scrolling with inertia, long-press to select a word, selection handles, pinch zoom, virtual keyboard avoidance.
- **Import and export**: Markdown / HTML / JSON (round-trippable).
- **Architecture**: plugin registry, unified command bus, typed event emitter.
- **Security**: URL protocol filtering, iframe sandboxing, export escaping and style allowlist, CSP-friendly.

[Unreleased]: https://github.com/go-xworks/canvas-rich/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/go-xworks/canvas-rich/releases/tag/v0.1.0
