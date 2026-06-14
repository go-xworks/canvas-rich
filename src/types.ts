// 基础类型定义：样式、字形度量、布局结果
// 坐标统一使用「设备像素(device px)」，在最外层乘以 devicePixelRatio。

/** 单段文本的解析后视觉样式（字体/字号/粗斜/颜色），度量与栅格化的输入。 @public */
export interface Style {
  fontFamily: string;
  fontSize: number; // 逻辑 px（渲染时再乘 dpr）
  bold: boolean;
  italic: boolean;
  color: [number, number, number, number]; // rgba，分量 0..1
}

/** 返回引擎默认样式（system-ui / 20px / 浅色）。 @public */
export function defaultStyle(): Style {
  return {
    fontFamily: 'system-ui, sans-serif',
    fontSize: 20,
    bold: false,
    italic: false,
    color: [0.92, 0.93, 0.96, 1],
  };
}

/** 生成字形图集/度量缓存的去重键，含按 dpr 取整后的像素字号。不变量：相同视觉外观必产生相同键。 @public */
export function styleKey(s: Style, dpr: number): string {
  const px = Math.round(s.fontSize * dpr);
  return `${s.fontFamily}|${px}|${s.bold ? 1 : 0}|${s.italic ? 1 : 0}`;
}

/** 把样式拼成 Canvas `ctx.font` 字符串（含按 dpr 取整的像素字号）。 @public */
export function cssFont(s: Style, dpr: number): string {
  const px = Math.round(s.fontSize * dpr);
  return `${s.italic ? 'italic ' : ''}${s.bold ? 700 : 400} ${px}px ${s.fontFamily}`;
}

// 文档里的一个字符（含样式）。原型用「逐字符 + 样式」的最简模型，
// 编辑操作 O(n)，但正确且易懂；后续应替换为 rope + 属性区间。
/** 带样式的单个用户可见字符（grapheme），最简文档模型的存储单元。 @public */
export interface StyledChar {
  ch: string; // 一个用户可见字符（grapheme），可能是多个 code unit
  style: Style;
}

// 字形在图集中的信息（设备像素）
/** 单个字形在图集中的纹理坐标与度量（设备像素），栅格化产物。 @public */
export interface GlyphInfo {
  u0: number;
  v0: number;
  u1: number;
  v1: number; // 纹理 uv（0..1）
  page: number; // 所在图集页号（empty 字形恒 0 占位；渲染按页分批绑定纹理）
  w: number;
  h: number; // 位图尺寸（设备 px）。巨字形夹紧光栅时仍存全尺寸，由 GPU 放大
  bearingX: number; // 笔位到位图左边（向右为正）
  bearingY: number; // 基线到位图顶边（向上为正）
  advance: number; // 笔位前进量
  empty: boolean; // 是否无可见像素（如空格）
  exhausted?: boolean; // 图集已满导致光栅失败（不应缓存，留待图集复位后重试）
}

// 排好版的一个字形实例
/** 已定位的字形实例（笔位/基线/颜色），布局输出、直接喂给渲染。 @public */
export interface PositionedGlyph {
  info: GlyphInfo;
  penX: number; // 笔位 x（设备 px，行内左起）
  baselineY: number; // 基线 y（设备 px）
  color: [number, number, number, number];
}

// 光标边界 / 命中盒（每个字符前一个，外加末尾一个）
/** 单个光标边界/命中盒（边界 x 与所在行上下沿），用于落点与导航。 @public */
export interface CaretBox {
  index: number;
  x: number; // 边界 x（设备 px）
  top: number; // 所在行顶
  bottom: number; // 所在行底
}

// 字符背景矩形（用于选区高亮）
/** 单字符的背景矩形（左右上下沿），用于选区高亮命中。 @public */
export interface CharRect {
  x: number;
  right: number;
  top: number;
  bottom: number;
}

/** 单段文本的排版结果（字形/光标盒/字符矩形/内容高度）。 @public */
export interface LayoutResult {
  glyphs: PositionedGlyph[];
  carets: CaretBox[]; // 长度 = 字符数 + 1
  charRects: CharRect[]; // 长度 = 字符数
  contentHeight: number;
}
