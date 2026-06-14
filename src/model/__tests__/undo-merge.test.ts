import { describe, it, expect } from 'vitest';
import { RichDoc, TEXT_MERGE_WINDOW_MS } from '../rich-document';
import { para, text, blockText, Block } from '../schema';

// 撤销输入合并：连续字符编辑（插入/退格/前删）在时间窗内且位置衔接时复用栈顶快照。
// 时间源经 rd.now 注入假时钟，确定性验证时间窗边界（不依赖真实系统时间）。

const rdOf = (...blocks: Block[]) => new RichDoc({ blocks });
const docText = (rd: RichDoc) => rd.doc.blocks.map((b) => blockText(b));

/** 装一个假时钟：返回推进函数（毫秒），rd.now 读当前假时刻。 */
function fakeClock(rd: RichDoc): (ms: number) => void {
  let t = 0;
  rd.now = () => t;
  return (ms) => { t += ms; };
}

describe('连续插入合并为一条撤销记录', () => {
  it('时间窗内逐字输入 N 字 → 1 次 undo 回滚全部', () => {
    const rd = rdOf(para([text('')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    for (const ch of ['h', 'e', 'l', 'l', 'o']) { rd.insertText(ch); tick(100); }
    expect(docText(rd)).toEqual(['hello']);
    rd.undo();
    expect(docText(rd)).toEqual(['']);
    expect(rd.canUndo).toBe(false); // 整段输入仅 1 条记录
  });

  it('IME 单次提交多字符仍是一条记录', () => {
    const rd = rdOf(para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('中文输入');
    rd.undo();
    expect(docText(rd)).toEqual(['']);
    expect(rd.canUndo).toBe(false);
  });

  it('undo 后 redo 恢复整段合并输入', () => {
    const rd = rdOf(para([text('')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a'); tick(50); rd.insertText('b'); tick(50); rd.insertText('c');
    rd.undo();
    expect(docText(rd)).toEqual(['']);
    rd.redo();
    expect(docText(rd)).toEqual(['abc']);
  });
});

describe('时间窗边界', () => {
  it('间隔超窗 → 分条（各自独立 undo）', () => {
    const rd = rdOf(para([text('')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    tick(TEXT_MERGE_WINDOW_MS + 1);
    rd.insertText('b');
    expect(docText(rd)).toEqual(['ab']);
    rd.undo();
    expect(docText(rd)).toEqual(['a']); // 仅回滚超窗后的 'b'
    rd.undo();
    expect(docText(rd)).toEqual(['']);
  });

  it('恰在时间窗上沿（== 窗长）仍合并', () => {
    const rd = rdOf(para([text('')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    tick(TEXT_MERGE_WINDOW_MS);
    rd.insertText('b');
    rd.undo();
    expect(docText(rd)).toEqual(['']);
  });
});

describe('位置/选区/编辑类型断开合并', () => {
  it('选区跳变（setSel）断开：跳走再打字是新记录', () => {
    const rd = rdOf(para([text('xy')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 2 });
    rd.insertText('a'); rd.insertText('b'); // 合并：'xyab'
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('z');                     // 新记录：'zxyab'
    expect(docText(rd)).toEqual(['zxyab']);
    rd.undo();
    expect(docText(rd)).toEqual(['xyab']);
    rd.undo();
    expect(docText(rd)).toEqual(['xy']);
  });

  it('跨块不合并（块下标不同即新记录）', () => {
    const rd = rdOf(para([text('')]), para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    rd.setSel({ block: 1, offset: 0 });
    rd.insertText('b');
    rd.undo();
    expect(docText(rd)).toEqual(['a', '']);
    rd.undo();
    expect(docText(rd)).toEqual(['', '']);
  });

  it('插入与退格互不合并', () => {
    const rd = rdOf(para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('ab');
    rd.backspace(); // 'a'：退格是独立记录
    expect(docText(rd)).toEqual(['a']);
    rd.undo();
    expect(docText(rd)).toEqual(['ab']);
    rd.undo();
    expect(docText(rd)).toEqual(['']);
  });

  it('非文本编辑（setAlign）断开合并', () => {
    const rd = rdOf(para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    rd.setAlign('center'); // 通用快照：断开
    rd.insertText('b');
    rd.undo();
    expect(docText(rd)).toEqual(['a']);
    expect(rd.doc.blocks[0].attrs.align).toBe('center');
    rd.undo();
    expect(rd.doc.blocks[0].attrs.align).toBeUndefined();
    rd.undo();
    expect(docText(rd)).toEqual(['']);
  });

  it('breakUndoCoalescing 主动断开（粘贴边界语义）', () => {
    const rd = rdOf(para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    rd.breakUndoCoalescing();
    rd.insertText('b');
    rd.undo();
    expect(docText(rd)).toEqual(['a']);
    rd.undo();
    expect(docText(rd)).toEqual(['']);
  });

  it('折叠光标切换 storedMarks（格式边界）断开合并', () => {
    const rd = rdOf(para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    rd.toggleMark('bold'); // 改 storedMarks：后续输入分属新记录
    rd.insertText('b');
    rd.undo();
    expect(docText(rd)).toEqual(['a']);
  });
});

describe('连续删除合并', () => {
  it('连续退格在窗内合并：1 次 undo 全部恢复', () => {
    const rd = rdOf(para([text('abcd')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 4 });
    rd.backspace(); tick(80); rd.backspace(); tick(80); rd.backspace();
    expect(docText(rd)).toEqual(['a']);
    rd.undo();
    expect(docText(rd)).toEqual(['abcd']);
    expect(rd.canUndo).toBe(false);
  });

  it('连续前删（del，光标原位）在窗内合并', () => {
    const rd = rdOf(para([text('abcd')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.del(); tick(80); rd.del(); tick(80); rd.del();
    expect(docText(rd)).toEqual(['d']);
    rd.undo();
    expect(docText(rd)).toEqual(['abcd']);
    expect(rd.canUndo).toBe(false);
  });

  it('退格超窗分条', () => {
    const rd = rdOf(para([text('abc')]));
    const tick = fakeClock(rd);
    rd.setSel({ block: 0, offset: 3 });
    rd.backspace();
    tick(TEXT_MERGE_WINDOW_MS + 1);
    rd.backspace();
    rd.undo();
    expect(docText(rd)).toEqual(['ab']);
    rd.undo();
    expect(docText(rd)).toEqual(['abc']);
  });
});

describe('undo/redo 与合并状态', () => {
  it('undo 后立即输入：新记录、redo 栈被清空', () => {
    const rd = rdOf(para([text('')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('abc');
    rd.undo();
    expect(rd.canRedo).toBe(true);
    rd.insertText('x'); // 不得与已撤销的输入合并；清空 redo
    expect(docText(rd)).toEqual(['x']);
    expect(rd.canRedo).toBe(false);
    rd.undo();
    expect(docText(rd)).toEqual(['']);
  });

  it('默认时钟（未注入）下连续两次插入也合并（真实 Date.now 间隔 ≪ 窗长）', () => {
    const rd = rdOf(para([text('')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a');
    rd.insertText('b');
    rd.undo();
    expect(docText(rd)).toEqual(['']);
    expect(rd.canUndo).toBe(false);
  });

  it('有选区的插入（替换选区）是独立快照，不与后续输入断裂语义', () => {
    const rd = rdOf(para([text('hello')]));
    fakeClock(rd);
    rd.setSel({ block: 0, offset: 0 });
    rd.setSel({ block: 0, offset: 5 }, true);
    rd.insertText('X');        // 替换整词：独立记录
    rd.insertText('Y');        // 与上一次插入位置衔接 → 合并进同一记录
    expect(docText(rd)).toEqual(['XY']);
    rd.undo();
    expect(docText(rd)).toEqual(['hello']);
  });
});

// undo/redo 结构共享（增量化）：restore 时未变块复用当前 doc 的 Block 对象（保布局缓存
// WeakMap 命中），仅真正回退的块取快照克隆；原子块（覆盖层就地回写不 touchBlock）不复用。
describe('undo/redo 结构共享：未变块保对象身份', () => {
  it('单块编辑后 undo：未编辑块复用同一对象，被编辑块换为快照克隆', () => {
    const rd = rdOf(para([text('aa')]), para([text('bb')]), para([text('cc')]));
    const [b0, b1, b2] = rd.doc.blocks;
    rd.setSel({ block: 1, offset: 2 });
    rd.insertText('X');
    rd.undo();
    expect(blockText(rd.doc.blocks[1])).toBe('bb');     // 内容正确回退
    expect(rd.doc.blocks[0]).toBe(b0);                  // 未变块：身份复用（缓存命中）
    expect(rd.doc.blocks[2]).toBe(b2);
    expect(rd.doc.blocks[1]).not.toBe(b1);              // 被编辑块：快照克隆（b1 已被改动）
  });

  it('redo 同样结构共享：未变块身份稳定', () => {
    const rd = rdOf(para([text('aa')]), para([text('bb')]));
    rd.setSel({ block: 1, offset: 2 });
    rd.insertText('X');
    rd.undo();
    const b0 = rd.doc.blocks[0];
    rd.redo();
    expect(blockText(rd.doc.blocks[1])).toBe('bbX');
    expect(rd.doc.blocks[0]).toBe(b0);
  });

  it('undo 后再编辑另一块、再 undo：各步内容均正确（共享不破坏快照语义）', () => {
    const rd = rdOf(para([text('one')]), para([text('two')]), para([text('three')]));
    rd.setSel({ block: 0, offset: 3 });
    rd.insertText('!');
    rd.setSel({ block: 2, offset: 5 });
    rd.insertText('?');
    expect(docText(rd)).toEqual(['one!', 'two', 'three?']);
    rd.undo();
    expect(docText(rd)).toEqual(['one!', 'two', 'three']);
    rd.undo();
    expect(docText(rd)).toEqual(['one', 'two', 'three']);
    rd.redo();
    rd.redo();
    expect(docText(rd)).toEqual(['one!', 'two', 'three?']);
  });

  it('原子块（表格）不复用：undo 后换为快照克隆（覆盖层就地回写不 touch，版本相等不充分）', () => {
    const rd = rdOf(
      para([text('p')]),
      { type: 'table', attrs: { rows: [[{ inlines: [text('a')] }]] }, inlines: [text('')] },
    );
    const tableBlk = rd.doc.blocks[1];
    rd.setSel({ block: 0, offset: 1 });
    rd.insertText('x'); // 编辑无关文本块
    // 模拟覆盖层单元格就地回写（不经 touchBlock 的写路径）
    tableBlk.attrs.rows![0][0] = { inlines: [text('EDITED')] };
    rd.undo();
    expect(rd.doc.blocks[1]).not.toBe(tableBlk); // 表格块不身份复用 → 快照克隆
    expect(rd.doc.blocks[1].attrs.rows![0][0].inlines[0]).toMatchObject({ text: 'a' }); // 未 touch 的回写也被回退
  });
});
