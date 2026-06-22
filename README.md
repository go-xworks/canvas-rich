# canvas-rich

> **English** · [简体中文](README.zh-CN.md)

> A GPU-rendered **canvas rich text editor engine** on HTML `<canvas>`.

[![CI](https://github.com/go-xworks/canvas-rich/actions/workflows/ci.yml/badge.svg)](https://github.com/go-xworks/canvas-rich/actions/workflows/ci.yml)
[![Website](https://img.shields.io/badge/website-live-brightgreen)](https://go-xworks.github.io/canvas-rich/)
[![Docs](https://img.shields.io/badge/docs-online-6f42c1)](https://go-xworks.github.io/canvas-rich/docs.html)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

canvas-rich renders the entire editor with TypeScript + `<canvas>` + WebGL2/WebGPU: glyphs are rasterized through an atlas into GPU-textured quads, with no reliance on DOM layout or browser text controls. On top of that it builds its own document tree, position model, style resolution, and block layout.

**🔗 Website: https://go-xworks.github.io/canvas-rich/**  
**📚 Docs: https://go-xworks.github.io/canvas-rich/docs.html**  
**🧪 Live demo: https://go-xworks.github.io/canvas-rich/demo.html**

## Features

- **GPU-rendered** — glyphs go into multi-page 2048² atlases, batched in a single WebGL2/WebGPU shader; automatic recovery on GPU context loss.
- **Document model** — 19 block types (headings / lists / tasks / quotes / code blocks / tables / media / formulas / shapes…) + 12 inline marks.
- **Typography** — block layout, paragraph line height / spacing / indentation / alignment, nested lists, table of contents, the Unicode BiDi algorithm, HarfBuzz complex-script shaping, and script-based font fallback.
- **Views** — web continuous scrolling / word A4 pagination; 50–200% functional zoom; light / dark themes.
- **Editing** — cross-block selection, word-level navigation, double-click word selection, drag-to-move text, undo coalescing, IME composition preview.
- **Tools** — find / replace (⌘F), rich text clipboard, print / export to PDF (⌘P), localStorage autosave and draft recovery.
- **Touch** — single-finger scrolling with inertia, long-press word selection, selection handles, two-finger pinch zoom, virtual keyboard avoidance.
- **Import / export** — Markdown / HTML / JSON (round-trippable).
- **Performance** — block-level incremental layout cache (editing only re-lays affected blocks) + viewport culling (zero cost on static frames).
- **Zero framework dependencies** — pure TypeScript, embeddable in any stack.

## Quick start

> Requires Node ≥ 20. The repository has two layers: `src/` is the core library, `examples/` is a sample site that consumes the library.

```bash
npm install
npm run dev        # start the sample site at http://localhost:5173
npm run build      # build the library: dist/index.js + dist/style.css + dist/index.d.ts
npm test           # unit tests
```

## Using as a library

The core library is on par with ProseMirror / CodeMirror 6 / Lexical: pass in a container, the library builds its own DOM shell, and the `createEditor(target, options)` factory returns an imperative instance handle.

```ts
import { createEditor } from 'canvas-rich';
import 'canvas-rich/style.css';

const editor = createEditor(document.getElementById('app')!, {
  initialMarkdown: '# Hello\n\nStart typing…',
  theme: 'light',          // 'light' | 'dark'
  viewMode: 'web',         // 'web' | 'word'
});

editor.exec('mark.bold');                            // dispatch a command
editor.on('doc:changed', () => console.log(editor.getMarkdown()));
editor.setHTML('<h1>New</h1>');                      // get/set content: get/set + HTML/Markdown/JSON/Doc
editor.destroy();                                    // fully destroy, releasing all DOM and listeners
```

`EditorInstance` provides `exec / getDoc / setDoc / getHTML / setHTML / getMarkdown / setMarkdown /
getJSON / setJSON / on / off / focus / setViewMode / setZoom / setTheme / destroy`.
See the full options in the [`createEditor` TSDoc](src/editor/create-editor.ts).

> **Runtime assets**: HarfBuzz shaping (`shaper:'harfbuzz'`) requires Roboto / Noto fonts served from `/fonts/` at the site root;
> formulas require `import 'katex/dist/katex.min.css'`. The default `canvas` shaper has none of these dependencies.
> **Known limitation**: the theme palette is a process-level global, so multiple instances on the same page cannot yet hold independent themes.

## Architecture

Layered strictly downward — `ui → editor → text → render → model → shared` — with the core layers free of any UI / DOM dependency.

```
model/    document tree schema, the RichDoc editing model, style resolution, import/export, block behavior registry
text/     shaper interface, glyph atlas, line breaking, block layout, BiDi, pagination
render/   WebGL2 / WebGPU backends (the factory picks the best and degrades gracefully)
editor/   command bus, event emitter, clipboard, hit testing, the createEditor factory
ui/       toolbar (declarative contribution manifest), overlays, panels, popovers, find bar (internal implementation)
shared/   cross-layer pure utilities
```

Design highlights: a **unified command bus** (keyboard / toolbar / context menu all dispatch the same ids), a **typed event emitter** (Observer), and a **plugin registry** (block behaviors / block exporters / toolbar contributions each registered in exactly one place).

## Contributing

Issues and PRs are welcome. Report security issues privately per [`SECURITY.md`](SECURITY.md). See [`CHANGELOG.md`](CHANGELOG.md) for the change log.

## License

[MIT](LICENSE) © go-xworks
