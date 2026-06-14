import { describe, it, expect } from 'vitest';
import { icon, hasIcon } from '../icons';

// 图标注册表回归：①全部在用图标名（toolbar 的按钮/DEF 表/对话框）必须已注册——防拼写漂移
// 渲染成空 SVG；②审计确认的死键（无任何调用点）已删除——防残留键回潜。

/** 全仓静态/动态拼接（BLOCK_DEFS/LIST_DEFS/MARK_DEFS/ALIGN_DEFS/SHAPE_DEFS/iconBtn/makeDropdown 等）在用的图标名清单。 */
const USED_ICONS = [
  // 历史 / 块类型 / 列表
  'undo-2', 'redo-2', 'pilcrow', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6',
  'list', 'list-ordered', 'list-checks', 'list-tree', 'quote', 'square-code',
  // 行内 mark / 字符排印
  'bold', 'italic', 'underline', 'strikethrough', 'code', 'superscript', 'subscript', 'link',
  'baseline', 'highlighter', 'eraser',
  // 段落
  'align-left', 'align-center', 'align-right', 'align-justify', 'align-distribute',
  'indent-increase', 'indent-decrease', 'arrow-left-right',
  // 插入：媒体 / 公文 / 引用 / 模板
  'image', 'image-plus', 'sigma', 'table', 'shapes', 'layout-template', 'save',
  'audio-lines', 'video', 'globe', 'paperclip', 'signature', 'stamp', 'text-box',
  'sh-line', 'sh-rect', 'sh-rounded', 'sh-ellipse', 'sh-triangle', 'sh-diamond', 'sh-star', 'sh-arrow', 'sh-divider',
  // 视图 / 导入导出 / 打印 / 通用
  'languages', 'download', 'file-input', 'globe-2', 'file-text', 'moon', 'sun', 'printer', 'chevron-down', 'x',
];

/** 集群6 审计确认无任何调用点而删除的死键。 */
const REMOVED_DEAD_ICONS = ['square-check', 'line-spacing', 'eye', 'type', 'pen-tool', 'badge', 'square-pen'];

describe('icons: 注册表与调用点对齐', () => {
  it('所有在用图标名均已注册', () => {
    const missing = USED_ICONS.filter((n) => !hasIcon(n));
    expect(missing).toEqual([]);
  });

  it('审计删除的死键不再注册（防残留回潜）', () => {
    const alive = REMOVED_DEAD_ICONS.filter((n) => hasIcon(n));
    expect(alive).toEqual([]);
  });

  it('icon() 对已注册名输出带路径内容的 SVG（stroke 随 currentColor）', () => {
    const svg = icon('bold');
    expect(svg).toContain('<svg');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('<path');
  });

  it('icon() 对未注册名优雅降级为空内容 SVG（不抛错）', () => {
    const svg = icon('no-such-icon');
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('<path');
  });
});
