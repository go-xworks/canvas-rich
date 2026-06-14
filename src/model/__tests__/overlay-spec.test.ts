import { describe, it, expect } from 'vitest';
import { blockMeta, overlaySpecOf, atomSizeAttrs, OverlaySpec } from '../block-specs';
import { BlockType } from '../schema';

// 覆盖层规格表（overlaySpec SSOT）一致性测试：
// 1) 全部原子块均已填表、非原子块不填表；
// 2) 各 sizing 策略的字段完备性（fullWidth 必有 fixedHeight、explicit 必有 defaultH 等）；
// 3) 逐 kind 锁定与历史散落常量一致的默认值（行为零变化的回归基线）；
// 4) atomSizeAttrs 派生（insert* 默认尺寸）与表一致。

const ALL_TYPES = Object.keys(blockMeta) as BlockType[];
const ATOM_TYPES = ALL_TYPES.filter((t) => blockMeta[t].atom);

describe('overlaySpec 表覆盖', () => {
  it('全部原子块（11 种）均填了 overlaySpec', () => {
    expect(ATOM_TYPES.length).toBe(11);
    for (const t of ATOM_TYPES) expect(blockMeta[t].overlaySpec, `${t} 缺 overlaySpec`).toBeDefined();
  });

  it('非原子块不填 overlaySpec', () => {
    for (const t of ALL_TYPES) {
      if (!blockMeta[t].atom) expect(blockMeta[t].overlaySpec, `${t} 不应有 overlaySpec`).toBeUndefined();
    }
  });

  it('sizing 策略字段完备：fullWidth 必有 fixedHeight；explicit/measured 必有 defaultH', () => {
    for (const t of ATOM_TYPES) {
      const s = blockMeta[t].overlaySpec!;
      if (s.sizing === 'fullWidth') {
        expect(s.fixedHeight, `${t} fullWidth 缺 fixedHeight`).toBeGreaterThan(0);
      } else {
        expect(s.defaultH, `${t} ${s.sizing} 缺 defaultH`).toBeGreaterThan(0);
      }
    }
  });

  it('resizable 当且仅当 sizing 为 explicit（音频/附件/公式/表格无手柄）', () => {
    for (const t of ATOM_TYPES) {
      const s = blockMeta[t].overlaySpec!;
      expect(s.resizable, `${t} 的 resizable 应与 sizing===explicit 一致`).toBe(s.sizing === 'explicit');
    }
  });
});

describe('overlaySpec 逐 kind 默认值（锁定历史行为）', () => {
  const expected: Record<string, OverlaySpec> = {
    image: { defaultH: 200, sizing: 'explicit', resizable: true }, // 无 defaultW = 默认满内容宽
    shape: { defaultW: 200, defaultH: 120, sizing: 'explicit', resizable: true },
    video: { defaultW: 480, defaultH: 270, sizing: 'explicit', resizable: true },
    iframe: { defaultW: 480, defaultH: 270, sizing: 'explicit', resizable: true },
    signature: { defaultW: 220, defaultH: 90, sizing: 'explicit', resizable: true },
    seal: { defaultW: 120, defaultH: 120, sizing: 'explicit', resizable: true },
    textbox: { defaultW: 240, defaultH: 80, sizing: 'explicit', resizable: true },
    audio: { sizing: 'fullWidth', resizable: false, fixedHeight: 54 },
    attachment: { sizing: 'fullWidth', resizable: false, fixedHeight: 64 },
    formula: { defaultH: 52, sizing: 'measured', resizable: false },
    table: { defaultH: 120, sizing: 'measured', resizable: false },
  };

  it('期望表覆盖全部原子块且逐项相等', () => {
    expect(Object.keys(expected).sort()).toEqual([...ATOM_TYPES].sort());
    for (const t of ATOM_TYPES) expect(overlaySpecOf(t), `${t} 规格不符`).toEqual(expected[t]);
  });

  it('未填表类型（非原子块）回退 measured 兜底（满宽实测、无手柄）', () => {
    expect(overlaySpecOf('paragraph')).toEqual({ sizing: 'measured', resizable: false });
    expect(overlaySpecOf('toc')).toEqual({ sizing: 'measured', resizable: false });
  });
});

describe('atomSizeAttrs（insert* 默认尺寸派生）', () => {
  it('有 defaultW/defaultH 的 kind 返回 width/height', () => {
    expect(atomSizeAttrs('video')).toEqual({ width: 480, height: 270 });
    expect(atomSizeAttrs('iframe')).toEqual({ width: 480, height: 270 });
    expect(atomSizeAttrs('signature')).toEqual({ width: 220, height: 90 });
    expect(atomSizeAttrs('seal')).toEqual({ width: 120, height: 120 });
    expect(atomSizeAttrs('textbox')).toEqual({ width: 240, height: 80 });
    expect(atomSizeAttrs('shape')).toEqual({ width: 200, height: 120 });
  });

  it('无显式默认宽（image 满内容宽）或非原子块返回 {}（attrs 不写尺寸键）', () => {
    expect(atomSizeAttrs('image')).toEqual({});
    expect(atomSizeAttrs('audio')).toEqual({});
    expect(atomSizeAttrs('attachment')).toEqual({});
    expect(atomSizeAttrs('paragraph')).toEqual({});
  });
});
