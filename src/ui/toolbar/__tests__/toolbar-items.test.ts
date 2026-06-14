import { describe, it, expect } from 'vitest';
import { TOOLBAR_GROUPS, NUM_INPUT_DEFS } from '../toolbar-items';
import { RENDERERS } from '../renderers';
import type { ToolbarItem, ToolbarState, ItemKind } from '../types';
import { icon } from '../../icons';
import { commands, keymap } from '../../../editor/commands';

// 工具栏声明式清单的 node 纯逻辑测试：①清单结构完整性（54 个 id 唯一、kind∈RENDERERS、tab 合法）；
// ②谓词纯函数行为对照源 refresh 分支（无需 DOM，契合 vitest node 环境）。
// 视觉/DOM 装配靠 parityChecklist 人工浏览器核对——node 环境无 jsdom，不引入第三方库兜底。

/** 展开清单为扁平 item 列表（含 trailing 导出钮）。 */
const allItems: ToolbarItem[] = TOOLBAR_GROUPS.flatMap((g) => g.rows.flat());
/** 按 id 取 item（测试便捷）。 */
const byId = (id: string): ToolbarItem => {
  const it = allItems.find((i) => i.id === id);
  if (!it) throw new Error(`no item with id "${id}"`);
  return it;
};

/** 构造一个最小 ToolbarState（字段全给默认，测试时按需覆盖）。 */
function makeState(over: Partial<ToolbarState> = {}): ToolbarState {
  return {
    marks: {}, blockValue: 'paragraph', fontSize: '16', fontFamily: 'default',
    color: null, highlight: null, align: 'left', dir: 'ltr', lineHeight: '1',
    spaceBefore: 0, spaceAfter: 0, letterSpacing: 0, canUndo: true, canRedo: true,
    shaperShort: 'Canvas', theme: 'light', viewMode: 'web', ...over,
  };
}

const VALID_TABS = new Set(['start', 'insert', 'view', 'trailing']);
const KINDS = new Set<string>(Object.keys(RENDERERS) as ItemKind[]);

describe('TOOLBAR_GROUPS 结构完整性', () => {
  it('恰好 54 个控件且 id 全唯一', () => {
    const ids = allItems.map((i) => i.id);
    expect(ids.length).toBe(54);
    expect(new Set(ids).size).toBe(54);
  });

  it('每条 item.kind ∈ RENDERERS 映射键', () => {
    for (const it of allItems) expect(KINDS.has(it.kind), `bad kind "${it.kind}" on "${it.id}"`).toBe(true);
  });

  it('每条 item.tab ∈ {start,insert,view,trailing} 且与所属 group.tab 一致', () => {
    for (const g of TOOLBAR_GROUPS) {
      for (const it of g.rows.flat()) {
        expect(VALID_TABS.has(it.tab), `bad tab "${it.tab}" on "${it.id}"`).toBe(true);
        expect(it.tab, `item "${it.id}" tab != group "${g.group}" tab`).toBe(g.tab);
      }
    }
  });

  it('每条 item.group 与所属 GroupSpec.group 一致', () => {
    for (const g of TOOLBAR_GROUPS) {
      for (const it of g.rows.flat()) expect(it.group).toBe(g.group);
    }
  });
});

describe('谓词纯函数对照源 refresh 分支', () => {
  it('bold.active({marks:{bold:true}}) === true', () => {
    const bold = byId('mark-bold');
    if (bold.kind !== 'icon-button') throw new Error('mark-bold 应为 icon-button');
    expect(bold.active?.(makeState({ marks: { bold: true } }))).toBe(true);
    expect(bold.active?.(makeState({ marks: { bold: false } }))).toBe(false);
  });

  it('font-size.labelOf({fontSize:"24"}) === "24"', () => {
    const fs = byId('font-size');
    if (fs.kind !== 'label-dropdown') throw new Error('font-size 应为 label-dropdown');
    expect(fs.labelOf(makeState({ fontSize: '24' }))).toBe('24');
  });

  it('theme.dynamic({theme:"light"}) 含 "moon" 与 "暗色"', () => {
    const theme = byId('theme');
    if (theme.kind !== 'text-button') throw new Error('theme 应为 text-button');
    const html = theme.dynamic?.(makeState({ theme: 'light' }), icon).html ?? '';
    expect(html).toContain('暗色');
    // 月亮图标（lucide moon）注入；用 icon() 实测产物含月亮路径特征。
    expect(html).toContain(icon('moon'));
  });

  it('theme.active({theme:"dark"}) === true', () => {
    const theme = byId('theme');
    if (theme.kind !== 'text-button') throw new Error('theme 应为 text-button');
    expect(theme.active?.(makeState({ theme: 'dark' }))).toBe(true);
    expect(theme.active?.(makeState({ theme: 'light' }))).toBe(false);
  });

  it('space-before.valueOf({spaceBefore:8}) === 8', () => {
    const sb = byId('space-before');
    if (sb.kind !== 'num-input') throw new Error('space-before 应为 num-input');
    expect(sb.valueOf(makeState({ spaceBefore: 8 }))).toBe(8);
  });

  it('undo.disabled({canUndo:false}) === true', () => {
    const undo = byId('undo');
    if (undo.kind !== 'icon-button') throw new Error('undo 应为 icon-button');
    expect(undo.disabled?.(makeState({ canUndo: false }))).toBe(true);
    expect(undo.disabled?.(makeState({ canUndo: true }))).toBe(false);
    // undo 是禁用而非 active（勿用 setOn 画蓝 wash）：不应有 active 谓词。
    expect(undo.active).toBeUndefined();
  });

  it('color/highlight 触发钮 isActive 随对应色是否为 null', () => {
    const color = byId('color'); const hl = byId('highlight');
    if (color.kind !== 'color-dropdown' || hl.kind !== 'color-dropdown') throw new Error('color/highlight 应为 color-dropdown');
    expect(color.isActive(makeState({ color: '#abc' }))).toBe(true);
    expect(color.isActive(makeState({ color: null }))).toBe(false);
    expect(hl.isActive(makeState({ highlight: '#abc' }))).toBe(true);
    expect(hl.isActive(makeState({ highlight: null }))).toBe(false);
  });
});

describe('工具栏 item.command 与命令总线一致性（统一命令总线接线）', () => {
  // 携带 command 字段的 item 类型（template-dropdown 无 command，其 apply/save 经 tplFill 间接派发）。
  const ITEMS_WITH_CMD = allItems.filter(
    (i): i is Extract<ToolbarItem, { command: string }> => 'command' in i && typeof (i as { command?: unknown }).command === 'string',
  );

  it('每个 item.command 都是已注册命令', () => {
    for (const it of ITEMS_WITH_CMD) {
      expect(commands[it.command], `item "${it.id}" → command "${it.command}" 未注册`).toBeTypeOf('function');
    }
  });

  it('除 template-dropdown 外的控件均声明 command（无遗漏）', () => {
    for (const it of allItems) {
      if (it.kind === 'template-dropdown') continue;
      expect('command' in it && typeof (it as { command?: unknown }).command === 'string', `item "${it.id}" 缺 command`).toBe(true);
    }
  });

  it('tplFill / divider 间接派发的命令亦已注册', () => {
    // 模板下拉运行时经 ctx.exec('template.apply'|'template.save')；分隔线钮 command:'insert.shape', arg:'divider'。
    for (const id of ['template.apply', 'template.save', 'insert.shape']) {
      expect(commands[id], `间接命令 "${id}" 未注册`).toBeTypeOf('function');
    }
    const divider = byId('divider');
    if (divider.kind !== 'icon-button') throw new Error('divider 应为 icon-button');
    expect(divider.command).toBe('insert.shape');
    expect(divider.arg).toBe('divider');
  });

  it('keymap 每个目标命令都在命令总线中存在', () => {
    for (const [combo, name] of Object.entries(keymap)) {
      expect(commands[name], `keymap["${combo}"] → "${name}" 未注册`).toBeTypeOf('function');
    }
  });
});

describe('NUM_INPUT_DEFS 与清单 num-input 项同源', () => {
  it('三个 num-input 项的 numTitle 顺序 = NUM_INPUT_DEFS 的 title 顺序', () => {
    const numTitles = allItems
      .filter((i): i is Extract<ToolbarItem, { kind: 'num-input' }> => i.kind === 'num-input')
      .map((i) => i.numTitle);
    expect(numTitles).toEqual(NUM_INPUT_DEFS.map(([, t]) => t));
  });
});
