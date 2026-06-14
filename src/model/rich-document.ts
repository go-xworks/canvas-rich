import {
  Doc, Block, BlockType, BlockAttrs, BlockAlign, Mark, MarkType, Inline, ShapeKind, TableCell,
  block as mkBlock, text as mkText, inlineAtom as mkInlineAtom, cell as mkCell, isCellEmpty, cloneCell,
  blockText, blockTextLen, isBlockEmpty, cloneDoc, cloneBlockAttrs, withMark, withoutMark, genBlockId, isInlineAtom, isAtomBlock,
} from './schema';
import {
  MIN_CELL_PX, tableColCount, normalizeRect, mergesIntersect,
  adjustMergesOnInsertRow, adjustMergesOnDeleteRow, adjustMergesOnInsertCol, adjustMergesOnDeleteCol,
} from './table-utils';
import { continuesOnEnter, defaultAfter, splitAtStart, liftOnBackspace, isAtom, isList, clampDepth, atomSizeAttrs } from './block-specs';
import {
  normalizeInlines, deleteRange as delInline, insertText as insInline,
  splitInlines, sliceInlines, applyMark, rangeHasMark, marksAt,
} from './inlines';
import { splitGraphemes, nextBoundary, prevBoundary } from './grapheme';
import { nextWordBoundary, prevWordBoundary } from './word-boundary';
import { touchBlock, blockVersion } from './block-version';
import { clamp } from '../shared/util';
import { sanitizeUrl, UrlKind } from '../shared/url';

/**
 * 编辑模型核心：文档树 + 选区 + storedMarks + 撤销栈，承载所有编辑操作。
 * 位于 model 层，是 editor/render 层依赖的状态源（schema 之上、视图之下）。
 */

// —— 位置模型 ——
/** 文档内的光标/选区端点：块下标 + 块内 UTF-16 偏移。 @public */
export interface Pos { block: number; offset: number } // offset ∈ [0, blockTextLen]，UTF-16 单位

/** 比较两个位置的先后（块优先、再比 offset），返回 -1/0/1。 @public */
export function comparePos(a: Pos, b: Pos): -1 | 0 | 1 {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  if (a.offset !== b.offset) return a.offset < b.offset ? -1 : 1;
  return 0;
}

/**
 * 区间 [from,to) 删除后位置 p 的新坐标（调用方保证 p 不在区间内）：区间之前不变；
 * 区间之后随删除量前移（与 to 同块的 offset 折算到 from 块、更后的块号整体前移）。
 * 拖拽移动文本（{@link RichDoc.moveSelTo}）计算落点用。
 * @internal
 */
export function posAfterRangeDelete(p: Pos, from: Pos, to: Pos): Pos {
  if (comparePos(p, from) <= 0) return p;
  if (p.block === to.block) return { block: from.block, offset: from.offset + (p.offset - to.offset) };
  return { block: p.block - (to.block - from.block), offset: p.offset };
}

interface Snapshot {
  doc: Doc; anchor: Pos; focus: Pos;
  // 结构共享元数据：blocks[i] 克隆时的来源块 + 当时版本。restore 时来源块版本未变（=自快照后
  // 未被改动）即复用来源对象，保住布局缓存（WeakMap 按 Block 身份键）命中——undo/redo 增量化。
  sources: { src: Block; v: number }[];
}

// —— 连续输入合并（撤销粒度）——
/** 连续文本编辑合并的时间窗（ms）：相邻同类编辑在窗内且位置衔接则复用栈顶快照。 @public */
export const TEXT_MERGE_WINDOW_MS = 1000;
// 可合并的文本编辑种类：插入 / 退格 / 前向删除（互不合并；任何其它编辑断开合并）。
type TextEditKind = 'insert' | 'backspace' | 'del';
// 合并锚点：上一次文本编辑结束后的光标位置 + 时刻；下一次同类编辑自该位置衔接且在时间窗内才合并。
interface TextMergeState { kind: TextEditKind; block: number; offset: number; time: number }

// 媒体类原子块类型 → URL 白名单种类：写 attrs.src 前经 sanitizeUrl 过滤。
// 模型层是第一道防线（insert*/updateAtomAttrs 统一入口），覆盖层写 DOM 前还有第二道。
const URL_KIND_BY_BLOCK: Partial<Record<BlockType, UrlKind>> = {
  image: 'image', signature: 'signature', audio: 'audio', video: 'video', iframe: 'iframe', attachment: 'attachment',
};

/** 按块类型过滤 src：媒体类块经协议白名单校验，非法降级为空串；非媒体类块原样返回。 */
function safeSrcFor(type: BlockType, src: string): string {
  const kind = URL_KIND_BY_BLOCK[type];
  return kind ? (sanitizeUrl(src, kind) ?? '') : src;
}

/** 文档编辑模型：文档树 + 选区（anchor/focus）+ storedMarks + 撤销栈。 @public */
export class RichDoc {
  anchor: Pos = { block: 0, offset: 0 };
  focus: Pos = { block: 0, offset: 0 };
  storedMarks: Mark[] | null = null; // 折叠光标下「下次输入」的 marks（toggle/移动时设置/清空）
  /**
   * 可替换时钟（返回毫秒时间戳）：输入合并的时间窗判定用。默认系统时间；
   * 单测注入假时钟（`rd.now = () => fake`）以确定性验证合并/超窗分条。 @public
   */
  now: () => number = () => Date.now();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private mergeState: TextMergeState | null = null; // 连续输入合并锚点（null = 下次文本编辑必新增快照）
  // IME 组合 transient 通道：begin 时快照一次并记录锚点，update 全量替换组合区间不再快照，
  // end 收尾为单次可撤销提交。replacedSelection=begin 已实质改动文档（删选区/原子块旁建段），
  // 取消组合（end 空串）时据此决定是否弹出起始快照。
  private composition: { block: number; start: number; length: number; marks: Mark[]; replacedSelection: boolean } | null = null;

  constructor(public doc: Doc) {
    // 不变量：文档恒有 ≥1 块（空文档补一个空段落）。下游（focus 块取用 / docEnd / clamp）
    // 依赖 blockCount ≥ 1，否则 blockCount-1 = -1 会越界。与 setDoc/replaceDoc 的空文档回退一致。
    if (this.doc.blocks.length === 0) this.doc = { blocks: [mkBlock('paragraph', [])] };
  }

  /**
   * 取 focus 所在块（块下标已 clamp 到 [0, blockCount-1]，恒非空）。
   * 统一 focus 块取用入口，替代各处直接索引 `doc.blocks[focus.block]`（可能越界为 undefined）。
   * @public
   */
  focusBlock(): Block { return this.doc.blocks[clamp(this.focus.block, 0, this.blockCount - 1)]; }

  // —— 查询 ——
  /** 文档块总数。 @public */
  get blockCount(): number { return this.doc.blocks.length; }
  /** 取第 i 块。 @public */
  blockAt(i: number): Block { return this.doc.blocks[i]; }
  /** 第 i 块文本的 UTF-16 长度。 @public */
  blockLen(i: number): number { return blockTextLen(this.doc.blocks[i]); }
  /** 第 i 块的纯文本。 @public */
  blockStr(i: number): string { return blockText(this.doc.blocks[i]); }

  /** 把任意 Pos 夹回合法范围（块下标 ∈ 文档、offset ∈ 该块文本长度）。 @public */
  clamp(p: Pos): Pos {
    const b = clamp(p.block, 0, this.blockCount - 1);
    const o = clamp(p.offset, 0, this.blockLen(b));
    return { block: b, offset: o };
  }

  /** 选区是否折叠（anchor 与 focus 同点，即无选中文本）。 @public */
  get isCollapsed(): boolean { return comparePos(this.anchor, this.focus) === 0; }
  /** 把 anchor/focus 规范化为有序区间 {from ≤ to}。 @public */
  range(): { from: Pos; to: Pos } {
    return comparePos(this.anchor, this.focus) <= 0
      ? { from: this.anchor, to: this.focus }
      : { from: this.focus, to: this.anchor };
  }

  /** 设置 focus（可选 extend 保留 anchor 以扩展选区），并清空 storedMarks。选区跳变即断开输入合并。 @public */
  setSel(focus: Pos, extend = false): void {
    this.focus = this.clamp(focus);
    if (!extend) this.anchor = this.focus;
    this.storedMarks = null;
    this.mergeState = null;
  }

  // —— 光标移动（按 grapheme）——
  /** 光标右移一个 grapheme 簇，块尾则跨入下一块块首。 @public */
  posRight(p: Pos): Pos {
    const len = this.blockLen(p.block);
    if (p.offset < len) return { block: p.block, offset: nextBoundary(this.blockStr(p.block), p.offset) };
    if (p.block < this.blockCount - 1) return { block: p.block + 1, offset: 0 };
    return p;
  }
  /** 光标左移一个 grapheme 簇，块首则跨入上一块块尾。 @public */
  posLeft(p: Pos): Pos {
    if (p.offset > 0) return { block: p.block, offset: prevBoundary(this.blockStr(p.block), p.offset) };
    if (p.block > 0) return { block: p.block - 1, offset: this.blockLen(p.block - 1) };
    return p;
  }
  /** 光标右移到下一个「词尾」边界（⌥→，UAX#29 词粒度），块尾则跨入下一块块首。 @public */
  posWordRight(p: Pos): Pos {
    const len = this.blockLen(p.block);
    if (p.offset < len) return { block: p.block, offset: nextWordBoundary(this.blockStr(p.block), p.offset) };
    if (p.block < this.blockCount - 1) return { block: p.block + 1, offset: 0 };
    return p;
  }
  /** 光标左移到上一个「词首」边界（⌥←，UAX#29 词粒度），块首则跨入上一块块尾。 @public */
  posWordLeft(p: Pos): Pos {
    if (p.offset > 0) return { block: p.block, offset: prevWordBoundary(this.blockStr(p.block), p.offset) };
    if (p.block > 0) return { block: p.block - 1, offset: this.blockLen(p.block - 1) };
    return p;
  }
  /** 文档起点位置。 @public */
  docStart(): Pos { return { block: 0, offset: 0 }; }
  /** 文档终点位置（末块块尾）。 @public */
  docEnd(): Pos { return { block: this.blockCount - 1, offset: this.blockLen(this.blockCount - 1) }; }

  /** 全选：anchor 置文首、focus 置文末。 @public */
  selectAll(): void { this.anchor = this.docStart(); this.focus = this.docEnd(); this.storedMarks = null; this.mergeState = null; }

  /** 选区纯文本，跨块以换行连接；折叠时返回空串。 @public */
  selectedText(): string {
    if (this.isCollapsed) return '';
    const { from, to } = this.range();
    if (from.block === to.block) return this.blockStr(from.block).slice(from.offset, to.offset);
    const parts: string[] = [this.blockStr(from.block).slice(from.offset)];
    for (let b = from.block + 1; b < to.block; b++) parts.push(this.blockStr(b));
    parts.push(this.blockStr(to.block).slice(0, to.offset));
    return parts.join('\n');
  }

  /** 当前生效的行内 marks：折叠时取 storedMarks 或左继承，选区时取 from 处。 @public */
  activeMarks(): Mark[] {
    if (this.isCollapsed) {
      if (this.storedMarks) return this.storedMarks;
      const f = this.focus;
      return marksAt(this.doc.blocks[f.block].inlines, f.offset);
    }
    const { from } = this.range();
    return marksAt(this.doc.blocks[from.block].inlines, from.offset);
  }

  /** 返回给定位置所在链接的 href（无链接返回 null），供 ⌘/Ctrl+点击跳转用。 @public */
  linkHrefAt(pos: Pos): string | null {
    const blk = this.doc.blocks[pos.block];
    if (!blk) return null;
    const m = marksAt(blk.inlines, pos.offset).find((mk) => mk.type === 'link');
    return m?.attrs?.href ?? null;
  }
  /** 指定 mark 是否在整个选区生效（跨块要求每块命中段都含）。 @public */
  markActive(type: MarkType): boolean {
    if (this.isCollapsed) return this.activeMarks().some((m) => m.type === type);
    const { from, to } = this.range();
    if (from.block === to.block) return rangeHasMark(this.doc.blocks[from.block].inlines, from.offset, to.offset, type);
    // 跨块：要求每块命中段都含（首块自 from、末块至 to、中间整块）
    let ok = true;
    this.eachSelRange((blk, s, e) => { if (!rangeHasMark(blk.inlines, s, e, type)) ok = false; });
    return ok;
  }

  // —— 编辑 ——
  /**
   * 在光标处插入文本（有选区先删）；若停在原子块上则改为在其后新建段落输入。
   * 折叠光标的连续输入在时间窗内且位置衔接时合并为一条撤销记录（见 {@link TEXT_MERGE_WINDOW_MS}）。
   * @public
   */
  insertText(str: string): void {
    if (!str) return;
    // 在被选中的原子块（图片/公式/表格）上打字 → 在其后新建段落输入，而非把文字塞进原子块
    if (this.isCollapsed && isAtom(this.doc.blocks[this.focus.block].type)) {
      this.insertParagraphAfterAtom(str);
      return;
    }
    // 折叠光标的纯插入可与上一次插入合并；替换选区的插入恒为独立快照
    if (this.isCollapsed) this.snapshotTextEdit('insert');
    else this.snapshot();
    if (!this.isCollapsed) this.deleteSel();
    const f = this.focus;
    const marks = this.storedMarks ?? marksAt(this.doc.blocks[f.block].inlines, f.offset);
    const b = this.doc.blocks[f.block];
    touchBlock(b);
    b.inlines = insInline(b.inlines, f.offset, str, marks);
    const np = { block: f.block, offset: f.offset + str.length };
    this.anchor = this.focus = np;
    this.storedMarks = null;
    this.rememberTextEdit('insert');
  }

  /** 在当前原子块之后新建段落并输入文本（insertText 的原子块分支）。 */
  private insertParagraphAfterAtom(str: string): void {
    this.snapshot();
    const at = this.focus.block + 1;
    this.doc.blocks.splice(at, 0, mkBlock('paragraph', [mkText('')]));
    const b0 = this.doc.blocks[at];
    b0.inlines = insInline(b0.inlines, 0, str, []);
    this.anchor = this.focus = { block: at, offset: str.length };
    this.storedMarks = null;
  }

  // —— IME 组合（transient 编辑通道）——
  /** 是否处于 IME 组合中（transient 通道激活，组合串已临时入文档参与布局）。 @public */
  get isComposing(): boolean { return this.composition !== null; }

  /**
   * 开始 IME 组合：快照一次（整个组合 = 一条撤销记录），有选区先删，
   * 停在原子块上则在其后新建空段落承载组合；记录组合锚点与「打字应继承」的 marks。
   * @public
   */
  beginComposition(): void {
    if (this.composition) return;
    this.snapshot();
    let replacedSelection = false;
    if (!this.isCollapsed) { this.deleteSel(); replacedSelection = true; }
    if (isAtom(this.doc.blocks[this.focus.block].type)) {
      const at = this.focus.block + 1;
      this.doc.blocks.splice(at, 0, mkBlock('paragraph', [mkText('')]));
      this.anchor = this.focus = { block: at, offset: 0 };
      replacedSelection = true; // 文档已实质变化：取消组合也保留快照
    }
    const f = this.focus;
    const marks = this.storedMarks ?? marksAt(this.doc.blocks[f.block].inlines, f.offset);
    this.composition = { block: f.block, start: f.offset, length: 0, marks, replacedSelection };
  }

  /**
   * 组合中间态：把组合区间全量替换为 text（**不进撤销栈**），临时段带 underline mark
   * 走既有 decorations 管线画组合下划线；光标贴组合串末尾。非组合期调用无操作。
   * @public
   */
  updateComposition(text: string): void {
    const c = this.composition;
    if (!c) return;
    const b = this.doc.blocks[c.block];
    if (!b) { this.composition = null; return; }
    touchBlock(b);
    let inl = delInline(b.inlines, c.start, c.start + c.length);
    if (text) inl = insInline(inl, c.start, text, withMark(c.marks, { type: 'underline' }));
    b.inlines = inl;
    c.length = text.length;
    this.anchor = this.focus = { block: c.block, offset: c.start + text.length };
  }

  /**
   * 结束 IME 组合：组合区间替换为最终提交串（继承 begin 时 marks，去掉临时下划线），
   * 整个组合收尾为单次可撤销提交。提交空串且 begin 未实质改动文档（纯取消）时弹出
   * 起始快照，撤销栈不留无效记录。
   * @public
   */
  endComposition(text: string): void {
    const c = this.composition;
    if (!c) return;
    const b = this.doc.blocks[c.block];
    if (b) {
      touchBlock(b);
      let inl = delInline(b.inlines, c.start, c.start + c.length);
      if (text) inl = insInline(inl, c.start, text, c.marks);
      b.inlines = inl;
      this.anchor = this.focus = { block: c.block, offset: c.start + text.length };
    }
    this.composition = null;
    this.storedMarks = null;
    this.mergeState = null;
    if (!text && !c.replacedSelection) this.undoStack.pop();
  }

  /**
   * 退格：删选区/前一簇；块首样式块先降级为段落，原子前块先选中再删，否则与上块合并。
   * 块内连续退格在时间窗内合并为一条撤销记录（跨块/降级/选区删除恒为独立快照）。 @public
   */
  backspace(): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    const f = this.focus;
    if (f.offset > 0) {
      this.snapshotTextEdit('backspace');
      const prev = prevBoundary(this.blockStr(f.block), f.offset);
      const b = this.doc.blocks[f.block];
      touchBlock(b);
      b.inlines = delInline(b.inlines, prev, f.offset);
      this.anchor = this.focus = { block: f.block, offset: prev };
      this.rememberTextEdit('backspace');
      return;
    }
    // 块首：样式块（标题/列表/引用/代码）先降级为段落（lift），不与上一块合并（Notion/Docs 行为）
    const cur = this.doc.blocks[f.block];
    if (liftOnBackspace(cur.type)) {
      this.snapshot();
      this.liftToParagraph(cur);
      return;
    }
    if (f.block === 0) return; // 文首、普通段落块首：无操作
    // 上一块是原子块（图片/公式/表格）：不合并，改为选中它（首次退格选中，再退格删除）
    if (isAtom(this.doc.blocks[f.block - 1].type)) { this.setSel({ block: f.block - 1, offset: 0 }); return; }
    this.snapshot();
    this.mergeWithPrev(f.block);
  }

  /**
   * 前向删除：删选区/后一簇；块尾与下块合并，下块为原子则先选中。
   * 块内连续前删（光标原位）在时间窗内合并为一条撤销记录。 @public
   */
  del(): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    const f = this.focus;
    const len = this.blockLen(f.block);
    if (f.offset < len) {
      this.snapshotTextEdit('del');
      const next = nextBoundary(this.blockStr(f.block), f.offset);
      const b = this.doc.blocks[f.block];
      touchBlock(b);
      b.inlines = delInline(b.inlines, f.offset, next);
      this.anchor = this.focus = f;
      this.rememberTextEdit('del');
      return;
    }
    if (f.block < this.blockCount - 1) {
      // 下一块是原子块：不合并，改为选中它
      if (isAtom(this.doc.blocks[f.block + 1].type)) { this.setSel({ block: f.block + 1, offset: 0 }); return; }
      this.snapshot(); this.mergeWithPrev(f.block + 1);
    }
  }

  /**
   * 删除光标前一个词（⌥⌫）：删 [上一词首, 光标)，独立撤销记录（不与连续输入合并）。
   * 有选区删选区；停在原子块上删整块；块首退回 {@link backspace} 语义（降级/合并/选中原子）。
   * @public
   */
  deleteWordBack(): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    if (isAtom(this.doc.blocks[this.focus.block].type)) { this.deleteBlock(this.focus.block); return; }
    const f = this.focus;
    if (f.offset === 0) { this.backspace(); return; }
    this.snapshot();
    const start = prevWordBoundary(this.blockStr(f.block), f.offset);
    const b = this.doc.blocks[f.block];
    touchBlock(b);
    b.inlines = delInline(b.inlines, start, f.offset);
    this.anchor = this.focus = { block: f.block, offset: start };
    this.storedMarks = null;
  }

  /**
   * 前向删除光标后一个词（⌥Del）：删 [光标, 下一词尾)，独立撤销记录。
   * 有选区删选区；停在原子块上删整块；块尾退回 {@link del} 语义（合并/选中原子）。
   * @public
   */
  deleteWordForward(): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    if (isAtom(this.doc.blocks[this.focus.block].type)) { this.deleteBlock(this.focus.block); return; }
    const f = this.focus;
    if (f.offset >= this.blockLen(f.block)) { this.del(); return; }
    this.snapshot();
    const end = nextWordBoundary(this.blockStr(f.block), f.offset);
    const b = this.doc.blocks[f.block];
    touchBlock(b);
    b.inlines = delInline(b.inlines, f.offset, end);
    this.anchor = this.focus = f;
    this.storedMarks = null;
  }

  /**
   * 删至行首（⌘⌫）：删 [lineStart, 光标)，独立撤销记录。lineStart 为视觉行首的块内偏移
   * （由装配层从布局行取得；软换行下非 0），夹回 [0, 光标]。已在行首/无布局时无操作。
   * 有选区删选区；停在原子块上删整块。
   * @public
   */
  deleteToLineStart(lineStart: number): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    if (isAtom(this.doc.blocks[this.focus.block].type)) { this.deleteBlock(this.focus.block); return; }
    const f = this.focus;
    const start = clamp(lineStart, 0, f.offset);
    if (start >= f.offset) return;
    this.snapshot();
    const b = this.doc.blocks[f.block];
    touchBlock(b);
    b.inlines = delInline(b.inlines, start, f.offset);
    this.anchor = this.focus = { block: f.block, offset: start };
    this.storedMarks = null;
  }

  /** 回车：空列表项/代码行 → 降级段落；否则在光标处拆块。 @public */
  enter(): void {
    this.snapshot();
    if (!this.isCollapsed) this.deleteSel();
    const cur = this.doc.blocks[this.focus.block];
    // 空列表项/空代码行回车 → 跳出（降级为段落）
    if (continuesOnEnter(cur.type) && isBlockEmpty(cur)) {
      this.liftToParagraph(cur);
      return;
    }
    this.splitBlockAtCaret(cur);
  }

  /**
   * 抽取与块类型无关的「段落排版属性」（对齐/行距/段前后/缩进/字间距/书写方向），
   * 丢弃块类型专属字段（level/src/latex/rows/width/height/checked/depth/merges 等）。
   * 用于降级/拆分/切类型时跨块类型保留用户排版，避免无声丢失。
   */
  private preserveFormattingAttrs(attrs: BlockAttrs): BlockAttrs {
    const next: BlockAttrs = {};
    if (attrs.align !== undefined) next.align = attrs.align;
    if (attrs.lineHeight !== undefined) next.lineHeight = attrs.lineHeight;
    if (attrs.spaceBefore !== undefined) next.spaceBefore = attrs.spaceBefore;
    if (attrs.spaceAfter !== undefined) next.spaceAfter = attrs.spaceAfter;
    if (attrs.indent !== undefined) next.indent = attrs.indent;
    if (attrs.letterSpacing !== undefined) next.letterSpacing = attrs.letterSpacing;
    if (attrs.dir !== undefined) next.dir = attrs.dir;
    return next;
  }

  /** 把块就地降级为普通段落（保留与块类型无关的段落排版属性）。 */
  private liftToParagraph(blk: Block): void {
    touchBlock(blk);
    blk.type = 'paragraph';
    blk.attrs = this.preserveFormattingAttrs(blk.attrs);
  }

  /** 在光标处把当前块拆成两块；行首样式块（标题/引用）特殊处理：上方留空段、内容保持原类型下移。 */
  private splitBlockAtCaret(cur: Block): void {
    touchBlock(cur); // 两分支都改写 cur（inlines 换半 / 降级）；新块 WeakMap 天然 miss
    const f = this.focus;
    const originalType = cur.type;
    const originalAttrs: BlockAttrs = { ...cur.attrs };
    const [front, back] = splitInlines(cur.inlines, f.offset);

    if (f.offset === 0 && splitAtStart(originalType)) {
      cur.inlines = normalizeInlines(front); // 空
      this.liftToParagraph(cur);
      const contentBlock = mkBlock(originalType, normalizeInlines(back), originalAttrs);
      this.doc.blocks.splice(f.block + 1, 0, contentBlock);
      this.anchor = this.focus = { block: f.block + 1, offset: 0 };
      return;
    }

    cur.inlines = normalizeInlines(front);
    const secondType = continuesOnEnter(originalType) ? originalType : defaultAfter(originalType);
    const newBlock: Block = mkBlock(secondType, normalizeInlines(back), this.preserveFormattingAttrs(originalAttrs));
    this.doc.blocks.splice(f.block + 1, 0, newBlock);
    this.anchor = this.focus = { block: f.block + 1, offset: 0 };
  }

  /** 切换 mark：折叠时切 storedMarks，选区时按整段是否已生效统一加/去。 @public */
  toggleMark(type: MarkType, attrs?: Record<string, string>): void {
    const mark: Mark = attrs ? { type, attrs } : { type };
    if (this.isCollapsed) {
      // 折叠：切换 storedMarks（格式边界：断开连续输入合并，前后文字分属不同撤销单元）
      const cur = this.activeMarks();
      const has = cur.some((m) => m.type === type);
      this.storedMarks = has ? cur.filter((m) => m.type !== type) : [...cur.filter((m) => m.type !== type), mark];
      this.mergeState = null;
      return;
    }
    const add = !this.markActive(type);
    this.snapshot();
    this.mutSelRange((blk, s, e) => { blk.inlines = applyMark(blk.inlines, s, e, mark, add); });
  }

  /**
   * 切换互斥 mark：开启 type 时移除同组其余 mark（如上标↔下标互斥）。
   * 关闭 type 时与 toggleMark 等价。
   * @public
   */
  toggleExclusiveMark(type: MarkType, group: MarkType[]): void {
    const mark: Mark = { type };
    const turningOn = !this.markActive(type);
    const siblings = group.filter((g) => g !== type);
    if (this.isCollapsed) {
      const cur = this.activeMarks();
      const kept = cur.filter((m) => m.type !== type && !(turningOn && siblings.includes(m.type)));
      this.storedMarks = turningOn ? [...kept, mark] : kept;
      this.mergeState = null; // 格式边界断开输入合并
      return;
    }
    // 选区：单次快照内移除同组兄弟并加/去 type，避免拆成多步撤销
    this.snapshot();
    this.mutSelRange((blk, s, e) => {
      let inl = blk.inlines;
      if (turningOn) for (const other of siblings) inl = applyMark(inl, s, e, { type: other }, false);
      blk.inlines = applyMark(inl, s, e, mark, turningOn);
    });
  }

  /** 设置/更新某 mark（如颜色、链接 href），总是加或覆盖，区别于 toggle。 @public */
  setMark(type: MarkType, attrs?: Record<string, string>): void {
    const mark: Mark = attrs ? { type, attrs } : { type };
    if (this.isCollapsed) { this.storedMarks = withMark(this.activeMarks(), mark); this.mergeState = null; return; }
    this.applyToSel((inl, s, e) => applyMark(inl, s, e, mark, true));
  }
  /** 清除选区或 storedMarks 上指定 mark。 @public */
  clearMark(type: MarkType): void {
    if (this.isCollapsed) { this.storedMarks = withoutMark(this.activeMarks(), type); this.mergeState = null; return; }
    this.applyToSel((inl, s, e) => applyMark(inl, s, e, { type }, false));
  }
  /** 一键清除选区内全部行内 marks（单次撤销）。折叠时清空 storedMarks。 @public */
  clearMarks(): void {
    if (this.isCollapsed) { this.storedMarks = []; this.mergeState = null; return; }
    const all: MarkType[] = ['bold', 'italic', 'underline', 'strikethrough', 'highlight', 'code', 'color', 'link', 'fontFamily', 'fontSize', 'superscript', 'subscript'];
    this.applyToSel((inl, s, e) => all.reduce((acc, t) => applyMark(acc, s, e, { type: t }, false), inl));
  }
  private applyToSel(fn: (inl: Inline[], s: number, e: number) => Inline[]) {
    this.snapshot();
    this.mutSelRange((blk, s, e) => { blk.inlines = fn(blk.inlines, s, e); });
  }

  // —— 选区遍历公共方法（消除 6 处重复的 from.block..to.block + s/e 计算）——
  // 文本区段：对选区覆盖的每块回调 (blk, s, e)，s<e；用于行内 marks 读/写。
  private eachSelRange(fn: (blk: Block, s: number, e: number) => void) {
    const { from, to } = this.range();
    for (let b = from.block; b <= to.block; b++) {
      const blk = this.doc.blocks[b];
      const s = b === from.block ? from.offset : 0;
      const e = b === to.block ? to.offset : blockTextLen(blk);
      if (s < e) fn(blk, s, e);
    }
  }
  // 块级：对选区覆盖的每块回调 blk；用于块类型/对齐/方向等块属性。
  private eachSelBlock(fn: (blk: Block) => void) {
    const { from, to } = this.range();
    for (let b = from.block; b <= to.block; b++) fn(this.doc.blocks[b]);
  }
  // —— 写专用的选区遍历（块版本打点收口）——
  // eachSelRange/eachSelBlock 读写两用（markActive 只读），不能在其内部无脑 touch；
  // 所有「就地改写选区块」的写者一律换用以下封装：先 touchBlock 再回调，保证布局缓存失效。
  // 立规矩：text 块的任何新增外部写入路径必须经 RichDoc 方法（即经此处或显式 touchBlock）。
  private mutSelRange(fn: (blk: Block, s: number, e: number) => void) {
    this.eachSelRange((blk, s, e) => { touchBlock(blk); fn(blk, s, e); });
  }
  private mutSelBlock(fn: (blk: Block) => void) {
    this.eachSelBlock((blk) => { touchBlock(blk); fn(blk); });
  }

  /** 设选区各块的块类型（保留段落排版属性，合并传入 attrs；传入项优先）。 @public */
  setBlockType(type: BlockType, attrs: BlockAttrs = {}): void {
    this.snapshot();
    this.mutSelBlock((blk) => { blk.type = type; blk.attrs = { ...this.preserveFormattingAttrs(blk.attrs), ...attrs }; });
  }
  /** 切换任务列表项的勾选态（进撤销栈）；非 task_item 块无操作。 @public */
  toggleTaskChecked(block: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'task_item') return;
    this.snapshot();
    touchBlock(b);
    b.attrs = { ...b.attrs, checked: !b.attrs.checked };
  }
  /** 设选区各块的水平对齐（左/中/右/两端/分散）。 @public */
  setAlign(align: BlockAlign): void {
    this.snapshot();
    this.mutSelBlock((blk) => { blk.attrs.align = align; });
  }
  /** 设选区各块的行距倍数（1 / 1.15 / 1.5 / 2 等）。 @public */
  setLineHeight(mult: number): void {
    this.snapshot();
    this.mutSelBlock((blk) => { blk.attrs.lineHeight = mult; });
  }
  /** 设选区各块的段前间距（逻辑 px，覆盖块主题默认）。 @public */
  setSpaceBefore(px: number): void {
    this.snapshot();
    const v = Math.max(0, px);
    this.mutSelBlock((blk) => { blk.attrs.spaceBefore = v; });
  }
  /** 设选区各块的段后间距（逻辑 px，覆盖块主题默认）。 @public */
  setSpaceAfter(px: number): void {
    this.snapshot();
    const v = Math.max(0, px);
    this.mutSelBlock((blk) => { blk.attrs.spaceAfter = v; });
  }
  /** 设选区各块的左缩进（逻辑 px，覆盖块主题默认；夹到 ≥0）。 @public */
  setIndent(px: number): void {
    this.snapshot();
    const v = Math.max(0, px);
    this.mutSelBlock((blk) => { blk.attrs.indent = v; });
  }
  /**
   * 按步长增/减选区各块缩进（点击「增加/减少缩进」）。
   * 基线为各块当前生效缩进（attrs.indent ?? 0），夹到 ≥0。
   * @public
   */
  adjustIndent(deltaPx: number): void {
    this.snapshot();
    this.mutSelBlock((blk) => {
      const cur = blk.attrs.indent ?? 0;
      blk.attrs.indent = Math.max(0, cur + deltaPx);
    });
  }
  /** 设选区各块的字间距（逻辑 px，逐元素 advance 追加；可为 0）。 @public */
  setLetterSpacing(px: number): void {
    this.snapshot();
    const v = Math.max(0, px);
    this.mutSelBlock((blk) => { blk.attrs.letterSpacing = v; });
  }
  /** 设选区各块的书写方向（LTR/RTL）。 @public */
  setDir(dir: 'ltr' | 'rtl'): void {
    this.snapshot();
    this.mutSelBlock((blk) => { blk.attrs.dir = dir; });
  }

  /**
   * 嵌套加深：选区内每个列表/任务项 depth +delta 并夹回 [0, MAX_LIST_DEPTH]。
   * 仅作用于 list/task 块（其余块跳过）；选区内若无任何 list/task 块则不入撤销栈。
   * @public
   */
  private changeListDepth(delta: number): void {
    const targets: Block[] = [];
    this.eachSelBlock((blk) => { if (isList(blk.type)) targets.push(blk); });
    if (targets.length === 0) return;            // 无可缩进块：不快照、不变更
    this.snapshot();
    for (const blk of targets) { touchBlock(blk); blk.attrs.depth = clampDepth(clampDepth(blk.attrs.depth) + delta); }
  }
  /** 选区内列表/任务项嵌套加深一级（Tab）。depth 夹到 ≤ MAX_LIST_DEPTH。 @public */
  indentList(): void { this.changeListDepth(1); }
  /** 选区内列表/任务项嵌套减一级（Shift+Tab）。depth 夹到 ≥ 0。 @public */
  outdentList(): void { this.changeListDepth(-1); }
  /** 焦点块当前是否为列表/任务项（决定 Tab/Shift+Tab 是否走嵌套缩进）。 @public */
  focusIsList(): boolean {
    const b = this.doc.blocks[this.focus.block];
    return !!b && isList(b.type);
  }

  // 在光标所在块之后插入原子块
  private insertAtom(block: Block) {
    this.snapshot();
    block.attrs.id = genBlockId(); // 稳定 id：覆盖层按 id 缓存，undo 不丢编辑态
    const at = this.focus.block + 1;
    this.doc.blocks.splice(at, 0, block);
    this.anchor = this.focus = { block: at, offset: 0 };
  }
  /**
   * 在光标所在块之后插入一个目录（toc）块。
   * toc 是非原子块，内容（标题行）在布局时按全文 heading 动态生成，自身只存一个空内联占位。
   * @public
   */
  insertToc(): void {
    this.snapshot();
    const at = this.focus.block + 1;
    this.doc.blocks.splice(at, 0, mkBlock('toc', [mkText('')]));
    this.anchor = this.focus = { block: at, offset: 0 };
    this.storedMarks = null;
  }
  /** 在光标块后插入图片原子块（src 经协议白名单过滤，非法降级空串）。 @public */
  insertImage(src: string): void { this.insertAtom({ type: 'image', attrs: { src: safeSrcFor('image', src) }, inlines: [mkText('')] }); }
  /**
   * 在光标处插入「行内图片」（行内原子，占 1 个 UTF-16 offset，随文字断行/光标移动）。
   * 区别于 insertImage（块级图片，独占一行）。有选区先删；停在原子块上则在其后新建段落再插。
   * width/height 为可选显示尺寸（CSS px）；缺省时布局给固定 ~1.2em 方形占位。 @public
   */
  insertInlineImage(src: string, width?: number, height?: number): void {
    // 停在原子块（块级图片/公式/表格）上：行内图片无处安放 → 在其后新建段落承载
    if (this.isCollapsed && isAtomBlock(this.doc.blocks[this.focus.block].type)) {
      this.snapshot();
      const at = this.focus.block + 1;
      const atom = mkInlineAtom('image', { src, width, height });
      this.doc.blocks.splice(at, 0, mkBlock('paragraph', [atom]));
      this.anchor = this.focus = { block: at, offset: 1 };
      this.storedMarks = null;
      return;
    }
    this.snapshot();
    if (!this.isCollapsed) this.deleteSel();
    const f = this.focus;
    const b = this.doc.blocks[f.block];
    const atom = mkInlineAtom('image', { src, width, height });
    touchBlock(b);
    // 在 offset f.offset 处把行内序列拆两半并夹入原子（占 1 offset）
    const [front, back] = splitInlines(b.inlines, f.offset);
    b.inlines = normalizeInlines([...front, atom, ...back]);
    this.anchor = this.focus = { block: f.block, offset: f.offset + 1 };
    this.storedMarks = null;
  }
  /** 在光标块后插入公式原子块。 @public */
  insertFormula(latex: string): void { this.insertAtom({ type: 'formula', attrs: { latex }, inlines: [mkText('')] }); }
  /** 在光标块后插入音频原子块（媒体 URL，经协议白名单过滤）。 @public */
  insertAudio(src: string): void { this.insertAtom({ type: 'audio', attrs: { src: safeSrcFor('audio', src) }, inlines: [mkText('')] }); }
  /** 在光标块后插入视频原子块（媒体 URL 经协议白名单过滤，默认尺寸查覆盖层规格表，可缩放）。 @public */
  insertVideo(src: string): void { this.insertAtom({ type: 'video', attrs: { src: safeSrcFor('video', src), ...atomSizeAttrs('video') }, inlines: [mkText('')] }); }
  /** 在光标块后插入内嵌网页(iframe)原子块（URL 仅 http/https，默认尺寸查覆盖层规格表，可缩放）。 @public */
  insertIframe(src: string): void { this.insertAtom({ type: 'iframe', attrs: { src: safeSrcFor('iframe', src), ...atomSizeAttrs('iframe') }, inlines: [mkText('')] }); }
  /** 在光标块后插入附件原子块（文件 URL 经协议白名单过滤 + 可选文件名，渲染为可下载文件卡片）。 @public */
  insertAttachment(src: string, name?: string): void {
    const safe = safeSrcFor('attachment', src);
    this.insertAtom({ type: 'attachment', attrs: name ? { src: safe, name } : { src: safe }, inlines: [mkText('')] });
  }
  /**
   * 在光标块后插入电子签名原子块（手绘签名 PNG dataURL，经协议白名单过滤）。
   * 默认显示尺寸查覆盖层规格表、透明底、可缩放（类 image 覆盖层）。 @public
   */
  insertSignature(src: string): void {
    this.insertAtom({ type: 'signature', attrs: { src: safeSrcFor('signature', src), ...atomSizeAttrs('signature') }, inlines: [mkText('')] });
  }
  /**
   * 在光标块后插入印章原子块（印章文字 = 单位/公司名）。
   * 覆盖层据 attrs.text 渲染红色圆形公章 SVG，默认尺寸查覆盖层规格表、可缩放。 @public
   */
  insertSeal(text: string): void {
    this.insertAtom({ type: 'seal', attrs: { text, ...atomSizeAttrs('seal') }, inlines: [mkText('')] });
  }
  /**
   * 在光标块后插入可编辑浮动文本框原子块（v1 纯文本内容）。
   * 默认显示尺寸查覆盖层规格表、居左、可缩放（contenteditable 覆盖层，复用表格单元格内容同步模式）。 @public
   */
  insertTextbox(content = ''): void {
    this.insertAtom({ type: 'textbox', attrs: { content, ...atomSizeAttrs('textbox') }, inlines: [mkText('')] });
  }
  /** 在光标块后插入形状原子块（默认尺寸查覆盖层规格表，居左）。 @public */
  insertShape(kind: ShapeKind): void {
    // line/divider 默认更扁（视觉为一条线）；其余给规格表的方形/矩形画布默认高
    const isLineLike = kind === 'line' || kind === 'divider';
    const sz = atomSizeAttrs('shape');
    this.insertAtom({ type: 'shape', attrs: { shape: kind, width: sz.width, height: isLineLike ? 40 : sz.height }, inlines: [mkText('')] });
  }
  /** 在光标块后插入 rows×cols 空表格原子块（每格为空富单元格）。 @public */
  insertTable(rows: number, cols: number): void {
    const grid: TableCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => mkCell()));
    this.insertAtom({ type: 'table', attrs: { rows: grid }, inlines: [mkText('')] });
  }

  /**
   * 设置表格第 col 列宽（逻辑 px，夹到 ≥ MIN_CELL_PX），进撤销栈。
   * 缺省 colWidths 时先按当前列数补齐再写入（避免稀疏数组），列号越界则忽略。 @public
   */
  setColWidth(block: number, col: number, w: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const cols = tableColCount(b.attrs.rows);
    if (col < 0 || col >= cols) return;
    this.snapshot();
    touchBlock(b);
    const widths = (b.attrs.colWidths ?? []).slice(0, cols);
    while (widths.length < cols) widths.push(0);
    widths[col] = Math.max(MIN_CELL_PX, Math.round(w));
    b.attrs = { ...b.attrs, colWidths: widths };
  }

  /**
   * 设置表格第 row 行高（逻辑 px，夹到 ≥ MIN_CELL_PX），进撤销栈。
   * 缺省 rowHeights 时先按当前行数补齐再写入；行号越界则忽略。 @public
   */
  setRowHeight(block: number, row: number, h: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const rowCount = b.attrs.rows.length;
    if (row < 0 || row >= rowCount) return;
    this.snapshot();
    touchBlock(b);
    const heights = (b.attrs.rowHeights ?? []).slice(0, rowCount);
    while (heights.length < rowCount) heights.push(0);
    heights[row] = Math.max(MIN_CELL_PX, Math.round(h));
    b.attrs = { ...b.attrs, rowHeights: heights };
  }

  /**
   * 合并表格中 (r0,c0)..(r1,c1) 包围的矩形单元格为一个锚点（左上角）。
   * 规范化矩形（min/max 排序）、clamp 到表格范围；锚点内容 = 矩形内所有非空单元格的
   * inlines 按行优先以单个空格 TextRun 连接（保留各自 marks/换行），被覆盖格置为空单元格。
   * 判空依据 {@link isCellEmpty}（纯文本全空白**且**无行内原子才算空）：含行内原子的格子
   * 即便无可见文字也承载内容，不得静默丢弃。
   * 若新矩形与既有合并区相交，则先移除被卷入的旧合并区（避免重叠冲突）。
   * 矩形退化为单格（1×1）时不记录合并。进撤销栈。 @public
   */
  mergeCells(block: number, r0: number, c0: number, r1: number, c1: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const rows = b.attrs.rows;
    const rect = normalizeRect(r0, c0, r1, c1, rows.length, tableColCount(rows));
    if (!rect) return;
    if (rect.rowspan === 1 && rect.colspan === 1) return; // 单格：无需合并
    this.snapshot();
    touchBlock(b);
    // 逐 cell 深拷后再改：被卷入格的 inlines 移交给锚点，不与原 cell 共享引用
    const nextRows = rows.map((row) => row.map(cloneCell));
    // 锚点内容 = 矩形内非空（isCellEmpty 为 false：有非空白文本或含行内原子）单元格的
    // inlines 以空格 TextRun 连接，其余格清空
    const parts: Inline[][] = [];
    for (let r = rect.r; r < rect.r + rect.rowspan; r++) {
      for (let c = rect.c; c < rect.c + rect.colspan; c++) {
        const cl = nextRows[r]?.[c];
        if (cl && !isCellEmpty(cl)) parts.push(cl.inlines);
        if (!(r === rect.r && c === rect.c) && nextRows[r]) nextRows[r][c] = mkCell(); // 参差行的空洞一并补为空格子

      }
    }
    const joined: Inline[] = [];
    parts.forEach((p, i) => { if (i > 0) joined.push(mkText(' ')); joined.push(...p); });
    nextRows[rect.r][rect.c] = { inlines: normalizeInlines(joined) };
    // 移除与新矩形相交的旧合并区，再追加新区（保持 merges 互不重叠的不变量）
    const kept = (b.attrs.merges ?? []).filter((m) => !mergesIntersect(m, rect));
    b.attrs = { ...b.attrs, rows: nextRows, merges: [...kept, rect] };
  }

  /**
   * 拆分锚点单元格 (r,c)：移除以该格为锚点的合并区（其余格恢复独立渲染）。
   * 非锚点格或无合并区则无操作（不进撤销栈）。被覆盖格内容保持为空（合并时已清空）。 @public
   */
  splitCell(block: number, r: number, c: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.merges) return;
    const merges = b.attrs.merges;
    if (!merges.some((m) => m.r === r && m.c === c)) return; // 非锚点：无操作
    this.snapshot();
    touchBlock(b);
    b.attrs = { ...b.attrs, merges: merges.filter((m) => !(m.r === r && m.c === c)) };
  }

  /**
   * 在表格第 `atRow` 行的上方/下方插入一行空单元格，进撤销栈。
   * 新行各格为空富单元格、列数对齐当前列数；rowHeights 对应位置插一个 0（auto）；
   * merges 锚点/跨度随插入位后移或撑高（{@link adjustMergesOnInsertRow}）。`atRow` 越界则忽略。 @public
   */
  insertRow(block: number, atRow: number, where: 'above' | 'below'): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const rows = b.attrs.rows;
    if (atRow < 0 || atRow >= rows.length) return;
    const at = where === 'below' ? atRow + 1 : atRow;
    this.snapshot();
    touchBlock(b);
    const cols = tableColCount(rows);
    const nextRows = rows.map((row) => row.slice());
    nextRows.splice(at, 0, Array.from({ length: cols }, () => mkCell()));
    const next: BlockAttrs = { ...b.attrs, rows: nextRows };
    if (b.attrs.rowHeights) { const rh = b.attrs.rowHeights.slice(); rh.splice(at, 0, 0); next.rowHeights = rh; }
    if (b.attrs.merges) next.merges = adjustMergesOnInsertRow(b.attrs.merges, at);
    b.attrs = next;
  }

  /**
   * 删除表格第 `row` 行，进撤销栈（至少保留 1 行，删到最后一行不允许）。
   * rowHeights 对应位置移除；merges 随删除收缩跨度或移除被删尽的合并区
   * （{@link adjustMergesOnDeleteRow}）。`row` 越界或仅剩 1 行则忽略。 @public
   */
  deleteRow(block: number, row: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const rows = b.attrs.rows;
    if (row < 0 || row >= rows.length || rows.length <= 1) return; // 最少 1 行
    this.snapshot();
    touchBlock(b);
    const nextRows = rows.map((r) => r.slice());
    nextRows.splice(row, 1);
    const next: BlockAttrs = { ...b.attrs, rows: nextRows };
    if (b.attrs.rowHeights) { const rh = b.attrs.rowHeights.slice(); rh.splice(row, 1); next.rowHeights = rh; }
    if (b.attrs.merges) next.merges = adjustMergesOnDeleteRow(b.attrs.merges, row);
    b.attrs = next;
  }

  /**
   * 在表格第 `atCol` 列的左侧/右侧插入一列空单元格，进撤销栈。
   * 每行对应位置插一个空富单元格；colWidths 对应位置插一个 0（auto）；
   * merges 锚点/跨度随插入位后移或撑宽（{@link adjustMergesOnInsertCol}）。`atCol` 越界则忽略。 @public
   */
  insertCol(block: number, atCol: number, where: 'left' | 'right'): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const rows = b.attrs.rows;
    const cols = tableColCount(rows);
    if (atCol < 0 || atCol >= cols) return;
    const at = where === 'right' ? atCol + 1 : atCol;
    this.snapshot();
    touchBlock(b);
    // 各行补齐到 cols 后再插入，避免参差行使插入列错位
    const nextRows = rows.map((row) => {
      const padded = row.slice();
      while (padded.length < cols) padded.push(mkCell());
      padded.splice(at, 0, mkCell());
      return padded;
    });
    const next: BlockAttrs = { ...b.attrs, rows: nextRows };
    if (b.attrs.colWidths) { const cw = b.attrs.colWidths.slice(); cw.splice(at, 0, 0); next.colWidths = cw; }
    if (b.attrs.merges) next.merges = adjustMergesOnInsertCol(b.attrs.merges, at);
    b.attrs = next;
  }

  /**
   * 删除表格第 `col` 列，进撤销栈（至少保留 1 列，删到最后一列不允许）。
   * 每行对应位置移除；colWidths 对应位置移除；merges 随删除收缩跨度或移除被删尽的合并区
   * （{@link adjustMergesOnDeleteCol}）。`col` 越界或仅剩 1 列则忽略。 @public
   */
  deleteCol(block: number, col: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'table' || !b.attrs.rows) return;
    const rows = b.attrs.rows;
    const cols = tableColCount(rows);
    if (col < 0 || col >= cols || cols <= 1) return; // 最少 1 列
    this.snapshot();
    touchBlock(b);
    const nextRows = rows.map((row) => {
      const padded = row.slice();
      while (padded.length < cols) padded.push(mkCell());
      padded.splice(col, 1);
      return padded;
    });
    const next: BlockAttrs = { ...b.attrs, rows: nextRows };
    if (b.attrs.colWidths) { const cw = b.attrs.colWidths.slice(); cw.splice(col, 1); next.colWidths = cw; }
    if (b.attrs.merges) next.merges = adjustMergesOnDeleteCol(b.attrs.merges, col);
    b.attrs = next;
  }

  /** 设置图片显示尺寸（CSS px），进撤销栈（缩放手柄提交时调用）。 @public */
  setImageSize(block: number, width: number, height: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'image') return;
    this.snapshot();
    touchBlock(b);
    b.attrs = { ...b.attrs, width: Math.round(width), height: Math.round(height) };
  }

  /**
   * 通用更新某原子块的内容属性（合并到现有 attrs），进撤销栈。
   * 双击原子块「再编辑」时调用：弹层取新值后按 kind 写对应字段（如公式 latex、印章 text、媒体 src）。
   * 浅合并（`{ ...attrs, ...partial }`）保留尺寸/id 等其余属性；块号越界或非原子块则忽略。
   * 安全：`partial.src` 按块类型经协议白名单过滤（与 insert* 同一道模型层防线），非法降级空串。
   * @param block - 目标块下标
   * @param partial - 要合并的属性子集（仅含本次改动的字段）
   * @public
   */
  updateAtomAttrs(block: number, partial: Partial<BlockAttrs>): void {
    const b = this.doc.blocks[block];
    if (!b || !isAtomBlock(b.type)) return;
    const next = partial.src !== undefined ? { ...partial, src: safeSrcFor(b.type, partial.src) } : partial;
    this.snapshot();
    touchBlock(b);
    b.attrs = { ...b.attrs, ...next };
  }
  /** 把块从 from 移到「插入间隙」to（0=首块前，blockCount=末块后），进撤销栈。 @public */
  moveBlock(from: number, to: number): void {
    const n = this.blockCount;
    if (from < 0 || from >= n) return;
    let t = clamp(to, 0, n);
    if (t === from || t === from + 1) return; // 原位 → 无操作
    this.snapshot();
    const [blk] = this.doc.blocks.splice(from, 1);
    if (t > from) t -= 1; // 移除后右侧索引左移一位
    this.doc.blocks.splice(t, 0, blk);
    this.anchor = this.focus = { block: t, offset: 0 };
  }
  /**
   * 拖拽移动文本（最小版）：把当前非折叠选区的文本（保 marks 与行内原子）移动到 target，
   * 单次撤销（undo 一步回到拖动前），移动后选中落点处的被移文本。
   * 不动作返回 false 的情形：选区折叠 / 落点在选区内（含端点）/ 选区或落点涉及原子块。
   * 已知最小版语义：落点为空段落时承接片段首块类型（insertFragment 既有行为）。
   * @public
   */
  moveSelTo(target: Pos): boolean {
    if (this.isCollapsed) return false;
    const t = this.clamp(target);
    const { from, to } = this.range();
    if (comparePos(t, from) >= 0 && comparePos(t, to) <= 0) return false;
    for (let b = from.block; b <= to.block; b++) if (isAtomBlock(this.doc.blocks[b].type)) return false;
    if (isAtomBlock(this.doc.blocks[t.block].type)) return false;
    // 提取选区片段（首末块按 offset 切行内、中间块整块；cloneDoc 深拷断共享引用）
    const blocks: Block[] = [];
    for (let bi = from.block; bi <= to.block; bi++) {
      const b = this.doc.blocks[bi];
      const s = bi === from.block ? from.offset : 0;
      const e = bi === to.block ? to.offset : blockTextLen(b);
      blocks.push(mkBlock(b.type, sliceInlines(b.inlines, s, e), cloneBlockAttrs(b.attrs)));
    }
    const frag = cloneDoc({ blocks });
    this.snapshot(); // 唯一保留的快照：拖动前全量状态
    this.deleteSel();
    const dst = posAfterRangeDelete(t, from, to);
    this.anchor = this.focus = this.clamp(dst);
    // insertFragment 入口必推恰一份快照（frag 非空）且不再多推 → 中间态恒在栈顶；
    // 按栈顶弹（而非按下标 splice：栈满 200 时 pushUndo 会 shift，使下标失准）保单次 undo 直回拖动前
    this.insertFragment(frag);
    this.undoStack.pop();
    this.anchor = this.clamp(dst); // 选中被移动文本（focus 已停在片段尾）
    return true;
  }

  /** 删除整块（用于删被选中的原子块）；删空则补一空段落，光标夹回合法块。 @public */
  deleteBlock(i: number): void {
    if (i < 0 || i >= this.blockCount) return;
    this.snapshot();
    this.doc.blocks.splice(i, 1);
    if (this.doc.blocks.length === 0) this.doc.blocks.push(mkBlock('paragraph', []));
    const nb = clamp(i, 0, this.blockCount - 1);
    this.anchor = this.focus = { block: nb, offset: 0 };
  }

  /** 整文档替换（如导入 Markdown/HTML）：进撤销栈，光标置文末。空文档回退为单空段落。 @public */
  setDoc(doc: Doc): void {
    this.snapshot();
    this.doc = doc.blocks.length ? doc : { blocks: [mkBlock('paragraph', [])] };
    this.anchor = this.focus = this.docEnd();
    this.storedMarks = null;
  }

  /**
   * 整文档替换并把光标归位到文首（用于应用模板）：进撤销栈、深拷贝传入文档、
   * 折叠选区置 {block:0, offset:0}。空文档回退为单空段落。区别于 setDoc（置文末）。
   * @public
   */
  replaceDoc(doc: Doc): void {
    this.snapshot();
    const next = doc.blocks.length ? cloneDoc(doc) : { blocks: [mkBlock('paragraph', [])] };
    this.doc = next;
    this.anchor = this.focus = this.docStart();
    this.storedMarks = null;
  }

  /**
   * 替换单个块内区间 [start,end) 为 str（查找/替换的「替换当前」），单次撤销。
   * 替换文本继承区间首字符处的 marks（{@link replaceAllTextRanges} 的单区间便捷封装）。
   * @public
   */
  replaceTextRange(block: number, start: number, end: number, str: string): void {
    this.replaceAllTextRanges([{ block, start, end }], str);
  }

  /**
   * 批量替换多个块内区间为同一 str（查找/替换的「全部替换」），单次撤销。
   * 区间须互不重叠（findMatches 产物天然满足）；按 (block,start) 升序逐块替换并累计偏移修正。
   * 每个区间的替换文本继承该区间首字符处的 marks；原子块/越界区间跳过。
   * 光标落在文档序最后一个替换的末尾。
   * @public
   */
  replaceAllTextRanges(ranges: { block: number; start: number; end: number }[], str: string): void {
    const valid = ranges.filter((r) => {
      const b = this.doc.blocks[r.block];
      return !!b && !isAtomBlock(b.type) && r.start < r.end && r.end <= blockTextLen(b);
    });
    if (valid.length === 0) return;
    this.snapshot();
    const sorted = [...valid].sort((a, b) => a.block - b.block || a.start - b.start);
    let curBlock = -1, delta = 0;
    let last: Pos = this.focus;
    for (const r of sorted) {
      if (r.block !== curBlock) { curBlock = r.block; delta = 0; }
      const b = this.doc.blocks[r.block];
      const len = blockTextLen(b);
      const s = clamp(r.start + delta, 0, len);
      const e = clamp(r.end + delta, 0, len);
      if (s >= e) continue;
      touchBlock(b);
      // 替换文本继承区间首字符的 marks（行内原子无 marks → 空）
      const first = sliceInlines(b.inlines, s, e)[0];
      const marks = first && !isInlineAtom(first) ? first.marks : [];
      let inl = delInline(b.inlines, s, e);
      if (str) inl = insInline(inl, s, str, marks);
      b.inlines = inl;
      delta += str.length - (r.end - r.start);
      last = { block: r.block, offset: s + str.length };
    }
    this.anchor = this.focus = this.clamp(last);
    this.storedMarks = null;
  }

  /**
   * 在光标处插入文档片段（富文本粘贴的核心原语），单次撤销。有选区先删。
   * 单文本块片段：行内并入当前块（保片段 marks/行内原子，不改当前块类型）；
   * 多块片段：拆当前块，首块行内并入前半、其余块依序插入、尾块承接后半；
   * 首/尾块为原子块则不并入、独立成块（尾部另起段落承接后半）。
   * 当前块为空段落时整体采用片段首块的类型/属性（标题/列表粘贴不降级）。
   * 光标停在原子块上：整片段插到其后。片段深拷入文档，原子块换新 id（覆盖层缓存不串）。
   * @public
   */
  insertFragment(frag: Doc): void {
    const src = frag.blocks;
    if (src.length === 0) return;
    this.snapshot();
    if (!this.isCollapsed) this.deleteSel();
    const blocks = cloneDoc(frag).blocks;
    for (const blk of blocks) if (isAtomBlock(blk.type)) blk.attrs.id = genBlockId();
    const f = this.focus;
    const cur = this.doc.blocks[f.block];
    // 光标停在原子块上：整片段插到其后（不与原子块合并）
    if (isAtom(cur.type)) {
      this.doc.blocks.splice(f.block + 1, 0, ...blocks);
      const lastIdx = f.block + blocks.length;
      this.anchor = this.focus = { block: lastIdx, offset: blockTextLen(this.doc.blocks[lastIdx]) };
      this.storedMarks = null;
      return;
    }
    const first = blocks[0];
    // 空段落承接：当前块为空段落且片段首块非原子 → 整体采用首块类型/属性
    if (cur.type === 'paragraph' && isBlockEmpty(cur) && !isAtom(first.type)) {
      cur.type = first.type;
      cur.attrs = first.attrs; // blocks 已深拷，独占引用
    }
    if (blocks.length === 1 && !isAtom(first.type)) {
      // 单文本块：行内并入当前块
      touchBlock(cur);
      const [front, back] = splitInlines(cur.inlines, f.offset);
      cur.inlines = normalizeInlines([...front, ...first.inlines, ...back]);
      this.anchor = this.focus = { block: f.block, offset: f.offset + blockTextLen(first) };
      this.storedMarks = null;
      return;
    }
    // 多块/含原子：拆当前块，首块并入前半（原子则独立成块），其余依序插入，尾块承接后半
    touchBlock(cur);
    const [front, back] = splitInlines(cur.inlines, f.offset);
    const insert: Block[] = [];
    if (isAtom(first.type)) { cur.inlines = normalizeInlines(front); insert.push(first); }
    else cur.inlines = normalizeInlines([...front, ...first.inlines]);
    for (let i = 1; i < blocks.length; i++) insert.push(blocks[i]);
    let caret: Pos;
    const lastBlk = insert.length ? insert[insert.length - 1] : cur;
    if (isAtom(lastBlk.type)) {
      insert.push(mkBlock('paragraph', normalizeInlines(back)));
      caret = { block: f.block + insert.length, offset: 0 };
    } else if (insert.length === 0) {
      // 仅首块且非原子（blocks.length===1 已在上分支处理，此处仅防御）
      caret = { block: f.block, offset: blockTextLen(cur) };
      cur.inlines = normalizeInlines([...cur.inlines, ...back]);
    } else {
      const lastLen = blockTextLen(lastBlk);
      lastBlk.inlines = normalizeInlines([...lastBlk.inlines, ...back]);
      caret = { block: f.block + insert.length, offset: lastLen };
    }
    this.doc.blocks.splice(f.block + 1, 0, ...insert);
    this.anchor = this.focus = this.clamp(caret);
    this.storedMarks = null;
  }

  /** 回填覆盖层实测高度（不进撤销栈）；高度有变返回 true，否则 false。 @public */
  setMeasuredHeight(block: number, h: number): boolean {
    const b = this.doc.blocks[block];
    if (b && b.attrs.measuredH !== h) { touchBlock(b); b.attrs.measuredH = h; return true; }
    return false;
  }

  // —— 内部 ——
  private deleteSel() {
    const { from, to } = this.range();
    if (comparePos(from, to) === 0) return;
    if (from.block === to.block) {
      const b = this.doc.blocks[from.block];
      touchBlock(b);
      b.inlines = delInline(b.inlines, from.offset, to.offset);
    } else {
      const first = this.doc.blocks[from.block];
      const last = this.doc.blocks[to.block];
      touchBlock(first);
      const merged = normalizeInlines([
        ...splitInlines(first.inlines, from.offset)[0],
        ...splitInlines(last.inlines, to.offset)[1],
      ]);
      first.inlines = merged; // 继承首块 type/attrs
      this.doc.blocks.splice(from.block + 1, to.block - from.block);
    }
    this.anchor = this.focus = from;
    this.storedMarks = null;
  }

  // 把 block i 合并进 i-1（i-1 存活，继承其 type/attrs）
  private mergeWithPrev(i: number) {
    const prev = this.doc.blocks[i - 1];
    const cur = this.doc.blocks[i];
    const caretOffset = blockTextLen(prev);
    touchBlock(prev);
    prev.inlines = normalizeInlines([...prev.inlines, ...cur.inlines]);
    this.doc.blocks.splice(i, 1);
    this.anchor = this.focus = { block: i - 1, offset: caretOffset };
  }

  // —— 撤销/重做 ——
  // 通用快照：任何非文本编辑（块操作/选区删除/表格/属性…）必新增快照并断开输入合并。
  private snapshot() {
    this.mergeState = null;
    this.pushUndo();
  }
  // 推入撤销快照（深拷 + 结构共享元数据 + 清空重做栈 + 栈上限 200）。
  private pushUndo() {
    this.undoStack.push(this.capture());
    this.redoStack.length = 0;
    if (this.undoStack.length > 200) this.undoStack.shift();
  }
  /**
   * 文本编辑专用快照（输入合并）：与上一次文本编辑同类（插入/退格/前删互不合并）、同块、
   * 位置衔接（光标恰停在上次编辑的结束位置）且在 {@link TEXT_MERGE_WINDOW_MS} 时间窗内时
   * 复用栈顶快照（不新增记录，一次 undo 回滚整段连续输入）；否则推入新快照。
   * 选区跳变（setSel/selectAll）、任何非文本编辑、undo/redo、超窗均已把 mergeState 置 null → 必不合并。
   */
  private snapshotTextEdit(kind: TextEditKind): void {
    const m = this.mergeState;
    const f = this.focus;
    const mergeable = m !== null && m.kind === kind && m.block === f.block && m.offset === f.offset
      && this.now() - m.time <= TEXT_MERGE_WINDOW_MS
      && this.undoStack.length > 0 && this.redoStack.length === 0;
    if (!mergeable) this.pushUndo();
  }
  // 记录本次文本编辑的合并锚点（编辑后的光标位置 + 当前时刻）。
  private rememberTextEdit(kind: TextEditKind): void {
    this.mergeState = { kind, block: this.focus.block, offset: this.focus.offset, time: this.now() };
  }
  /** 主动断开连续输入合并（粘贴等命令边界调用）：下一次文本编辑必新增独立快照。 @public */
  breakUndoCoalescing(): void { this.mergeState = null; }
  /** 撤销栈是否非空。 @public */
  get canUndo(): boolean { return this.undoStack.length > 0; }
  /** 重做栈是否非空。 @public */
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** 撤销一步：当前态入重做栈，恢复栈顶快照。 @public */
  undo(): void { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.capture()); this.restore(s); }
  /** 重做一步：当前态入撤销栈，恢复栈顶快照。 @public */
  redo(): void { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.capture()); this.restore(s); }
  private capture(): Snapshot {
    return {
      doc: cloneDoc(this.doc), anchor: { ...this.anchor }, focus: { ...this.focus },
      sources: this.doc.blocks.map((b) => ({ src: b, v: blockVersion(b) })),
    };
  }
  // 恢复快照（undo/redo 增量化：结构共享）。快照块的克隆源若自快照以来未被改动
  //（blockVersion 相等——文本块全部写路径必经 touchBlock，见 mutSelRange/mutSelBlock 处「立规矩」），
  // 直接复用当前存活的源对象：布局缓存按 Block 身份命中，undo 只为真正回退的块付整形/重排代价
  //（修复：旧实现整体换入克隆块 → WeakMap 全 miss → 每次 ⌘Z 全文档重排）。
  // 原子块（表格/文本框等）不复用：覆盖层持活引用就地回写 attrs（单元格文本/textbox content）
  // 不经 touchBlock，版本相等不充分；且表格 DOM 的回退重建正确性依赖换块身份（canSkipTableRebuild）。
  private restore(s: Snapshot) {
    const blocks = s.doc.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const rec = s.sources[i];
      if (rec && !isAtomBlock(blocks[i].type) && blockVersion(rec.src) === rec.v) blocks[i] = rec.src;
    }
    this.doc = s.doc; this.anchor = this.clamp(s.anchor); this.focus = this.clamp(s.focus); this.storedMarks = null; this.mergeState = null;
  }
}

/** 转发 grapheme 簇拆分工具，便于布局/命中从模型层统一引入。 @public */
export { splitGraphemes };

// 表格纯工具（MIN_CELL_PX/tableColCount/normalizeRect/mergesIntersect + 增删行列的 merges 调整）已下沉至
// ./table-utils；此处再导出，保持历史 import 路径（`from './rich-document'`）不破坏（model 内部已直接 import 自 ./table-utils）。
export {
  MIN_CELL_PX, tableColCount, normalizeRect, mergesIntersect,
  adjustMergesOnInsertRow, adjustMergesOnDeleteRow, adjustMergesOnInsertCol, adjustMergesOnDeleteCol,
};
