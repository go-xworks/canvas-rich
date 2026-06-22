/**
 * 作用域化纯逻辑（build 层；node 可测，不触网/不读盘）。
 *
 * 把库 CSS 的「全局选择器」改写为作用域到 `.canvas-rich` 子树的选择器，使库样式仅命中编辑器
 * 子树、零全局污染（嵌入宿主页时与宿主的 `.flex`/`.px-2` 等工具类互不冲突）。改写在 lightningcss
 * 的选择器 AST 上做（结构化、版本稳定），由 {@link tailwind-plugin} 在构建期调用。
 *
 * 三类映射（见 {@link scopeSelector}）：
 *  1. 普通选择器 `.flex` / `.rte-shell` → `.canvas-rich .flex`（后代组合：仅匹配 wrapper 的后代，
 *     故运行时须用 `display:contents` 的包裹 div，不能给已有根直接加 class）。
 *  2. 纯 `:root` → `.canvas-rich`（亮色 `--rte-*` 令牌改挂作用域元素，沿 DOM 树继承到编辑器子树）。
 *  3. root-like 且后随属性选择器（`html[data-theme='dark']`）→ `[data-theme='dark'] .canvas-rich`
 *     （cssVars 方案B：把 html 的属性条件保留为「祖先选择器」，再以 `.canvas-rich` 作后代锚点。
 *     这样运行时仍只改 `document.documentElement.dataset.theme`（写 `<html>`），暗色照常生效，
 *     无需任何运行时主题改动）。
 *
 * lightningcss 天然跳过的特例（无需在此特判，由 `Rule.style` 只命中样式规则保证）：
 *  - `@keyframes` 帧（`0%`/`from`/`to`）是 keyframe 规则，不进 `Rule.style`，帧选择器不被前缀。
 *  - `@property` / `@font-face` 无 selector 列表，不进 `Rule.style`，天然跳过。
 *  - `@media` / `@supports` / `@layer` 内部的样式规则照常进 `Rule.style` 被前缀，at-rule 名/条件不动。
 *
 * 分层：build（构建期工具，仅本插件链路引用，不进运行时 bundle）。
 */
import { transform, type Selector, type SelectorComponent } from 'lightningcss';

/** 库 CSS 作用域祖先类名（与运行时 `src/editor/scope.ts` 的 `SCOPE_CLASS` 保持一致）。 @internal */
export const SCOPE_CLASS = 'canvas-rich';

/** 后代组合子组件（`.canvas-rich <sel>` 的空格）。 */
const DESCENDANT: SelectorComponent = { type: 'combinator', value: 'descendant' };

/** 作用域 class 组件 `.canvas-rich`。 */
function scopeClassComponent(scopeClass: string): SelectorComponent {
  return { type: 'class', name: scopeClass };
}

/** 首组件是否为 `:root`（伪类 root）。 */
function isRootPseudo(first: SelectorComponent | undefined): boolean {
  return !!first && first.type === 'pseudo-class' && first.kind === 'root';
}

/** 首组件是否为 `html` / `body` 类型选择器（root-like 元素锚点）。 */
function isHtmlBodyType(first: SelectorComponent | undefined): boolean {
  return !!first && first.type === 'type' && (first.name === 'html' || first.name === 'body');
}

/**
 * 首组件是否为嵌套选择器 `&`（CSS nesting）。tailwind v4 把 `hover:`/`focus:`/`placeholder:`/
 * `last:`/`disabled:` 等变体编成嵌套块 `.x{&:hover{…}}`，其中 `&` 已相对「已作用域化的父规则」。
 * 这类选择器**不可再前缀** `.canvas-rich`——否则会变成 `.canvas-rich &…`，`&` 展开为
 * `.canvas-rich .x`，整体要求两层嵌套 `.canvas-rich` 祖先，运行时只有一层包裹，规则永不命中。
 */
function isNesting(first: SelectorComponent | undefined): boolean {
  return !!first && first.type === 'nesting';
}

/**
 * 改写单条选择器（一个 `SelectorComponent[]`）为作用域版本。纯函数，便于 node 单测。
 *
 * @param sel - 原始选择器组件数组（lightningcss `Selector`）。
 * @param scopeClass - 作用域祖先类名（默认 `canvas-rich`）。
 * @returns 改写后的选择器组件数组。
 * @internal
 */
export function scopeSelector(sel: Selector, scopeClass: string = SCOPE_CLASS): Selector {
  const first = sel[0];
  const scopeComp = scopeClassComponent(scopeClass);

  // 嵌套 `&` 选择器（变体编译产物）已相对已作用域化的父规则，原样返回，绝不再前缀。
  if (isNesting(first)) {
    return sel;
  }

  if (isRootPseudo(first) || isHtmlBodyType(first)) {
    const rest = sel.slice(1);
    // 收集紧跟 root-like 锚点之后的属性选择器（如 html[data-theme='dark'] 的 [data-theme]）。
    let i = 0;
    const leadingAttrs: SelectorComponent[] = [];
    while (i < rest.length && rest[i].type === 'attribute') {
      leadingAttrs.push(rest[i]);
      i++;
    }
    const tail = rest.slice(i);

    if (leadingAttrs.length > 0) {
      // 方案B：[attr] .canvas-rich <tail>（属性条件保留在 html 祖先上，.canvas-rich 作后代锚点）。
      return [...leadingAttrs, DESCENDANT, scopeComp, ...tail];
    }
    // 纯 :root / html / body → .canvas-rich <tail>（令牌/规则挂到作用域元素自身）。
    return [scopeComp, ...tail];
  }

  // 普通选择器 → .canvas-rich <sel>（后代组合）。
  return [scopeComp, DESCENDANT, ...sel];
}

/** {@link scopeCss} 选项。 @internal */
export interface ScopeCssOptions {
  /** 作用域祖先类名（默认 `canvas-rich`）。 */
  scopeClass?: string;
  /** 是否压缩输出（默认 true，与产物体积优先一致）。 */
  minify?: boolean;
  /** 错误信息里展示的文件名（默认 `lib.css`）。 */
  filename?: string;
}

/**
 * 对一段 CSS 串做「作用域化 + 可选压缩」，返回改写后的 CSS 串。
 *
 * 用 lightningcss `transform` 单趟完成：`Selector` 访问器对每条选择器调 {@link scopeSelector} 前缀，
 * `minify:true` 在同趟压缩，零额外解析库。
 *
 * 为何用 `Selector` 而非 `Rule.style` 访问器：实测 lightningcss\@1.32.0 在挂 `Rule` 访问器时对
 * tailwind v4 产物里某些规则的 selector 反序列化回 JS 会抛 `expected ... struct named Specifier`
 * （即便是 identity 访问器也复现）；改用 `Selector` 访问器（逐选择器、不经 Rule 往返）则正常。
 * 二者对样式规则选择器的覆盖等价，且 `Selector` 同样不命中 `@keyframes` 帧 / `@property` /
 * `@font-face`（这些天然跳过，见本文件头注）。
 *
 * @param css - 输入 CSS（已编译好的 tailwind utilities + shell.css，含 `:root`/`@media` 等）。
 * @param options - 见 {@link ScopeCssOptions}。
 * @returns 作用域化（+ 压缩）后的 CSS 字符串。
 * @internal
 */
export function scopeCss(css: string, options: ScopeCssOptions = {}): string {
  const scopeClass = options.scopeClass ?? SCOPE_CLASS;
  const minify = options.minify ?? true;
  const filename = options.filename ?? 'lib.css';

  const result = transform({
    filename,
    code: new TextEncoder().encode(css),
    minify,
    visitor: {
      Selector(sel) {
        return scopeSelector(sel, scopeClass);
      },
    },
  });

  return new TextDecoder().decode(result.code);
}
