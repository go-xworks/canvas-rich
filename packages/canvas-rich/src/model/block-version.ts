import type { Block } from './schema';

// 块版本计数（model 层，零依赖）：RichDoc 在每个变更点 touch，布局缓存据此判断块几何是否陈旧。
// 选型依据：本仓编辑路径以「原地 mutate」为常态（换 inlines 数组 / 直写 attrs 字段，不换 Block 对象），
// 且覆盖层跨帧持有 Block 活引用回写（textbox content / 表格单元格）——CoW 换块引用会使这些闭包引用
// 变僵尸，故采用 WeakMap 显式版本：块对象被整体替换（undo/redo 的 cloneDoc）时天然 miss。

const versions = new WeakMap<Block, number>();
let seq = 0;

/**
 * 标记某块发生几何相关变更（版本号自增）。RichDoc 的所有写路径（文本编辑 / mark / 块属性 /
 * 表格结构 / 原子属性）必须调用；新建块无需调用（WeakMap 缺省版本 0，缓存天然 miss）。
 * @public
 */
export function touchBlock(b: Block): void {
  versions.set(b, ++seq);
}

/** 读取某块当前版本号（从未 touch 过的块恒为 0）。 @public */
export function blockVersion(b: Block): number {
  return versions.get(b) ?? 0;
}
