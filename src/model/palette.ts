import { Style } from '../types';

// 共享主题原语：调色板 + 块主题类型 + 颜色解析。blockSpecs / styleResolver 复用，单一信息源。
// 分层位置：model 层的主题原语基座，被同层 blockSpecs / styleResolver 引用。

/** 归一化的 RGBA 颜色四元组（各分量 0..1）。 @public */
export type RGBA = [number, number, number, number];

/**
 * 全局命名调色板（默认**亮色/白底**主题）：canvas 渲染侧颜色的单一来源。
 * 文本/装饰色在 #ffffff 上均过 WCAG AA。DOM 外壳的颜色见 index.html 的 `--rte-*` CSS 变量。
 * @public
 */
export const C = {
  // —— 文本（块主题用，键名沿用以兼容 block-specs）——
  light: [0.122, 0.141, 0.188, 1] as RGBA,   // 正文 #1f2430
  muted: [0.420, 0.447, 0.502, 1] as RGBA,   // 引用/弱化 #6b7280
  title: [0.059, 0.067, 0.090, 1] as RGBA,   // H1 #0f1117（层级靠字号字重，不再用彩色）
  h2: [0.200, 0.216, 0.239, 1] as RGBA,      // H2 #33373d
  link: [0.145, 0.388, 0.922, 1] as RGBA,    // 链接 #2563eb
  code: [0.176, 0.192, 0.220, 1] as RGBA,    // 行内代码文字 #2d3138
  codeText: [0.176, 0.192, 0.220, 1] as RGBA, // 代码块文字 #2d3138
  codeBg: [0.957, 0.961, 0.969, 1] as RGBA,  // 代码块底 #f4f5f7
  // —— 画布级（main.ts / doc-layout 用）——
  bg: [1, 1, 1, 1] as RGBA,                  // 画布纸面 #ffffff
  selection: [0.145, 0.388, 0.922, 0.16] as RGBA, // 选区蓝 wash rgba(37,99,235,.16)
  caret: [0.059, 0.067, 0.090, 1] as RGBA,   // 光标 #0f1117（深色，白底可见）
  marker: [0.604, 0.631, 0.678, 1] as RGBA,  // 列表标记 #9aa1ad
};

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
