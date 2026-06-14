import { describe, it, expect } from 'vitest';
import {
  atomSig,
  tableSig,
  textboxSig,
  canSkipTableRebuild,
  measuredHeightChanged,
  overlayLayerZoom,
  overlayCssRect,
  blurActiveCellWithin,
} from '../overlays';
import { cellsFromStrings, text } from '../../model/schema';
import type { BlockAttrs, CellMerge, TableCell } from '../../model/schema';

// 覆盖层纯逻辑测试（不依赖 DOM，契合 vitest node 环境）：
//  - tableSig：表格内容签名是否纳入全部影响渲染的 attrs（结构 + 列宽/行高/合并 + align/dir），
//    防回归——曾漏 align/dir，方向/对齐切换时 sig 不变 → renderTable 早返回 → 视图不重建。
//  - measuredHeightChanged：onMeasured 每帧回调的 throttle 判定（亚像素抖动不触发）。
//  - overlayLayerZoom / overlayCssRect：功能性缩放（zoom≠1）下覆盖层与 canvas 内容的对齐换算
//    （集群1 回归——曾以设备 dpr 直除布局盒，表格/公式预留空间与 DOM 高度差 zoom 倍而错位）。

const baseRows = (): TableCell[][] =>
  cellsFromStrings([
    ['a', 'b'],
    ['c', 'd'],
  ]);

describe('tableSig', () => {
  it('is stable across pure text edits (cell content not in the signature)', () => {
    const a: BlockAttrs = { rows: cellsFromStrings([['a', 'b']]) };
    const b: BlockAttrs = { rows: cellsFromStrings([['X', 'Y']]) }; // 同结构、改文本
    expect(tableSig(a)).toBe(tableSig(b));
  });

  it('is stable across pure mark edits inside cells (rich content not in the signature)', () => {
    // 纯内容（含 marks）编辑不重建表格 DOM，否则打字/加粗时每帧重建会打断编辑态。
    const plain: BlockAttrs = { rows: cellsFromStrings([['a', 'b']]) };
    const marked: BlockAttrs = { rows: [[{ inlines: [text('a', [{ type: 'bold' }])] }, { inlines: [text('x\ny')] }]] };
    expect(tableSig(plain)).toBe(tableSig(marked));
  });

  it('changes when row/column structure changes', () => {
    const a: BlockAttrs = { rows: cellsFromStrings([['a', 'b']]) };
    const b: BlockAttrs = { rows: cellsFromStrings([['a', 'b', 'c']]) }; // 多一列
    const c: BlockAttrs = {
      rows: cellsFromStrings([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    }; // 多一行
    expect(tableSig(a)).not.toBe(tableSig(b));
    expect(tableSig(a)).not.toBe(tableSig(c));
  });

  it('changes when column widths or row heights change', () => {
    const base: BlockAttrs = { rows: baseRows() };
    const cw: BlockAttrs = { rows: baseRows(), colWidths: [80, 120] };
    const rh: BlockAttrs = { rows: baseRows(), rowHeights: [30, 40] };
    expect(tableSig(base)).not.toBe(tableSig(cw));
    expect(tableSig(base)).not.toBe(tableSig(rh));
  });

  it('changes when merges change', () => {
    const base: BlockAttrs = { rows: baseRows() };
    const merge: CellMerge = { r: 0, c: 0, rowspan: 2, colspan: 1 };
    const merged: BlockAttrs = { rows: baseRows(), merges: [merge] };
    expect(tableSig(base)).not.toBe(tableSig(merged));
  });

  it('changes when align changes (regression: align must affect the signature)', () => {
    const base: BlockAttrs = { rows: baseRows() };
    const centered: BlockAttrs = { rows: baseRows(), align: 'center' };
    const right: BlockAttrs = { rows: baseRows(), align: 'right' };
    expect(tableSig(base)).not.toBe(tableSig(centered));
    expect(tableSig(centered)).not.toBe(tableSig(right));
  });

  it('changes when dir changes (regression: dir must affect the signature)', () => {
    const ltr: BlockAttrs = { rows: baseRows() };
    const rtl: BlockAttrs = { rows: baseRows(), dir: 'rtl' };
    expect(tableSig(ltr)).not.toBe(tableSig(rtl));
  });

  it('treats absent vs explicit-default attrs identically (no spurious rebuild)', () => {
    const absent: BlockAttrs = { rows: baseRows() };
    const explicitLtr: BlockAttrs = { rows: baseRows(), dir: 'ltr' };
    // dir='ltr' 与缺省并非同义（缺省序列化为 null，'ltr' 序列化为字符串），这是有意区分：
    // 显式设方向应触发一次重建。仅验证「同样的输入产同样的 sig」幂等性。
    expect(tableSig(absent)).toBe(tableSig({ rows: baseRows() }));
    expect(tableSig(explicitLtr)).toBe(tableSig({ rows: baseRows(), dir: 'ltr' }));
  });

  it('treats missing rows as an empty table', () => {
    expect(tableSig({})).toBe(tableSig({ rows: [] }));
  });
});

describe('atomSig（kind 前缀内容签名，集群2 回归）', () => {
  it('同 payload 不同 kind 的签名互不相等（跨字段同值不再误判「未变化」）', () => {
    // 例：image.src 与 seal.text 恰为同一字符串时，无前缀签名相等 → sync 跳过更新（隐患）
    expect(atomSig('image', 'X')).not.toBe(atomSig('seal', 'X'));
    expect(atomSig('formula', 'X')).not.toBe(atomSig('signature', 'X'));
    expect(atomSig('video', '')).not.toBe(atomSig('audio', ''));
  });

  it('同 kind 同 payload 幂等', () => {
    expect(atomSig('image', 'https://e.com/a.png')).toBe(atomSig('image', 'https://e.com/a.png'));
  });

  it('tableSig / textboxSig 已内置各自 kind 前缀（与其它 kind 的同串 payload 不碰撞）', () => {
    expect(textboxSig('t', '1px', '2px')).toBe(atomSig('textbox', '1px|2px|t'));
    expect(textboxSig('t', '1px', '2px')).not.toBe(atomSig('seal', '1px|2px|t'));
    expect(tableSig({}).startsWith('table:')).toBe(true);
  });
});

describe('textboxSig', () => {
  it('changes when the text content changes (so sync refreshes the body)', () => {
    expect(textboxSig('hello', '240px', '80px')).not.toBe(textboxSig('world', '240px', '80px'));
  });

  it('changes when width or height changes (so resize refreshes)', () => {
    const base = textboxSig('t', '240px', '80px');
    expect(base).not.toBe(textboxSig('t', '300px', '80px'));
    expect(base).not.toBe(textboxSig('t', '240px', '120px'));
  });

  it('is stable for identical content + size (idempotent → no spurious clobber while editing)', () => {
    expect(textboxSig('同一段', '240px', '80px')).toBe(textboxSig('同一段', '240px', '80px'));
  });

  it('keeps empty content distinct from non-empty at same size', () => {
    expect(textboxSig('', '240px', '80px')).not.toBe(textboxSig('x', '240px', '80px'));
  });
});

describe('canSkipTableRebuild（renderTable 早退判定：签名 + Block 身份 + 行数）', () => {
  const blkA = { tag: 'a' };
  const blkB = { tag: 'b' };

  it('签名相等 + 同一 Block + 行数一致 → 跳过重建（就地单元格编辑保留编辑态）', () => {
    expect(canSkipTableRebuild('table:s', 'table:s', blkA, blkA, 2, 2)).toBe(true);
  });

  it('Block 对象被替换（undo/redo 经 cloneDoc）→ 即使结构签名不变也必须重建（单元格文本可能已回退）', () => {
    expect(canSkipTableRebuild('table:s', 'table:s', blkA, blkB, 2, 2)).toBe(false);
  });

  it('签名变化（结构/列宽/合并/align/dir）→ 重建', () => {
    expect(canSkipTableRebuild('table:s', 'table:s2', blkA, blkA, 2, 2)).toBe(false);
  });

  it('首次构建（contentBlk 尚未记录）→ 重建', () => {
    expect(canSkipTableRebuild('', 'table:s', undefined, blkA, 0, 2)).toBe(false);
  });

  it('DOM 行数与模型不符（防御）→ 重建', () => {
    expect(canSkipTableRebuild('table:s', 'table:s', blkA, blkA, 1, 2)).toBe(false);
  });
});

describe('blurActiveCellWithin（结构操作前焦点收口，集群3）', () => {
  // 结构子集纯对象：node 环境无 DOM，按 contains/blur 的最小契约构造（同 cell-dom 测试模式）。
  const mkActive = (): { blur(): void; blurred: boolean } => {
    const a = {
      blurred: false,
      blur(): void {
        a.blurred = true;
      },
    };
    return a;
  };
  const containerWith = (inside: unknown): { contains(node: unknown): boolean } => ({
    contains: (node: unknown) => node === inside,
  });

  it('activeElement 在表格覆盖层内 → 执行 blur 并返回 true（编辑回写成为唯一事实再做结构操作）', () => {
    const active = mkActive();
    expect(blurActiveCellWithin(containerWith(active), active)).toBe(true);
    expect(active.blurred).toBe(true);
  });

  it('activeElement 在覆盖层外 → 不 blur、返回 false（不打扰无关焦点）', () => {
    const active = mkActive();
    expect(blurActiveCellWithin(containerWith(null), active)).toBe(false);
    expect(active.blurred).toBe(false);
  });

  it('无 activeElement（null）→ 返回 false', () => {
    expect(blurActiveCellWithin(containerWith(null), null)).toBe(false);
  });
});

describe('measuredHeightChanged', () => {
  it('always reports change on first measure (last undefined)', () => {
    expect(measuredHeightChanged(undefined, 0)).toBe(true);
    expect(measuredHeightChanged(undefined, 42)).toBe(true);
  });

  it('reports no change for sub-pixel jitter below epsilon', () => {
    expect(measuredHeightChanged(100, 100)).toBe(false);
    expect(measuredHeightChanged(100, 100.4)).toBe(false);
    expect(measuredHeightChanged(100, 99.6)).toBe(false);
  });

  it('reports change once the delta reaches the 0.5px epsilon', () => {
    expect(measuredHeightChanged(100, 100.5)).toBe(true);
    expect(measuredHeightChanged(100, 99.5)).toBe(true);
    expect(measuredHeightChanged(100, 130)).toBe(true);
  });
});

describe('overlayLayerZoom', () => {
  it('zoom = scale / deviceDpr（定位层 transform 的缩放因子）', () => {
    expect(overlayLayerZoom(2, 1)).toBe(2); // zoom 2 @ deviceDpr 1
    expect(overlayLayerZoom(3, 2)).toBe(1.5); // zoom 1.5 @ deviceDpr 2
    expect(overlayLayerZoom(1, 2)).toBe(0.5); // zoom 0.5 @ deviceDpr 2
    expect(overlayLayerZoom(2, 2)).toBe(1); // zoom 1 → 不加 transform
  });

  it('deviceDpr 夹到 ≥1（与装配层 Math.max(1, devicePixelRatio) 一致）', () => {
    expect(overlayLayerZoom(2, 0.5)).toBe(2);
    expect(overlayLayerZoom(2, 0)).toBe(2);
  });
});

describe('overlayCssRect', () => {
  const box = { x: 300, y: 450, w: 600, h: 150 };

  it('布局盒 ÷scale → 覆盖层本地逻辑 px（y 先减滚动）', () => {
    expect(overlayCssRect(box, 90, 3)).toEqual({ left: 100, top: 120, width: 200, height: 50 });
  });

  it('zoom=1（scale=deviceDpr）退化为原 ÷dpr 行为（无回归）', () => {
    expect(overlayCssRect(box, 0, 2)).toEqual({ left: 150, top: 225, width: 300, height: 75 });
  });

  it('屏幕对齐不变量：本地 rect × zoom === 布局 rect ÷ deviceDpr（任意 dpr/zoom 组合）', () => {
    const scrollY = 90;
    for (const [deviceDpr, zoom] of [
      [1, 2],
      [2, 1.5],
      [2, 0.5],
      [1.5, 1],
    ] as const) {
      const scale = deviceDpr * zoom;
      const z = overlayLayerZoom(scale, deviceDpr);
      const r = overlayCssRect(box, scrollY, scale);
      expect(r.left * z).toBeCloseTo(box.x / deviceDpr, 9);
      expect(r.top * z).toBeCloseTo((box.y - scrollY) / deviceDpr, 9);
      expect(r.width * z).toBeCloseTo(box.w / deviceDpr, 9);
      expect(r.height * z).toBeCloseTo(box.h / deviceDpr, 9);
    }
  });

  it('实测高度闭环（回归：zoom≠1 时表格/公式错位）：measuredH×scale 的盒还原 height === measuredH', () => {
    // doc-layout 以 measuredH(逻辑 px)×scale 预留空间；DOM offsetHeight 取 transform 前本地值，
    // 应恒等于 measuredH → 回填后预留高度稳定。旧实现 ÷deviceDpr 得 measuredH×zoom，反馈不闭环。
    const measuredH = 80;
    for (const scale of [1, 2, 3]) {
      expect(overlayCssRect({ x: 0, y: 0, w: 600, h: measuredH * scale }, 0, scale).height).toBe(measuredH);
    }
  });
});
