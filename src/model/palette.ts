import { Style } from '../types';

// 共享主题原语：调色板 + 块主题类型 + 颜色解析。blockSpecs / styleResolver 复用，单一信息源。
// 分层位置：model 层的主题原语基座，被同层 blockSpecs / styleResolver 引用。

/** 归一化的 RGBA 颜色四元组（各分量 0..1）。 @public */
export type RGBA = [number, number, number, number];

/** 主题名：亮色 / 暗色。canvas 渲染色与 DOM 外壳（`--rte-*`）按同名主题成对切换。 @public */
export type ThemeName = 'light' | 'dark';

/** canvas 渲染调色板的字段集合（{@link C} 的形状）：一套完整的渲染色令牌。 @public */
export interface CanvasPalette {
  /** 正文文字 @public */ light: RGBA;
  /** 引用/弱化文字 @public */ muted: RGBA;
  /** H1 标题文字 @public */ title: RGBA;
  /** H2–H6 标题文字 @public */ h2: RGBA;
  /** 链接文字/下划线 @public */ link: RGBA;
  /** 行内代码文字 @public */ code: RGBA;
  /** 代码块文字 @public */ codeText: RGBA;
  /** 代码块背景 @public */ codeBg: RGBA;
  /** 画布纸面背景（clear color） @public */ bg: RGBA;
  /** 选区高亮 wash @public */ selection: RGBA;
  /** 查找命中高亮 wash（当前命中以选区色突出） @public */ findMatch: RGBA;
  /** 文本光标 @public */ caret: RGBA;
  /** 列表标记（项目符号/编号） @public */ marker: RGBA;
  /** word(分页) 视图页间背景（页缝/画布衬底，纸面用 bg） @public */ pageGap: RGBA;
}

/**
 * 亮色令牌集（默认/白底）：canvas 渲染侧颜色。
 * 文本/装饰色在 #ffffff 上均过 WCAG AA。DOM 外壳的对应色见 index.html `:root` 的 `--rte-*`。
 * @public
 */
export const LIGHT: CanvasPalette = {
  // —— 文本（块主题用，键名沿用以兼容 block-specs）——
  light: [0.122, 0.141, 0.188, 1],   // 正文 #1f2430
  muted: [0.420, 0.447, 0.502, 1],   // 引用/弱化 #6b7280
  title: [0.059, 0.067, 0.090, 1],   // H1 #0f1117（层级靠字号字重，不再用彩色）
  h2: [0.200, 0.216, 0.239, 1],      // H2 #33373d
  link: [0.145, 0.388, 0.922, 1],    // 链接 #2563eb
  code: [0.176, 0.192, 0.220, 1],    // 行内代码文字 #2d3138
  codeText: [0.176, 0.192, 0.220, 1], // 代码块文字 #2d3138
  codeBg: [0.957, 0.961, 0.969, 1],  // 代码块底 #f4f5f7
  // —— 画布级（main.ts / doc-layout 用）——
  bg: [1, 1, 1, 1],                  // 画布纸面 #ffffff
  selection: [0.145, 0.388, 0.922, 0.16], // 选区蓝 wash rgba(37,99,235,.16)
  findMatch: [0.961, 0.620, 0.043, 0.30], // 查找命中琥珀 wash rgba(245,158,11,.30)
  caret: [0.059, 0.067, 0.090, 1],   // 光标 #0f1117（深色，白底可见）
  marker: [0.604, 0.631, 0.678, 1],  // 列表标记 #9aa1ad
  pageGap: [0.925, 0.933, 0.949, 1],  // word 视图页缝 #eceef2（比纸面略灰，衬出纸张）
};

/**
 * 暗色令牌集（深底 #1a1b22）：canvas 渲染侧颜色。
 * 文字/装饰色在深底上均过 WCAG AA。DOM 外壳的对应色见 index.html `html[data-theme="dark"]` 的 `--rte-*`。
 * @public
 */
export const DARK: CanvasPalette = {
  // —— 文本 ——
  light: [0.886, 0.898, 0.925, 1],   // 正文 #e2e5ec（深底浅文字）
  muted: [0.604, 0.627, 0.682, 1],   // 引用/弱化 #9aa0ae
  title: [0.965, 0.972, 0.984, 1],   // H1 #f6f8fb（最亮，层级靠字号字重）
  h2: [0.831, 0.851, 0.890, 1],      // H2–H6 #d4d9e3
  link: [0.451, 0.659, 0.992, 1],    // 链接 #73a8fd（深底上更亮的蓝）
  code: [0.776, 0.804, 0.851, 1],    // 行内代码文字 #c6cdd9
  codeText: [0.776, 0.804, 0.851, 1], // 代码块文字 #c6cdd9
  codeBg: [0.149, 0.157, 0.196, 1],  // 代码块底 #262832（比纸面略亮一档）
  // —— 画布级 ——
  bg: [0.102, 0.106, 0.133, 1],      // 画布纸面 #1a1b22（深底）
  selection: [0.451, 0.659, 0.992, 0.26], // 选区蓝 wash（深底上加大 alpha 提可见度）
  findMatch: [0.961, 0.620, 0.043, 0.38], // 查找命中琥珀 wash（深底上加大 alpha 提可见度）
  caret: [0.965, 0.972, 0.984, 1],   // 光标 #f6f8fb（浅色，深底可见）
  marker: [0.490, 0.514, 0.573, 1],  // 列表标记 #7d8392
  pageGap: [0.063, 0.067, 0.090, 1],  // word 视图页缝 #101117（比纸面更深，衬出纸张）
};

/** 各主题名 → 其 canvas 令牌集。 @internal */
const THEMES: Record<ThemeName, CanvasPalette> = { light: LIGHT, dark: DARK };

/**
 * 全局命名调色板（canvas 渲染侧颜色的单一来源）：**可变**对象，引用恒定。
 * 由 {@link applyCanvasTheme} 原地改写其字段，使所有读 `C.bg`/`C.selection`/… 的处下次取到新主题色；
 * block-specs / styleResolver 的 `theme()` 在布局时读 `C.*`，故重排即生效。默认亮色。
 * DOM 外壳的颜色见 index.html 的 `--rte-*` CSS 变量。
 * @public
 */
export const C: CanvasPalette = { ...LIGHT };

let _activeTheme: ThemeName = 'light';

/**
 * 把指定主题的令牌集原地拷入可变的 {@link C}（保持 C 同引用），并记录为当前主题。
 * 不触发重排——调用方应在其后 markDirty/relayout 让 canvas 用新色重绘。
 * @param name 目标主题名
 * @public
 */
export function applyCanvasTheme(name: ThemeName): void {
  Object.assign(C, THEMES[name]);
  _activeTheme = name;
}

/** 查询当前生效的 canvas 主题名。 @public */
export function activeTheme(): ThemeName {
  return _activeTheme;
}

/** UI（正文/标题）默认字体栈。 @public */
export const FONT_UI = 'system-ui, sans-serif';
/** 等宽（代码）默认字体栈。 @public */
export const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** 块级主题：字体/字号/缩进/间距/标记/背景，由 blockSpecs 产出、styleResolver 消费。 @public */
export interface BlockTheme {
  base: Style; indent: number; spaceBefore: number; spaceAfter: number;
  marker: string | null; ordered: boolean; background: RGBA | null;
}

/** 解析 6 位十六进制色（可带 #）为归一化 RGBA；非法输入返回 fallback。 @public */
export function parseHex(hex: string, fallback: RGBA): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}
