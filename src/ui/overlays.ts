import katex from 'katex';
import { Block, BlockAttrs, CellMerge, ShapeKind, genBlockId } from '../model/schema';
import { blockVersion } from '../model/block-version';
import { overlaySpecOf } from '../model/block-specs';
import { tableColCount, MIN_CELL_PX } from '../model/table-utils';
import { inlinesToCellHtml } from '../model/export';
import { domToInlines } from '../editor/cell-dom';
import { sealSvg } from '../model/seal';
import { sanitizeUrl, UrlKind } from '../shared/url';
import { OverlayBox, OverlayKind, InlineOverlayBox } from '../text/doc-layout';

// 原子块 DOM 覆盖层管理：图片 / 公式(KaTeX) / 表格(可编辑)。
// 按「稳定 block id」缓存 DOM（不是对象身份）——undo(cloneDoc 换对象) 后同 id 复用同一 DOM，
// 不丢表格编辑态、不闪烁。事件闭包引用 entry.blk（每帧更新为当前块），避免写入陈旧对象。
// 分层：ui（呈现层，桥接 text/docLayout 的 OverlayBox 与原子块 DOM）。
//
// 坐标系约定（功能性缩放 zoom 的关键）：
//  - 布局盒（OverlayBox/InlineOverlayBox）单位 = 布局 px = canvas 物理 px；
//    布局以 scale = deviceDpr × zoom 产坐标（逻辑 px × scale）。
//  - 覆盖层 DOM 以「逻辑 px」定位/定尺寸（盒坐标 ÷ scale），整个定位层再经
//    CSS transform scale(zoom) 放大 → 屏幕位置 = 布局 px ÷ deviceDpr，与 canvas 内容像素对齐，
//    且 DOM 内容（表格文字/公式/控件）随 zoom 同步缩放。
//  - 实测高度回填（onMeasured/offsetHeight）取 transform 前的本地值 = 逻辑 px，
//    布局 ×scale 还原 → 预留空间与 DOM 显示高度在任意 zoom 下一致（闭环自洽）。
//  - 指针事件坐标（clientX/Y）是屏幕 CSS px，参与覆盖层内部几何时须 ÷zoom 回逻辑 px。

/**
 * 覆盖层向装配层回调的句柄：表格编辑、测量高度、单元格聚焦/失焦。
 * @public
 */
export interface OverlayCallbacks {
  onTableEdit(block: Block): void;
  /** 文本框内容编辑：contenteditable 内容已回写 entry.blk.attrs.content，通知装配层 markDirty。 */
  onTextboxEdit(block: Block): void;
  /**
   * 双击原子块「再编辑」：通知装配层按 kind 弹对应弹层取新值并写回 attrs（进撤销栈）。
   * 仅非 contenteditable 的原子块（公式/印章/iframe/音频/视频/附件/图片/签名）绑定；
   * textbox 可直接在覆盖层内编辑，不走此回调。
   */
  onAtomEdit(blockIndex: number, kind: string): void;
  onMeasured(blockIndex: number, hLogical: number): void;
  /**
   * measured 类覆盖层（公式/表格）DOM 高度自发变化（KaTeX 字体晚到/单元格图片加载等）：
   * 帧门控下静止帧不再每帧轮询 offsetHeight，由 ResizeObserver 回调此钩子让装配层
   * 置 needRender——下一渲染帧的 sync 统一重读高度并回填。可选（node 测试环境无 RO）。
   */
  onMeasuredResize?(): void;
  /**
   * 单元格/文本框 contenteditable 取得焦点：blockIndex 为所在原子块号。
   * 装配层据此把文档模型选区同步到该原子块——这些覆盖层 contenteditable 会拦截点击、
   * 不穿透到 canvas 命中（不同于图片/公式等点击穿透设选区的原子块），若不同步，
   * 模型选区将停在点表格前的陈旧块（如紧邻的公式），结构操作后选中环错落到该块。
   */
  onCellFocus(blockIndex: number): void;
  onCellBlur(): void;
  /** 缩放手柄提交：图片新显示尺寸（逻辑 px，与 zoom 无关；布局 ×scale 还原），进撤销栈。 */
  onImageResize(blockIndex: number, widthCss: number, heightCss: number): void;
  /** 拖动重排：move 阶段更新落点指示，drop 阶段提交移动。 */
  onBlockMove(blockIndex: number, clientY: number, phase: 'move' | 'drop'): void;
  /** 列宽拖拽提交：表格第 col 列新宽（逻辑 px），进撤销栈。 */
  onColResize(blockIndex: number, col: number, widthPx: number): void;
  /** 行高拖拽提交：表格第 row 行新高（逻辑 px），进撤销栈。 */
  onRowResize(blockIndex: number, row: number, heightPx: number): void;
  /** 合并单元格：把 (r0,c0)..(r1,c1) 矩形并为锚点，进撤销栈。 */
  onTableMerge(blockIndex: number, r0: number, c0: number, r1: number, c1: number): void;
  /** 拆分单元格：移除以 (r,c) 为锚点的合并区，进撤销栈。 */
  onTableSplit(blockIndex: number, r: number, c: number): void;
  /** 增删行：以选区锚点行 row 为基准在其上/下插入，或删除该行，进撤销栈。 */
  onTableRowOp(blockIndex: number, row: number, op: 'above' | 'below' | 'delete'): void;
  /** 增删列：以选区锚点列 col 为基准在其左/右插入，或删除该列，进撤销栈。 */
  onTableColOp(blockIndex: number, col: number, op: 'left' | 'right' | 'delete'): void;
}

/**
 * 原子块内容签名：`${kind}:${payload}`。kind 前缀消除「跨字段同值」碰撞——
 * 同一 entry 的 content 在不同 kind 下缓存不同字段（image 的 src、seal 的 text、formula 的
 * latex…），若不带前缀，两个 kind 恰好缓存同一字符串时 sync 会误判「未变化」而跳过更新。
 * 所有 kind 的签名统一经此构造，前缀即 box.kind，天然互不碰撞。
 * @internal
 */
export function atomSig(kind: string, payload: string): string {
  return `${kind}:${payload}`;
}

/**
 * 表格内容签名（带 `table:` kind 前缀）：结构（各行列数）+ 列宽/行高 + 合并区 +
 * 影响渲染的块属性(align/dir)。
 * 任一变化才重建表格 DOM；纯文本编辑不计入签名，故不触发重建（保留单元格编辑态）。
 *
 * 不变量：凡「结构外但仍影响表格 DOM 呈现」的属性都必须纳入，否则结构未变而样式变化时
 * sig 不动 → renderTable 早返回 → 视图与模型不一致（曾漏 align/dir，方向/对齐切换不重建）。
 * @internal
 */
export function tableSig(attrs: BlockAttrs): string {
  return atomSig('table', JSON.stringify({
    shape: (attrs.rows ?? []).map((r) => r.length),
    cw: attrs.colWidths ?? null,
    rh: attrs.rowHeights ?? null,
    mg: attrs.merges ?? null,
    align: attrs.align ?? null,
    dir: attrs.dir ?? null,
  }));
}

// 表格签名的版本缓存：blockVersion 不变即复用上次 JSON.stringify 结果，消除每渲染帧
// 全表结构序列化（defects idx4）。正确性依据：凡改变 tableSig 的写路径（结构操作经
// RichDoc 表格方法、align/dir 经 mutSelBlock）都 touchBlock；覆盖层单元格文本回写
// 不 touch 但也不改签名（shape/cw/rh/mg/align/dir 均不变）；undo/redo 换 Block 对象 → 天然重算。
// 注意：重算的仍只是「结构」签名——单元格文本不入签名，undo/redo 仅回退文本时 sig 不变，
// 该盲区由 renderTable 早退判定中的 Block 身份比对（canSkipTableRebuild）补住，并非签名自身覆盖。
const tableSigCache = new WeakMap<Block, { v: number; sig: string }>();
function versionedTableSig(blk: Block): string {
  const v = blockVersion(blk);
  const hit = tableSigCache.get(blk);
  if (hit && hit.v === v) return hit.sig;
  const sig = tableSig(blk.attrs);
  tableSigCache.set(blk, { v, sig });
  return sig;
}

/**
 * 文本框内容签名（带 `textbox:` kind 前缀）：尺寸（width|height CSS px 字符串）+ 纯文本内容。
 * 纳入尺寸是为了缩放后能刷新；纳入文本是为了避免 sync 把陈旧的 attrs.content 写回正在编辑的 body
 * （编辑态时 input 已把同一签名写入 entry.content，sync 比对相等即跳过 → 不打断 contenteditable 光标/IME）。
 * @internal
 */
export function textboxSig(content: string, width: string, height: string): string {
  return atomSig('textbox', `${width}|${height}|${content}`);
}

/**
 * 表格 DOM 是否可跳过重建（renderTable 早退判定，纯函数 node 可测）：
 * 签名相等 且 构建来源 Block 对象未被替换 且 DOM 行数与模型一致。
 * Block 身份比对补住签名盲区：{@link tableSig} 只含结构（单元格文本不入签名，编辑态才得以保留），
 * 而 undo/redo 经 cloneDoc 整体换 Block 对象、文本可能已回退而结构签名不变——此时必须重建，
 * 否则 td contenteditable 停留在回退前文本（模型-DOM 失同步直到下一次结构变更）。
 * 就地单元格编辑不换 Block（身份相等）→ 仍走早退，不打断编辑光标/IME。
 * @internal
 */
export function canSkipTableRebuild(
  prevSig: string, sig: string, prevBlk: object | undefined, blk: object, domRowCount: number, modelRowCount: number,
): boolean {
  return prevSig === sig && prevBlk === blk && domRowCount === modelRowCount;
}

/**
 * 实测高度是否「有意义地」变化：与上次已回填值比较，差值 < epsilon(0.5 逻辑 px) 视为未变。
 * 用于 throttle 覆盖层每帧的 onMeasured 回调，避免亚像素抖动反复触发 setMeasuredHeight/dirty。
 * `last` 为 undefined（首次测量）时恒返回 true。
 * @internal
 */
export function measuredHeightChanged(last: number | undefined, next: number): boolean {
  return last === undefined || Math.abs(last - next) >= 0.5;
}

/**
 * 表格结构操作提交前的焦点收口：activeElement 仍在该表格覆盖层内（正在编辑某 td）时
 * 先对其 blur()；返回是否实际执行了 blur。
 *
 * 不变量：合并/拆分/行列增删/列宽行高等结构操作改变 tableSig → renderTable 整体重建 DOM；
 * 单元格编辑以 input 事件就地回写模型，但 IME 合成中的待定输入尚未派发 input——不先收口焦点，
 * 重建会让这部分输入随旧 DOM 静默丢失，编辑回写与结构操作形成竞态。blur() 强制结束合成并
 * 派发收尾 input/focusout（onCellBlur 复位装配层焦点态），使「input 已回写的模型」成为唯一
 * 事实源，之后才允许执行结构回调。入参为 DOM 的结构子集，node 测试可用纯对象验证。 @internal
 */
export function blurActiveCellWithin(
  container: { contains(node: unknown): boolean },
  active: { blur(): void } | null,
): boolean {
  if (active && container.contains(active)) { active.blur(); return true; }
  return false;
}

/**
 * 覆盖层定位层的 CSS 缩放因子：zoom = scale / deviceDpr。
 *
 * 布局坐标 = 逻辑 px × scale（scale = deviceDpr × zoom），canvas 物理 px = 屏幕 CSS × deviceDpr，
 * 故屏幕 CSS 位置 = 布局 px ÷ deviceDpr = (布局 px ÷ scale) × zoom——覆盖层以逻辑 px（÷scale）定位，
 * 再由定位层 transform scale(zoom) 放大，恰与 canvas 内容对齐，且 DOM 内容随 zoom 同步缩放。
 * deviceDpr 与装配层一致地夹到 ≥1（浏览器可能上报 <1）。
 * @internal
 */
export function overlayLayerZoom(scale: number, deviceDpr: number): number {
  return scale / Math.max(1, deviceDpr);
}

/**
 * 布局盒（布局 px，y 含文档滚动）→ 覆盖层本地定位（逻辑 px，transform 前）。
 * 与 {@link overlayLayerZoom} 配套的不变量：本地 rect × zoom = 屏幕 CSS rect = 布局 rect ÷ deviceDpr。
 * 实测高度回填闭环：布局以 measuredH×scale 预留的盒经此还原 height === measuredH（任意 zoom 下稳定）。
 * @internal
 */
export function overlayCssRect(
  box: { x: number; y: number; w: number; h: number },
  scrollY: number,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  return { left: box.x / scale, top: (box.y - scrollY) / scale, width: box.w / scale, height: box.h / scale };
}

// 单元格内格式快捷键 → document.execCommand 命令名（mod+b/i/u；改动后 input 事件自然回写解析）。
const CELL_MARK_COMMAND: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline' };

interface CellRC { r: number; c: number }
interface Entry {
  el: HTMLElement; kind: string; content: string; blk: Block; blockIndex: number;
  // content 签名构建时的来源 Block（表格用）：undo/redo 换块对象而结构签名不变时据此强制重建。
  contentBlk?: Block;
  // 表格区域选择（拖拽起止单元格，跨重建保留以便合并/拆分浮动条联动）；非表格为 null
  tableSel?: { start: CellRC; end: CellRC } | null;
  // 上次回填给布局的实测高度（逻辑 px）；用于 throttle onMeasured，仅高度变化才回调。
  lastMeasuredH?: number;
  // measured 类（公式/表格）的高度自发变化监听（帧门控下替代每帧轮询）；removeEntry 时断开。
  resizeObs?: ResizeObserver;
}

/**
 * 覆盖层管理器句柄：按帧将原子块 DOM 与布局盒同步对齐。
 * @public
 */
export interface OverlayManager {
  /**
   * 同步原子块覆盖层：按帧将原子块 DOM 与布局盒对齐。
   * @param scale - 布局有效渲染比例（= deviceDpr × zoom，即 DocLayout.dpr）：盒坐标 ÷ scale 还原为
   *   逻辑 px 定位，定位层经 transform scale(zoom) 放大后与 canvas 内容像素对齐。
   */
  sync(doc: { blocks: Block[] }, overlays: OverlayBox[], scrollY: number, scale: number, selectedBlock: number): void;
  /**
   * 同步行内原子（行内图片）覆盖层：按 block:offset 缓存 DOM，定位到行内 x/y。
   * 随重排/滚动每帧调用；不在视口的盒仍定位（由外层 overflow:hidden 裁剪）。
   * @param scale - 同 {@link OverlayManager.sync}：布局比例（deviceDpr × zoom）。
   */
  syncInline(boxes: InlineOverlayBox[], srcOf: (box: InlineOverlayBox) => string, scrollY: number, scale: number): void;
}

const CSS = `
.rte-ovl{position:absolute;border-radius:6px;box-sizing:border-box}
.rte-ovl img{width:100%;height:100%;object-fit:contain;border-radius:6px;background:var(--rte-code-bg);display:block}
.rte-formula{display:flex;align-items:center;justify-content:center;color:var(--rte-text);overflow:hidden;pointer-events:none}
.rte-formula .katex{font-size:1.3em}
.rte-formula.err{color:#dc2626;font:13px ui-monospace,monospace}
.rte-table-wrap{position:relative}
.rte-table{border-collapse:collapse;table-layout:fixed;width:100%;pointer-events:auto;background:var(--rte-overlay-bg);border-radius:6px;overflow:hidden}
.rte-table td{border:1px solid var(--rte-overlay-border);padding:5px 8px;color:var(--rte-text);font:14px system-ui,sans-serif;vertical-align:top;min-width:40px;outline:none}
.rte-table td:focus{box-shadow:inset 0 0 0 2px var(--rte-accent)}
.rte-table td.rte-cell-sel{background:var(--rte-active-bg)}
.rte-table td span[data-href]{color:var(--rte-accent);text-decoration:underline}
.rte-table td code{font:12px ui-monospace,monospace;background:var(--rte-code-bg);border-radius:3px;padding:0 3px}
.rte-table td mark{background:var(--rte-active-bg);color:inherit;border-radius:2px}
.rte-col-grip{position:absolute;top:0;width:7px;margin-left:-3px;cursor:col-resize;pointer-events:auto;z-index:2}
.rte-row-grip{position:absolute;left:0;height:7px;margin-top:-3px;cursor:row-resize;pointer-events:auto;z-index:2}
.rte-table-bar{position:absolute;top:-30px;left:0;display:none;gap:6px;align-items:center;background:var(--rte-overlay-bg);border:1px solid var(--rte-overlay-border);border-radius:6px;box-shadow:var(--rte-shadow);padding:3px;z-index:5;pointer-events:auto}
.rte-table-bar button{font:12px system-ui,sans-serif;color:var(--rte-text);background:transparent;border:0;border-radius:4px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.rte-table-bar button:hover{background:var(--rte-active-bg);color:var(--rte-active-fg)}
.rte-resize{position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;border-radius:3px;background:var(--rte-accent);border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3);cursor:nwse-resize;pointer-events:auto;display:none}
.rte-ovl.rte-img-sel{cursor:move}
.rte-shape canvas{width:100%;height:100%;display:block}
.rte-signature img{width:100%;height:100%;object-fit:contain;border-radius:6px;background:transparent;display:block}
.rte-seal-body{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.rte-seal-body svg{width:100%;height:100%;display:block}
.rte-textbox{background:var(--rte-overlay-bg);border:1px solid var(--rte-overlay-border)}
.rte-textbox .rte-textbox-body{position:absolute;inset:0;padding:8px 10px;box-sizing:border-box;overflow:auto;color:var(--rte-text);font:14px system-ui,sans-serif;line-height:1.5;outline:none;white-space:pre-wrap;word-break:break-word}
.rte-textbox .rte-textbox-body:focus{box-shadow:inset 0 0 0 2px var(--rte-accent);border-radius:6px}
.rte-ovl audio{width:100%;height:100%;display:block;border-radius:6px}
.rte-ovl video{width:100%;height:100%;object-fit:contain;border-radius:6px;background:#000;display:block}
.rte-ovl iframe{width:100%;height:100%;border:0;border-radius:6px;background:var(--rte-code-bg);display:block}
.rte-attach{display:flex;align-items:center;gap:10px;padding:10px 14px;box-sizing:border-box;background:var(--rte-overlay-bg);border:1px solid var(--rte-overlay-border);color:var(--rte-text);text-decoration:none;font:13px system-ui,sans-serif}
.rte-attach .rte-attach-icon{flex:0 0 auto;color:var(--rte-muted)}
.rte-attach .rte-attach-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rte-attach .rte-attach-dl{flex:0 0 auto;color:var(--rte-accent)}
.rte-inline-img{position:absolute;border-radius:3px;box-sizing:border-box;pointer-events:none}
.rte-inline-img img{width:100%;height:100%;object-fit:cover;border-radius:3px;background:var(--rte-code-bg);display:block}
`;

// 附件文件卡片用的内联图标（Lucide 风格描边，随 currentColor 染色）。
const svg = (paths: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" `
  + `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const PAPERCLIP_SVG = svg('<path d="M13.234 20.252 21 12.3a4.6 4.6 0 0 0-6.5-6.5l-9.5 9.5a3 3 0 0 0 4.243 4.243l7.5-7.5a1.5 1.5 0 0 0-2.121-2.121L7.5 16.5"/>');
const DOWNLOAD_SVG = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>');

// 写 DOM src 前的第二道 URL 防线（第一道在模型层 insert*/updateAtomAttrs；历史文档反序列化/
// 直接构造的 Doc 可能绕过模型入口仍携带危险协议）：非法 URL 不写入并移除既有 src（降级为空）。
function applySafeSrc(el: HTMLImageElement | HTMLMediaElement | HTMLIFrameElement, src: string, kind: UrlKind): void {
  const safe = sanitizeUrl(src, kind);
  if (safe !== null) el.src = safe; else el.removeAttribute('src');
}

// 当前框宽高比（getBoundingClientRect）；未挂载/零尺寸时回退 fallback。
function rectAspect(wrap: HTMLElement, fallback: number): number {
  const r = wrap.getBoundingClientRect();
  return (r.width / r.height) || fallback;
}

// 媒体类原子块 src 同步表：kind → { 内容元素选择器, URL 白名单类别 }。
// sync 的「签名比对 + applySafeSrc 写回」对这些 kind 完全同构，统一为单一查表分支。
const MEDIA_SRC_SYNC: Partial<Record<OverlayKind, { selector: string; url: UrlKind }>> = {
  image: { selector: 'img', url: 'image' },
  video: { selector: 'video', url: 'video' },
  iframe: { selector: 'iframe', url: 'iframe' },
  audio: { selector: 'audio', url: 'audio' },
  signature: { selector: 'img', url: 'signature' },
};

// 解析 CSS 变量 --rte-accent 为可绘制颜色（Canvas2D 不识别 var()）；缺省回退到品牌蓝。
function accentColor(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--rte-accent').trim();
    return v || '#2563eb';
  } catch { return '#2563eb'; }
}

// 在 2D 上下文里按 shape 种类绘制（描边 + 半透明填充，accent 色）。w/h 为逻辑 px（已乘 dpr 缩放上下文）。
function drawShape(ctx: CanvasRenderingContext2D, kind: ShapeKind, w: number, h: number, accent: string): void {
  const pad = 8;
  const x0 = pad, y0 = pad, x1 = w - pad, y1 = h - pad;
  const cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 2;
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent + '22'; // ~13% alpha 填充
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const poly = (pts: [number, number][], close = true): void => {
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    if (close) ctx.closePath();
    ctx.fill(); ctx.stroke();
  };
  switch (kind) {
    case 'line':
      ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y0); ctx.stroke(); break;
    case 'divider':
      ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke(); break;
    case 'rect':
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill(); ctx.stroke(); break;
    case 'rounded-rect': {
      const r = Math.min(18, (x1 - x0) / 2, (y1 - y0) / 2);
      ctx.beginPath();
      ctx.moveTo(x0 + r, y0);
      ctx.arcTo(x1, y0, x1, y1, r); ctx.arcTo(x1, y1, x0, y1, r);
      ctx.arcTo(x0, y1, x0, y0, r); ctx.arcTo(x0, y0, x1, y0, r);
      ctx.closePath(); ctx.fill(); ctx.stroke(); break;
    }
    case 'ellipse':
      ctx.beginPath(); ctx.ellipse(cx, cy, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke(); break;
    case 'triangle':
      poly([[cx, y0], [x1, y1], [x0, y1]]); break;
    case 'diamond':
      poly([[cx, y0], [x1, cy], [cx, y1], [x0, cy]]); break;
    case 'star': {
      const pts: [number, number][] = [];
      const rOut = Math.min(x1 - x0, y1 - y0) / 2, rIn = rOut * 0.4;
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? rOut : rIn;
        pts.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]);
      }
      poly(pts); break;
    }
    case 'arrow': {
      const midY = cy, headW = Math.min(40, (x1 - x0) * 0.35), shaftH = (y1 - y0) * 0.28;
      poly([
        [x0, midY - shaftH / 2], [x1 - headW, midY - shaftH / 2], [x1 - headW, y0],
        [x1, midY], [x1 - headW, y1], [x1 - headW, midY + shaftH / 2], [x0, midY + shaftH / 2],
      ]); break;
    }
  }
}

/**
 * 创建覆盖层管理器：注入样式与定位层，按稳定 block id 缓存/复用原子块 DOM。
 * @public
 */
export function createOverlayManager(host: HTMLElement, cb: OverlayCallbacks): OverlayManager {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  // 双层结构：clip（编辑器边界裁剪，不缩放）→ layer（逻辑 px 定位层，transform scale(zoom) 放大）。
  // 裁剪必须在 transform 外层：transform 后 layer 的视觉盒超出编辑器，自身 overflow 无法按编辑器边界裁剪。
  const clip = document.createElement('div');
  clip.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  host.appendChild(clip);
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;transform-origin:0 0';
  clip.appendChild(layer);
  const map = new Map<string, Entry>();
  // 行内图片 DOM 缓存：键 = `${block}:${offset}`，值 = { 包裹元素, 当前 src }
  const inlineMap = new Map<string, { el: HTMLElement; img: HTMLImageElement; src: string }>();
  // 正在被缩放手柄拖动的覆盖层：此期间 sync 不把尺寸从（陈旧的）布局盒写回，避免每帧覆盖手柄的实时尺寸。
  let activeResizeWrap: HTMLElement | null = null;
  // 当前生效的覆盖层缩放因子（= scale / deviceDpr）；指针事件 px→逻辑 px 的换算共用。
  let zoomNow = 1;

  /**
   * 移除覆盖层 DOM 前的焦点清理：浏览器对「焦点节点随父级被移除」不派发 focusout →
   * onCellBlur 永不触发 → 装配层 tableFocused 卡死（canvas 光标恒暂停、ime 不回焦）。
   * 撤销/删块/块类型变化（kind 改变重建）移除正在编辑的表格/文本框时均命中此路径，
   * 与拖拽的 pointercancel 清理同理：任何「非常规退出」都必须恢复焦点状态。
   */
  function removeEntry(entry: Entry): void {
    if (entry.el.contains(document.activeElement)) cb.onCellBlur();
    entry.resizeObs?.disconnect();
    entry.el.remove();
  }

  // measured 类（公式/表格）挂 ResizeObserver：DOM 高度在静止期自发变化（KaTeX 字体晚到/
  // 单元格图片加载）时通知装配层置 needRender——替代旧「每帧读 offsetHeight」的轮询语义
  //（顺带消除交错读写的强制 reflow）。node 测试环境无 ResizeObserver 时静默跳过。
  function observeMeasured(entry: Entry): void {
    if (typeof ResizeObserver !== 'function' || !cb.onMeasuredResize) return;
    const obs = new ResizeObserver(() => cb.onMeasuredResize!());
    obs.observe(entry.el);
    entry.resizeObs = obs;
  }

  /** 按本帧布局比例同步定位层缩放：zoom 变化（含换屏致 deviceDpr 变化）才改写 transform。 */
  function applyLayerZoom(scale: number): void {
    const z = overlayLayerZoom(scale, window.devicePixelRatio || 1);
    if (z === zoomNow) return;
    zoomNow = z;
    layer.style.transform = z === 1 ? '' : `scale(${z})`;
  }

  // 缩放手柄：拖右下角改宽（左上锚定），aspect() 给出锁定的宽高比，松手提交模型（进撤销栈）。
  // 图片用自然宽高比；形状返回当前框宽高比（自由感更强但仍等比，避免变形）。
  function wireResize(wrap: HTMLElement, handle: HTMLElement, entry: Entry, aspect: () => number): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch { /* 合成事件/无效指针 */ }
      activeResizeWrap = wrap; // 拖动期间冻结 sync 对本盒尺寸的写回
      const rect = wrap.getBoundingClientRect();
      const left = rect.left;
      const asp = aspect();
      // 右界取不缩放的 clip 层（= 编辑器边界）；clientX/rect 是屏幕 CSS px，先在屏幕系夹取。
      const maxW = clip.getBoundingClientRect().right - left - 6;
      const onMove = (ev: PointerEvent) => {
        // 屏幕 px ÷ zoom → 逻辑 px（wrap 样式是逻辑 px，经定位层 transform 放大显示）；
        // 最小宽 40 逻辑 px，与 doc-layout 对原子块宽度的下限一致。
        const w = Math.max(40, Math.min(maxW, ev.clientX - left) / zoomNow);
        wrap.style.width = w + 'px'; wrap.style.height = (w / asp) + 'px';
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        cb.onImageResize(entry.blockIndex, parseFloat(wrap.style.width), parseFloat(wrap.style.height));
        activeResizeWrap = null; // 提交/取消后恢复：下一帧 relayout 已据新尺寸产盒，sync 据其写回
      };
      // pointercancel 与 pointerup 同处理：拖动被系统中断（如手势取消）时仍清理监听并解除冻结，
      // 否则 activeResizeWrap 卡住 → 后续帧 sync 永不写回该盒尺寸。
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp); handle.addEventListener('pointercancel', onUp);
    });
  }

  // 拖动重排：在本体按下并拖动 → 移到落点（仅选中态；阈值 5px 才算拖动）。
  function wireDrag(wrap: HTMLElement, handle: HTMLElement, entry: Entry): void {
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === handle || wrap.style.pointerEvents !== 'auto') return;
      // 文本框：pointerdown 落在可编辑 body 上时不接管（否则 preventDefault 会阻止 contenteditable
      // 取焦/落光标，且拖动选词会被误判为块移动）。仅从非编辑区（外框）发起拖动重排。
      if ((e.target as HTMLElement | null)?.closest('[contenteditable="true"]')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY; let moving = false;
      const onMove = (ev: PointerEvent) => {
        if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        if (!moving) { moving = true; wrap.style.opacity = '0.5'; }
        cb.onBlockMove(entry.blockIndex, ev.clientY, 'move');
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        wrap.style.opacity = '';
      };
      const onUp = (ev: PointerEvent) => {
        const wasMoving = moving;
        cleanup();
        if (wasMoving) cb.onBlockMove(entry.blockIndex, ev.clientY, 'drop');
      };
      // pointercancel：拖动被系统中断 → 用起点 y 提交 'drop'，让装配层落回原位并清掉落点指示线，
      // 避免 dropLine 卡在屏上 / dropTarget 残留（与 pointerup 的清理路径一致）。
      const onCancel = () => { const wasMoving = moving; cleanup(); if (wasMoving) cb.onBlockMove(entry.blockIndex, sy, 'drop'); };
      window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  }

  // 双击「再编辑」：在非 contenteditable 原子块容器上绑 dblclick → 回调装配层弹层改 attrs。
  // 闭包引用 entry（每帧更新 blockIndex/blk），故移动/undo 换块后仍指向当前块。
  function wireAtomEdit(wrap: HTMLElement, entry: Entry): void {
    wrap.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      cb.onAtomEdit(entry.blockIndex, entry.kind);
    });
  }

  // 单元格类 contenteditable 焦点跟踪（table/textbox 共用）：进入暂停 canvas 光标（onCellFocus）、
  // 焦点离开整个 wrap 才恢复（onCellBlur；wrap 内部转移焦点不触发）。
  // entry 每帧原地更新 blockIndex（移动/undo 换块后仍指当前块），故 focusin 时读 entry.blockIndex 取最新值。
  function wireCellFocusTracking(wrap: HTMLElement, entry: Entry): void {
    wrap.addEventListener('focusin', () => cb.onCellFocus(entry.blockIndex));
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget as Node)) cb.onCellBlur(); });
  }

  /**
   * 原子块覆盖层的公共样板：wrap 创建 + 内容挂载 + 可选「缩放手柄/拖动重排/双击再编辑/常开交互」接线。
   * 各 kind 的 builder 只保留内容构建差异（见 atomBuilders 表）。
   */
  function makeAtomWrap(entry: Entry, content: HTMLElement[], opts: {
    className?: string;          // 追加在 rte-ovl 之后的类名
    interactive?: boolean;       // 常开指针交互（audio 播放控件 / table 单元格编辑）
    aspect?: (wrap: HTMLElement) => number; // 提供 → 缩放手柄（锁定该宽高比）+ 拖动重排
    dblEdit?: boolean;           // 双击「再编辑」（onAtomEdit 弹层）
  }): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = opts.className ? `rte-ovl ${opts.className}` : 'rte-ovl';
    if (opts.interactive) wrap.style.pointerEvents = 'auto';
    for (const el of content) wrap.appendChild(el);
    const aspect = opts.aspect;
    if (aspect) {
      const handle = document.createElement('div'); handle.className = 'rte-resize'; wrap.appendChild(handle);
      wireResize(wrap, handle, entry, () => aspect(wrap));
      wireDrag(wrap, handle, entry);
    }
    if (opts.dblEdit) wireAtomEdit(wrap, entry);
    return wrap;
  }

  // 各 kind 的内容构建差异表：公共前置（wrap/手柄/接线）统一走 makeAtomWrap。
  const atomBuilders: Record<OverlayKind, (entry: Entry) => HTMLElement> = {
    image(entry) {
      // 图片：缩放锁自然宽高比（未加载回退当前框比，再回退 2）；双击换图。
      const img = document.createElement('img'); img.draggable = false;
      return makeAtomWrap(entry, [img], {
        aspect: (wrap) => (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : rectAspect(wrap, 2),
        dblEdit: true,
      });
    },
    shape(entry) {
      // 形状：内部 canvas 绘制；缩放保持当前框宽高比（自由感更强但仍等比，避免变形）。
      const cv = document.createElement('canvas');
      return makeAtomWrap(entry, [cv], { className: 'rte-shape', aspect: (wrap) => rectAspect(wrap, 1.6) });
    },
    signature(entry) {
      // 电子签名：<img>（手绘 PNG，透明底，类 image）；缩放锁自然宽高比；双击重画签名。
      const img = document.createElement('img'); img.draggable = false; img.alt = '签名';
      return makeAtomWrap(entry, [img], {
        className: 'rte-signature',
        aspect: (wrap) => (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : rectAspect(wrap, 220 / 90),
        dblEdit: true,
      });
    },
    seal(entry) {
      // 印章：内联红色圆形公章 SVG（随 attrs.text 重绘）。SVG 注入独立 body 容器（非 wrap 本体），
      // 避免 innerHTML 重绘时抹掉缩放手柄；公章恒方形（宽高比 1）。双击改印章文字。
      const body = document.createElement('div'); body.className = 'rte-seal-body';
      return makeAtomWrap(entry, [body], { className: 'rte-seal', aspect: () => 1, dblEdit: true });
    },
    video(entry) {
      // 视频：<video controls>；缩放锁视频自然宽高比（元数据未加载回退当前框比）。双击改视频源。
      const v = document.createElement('video'); v.controls = true;
      return makeAtomWrap(entry, [v], {
        aspect: (wrap) => (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : rectAspect(wrap, 16 / 9),
        dblEdit: true,
      });
    },
    iframe(entry) {
      // 内嵌网页：sandbox 限定（脚本/弹窗）+ 缩放（当前框宽高比）。双击改内嵌网页地址。
      // 不含 allow-same-origin：与 allow-scripts 同时开启时，同源（或被诱导加载的本站）内容
      // 可经 window.parent 直达宿主文档，构成沙箱逃逸/XSS 组合风险；去同源能力后脚本仍可运行，
      // 但 iframe 被视作不透明源，无法读写宿主页 DOM 与同源存储。
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-popups');
      f.setAttribute('referrerpolicy', 'no-referrer');
      return makeAtomWrap(entry, [f], { aspect: (wrap) => rectAspect(wrap, 16 / 9), dblEdit: true });
    },
    audio(entry) {
      // 音频：<audio controls>，固定高度（无缩放手柄）、常开交互（播放控件）。双击改音频源。
      const a = document.createElement('audio'); a.controls = true;
      return makeAtomWrap(entry, [a], { interactive: true, dblEdit: true });
    },
    attachment(entry) {
      // 附件：文件卡片（图标 + 文件名 + 下载链接），固定高度（无缩放手柄）。
      // 双击改附件源/名：阻止默认（避免双击触发下载导航），交回调弹层。
      const card = document.createElement('a'); card.className = 'rte-attach';
      const ic = document.createElement('span'); ic.className = 'rte-attach-icon'; ic.innerHTML = PAPERCLIP_SVG;
      const nm = document.createElement('span'); nm.className = 'rte-attach-name';
      const dl = document.createElement('span'); dl.className = 'rte-attach-dl'; dl.innerHTML = DOWNLOAD_SVG;
      card.append(ic, nm, dl);
      return makeAtomWrap(entry, [card], { dblEdit: true });
    },
    textbox(entry) {
      // 可编辑浮动文本框：外层 .rte-ovl 定位盒（带边框/背景）→ 内层 contenteditable body（纯文本 v1）
      // + 缩放（当前框宽高比）。复用表格单元格的 contenteditable + 内容回写模式：input 时把 textContent
      // 写回 entry.blk.attrs.content 并回调 onTextboxEdit；focusin/out 复用 onCellFocus/onCellBlur
      // 暂停 canvas 光标 / 不抢回 ime。
      const body = document.createElement('div'); body.className = 'rte-textbox-body';
      body.contentEditable = 'true'; body.spellcheck = false;
      const wrap = makeAtomWrap(entry, [body], { className: 'rte-textbox', aspect: (w) => rectAspect(w, 240 / 80) });
      body.addEventListener('input', () => {
        const txt = body.textContent ?? '';
        entry.blk.attrs.content = txt;
        entry.content = textboxSig(txt, wrap.style.width, wrap.style.height); // 编辑态同步签名，避免 sync 把陈旧文本写回
        cb.onTextboxEdit(entry.blk);
      });
      wireCellFocusTracking(wrap, entry);
      return wrap;
    },
    formula(entry) {
      // 公式：KaTeX 注入 wrap 本体（无内容子节点/手柄）；双击改 LaTeX（选中态下 sync 开启 pointerEvents 才命中）。
      return makeAtomWrap(entry, [], { className: 'rte-formula', dblEdit: true });
    },
    table(entry) {
      // table：外层 .rte-ovl 定位盒 → 内层 .rte-table-wrap（承载拖拽手柄/浮动条的绝对定位基准）→ table
      const inner = document.createElement('div'); inner.className = 'rte-table-wrap';
      const t = document.createElement('table'); t.className = 'rte-table'; inner.appendChild(t);
      const wrap = makeAtomWrap(entry, [inner], { interactive: true });
      wireCellFocusTracking(wrap, entry);
      return wrap;
    },
  };

  function build(kind: string, entry: Entry): HTMLElement {
    const builder = (atomBuilders as Partial<Record<string, (entry: Entry) => HTMLElement>>)[kind];
    if (builder) return builder(entry);
    // 未知 kind 显式兜底：渲染中性占位 div 并告警，不再隐式落入表格分支——
    // 新增 BlockType 若忘了接覆盖层，旧逻辑会把它静默错绑成表格 DOM（querySelector('table')
    // 取空还会在 renderTable 抛错）；占位 + console.warn 让问题在开发期即刻暴露。
    console.warn(`[overlays] 未知原子块 kind「${kind}」：渲染占位 div（请为其接入覆盖层分支）`);
    const wrap = document.createElement('div'); wrap.className = 'rte-ovl';
    wrap.style.background = 'var(--rte-code-bg)';
    wrap.textContent = `[${kind}]`;
    return wrap;
  }

  // 结构操作（合并/拆分/行列增删/列宽行高提交）入口统一先收口单元格焦点
  //（不变量见 blurActiveCellWithin 的 TSDoc：让 input 已回写的模型成为唯一事实，再执行结构回调）。
  function blurCellFocus(entry: Entry): void {
    const ae = document.activeElement;
    blurActiveCellWithin(entry.el, ae instanceof HTMLElement ? ae : null);
  }

  // 由 merges 算出「被覆盖格」集合（锚点除外）与「锚点查找表」：键 `r,c`。
  function mergeMaps(merges: CellMerge[]): { covered: Set<string>; anchorAt: Map<string, CellMerge> } {
    const covered = new Set<string>();
    const anchorAt = new Map<string, CellMerge>();
    for (const m of merges) {
      anchorAt.set(`${m.r},${m.c}`, m);
      for (let r = m.r; r < m.r + m.rowspan; r++)
        for (let c = m.c; c < m.c + m.colspan; c++)
          if (!(r === m.r && c === m.c)) covered.add(`${r},${c}`);
    }
    return { covered, anchorAt };
  }

  function renderTable(entry: Entry) {
    const rows = entry.blk.attrs.rows ?? [];
    const sig = versionedTableSig(entry.blk);
    const inner = entry.el.querySelector('.rte-table-wrap') as HTMLElement;
    const table = entry.el.querySelector('table') as HTMLTableElement;
    // 结构/列宽/合并未变且块对象未被替换：保留编辑态（身份比对捕捉 undo/redo 的单元格文本回退）
    if (canSkipTableRebuild(entry.content, sig, entry.contentBlk, entry.blk, table.rows.length, rows.length)) return;
    entry.content = sig;
    entry.contentBlk = entry.blk;
    entry.tableSel = null;
    entry.lastMeasuredH = undefined; // 结构重建 → 强制下一帧重新回填实测高度（绕过 throttle）
    const cols = tableColCount(rows);
    const merges = entry.blk.attrs.merges ?? [];
    const { covered, anchorAt } = mergeMaps(merges);

    // 清空 inner（保留 table 节点本身，移除旧手柄/浮动条），重置 table
    inner.querySelectorAll('.rte-col-grip,.rte-row-grip,.rte-table-bar').forEach((n) => n.remove());
    table.innerHTML = '';

    // 影响渲染的块属性：书写方向 + 单元格水平对齐（均纳入 tableSig，变化即重建生效）
    table.dir = entry.blk.attrs.dir ?? '';
    table.style.textAlign = entry.blk.attrs.align && entry.blk.attrs.align !== 'left' ? entry.blk.attrs.align : '';

    // 列宽：colgroup<col width>；缺省整列不设 width（等分/auto）
    const widths = entry.blk.attrs.colWidths;
    const colgroup = document.createElement('colgroup');
    for (let c = 0; c < cols; c++) {
      const col = document.createElement('col');
      const w = widths?.[c];
      if (w && w > 0) col.style.width = w + 'px';
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    rows.forEach((row, r) => {
      const tr = table.insertRow();
      const rh = entry.blk.attrs.rowHeights?.[r];
      if (rh && rh > 0) tr.style.height = rh + 'px';
      for (let c = 0; c < cols; c++) {
        if (covered.has(`${r},${c}`)) continue; // 被合并覆盖：不 insertCell
        const td = tr.insertCell();
        const anchor = anchorAt.get(`${r},${c}`);
        if (anchor) { td.colSpan = anchor.colspan; td.rowSpan = anchor.rowspan; }
        td.contentEditable = 'true'; td.spellcheck = false;
        td.innerHTML = row[c] ? inlinesToCellHtml(row[c].inlines) : ''; // 富单元格：marks/'\n' → 标签/<br>（已转义）
        td.dataset.r = String(r); td.dataset.c = String(c);
        // 回写：把 td 的 DOM 解析回 Inline[]，赋「新 cell 对象」到当前 rows（沿用就地回写模式；
        // 撤销栈安全由 cloneDoc 对 rows 的逐 cell 深拷保证——快照与当前态不共享任何 cell 引用）。
        td.addEventListener('input', () => {
          const rowsNow = entry.blk.attrs.rows;
          if (rowsNow?.[r]) rowsNow[r][c] = { inlines: domToInlines(td) };
          cb.onTableEdit(entry.blk);
        });
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') { e.preventDefault(); focusCell(table, r, c, e.shiftKey ? -1 : 1); return; }
          // 单元格内快捷键：mod+b/i/u → 浏览器原生 contenteditable 富文本命令（改动后 input 自然回写解析）
          if ((e.metaKey || e.ctrlKey) && !e.altKey) {
            const cmd = CELL_MARK_COMMAND[e.key.toLowerCase()];
            if (cmd) { e.preventDefault(); document.execCommand(cmd); return; }
          }
          // 单元格内换行：统一产 <br>（domToInlines 解析为 '\n'），避免浏览器默认包 <div> 的结构分歧
          if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
        });
        wireCellSelect(entry, table, inner, td, r, c);
      }
    });

    placeGrips(entry, table, inner, rows.length, cols);
    buildMergeBar(entry, inner);
    syncTableSelUI(entry, table, inner);
  }

  // 区域选择：在单元格上按下记起点，拖动到落点单元格记终点（更新高亮 + 浮动条）。
  function wireCellSelect(entry: Entry, table: HTMLTableElement, inner: HTMLElement, td: HTMLElement, r: number, c: number): void {
    td.addEventListener('pointerdown', () => {
      entry.tableSel = { start: { r, c }, end: { r, c } };
      const onMove = (ev: PointerEvent) => {
        const cell = (ev.target as HTMLElement | null)?.closest('td') as HTMLElement | null;
        if (cell && cell.dataset.r !== undefined && entry.tableSel)
          entry.tableSel.end = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
        syncTableSelUI(entry, table, inner);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
        syncTableSelUI(entry, table, inner);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
      syncTableSelUI(entry, table, inner);
    });
  }

  // 选区规范化为矩形 {r0,c0,r1,c1}；无选区返回 null。
  function selRect(entry: Entry): { r0: number; c0: number; r1: number; c1: number } | null {
    const s = entry.tableSel; if (!s) return null;
    return {
      r0: Math.min(s.start.r, s.end.r), c0: Math.min(s.start.c, s.end.c),
      r1: Math.max(s.start.r, s.end.r), c1: Math.max(s.start.c, s.end.c),
    };
  }

  // 同步选区高亮（td.rte-cell-sel）+ 浮动条可见性/按钮（≥2 格→合并；单选锚点→拆分）。
  function syncTableSelUI(entry: Entry, table: HTMLTableElement, inner: HTMLElement): void {
    const rect = selRect(entry);
    for (const row of Array.from(table.rows))
      for (const cell of Array.from(row.cells)) {
        const r = Number((cell as HTMLElement).dataset.r), c = Number((cell as HTMLElement).dataset.c);
        const on = !!rect && r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
        cell.classList.toggle('rte-cell-sel', on);
      }
    const bar = inner.querySelector('.rte-table-bar') as HTMLElement | null;
    if (!bar) return;
    const mergeBtn = bar.querySelector('[data-act="merge"]') as HTMLElement;
    const splitBtn = bar.querySelector('[data-act="split"]') as HTMLElement;
    const multi = !!rect && (rect.r0 !== rect.r1 || rect.c0 !== rect.c1);
    const anchorSel = !!rect && rect.r0 === rect.r1 && rect.c0 === rect.c1
      && (entry.blk.attrs.merges ?? []).some((m) => m.r === rect.r0 && m.c === rect.c0);
    // 合并：仅多格选区可用；拆分：仅单选到合并锚点可用；增删行列：任意选区均可用。
    mergeBtn.style.display = multi ? '' : 'none';
    splitBtn.style.display = anchorSel ? '' : 'none';
    // 删除行/列：表格仅剩 1 行/1 列时禁用入口（模型层也拒绝，UI 一并隐藏避免误点）。
    const rowCount = (entry.blk.attrs.rows ?? []).length;
    const colCount = tableColCount(entry.blk.attrs.rows ?? []);
    (bar.querySelector('[data-act="row-del"]') as HTMLElement).style.display = rect && rowCount > 1 ? '' : 'none';
    (bar.querySelector('[data-act="col-del"]') as HTMLElement).style.display = rect && colCount > 1 ? '' : 'none';
    bar.style.display = rect ? 'flex' : 'none';
  }

  // 浮动条：合并 / 拆分 + 增删行列按钮，点击经回调通知装配层。
  // 行列增删以选区锚点格 (r0,c0) 为基准；增删后清空选区（结构变了原选区可能越界）。
  function buildMergeBar(entry: Entry, inner: HTMLElement): void {
    const bar = document.createElement('div'); bar.className = 'rte-table-bar';
    const mk = (label: string, act: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button'); b.textContent = label; b.dataset.act = act;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
      // 浮动条按钮均为结构操作：先收口单元格焦点（pointerdown 已 preventDefault，点击时焦点
      // 仍在 td 上，恰是「编辑回写 × 结构重建」的竞态窗口），再执行回调。
      b.addEventListener('click', (e) => { e.preventDefault(); blurCellFocus(entry); fn(); });
      return b;
    };
    bar.appendChild(mk('合并单元格', 'merge', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableMerge(entry.blockIndex, rect.r0, rect.c0, rect.r1, rect.c1);
      entry.tableSel = null;
    }));
    bar.appendChild(mk('拆分单元格', 'split', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableSplit(entry.blockIndex, rect.r0, rect.c0);
      entry.tableSel = null;
    }));
    bar.appendChild(mk('插入行(上)', 'row-above', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableRowOp(entry.blockIndex, rect.r0, 'above'); entry.tableSel = null;
    }));
    bar.appendChild(mk('插入行(下)', 'row-below', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableRowOp(entry.blockIndex, rect.r1, 'below'); entry.tableSel = null;
    }));
    bar.appendChild(mk('删除行', 'row-del', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableRowOp(entry.blockIndex, rect.r0, 'delete'); entry.tableSel = null;
    }));
    bar.appendChild(mk('插入列(左)', 'col-left', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableColOp(entry.blockIndex, rect.c0, 'left'); entry.tableSel = null;
    }));
    bar.appendChild(mk('插入列(右)', 'col-right', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableColOp(entry.blockIndex, rect.c1, 'right'); entry.tableSel = null;
    }));
    bar.appendChild(mk('删除列', 'col-del', () => {
      const rect = selRect(entry); if (!rect) return;
      cb.onTableColOp(entry.blockIndex, rect.c0, 'delete'); entry.tableSel = null;
    }));
    inner.appendChild(bar);
  }

  // 列右边界 / 行下边界放细拖拽手柄（绝对定位）；拖动实时改宽/高，松手提交模型。
  function placeGrips(entry: Entry, table: HTMLTableElement, inner: HTMLElement, rowCount: number, cols: number): void {
    requestAnimationFrame(() => {
      if (!inner.isConnected) return;
      const cells = table.rows[0] ? Array.from(table.rows[0].cells) : [];
      const h = table.offsetHeight;
      // 列手柄：用 colgroup 的 col 累计宽，缺省时按表均分；放在每列右边界
      const colEls = Array.from(table.querySelectorAll('col')) as HTMLElement[];
      let x = 0;
      for (let c = 0; c < cols; c++) {
        const cw = colEls[c]?.offsetWidth || (table.offsetWidth / Math.max(1, cols));
        x += cw;
        const grip = document.createElement('div'); grip.className = 'rte-col-grip';
        grip.style.left = x + 'px'; grip.style.height = h + 'px';
        wireColResize(entry, table, grip, c);
        inner.appendChild(grip);
      }
      // 行手柄：累计每行高，放在每行下边界
      let y = 0;
      for (let r = 0; r < rowCount; r++) {
        const rowH = table.rows[r]?.offsetHeight ?? 0;
        y += rowH;
        const grip = document.createElement('div'); grip.className = 'rte-row-grip';
        grip.style.top = y + 'px'; grip.style.width = table.offsetWidth + 'px';
        wireRowResize(entry, table, grip, r);
        inner.appendChild(grip);
      }
      void cells;
    });
  }

  function wireColResize(entry: Entry, table: HTMLTableElement, grip: HTMLElement, col: number): void {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const colEl = Array.from(table.querySelectorAll('col'))[col] as HTMLElement | undefined;
      const startW = colEl?.offsetWidth ?? table.offsetWidth / Math.max(1, table.querySelectorAll('col').length);
      const startX = e.clientX;
      let w = startW;
      const onMove = (ev: PointerEvent) => {
        // 指针位移是屏幕 CSS px，列宽（offsetWidth/样式）是逻辑 px → ÷zoom 使拖动与光标 1:1
        w = Math.max(MIN_CELL_PX, startW + (ev.clientX - startX) / zoomNow);
        if (colEl) colEl.style.width = w + 'px';
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
        blurCellFocus(entry); // 列宽提交也改 tableSig（重建 DOM）：先收口单元格焦点再回调
        cb.onColResize(entry.blockIndex, col, w);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
    });
  }

  function wireRowResize(entry: Entry, table: HTMLTableElement, grip: HTMLElement, row: number): void {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const tr = table.rows[row]; if (!tr) return;
      const startH = tr.offsetHeight, startY = e.clientY;
      let h = startH;
      // 指针位移 ÷zoom → 逻辑 px（同列宽手柄），行高样式为逻辑 px
      const onMove = (ev: PointerEvent) => { h = Math.max(MIN_CELL_PX, startH + (ev.clientY - startY) / zoomNow); tr.style.height = h + 'px'; };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
        blurCellFocus(entry); // 行高提交也改 tableSig（重建 DOM）：先收口单元格焦点再回调
        cb.onRowResize(entry.blockIndex, row, h);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
    });
  }

  // Tab 导航：从当前 (r,c) 按文档顺序移到相邻「实际渲染」格（dir +1/-1），跳过被合并覆盖的格；夹到边界。
  function focusCell(table: HTMLTableElement, r: number, c: number, dir: 1 | -1): void {
    const flat: HTMLElement[] = [];
    for (const row of Array.from(table.rows))
      for (const cell of Array.from(row.cells)) flat.push(cell as HTMLElement);
    if (flat.length === 0) return;
    const idx = flat.findIndex((el) => Number(el.dataset.r) === r && Number(el.dataset.c) === c);
    const next = Math.max(0, Math.min(flat.length - 1, (idx < 0 ? 0 : idx) + dir));
    flat[next]?.focus();
  }

  // 形状：按 kind + 布局尺寸(box w/h) + scale 把图形画到内部 canvas；content 缓存「种类|宽|高」避免重画。
  // 背板 = 布局 px（逻辑 × scale），显示 = 逻辑 px × zoom → 物理像素密度恰为 deviceDpr，任意 zoom 下清晰。
  function renderShape(entry: Entry, wLayout: number, hLayout: number, scale: number): void {
    const kind = (entry.blk.attrs.shape ?? 'rect') as ShapeKind;
    const wL = wLayout / scale, hL = hLayout / scale;
    const sig = atomSig('shape', `${kind}|${Math.round(wL)}|${Math.round(hL)}`);
    if (entry.content === sig) return;
    entry.content = sig;
    const cv = entry.el.querySelector('canvas')!;
    cv.width = Math.max(1, Math.round(wLayout)); cv.height = Math.max(1, Math.round(hLayout));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); // 逻辑 px 坐标系
    drawShape(ctx, kind, wL, hL, accentColor());
  }

  return {
    sync(doc, boxes, scrollY, scale, selectedBlock) {
      applyLayerZoom(scale);
      const seen = new Set<string>();
      // 读写分离：主循环只写样式/重建 DOM，measured 类的 offsetHeight 读集中到循环后统一执行
      //（交错「写样式→读布局」会让每个 measured 覆盖层各强制一次同步 reflow）。
      const measuredReads: { entry: Entry; block: number }[] = [];
      for (const box of boxes) {
        const blk = doc.blocks[box.block]; if (!blk) continue;
        const id = blk.attrs.id ?? (blk.attrs.id = genBlockId());
        seen.add(id);
        let entry = map.get(id);
        if (!entry || entry.kind !== box.kind) {
          if (entry) removeEntry(entry); // 含焦点清理（kind 变化重建可能移除正在编辑的 DOM）
          entry = { el: null as unknown as HTMLElement, kind: box.kind, content: '', blk, blockIndex: box.block };
          entry.el = build(box.kind, entry);
          layer.appendChild(entry.el); map.set(id, entry);
          if (overlaySpecOf(box.kind).sizing === 'measured') observeMeasured(entry);
        }
        entry.blk = blk; entry.blockIndex = box.block; // 关键：闭包引用最新块与当前索引（undo/移动后变化）
        // 内容
        // 由覆盖层规格 SSOT（blockSpecs.overlaySpecOf）派生交互/高度策略，不再逐 kind 写布尔链：
        // fixedH = 非 measured（explicit 的 attrs 尺寸 + fullWidth 的固定高度，均不向布局回填实测高度）；
        // resizable = 规格表的 resizable（拖右下角改尺寸 + 拖动重排；音频/附件固定高度无手柄）。
        const spec = overlaySpecOf(box.kind);
        const fixedH = spec.sizing !== 'measured';
        const resizable = spec.resizable;
        // 各 kind 的 content 签名统一经 atomSig 加 kind 前缀（消除跨字段同值碰撞）；
        // 签名以「模型原值」计（含非法 URL），写 DOM 前再经 applySafeSrc 过滤——
        // 这样 src 从非法改为合法时签名必变化，能触发一次重写。
        const media = MEDIA_SRC_SYNC[box.kind];
        if (media) {
          // 媒体类（image/video/iframe/audio/signature）：同构的「查内容元素 + 签名比对 + 安全写 src」
          const el = entry.el.querySelector(media.selector) as HTMLImageElement | HTMLMediaElement | HTMLIFrameElement;
          const src = blk.attrs.src ?? '';
          const sig = atomSig(box.kind, src);
          if (entry.content !== sig) { applySafeSrc(el, src, media.url); entry.content = sig; }
        } else if (box.kind === 'attachment') {
          const src = blk.attrs.src ?? '', name = blk.attrs.name || src || '附件';
          // JSON 序列化二元组（替代裸 NUL 分隔拼接）：边界显式且可读，值含任意字符均无歧义
          const sig = atomSig(box.kind, JSON.stringify([src, name]));
          if (entry.content !== sig) {
            entry.content = sig;
            const card = entry.el.querySelector('.rte-attach') as HTMLAnchorElement;
            const safeHref = sanitizeUrl(src, 'attachment'); // 第二道 URL 防线（href 同样可承载 javascript:）
            if (safeHref !== null) card.href = safeHref; else card.removeAttribute('href');
            card.setAttribute('download', name); card.title = name;
            (entry.el.querySelector('.rte-attach-name') as HTMLElement).textContent = name;
          }
        } else if (box.kind === 'seal') {
          // 印章：按 attrs.text 重绘 SVG（注入 body 容器，保留手柄）；content 缓存文字签名，文字不变不重建。
          const sealText = blk.attrs.text ?? '';
          const sig = atomSig(box.kind, sealText);
          if (entry.content !== sig) {
            entry.content = sig;
            const body = entry.el.querySelector('.rte-seal-body') as HTMLElement;
            body.innerHTML = sealSvg(sealText);
          }
        } else if (box.kind === 'textbox') {
          // 文本框：把模型 content 同步进 contenteditable body。签名 = 尺寸 + 文本：
          // 编辑态时 input 已写入同一签名（含本帧尺寸），sig 相等即跳过 → 不打断光标/IME；
          // 缩放只改尺寸（box w/h → wrap 样式）但文本不变时，签名变化会触发一次无害的 textContent 重设（值相等）。
          const body = entry.el.querySelector('.rte-textbox-body') as HTMLElement;
          const content = blk.attrs.content ?? '';
          const sig = textboxSig(content, entry.el.style.width, entry.el.style.height);
          if (entry.content !== sig) {
            entry.content = sig;
            if (body.textContent !== content) body.textContent = content; // 仅在确有差异时改，避免清空编辑光标
          }
        } else if (box.kind === 'shape') {
          renderShape(entry, box.w, box.h, scale);
        } else if (box.kind === 'formula') {
          const tex = blk.attrs.latex ?? '';
          const sig = atomSig(box.kind, tex);
          if (entry.content !== sig) {
            entry.content = sig; entry.el.classList.remove('err');
            entry.lastMeasuredH = undefined; // 公式内容变 → 渲染高度可能变，强制下一帧重新回填
            try { entry.el.innerHTML = katex.renderToString(tex, { throwOnError: false, displayMode: true, output: 'html', trust: false }); }
            catch { entry.el.classList.add('err'); entry.el.textContent = tex; }
          }
        } else if (box.kind === 'table') {
          renderTable(entry);
        }
        // 未知 kind：build 已渲染占位 div（含 console.warn），此处无内容可同步，仅随帧定位。
        // 定位：逻辑 px（÷scale，定位层 transform 放大回屏幕）。
        // 缩放拖动中的盒子：保留手柄的实时尺寸，本帧不从陈旧布局盒覆盖宽高。
        const r = overlayCssRect(box, scrollY, scale);
        const s = entry.el.style;
        s.left = r.left + 'px'; s.top = r.top + 'px';
        if (entry.el !== activeResizeWrap) {
          s.width = r.width + 'px';
          s.height = fixedH ? r.height + 'px' : 'auto';
        }
        s.display = '';
        s.outline = box.block === selectedBlock ? '2px solid var(--rte-accent)' : '';
        s.outlineOffset = '2px';
        if (resizable) {
          // 选中态：开启指针交互（缩放手柄 + 拖动重排）；非选中态保持点击穿透到 canvas（用于选中/光标）
          const sel = box.block === selectedBlock;
          // 文本框特例：内部 contenteditable 聚焦编辑时（tableFocused 使 selectedBlock 变 -1，sel=false），
          // 仍须保持 pointerEvents:auto，否则一聚焦即穿透 → 无法继续点击/选词。聚焦判定 = 本盒含 activeElement。
          const editing = box.kind === 'textbox' && entry.el.contains(document.activeElement);
          s.pointerEvents = (sel || editing) ? 'auto' : 'none';
          entry.el.classList.toggle('rte-img-sel', sel);
          const handle = entry.el.querySelector('.rte-resize') as HTMLElement | null;
          if (handle) handle.style.display = sel ? 'block' : 'none';
        } else if (fixedH) {
          // 音频/附件：固定高度、无缩放手柄；内容始终可交互（播放控件 / 下载链接），不抢 canvas 命中。
          s.pointerEvents = 'auto';
        } else {
          // 表格/公式：渲染帧实测高度回填布局（读集中到循环后，见 measuredReads）。
          // 公式特例：CSS 默认 pointer-events:none（让单击穿透到 canvas 定位/选中）；选中态临时开启
          // 以便双击「再编辑」命中（dblclick 由 wireAtomEdit 绑定）。表格自身在 build 已设 auto，不在此覆盖。
          if (box.kind === 'formula') s.pointerEvents = box.block === selectedBlock ? 'auto' : 'none';
          measuredReads.push({ entry, block: box.block });
        }
      }
      for (const [id, entry] of map) if (!seen.has(id)) { removeEntry(entry); map.delete(id); }
      // 统一读阶段：全部样式写完后才读 offsetHeight（至多触发一次同步布局）。
      // throttle：仅当较上次回填值有意义变化(≥0.5 逻辑 px) 才回调，
      // 避免亚像素抖动逐帧触发 setMeasuredHeight → dirty → 无谓重排。
      for (const { entry, block } of measuredReads) {
        const hL = entry.el.offsetHeight;
        if (hL > 0 && measuredHeightChanged(entry.lastMeasuredH, hL)) {
          entry.lastMeasuredH = hL;
          cb.onMeasured(block, hL);
        }
      }
    },
    syncInline(boxes, srcOf, scrollY, scale) {
      applyLayerZoom(scale);
      const seen = new Set<string>();
      for (const box of boxes) {
        const key = `${box.block}:${box.offset}`;
        seen.add(key);
        let ent = inlineMap.get(key);
        if (!ent) {
          const el = document.createElement('div'); el.className = 'rte-inline-img';
          const img = document.createElement('img'); img.draggable = false; el.appendChild(img);
          layer.appendChild(el);
          ent = { el, img, src: '' };
          inlineMap.set(key, ent);
        }
        const src = srcOf(box);
        if (ent.src !== src) { applySafeSrc(ent.img, src, 'image'); ent.src = src; } // 行内图片同走第二道 URL 防线
        const r = overlayCssRect(box, scrollY, scale); // 逻辑 px 定位（定位层 transform 放大回屏幕）
        const s = ent.el.style;
        s.left = r.left + 'px'; s.top = r.top + 'px';
        s.width = r.width + 'px'; s.height = r.height + 'px';
        s.display = '';
      }
      for (const [key, ent] of inlineMap) if (!seen.has(key)) { ent.el.remove(); inlineMap.delete(key); }
    },
  };
}
