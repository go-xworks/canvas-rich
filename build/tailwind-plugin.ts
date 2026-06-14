/**
 * tsdown / rolldown 插件（build 层）：在库构建期把 Tailwind v4 样式编译 + 作用域化 + 压缩，
 * 经 `this.emitFile` 产出 `dist/style.css`——把原先「`tsdown && @tailwindcss/cli`」两步合一，
 * 让单条 `tsdown` 命令同时产出 JS + d.ts + CSS。
 *
 * 链路（`buildEnd` 钩子内，于所有模块构建结束后、`generateBundle` 前）：
 *  1. 读入口 `src/styles/lib.css`。
 *  2. `compile()`（@tailwindcss/node）→ 得 `{ root, sources, build }`；`onDependency` 收集
 *     theme.css/utilities.css/shell.css（仅 watch 失配提示用，库构建非 watch，可不接 addWatchFile）。
 *  3. 逐字对齐 @tailwindcss/cli 拼 scanner sources：root 为 none 则空、为 null 则用 cwd 全量 glob、
 *     否则用 root 自身；再 concat `sources`（含 @source 库源码 glob 解析项）。
 *  4. `new Scanner({ sources }).scan()`（@tailwindcss/oxide）扫盘得候选类名——`@source` 的内容扫描即在此完成。
 *  5. `compiler.build(candidates)` 产出含全部用到的 utility + theme + shell.css 的 CSS。
 *  6. {@link scopeCss}（lightningcss 单趟）作用域化到 `.canvas-rich` + 压缩。
 *  7. `this.emitFile({ type:'asset', fileName:'style.css', source })` 落到 outDir/style.css
 *     （固定 fileName，不带 hash，消费者 `import 'canvas-rich/style.css'` 稳定可达）。
 *
 * `clean` 由 tsdown 主流程在 `buildStart` 清 outDir，`emitFile` 在 `buildEnd`（其后），无被清风险。
 *
 * 分层：build（构建期工具，仅 tsdown.config.ts 引用，不进运行时 bundle）。
 */
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import type { TsdownPlugin } from 'tsdown';
import { scopeCss, SCOPE_CLASS } from './scope-css.ts';

/** {@link tailwindCss} 选项。 @internal */
export interface TailwindPluginOptions {
  /** Tailwind CSS 入口（相对 cwd 或绝对路径），默认 `src/styles/lib.css`。 */
  entry?: string;
  /** 产出文件名（落到 outDir 下，固定名不带 hash），默认 `style.css`。 */
  fileName?: string;
  /** 作用域祖先类名，默认 `canvas-rich`。 */
  scopeClass?: string;
  /** 是否压缩产物 CSS，默认 true。 */
  minify?: boolean;
}

/** 默认入口（相对 cwd）。 */
const DEFAULT_ENTRY = 'src/styles/lib.css';

/**
 * 编译 + 作用域化 + 压缩入口 CSS，返回产物字符串（纯 IO + 计算，便于复用/测试）。
 *
 * @param entryPath - Tailwind 入口的绝对路径。
 * @param cwd - 当前工作目录（root===null 时 scanner 扫描基准）。
 * @param scopeClass - 作用域祖先类名。
 * @param minify - 是否压缩。
 * @returns 作用域化（+ 压缩）后的 CSS 字符串。
 * @internal
 */
export async function buildScopedCss(
  entryPath: string,
  cwd: string,
  scopeClass: string,
  minify: boolean,
): Promise<string> {
  const stylesDir = dirname(entryPath);
  const css = readFileSync(entryPath, 'utf8');

  // 1) 编译 tailwind（@tailwindcss/node）：得 root/sources/build。onDependency 收集传递依赖（此处不用）。
  const compiler = await compile(css, {
    base: stylesDir,
    from: entryPath,
    onDependency: () => {},
  });

  // 2) 拼 scanner sources（逐字对齐 @tailwindcss/cli 内部 root + sources 拼法）。
  const root = compiler.root;
  const rootSources =
    root === 'none'
      ? []
      : root === null
        ? [{ base: cwd, pattern: '**/*', negated: false }]
        : [{ ...root, negated: false }];
  const sources = [...rootSources, ...compiler.sources];

  // 3) 扫盘得候选类名（@source 的内容扫描在此完成）。
  const scanner = new Scanner({ sources });
  const candidates = scanner.scan();

  // 4) 产出 CSS（含用到的 utility + theme + shell.css）。
  const built = compiler.build(candidates);

  // 5) 作用域化 + 压缩（lightningcss 单趟）。
  return scopeCss(built, { scopeClass, minify, filename: entryPath });
}

/**
 * 创建 Tailwind CSS 构建插件：库构建期编译 tailwind、作用域化到 `.canvas-rich`、压缩，
 * 并 `emitFile` 出 `dist/style.css`。在 tsdown.config.ts 的 `plugins` 里引入即可。
 *
 * @param options - 见 {@link TailwindPluginOptions}。
 * @returns rolldown 插件（`TsdownPlugin extends rolldown Plugin`）。
 * @internal
 */
export function tailwindCss(options: TailwindPluginOptions = {}): TsdownPlugin {
  const fileName = options.fileName ?? 'style.css';
  const scopeClass = options.scopeClass ?? SCOPE_CLASS;
  const minify = options.minify ?? true;

  return {
    name: 'canvas-rich:tailwind-css',
    async buildEnd() {
      const cwd = process.cwd();
      const entryPath = resolve(cwd, options.entry ?? DEFAULT_ENTRY);
      const source = await buildScopedCss(entryPath, cwd, scopeClass, minify);
      this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
