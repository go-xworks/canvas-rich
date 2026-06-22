import { describe, it, expect } from 'vitest';
import { breakLines, BreakItem } from '../line-break';

// 工具：从一段「描述」构造 BreakItem[]。
// 'a'..'z' / 其它可见字符 → 普通字符；' ' → 空格；'\n' → 换行符。
// 每个 item 的 advance 默认 10，可用 advances 覆盖。
function items(spec: string, advances?: number[]): BreakItem[] {
  const out: BreakItem[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    out.push({
      advance: advances ? advances[i] : 10,
      isSpace: c === ' ',
      isNewline: c === '\n',
    });
  }
  return out;
}

describe('breakLines', () => {
  it('全部能放进一行 → 单行', () => {
    const its = items('hello'); // 5 * 10 = 50
    const lines = breakLines(its, 100);
    expect(lines).toEqual([[0, 1, 2, 3, 4]]);
  });

  it('单个 \\n → 切成两行', () => {
    const its = items('ab\ncd'); // 下标: a0 b1 \n2 c3 d4
    const lines = breakLines(its, 1000);
    // 换行符并入其所在行的行尾
    expect(lines).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it('连续多个 \\n → 多个空行', () => {
    const its = items('a\n\n\nb'); // a0 \n1 \n2 \n3 b4
    const lines = breakLines(its, 1000);
    expect(lines).toEqual([[0, 1], [2], [3], [4]]);
  });

  it('宽度溢出、有空格 → 在空格处折行，单词不被拆断', () => {
    // "ab cd" 每个 advance=10。maxWidth=30 → "ab " (30) 放得下，加 'c' 超 30 → 在空格后折行。
    const its = items('ab cd'); // a0 b1 (space)2 c3 d4
    const lines = breakLines(its, 30);
    // 第一行含空格在末尾，"cd" 完整移到下一行（单词不拆）
    expect(lines).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it('宽度溢出、无空格（全是连续窄字符） → 硬断成多行', () => {
    // "abcde" 每个 10，maxWidth=25 → 每行最多 2 个字符（第 3 个使 lineW=20+10=30>25）
    const its = items('abcde');
    const lines = breakLines(its, 25);
    expect(lines).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('文末以 \\n 结尾 → 末尾有一个空行', () => {
    const its = items('ab\n'); // a0 b1 \n2
    const lines = breakLines(its, 1000);
    // \n 触发换行后，循环结束 push 空的最后一行
    expect(lines).toEqual([[0, 1, 2], []]);
  });

  it('空输入 → 返回单个空行 [[]]', () => {
    const lines = breakLines([], 100);
    expect(lines).toEqual([[]]);
  });

  it('行首即溢出的单个超宽字符不会被丢弃（line.length>0 才折行）', () => {
    // 单个 advance=50 的字符，maxWidth=30：line 为空时不折行，直接放入。
    const its = items('x', [50]);
    const lines = breakLines(its, 30);
    expect(lines).toEqual([[0]]);
  });

  it('折行后重算下一行宽度并能再次折行', () => {
    // "a bb cc" advance=10。maxWidth=30。
    // a0 (10) sp1 (20) b2 (30) -> 加 b3 超30, 在 sp1 后折行: 行1=[0,1], 行2=[2]
    // 行2: b2(10) b3(20) sp4(30) -> 加 c5 超30, 在 sp4 后折行: 行2=[2,3,4], 行3=[5]
    // 行3: c5(10) c6(20) 结束 -> [5,6]
    const its = items('a bb cc');
    const lines = breakLines(its, 30);
    expect(lines).toEqual([
      [0, 1],
      [2, 3, 4],
      [5, 6],
    ]);
  });
});
