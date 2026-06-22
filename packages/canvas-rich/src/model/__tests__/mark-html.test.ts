import { describe, it, expect } from 'vitest';
import { MARK_WRAP_TAGS, SPAN_STYLE_MARKS, markTypeOfTag } from '../mark-html';
import { MarkType } from '../schema';

// mark ↔ HTML 标签映射表（SSOT）一致性测试：
// 1) 全部 MarkType 被「包裹标签 ∪ span style ∪ link（调用方另裹）」完整覆盖且不重叠；
// 2) 解析端 markTypeOfTag 与导出端包裹标签互逆（含同义别名、大小写不敏感）；
// 3) 包裹次序锁定（改变顺序会改变导出 HTML 字节序列）。

// Record<MarkType, true> 强制穷举：schema 新增 mark 类型时此处编译失败，提醒补映射表。
const ALL_MARKS: Record<MarkType, true> = {
  bold: true,
  italic: true,
  underline: true,
  strikethrough: true,
  highlight: true,
  code: true,
  color: true,
  link: true,
  fontFamily: true,
  fontSize: true,
  superscript: true,
  subscript: true,
};

describe('mark 覆盖完整性', () => {
  it('包裹标签 ∪ span style ∪ link 覆盖全部 MarkType 且不重叠', () => {
    const wrap = MARK_WRAP_TAGS.map((e) => e.mark);
    const span = SPAN_STYLE_MARKS.map((e) => e.mark);
    const covered = [...wrap, ...span, 'link' as MarkType];
    expect(new Set(covered).size).toBe(covered.length); // 三组互不重叠
    expect([...covered].sort()).toEqual(Object.keys(ALL_MARKS).sort());
  });
});

describe('markTypeOfTag（解析端）', () => {
  it('导出包裹标签逐一互逆（tag → 同一 mark）', () => {
    for (const { mark, tag } of MARK_WRAP_TAGS) {
      expect(markTypeOfTag(tag), `${tag} 应解析为 ${mark}`).toBe(mark);
    }
  });

  it('同义别名归并：b/i/strike/del', () => {
    expect(markTypeOfTag('b')).toBe('bold');
    expect(markTypeOfTag('i')).toBe('italic');
    expect(markTypeOfTag('strike')).toBe('strikethrough');
    expect(markTypeOfTag('del')).toBe('strikethrough');
  });

  it('大小写不敏感（cell-dom 传大写标签）', () => {
    expect(markTypeOfTag('STRONG')).toBe('bold');
    expect(markTypeOfTag('Mark')).toBe('highlight');
    expect(markTypeOfTag('SUB')).toBe('subscript');
  });

  it('非外观标签返回 undefined（a/span/img 等另有专门处理）', () => {
    for (const tag of ['a', 'span', 'img', 'div', 'p', 'br', 'unknown']) {
      expect(markTypeOfTag(tag), `${tag} 不应映射 mark`).toBeUndefined();
    }
  });
});

describe('包裹次序锁定（导出 HTML 字节级不变的前提）', () => {
  it('标签包裹序：code 最内 → sub 最外', () => {
    expect(MARK_WRAP_TAGS.map((e) => e.tag)).toEqual(['code', 'strong', 'em', 'u', 's', 'mark', 'sup', 'sub']);
  });

  it('span style 包裹序与键名：fontFamily → fontSize(px) → color', () => {
    expect(SPAN_STYLE_MARKS).toEqual([
      { mark: 'fontFamily', attrKey: 'fontFamily', cssName: 'font-family', suffix: '' },
      { mark: 'fontSize', attrKey: 'size', cssName: 'font-size', suffix: 'px' },
      { mark: 'color', attrKey: 'color', cssName: 'color', suffix: '' },
    ]);
  });
});
