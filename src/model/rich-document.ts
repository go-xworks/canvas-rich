import {
  Doc, Block, BlockType, BlockAttrs, Mark, MarkType, Inline,
  block as mkBlock, text as mkText, blockText, blockTextLen, isBlockEmpty, cloneDoc, withMark, withoutMark, genBlockId,
} from './schema';
import { continuesOnEnter, defaultAfter, splitAtStart, liftOnBackspace, isAtom } from './block-specs';
import {
  normalizeInlines, deleteRange as delInline, insertText as insInline,
  splitInlines, applyMark, rangeHasMark, marksAt,
} from './inlines';
import { splitGraphemes, nextBoundary, prevBoundary } from './grapheme';
import { clamp } from '../shared/util';

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

interface Snapshot { doc: Doc; anchor: Pos; focus: Pos }

/** 文档编辑模型：文档树 + 选区（anchor/focus）+ storedMarks + 撤销栈。 @public */
export class RichDoc {
  anchor: Pos = { block: 0, offset: 0 };
  focus: Pos = { block: 0, offset: 0 };
  storedMarks: Mark[] | null = null; // 折叠光标下「下次输入」的 marks（toggle/移动时设置/清空）
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  constructor(public doc: Doc) {}

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

  /** 设置 focus（可选 extend 保留 anchor 以扩展选区），并清空 storedMarks。 @public */
  setSel(focus: Pos, extend = false): void {
    this.focus = this.clamp(focus);
    if (!extend) this.anchor = this.focus;
    this.storedMarks = null;
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
  /** 文档起点位置。 @public */
  docStart(): Pos { return { block: 0, offset: 0 }; }
  /** 文档终点位置（末块块尾）。 @public */
  docEnd(): Pos { return { block: this.blockCount - 1, offset: this.blockLen(this.blockCount - 1) }; }

  /** 全选：anchor 置文首、focus 置文末。 @public */
  selectAll(): void { this.anchor = this.docStart(); this.focus = this.docEnd(); this.storedMarks = null; }

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
  /** 在光标处插入文本（有选区先删）；若停在原子块上则改为在其后新建段落输入。 @public */
  insertText(str: string): void {
    if (!str) return;
    // 在被选中的原子块（图片/公式/表格）上打字 → 在其后新建段落输入，而非把文字塞进原子块
    if (this.isCollapsed && isAtom(this.doc.blocks[this.focus.block].type)) {
      this.insertParagraphAfterAtom(str);
      return;
    }
    this.snapshot();
    if (!this.isCollapsed) this.deleteSel();
    const f = this.focus;
    const marks = this.storedMarks ?? marksAt(this.doc.blocks[f.block].inlines, f.offset);
    const b = this.doc.blocks[f.block];
    b.inlines = insInline(b.inlines, f.offset, str, marks);
    const np = { block: f.block, offset: f.offset + str.length };
    this.anchor = this.focus = np;
    this.storedMarks = null;
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

  /** 退格：删选区/前一簇；块首样式块先降级为段落，原子前块先选中再删，否则与上块合并。 @public */
  backspace(): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    const f = this.focus;
    if (f.offset > 0) {
      this.snapshot();
      const prev = prevBoundary(this.blockStr(f.block), f.offset);
      const b = this.doc.blocks[f.block];
      b.inlines = delInline(b.inlines, prev, f.offset);
      this.anchor = this.focus = { block: f.block, offset: prev };
      return;
    }
    // 块首：样式块（标题/列表/引用/代码）先降级为段落（lift），不与上一块合并（Notion/Docs 行为）
    const cur = this.doc.blocks[f.block];
    if (liftOnBackspace(cur.type)) {
      this.snapshot();
      cur.type = 'paragraph'; cur.attrs = { align: cur.attrs.align };
      return;
    }
    if (f.block === 0) return; // 文首、普通段落块首：无操作
    // 上一块是原子块（图片/公式/表格）：不合并，改为选中它（首次退格选中，再退格删除）
    if (isAtom(this.doc.blocks[f.block - 1].type)) { this.setSel({ block: f.block - 1, offset: 0 }); return; }
    this.snapshot();
    this.mergeWithPrev(f.block);
  }

  /** 前向删除：删选区/后一簇；块尾与下块合并，下块为原子则先选中。 @public */
  del(): void {
    if (!this.isCollapsed) { this.snapshot(); this.deleteSel(); return; }
    const f = this.focus;
    const len = this.blockLen(f.block);
    if (f.offset < len) {
      this.snapshot();
      const next = nextBoundary(this.blockStr(f.block), f.offset);
      const b = this.doc.blocks[f.block];
      b.inlines = delInline(b.inlines, f.offset, next);
      this.anchor = this.focus = f;
      return;
    }
    if (f.block < this.blockCount - 1) {
      // 下一块是原子块：不合并，改为选中它
      if (isAtom(this.doc.blocks[f.block + 1].type)) { this.setSel({ block: f.block + 1, offset: 0 }); return; }
      this.snapshot(); this.mergeWithPrev(f.block + 1);
    }
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

  /** 把块就地降级为普通段落（仅保留对齐属性）。 */
  private liftToParagraph(blk: Block): void {
    blk.type = 'paragraph';
    blk.attrs = { align: blk.attrs.align };
  }

  /** 在光标处把当前块拆成两块；行首样式块（标题/引用）特殊处理：上方留空段、内容保持原类型下移。 */
  private splitBlockAtCaret(cur: Block): void {
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
    const newBlock: Block = mkBlock(secondType, normalizeInlines(back), { align: originalAttrs.align });
    this.doc.blocks.splice(f.block + 1, 0, newBlock);
    this.anchor = this.focus = { block: f.block + 1, offset: 0 };
  }

  /** 切换 mark：折叠时切 storedMarks，选区时按整段是否已生效统一加/去。 @public */
  toggleMark(type: MarkType, attrs?: Record<string, string>): void {
    const mark: Mark = attrs ? { type, attrs } : { type };
    if (this.isCollapsed) {
      // 折叠：切换 storedMarks
      const cur = this.activeMarks();
      const has = cur.some((m) => m.type === type);
      this.storedMarks = has ? cur.filter((m) => m.type !== type) : [...cur.filter((m) => m.type !== type), mark];
      return;
    }
    const add = !this.markActive(type);
    this.snapshot();
    this.eachSelRange((blk, s, e) => { blk.inlines = applyMark(blk.inlines, s, e, mark, add); });
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
      return;
    }
    // 选区：单次快照内移除同组兄弟并加/去 type，避免拆成多步撤销
    this.snapshot();
    this.eachSelRange((blk, s, e) => {
      let inl = blk.inlines;
      if (turningOn) for (const other of siblings) inl = applyMark(inl, s, e, { type: other }, false);
      blk.inlines = applyMark(inl, s, e, mark, turningOn);
    });
  }

  /** 设置/更新某 mark（如颜色、链接 href），总是加或覆盖，区别于 toggle。 @public */
  setMark(type: MarkType, attrs?: Record<string, string>): void {
    const mark: Mark = attrs ? { type, attrs } : { type };
    if (this.isCollapsed) { this.storedMarks = withMark(this.activeMarks(), mark); return; }
    this.applyToSel((inl, s, e) => applyMark(inl, s, e, mark, true));
  }
  /** 清除选区或 storedMarks 上指定 mark。 @public */
  clearMark(type: MarkType): void {
    if (this.isCollapsed) { this.storedMarks = withoutMark(this.activeMarks(), type); return; }
    this.applyToSel((inl, s, e) => applyMark(inl, s, e, { type }, false));
  }
  /** 一键清除选区内全部行内 marks（单次撤销）。折叠时清空 storedMarks。 @public */
  clearMarks(): void {
    if (this.isCollapsed) { this.storedMarks = []; return; }
    const all: MarkType[] = ['bold', 'italic', 'underline', 'strikethrough', 'highlight', 'code', 'color', 'link', 'fontFamily', 'fontSize', 'superscript', 'subscript'];
    this.applyToSel((inl, s, e) => all.reduce((acc, t) => applyMark(acc, s, e, { type: t }, false), inl));
  }
  private applyToSel(fn: (inl: Inline[], s: number, e: number) => Inline[]) {
    this.snapshot();
    this.eachSelRange((blk, s, e) => { blk.inlines = fn(blk.inlines, s, e); });
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

  /** 设选区各块的块类型（保留对齐属性，合并传入 attrs）。 @public */
  setBlockType(type: BlockType, attrs: BlockAttrs = {}): void {
    this.snapshot();
    this.eachSelBlock((blk) => { blk.type = type; blk.attrs = { align: blk.attrs.align, ...attrs }; });
  }
  /** 切换任务列表项的勾选态（进撤销栈）；非 task_item 块无操作。 @public */
  toggleTaskChecked(block: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'task_item') return;
    this.snapshot();
    b.attrs = { ...b.attrs, checked: !b.attrs.checked };
  }
  /** 设选区各块的水平对齐。 @public */
  setAlign(align: 'left' | 'center' | 'right'): void {
    this.snapshot();
    this.eachSelBlock((blk) => { blk.attrs.align = align; });
  }
  /** 设选区各块的书写方向（LTR/RTL）。 @public */
  setDir(dir: 'ltr' | 'rtl'): void {
    this.snapshot();
    this.eachSelBlock((blk) => { blk.attrs.dir = dir; });
  }

  // 在光标所在块之后插入原子块
  private insertAtom(block: Block) {
    this.snapshot();
    block.attrs.id = genBlockId(); // 稳定 id：覆盖层按 id 缓存，undo 不丢编辑态
    const at = this.focus.block + 1;
    this.doc.blocks.splice(at, 0, block);
    this.anchor = this.focus = { block: at, offset: 0 };
  }
  /** 在光标块后插入图片原子块。 @public */
  insertImage(src: string): void { this.insertAtom({ type: 'image', attrs: { src }, inlines: [mkText('')] }); }
  /** 在光标块后插入公式原子块。 @public */
  insertFormula(latex: string): void { this.insertAtom({ type: 'formula', attrs: { latex }, inlines: [mkText('')] }); }
  /** 在光标块后插入 rows×cols 空表格原子块。 @public */
  insertTable(rows: number, cols: number): void {
    const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
    this.insertAtom({ type: 'table', attrs: { rows: grid }, inlines: [mkText('')] });
  }
  /** 设置图片显示尺寸（CSS px），进撤销栈（缩放手柄提交时调用）。 @public */
  setImageSize(block: number, width: number, height: number): void {
    const b = this.doc.blocks[block];
    if (!b || b.type !== 'image') return;
    this.snapshot();
    b.attrs = { ...b.attrs, width: Math.round(width), height: Math.round(height) };
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

  /** 回填覆盖层实测高度（不进撤销栈）；高度有变返回 true，否则 false。 @public */
  setMeasuredHeight(block: number, h: number): boolean {
    const b = this.doc.blocks[block];
    if (b && b.attrs.measuredH !== h) { b.attrs.measuredH = h; return true; }
    return false;
  }

  // —— 内部 ——
  private deleteSel() {
    const { from, to } = this.range();
    if (comparePos(from, to) === 0) return;
    if (from.block === to.block) {
      const b = this.doc.blocks[from.block];
      b.inlines = delInline(b.inlines, from.offset, to.offset);
    } else {
      const first = this.doc.blocks[from.block];
      const last = this.doc.blocks[to.block];
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
    prev.inlines = normalizeInlines([...prev.inlines, ...cur.inlines]);
    this.doc.blocks.splice(i, 1);
    this.anchor = this.focus = { block: i - 1, offset: caretOffset };
  }

  // —— 撤销/重做 ——
  private snapshot() {
    this.undoStack.push({ doc: cloneDoc(this.doc), anchor: { ...this.anchor }, focus: { ...this.focus } });
    this.redoStack.length = 0;
    if (this.undoStack.length > 200) this.undoStack.shift();
  }
  /** 撤销栈是否非空。 @public */
  get canUndo(): boolean { return this.undoStack.length > 0; }
  /** 重做栈是否非空。 @public */
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** 撤销一步：当前态入重做栈，恢复栈顶快照。 @public */
  undo(): void { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.capture()); this.restore(s); }
  /** 重做一步：当前态入撤销栈，恢复栈顶快照。 @public */
  redo(): void { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.capture()); this.restore(s); }
  private capture(): Snapshot { return { doc: cloneDoc(this.doc), anchor: { ...this.anchor }, focus: { ...this.focus } }; }
  private restore(s: Snapshot) { this.doc = s.doc; this.anchor = this.clamp(s.anchor); this.focus = this.clamp(s.focus); this.storedMarks = null; }
}

/** 供 layout/命中测试复用：取第 b 块按 grapheme 边界的纯文本。 @public */
export function blockClusterText(rd: RichDoc, b: number): string { return rd.blockStr(b); }
/** 转发 grapheme 簇拆分工具，便于布局/命中从模型层统一引入。 @public */
export { splitGraphemes };
