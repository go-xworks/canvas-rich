import { describe, it, expect } from 'vitest';
import { normalizeEditorOptions } from '../normalize-options';
import type { EditorOptions } from '../create-editor';

// normalize-options：createEditor 顶部选项归一化的纯逻辑（node 可测，无 DOM）。
// 覆盖 chrome 各开关的 !== false 默认开语义、persistDraft/readOnly/shaper 缺省与各分支。

describe('normalizeEditorOptions — 缺省（复刻现 demo 全开）', () => {
  it('无参：全 chrome 开、persistDraft 开、非只读、shaper=canvas', () => {
    expect(normalizeEditorOptions()).toEqual({
      showToolbar: true,
      showOutline: true,
      showStatusBar: true,
      enableContextMenu: true,
      showFindBar: true,
      persistDraft: true,
      readOnly: false,
      defaultShaper: 'canvas',
    });
  });

  it('空对象等价于无参', () => {
    expect(normalizeEditorOptions({})).toEqual(normalizeEditorOptions());
  });

  it('空 chrome 对象：各开关仍默认 true', () => {
    const n = normalizeEditorOptions({ chrome: {} });
    expect([n.showToolbar, n.showOutline, n.showStatusBar, n.enableContextMenu, n.showFindBar])
      .toEqual([true, true, true, true, true]);
  });
});

describe('normalizeEditorOptions — chrome 开关 !== false 语义', () => {
  it('显式 false 才关，undefined/true 均开', () => {
    const off = normalizeEditorOptions({
      chrome: { toolbar: false, outline: false, statusBar: false, contextMenu: false, findBar: false },
    });
    expect([off.showToolbar, off.showOutline, off.showStatusBar, off.enableContextMenu, off.showFindBar])
      .toEqual([false, false, false, false, false]);

    const on = normalizeEditorOptions({
      chrome: { toolbar: true, outline: true, statusBar: true, contextMenu: true, findBar: true },
    });
    expect([on.showToolbar, on.showOutline, on.showStatusBar, on.enableContextMenu, on.showFindBar])
      .toEqual([true, true, true, true, true]);
  });

  it('部分关闭：未提及的开关保持默认开', () => {
    const n = normalizeEditorOptions({ chrome: { toolbar: false } });
    expect(n.showToolbar).toBe(false);
    expect([n.showOutline, n.showStatusBar, n.enableContextMenu, n.showFindBar])
      .toEqual([true, true, true, true]);
  });

  it('chrome 开关显式 undefined 视同默认开（!== false）', () => {
    const n = normalizeEditorOptions({ chrome: { toolbar: undefined, findBar: undefined } });
    expect(n.showToolbar).toBe(true);
    expect(n.showFindBar).toBe(true);
  });
});

describe('normalizeEditorOptions — persistDraft / readOnly', () => {
  it('persistDraft 默认 true，显式 false 才关，true 保持开', () => {
    expect(normalizeEditorOptions({ persistDraft: false }).persistDraft).toBe(false);
    expect(normalizeEditorOptions({ persistDraft: true }).persistDraft).toBe(true);
    expect(normalizeEditorOptions({}).persistDraft).toBe(true);
  });

  it('readOnly 默认 false，显式 true 才只读（=== true 语义）', () => {
    expect(normalizeEditorOptions({ readOnly: true }).readOnly).toBe(true);
    expect(normalizeEditorOptions({ readOnly: false }).readOnly).toBe(false);
    expect(normalizeEditorOptions({}).readOnly).toBe(false);
  });
});

describe('normalizeEditorOptions — shaper 缺省', () => {
  it('缺省 canvas；显式透传 canvas/harfbuzz', () => {
    expect(normalizeEditorOptions({}).defaultShaper).toBe('canvas');
    expect(normalizeEditorOptions({ shaper: 'canvas' }).defaultShaper).toBe('canvas');
    expect(normalizeEditorOptions({ shaper: 'harfbuzz' }).defaultShaper).toBe('harfbuzz');
  });
});

describe('normalizeEditorOptions — 无关字段不影响归一化', () => {
  it('initialDoc/theme/viewMode 等不参与本归一化（各自路径处理）', () => {
    const opts: EditorOptions = { theme: 'dark', viewMode: 'word', initialMarkdown: '# x' };
    expect(normalizeEditorOptions(opts)).toEqual(normalizeEditorOptions());
  });
});
