import { describe, it, expect } from 'vitest';
import { BLOCK_EXPORTERS, CLUSTER_EXPORT_TYPES, PARAGRAPH_FALLBACK_TYPES, toHtml, toMarkdown } from '../export';
import { blockMeta } from '../block-specs';
import { Doc, BlockType, block as mkBlock, text as mkText } from '../schema';

// 块导出注册表（抽象②）覆盖性测试：锁定「新增块类型只改 block-specs / export 一处」的约束。
// 1) blockMeta 的每个块类型都有明确导出归宿：注册表钩子 / 聚类合并 / 段落兜底，三者构成完备分区。
// 2) 兜底路径（未注册类型）输出与 paragraph 一致——新块类型即便忘填钩子也安全降级，不破坏导出。

const ALL_TYPES = Object.keys(blockMeta) as BlockType[];
const REGISTRY_TYPES = Object.keys(BLOCK_EXPORTERS) as BlockType[];

describe('export 注册表覆盖性（block-specs SSOT）', () => {
  it('每个块类型都有明确导出归宿：注册表 / 聚类 / 段落兜底（完备分区、互斥）', () => {
    const cluster = new Set<BlockType>(CLUSTER_EXPORT_TYPES);
    const fallback = new Set<BlockType>(PARAGRAPH_FALLBACK_TYPES);
    const registry = new Set<BlockType>(REGISTRY_TYPES);
    for (const t of ALL_TYPES) {
      const homes = (registry.has(t) ? 1 : 0) + (cluster.has(t) ? 1 : 0) + (fallback.has(t) ? 1 : 0);
      expect(homes, `${t} 应恰好归属一个导出归宿（注册表/聚类/兜底），实得 ${homes}`).toBe(1);
    }
  });

  it('注册表/聚类/兜底三集合不引入 blockMeta 之外的幽灵类型', () => {
    const known = new Set<BlockType>(ALL_TYPES);
    for (const t of [...REGISTRY_TYPES, ...CLUSTER_EXPORT_TYPES, ...PARAGRAPH_FALLBACK_TYPES]) {
      expect(known.has(t), `${t} 不在 blockMeta 中`).toBe(true);
    }
  });

  it('注册表每条钩子同时提供 html 与 md（避免单侧遗漏导致格式不对称）', () => {
    for (const t of REGISTRY_TYPES) {
      const ex = BLOCK_EXPORTERS[t]!;
      expect(typeof ex.html, `${t} 缺 html 钩子`).toBe('function');
      expect(typeof ex.md, `${t} 缺 md 钩子`).toBe('function');
    }
  });

  it('未注册类型走段落兜底：toHtml→<p>、toMarkdown→inlinesMd（与 paragraph 同形）', () => {
    // 构造一个 blockMeta 未覆盖（且不在注册表/聚类内）的合成块类型，验证导出不抛错、降级为段落形态。
    const ghost = '__ghost_block__' as unknown as BlockType;
    const mk = (type: BlockType): Doc => ({ blocks: [mkBlock(type, [mkText('hi <x>')])] });
    expect(toHtml(mk(ghost))).toBe(toHtml(mk('paragraph')));
    expect(toMarkdown(mk(ghost))).toBe(toMarkdown(mk('paragraph')));
    // 且确为段落形态（<p>…</p> / 纯 inlinesMd），转义生效。
    expect(toHtml(mk(ghost))).toBe('<p>hi &lt;x&gt;</p>');
    expect(toMarkdown(mk(ghost))).toBe('hi <x>');
  });
});
