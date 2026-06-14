import { describe, it, expect } from 'vitest';
import { tipParse, tipDescKey, TIP_DESC, NUM_INPUT_DEFS } from '../toolbar';

// 工具栏纯逻辑测试：悬停提示的 title 解析 / 描述查找键归一，以及
// 段落数字输入（段前/段后/字距）的 title 与 TIP_DESC 键对齐（防回归：曾出现键名重复/不匹配）。
// 仅测不依赖 DOM 的纯函数，契合 vitest node 环境。

describe('tipParse', () => {
  it('splits a title with a trailing shortcut into name + shortcut', () => {
    expect(tipParse('粗体 ⌘B')).toEqual({ name: '粗体', shortcut: '⌘B' });
    expect(tipParse('撤销 ⌘Z')).toEqual({ name: '撤销', shortcut: '⌘Z' });
    expect(tipParse('右对齐 ⌘⇧R')).toEqual({ name: '右对齐', shortcut: '⌘⇧R' });
  });

  it('returns name only when there is no modifier-key shortcut', () => {
    expect(tipParse('删除线')).toEqual({ name: '删除线' });
    expect(tipParse('段前间距 (px)')).toEqual({ name: '段前间距 (px)' });
  });

  it('does not treat a parenthetical note as a shortcut', () => {
    expect(tipParse('插入图片（块级）')).toEqual({ name: '插入图片（块级）' });
  });
});

describe('tipDescKey', () => {
  it('strips parenthetical notes (both half- and full-width)', () => {
    expect(tipDescKey('段前间距 (px)')).toBe('段前间距');
    expect(tipDescKey('插入图片（块级）')).toBe('插入图片');
  });

  it('takes the leading run of CJK characters as the lookup key', () => {
    expect(tipDescKey('字间距 (px)')).toBe('字间距');
    expect(tipDescKey('标题 1')).toBe('标题');
  });
});

describe('numInput titles map to TIP_DESC keys (no duplicate / mismatched keys)', () => {
  it('every段落数字输入 title resolves to an existing TIP_DESC entry', () => {
    for (const [, title] of NUM_INPUT_DEFS) {
      const key = tipDescKey(tipParse(title).name);
      expect(TIP_DESC[key], `missing TIP_DESC for "${title}" (key="${key}")`).toBeDefined();
    }
  });

  it('exposes exactly the three paragraph numeric inputs with px titles', () => {
    expect(NUM_INPUT_DEFS.map(([, t]) => t)).toEqual([
      '段前间距 (px)', '段后间距 (px)', '字间距 (px)',
    ]);
  });

  it('has no dead pre-dedup keys left in TIP_DESC', () => {
    // 修复前遗留的重复/无主键（段前 / 段后 / 字距 / 段前距 / 段后距）应已删除，
    // 仅保留与实际 title 对齐的 段前间距 / 段后间距 / 字间距。
    expect(TIP_DESC['段前']).toBeUndefined();
    expect(TIP_DESC['段后']).toBeUndefined();
    expect(TIP_DESC['字距']).toBeUndefined();
    expect(TIP_DESC['段前距']).toBeUndefined();
    expect(TIP_DESC['段后距']).toBeUndefined();
  });
});
