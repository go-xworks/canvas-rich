// ui 层 · DOM 取元素小工具：mustEl 按 id 取元素并断言存在，缺失时抛带 id 的错误（装配期 fail-fast）。
// 替代 `getElementById(...) as T` / `!` 断言——外壳结构（index.html）变更时立刻报错而非延迟空指针。

/**
 * 取 id 对应的 DOM 元素并断言存在；取不到立即抛出带 id 的错误。
 * @param id 元素 id（不含 `#`）
 * @returns 命中的元素（按调用方声明的具体子类型返回）
 * @internal
 */
export function mustEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[dom] 找不到元素 #${id}（index.html 外壳结构可能已变更）`);
  return el as T;
}
