/**
 * 作用域包裹助手（editor 层）：库 CSS 经构建期作用域化为 `.canvas-rich <sel>`（后代组合），
 * 仅命中 `.canvas-rich` 元素的**后代**——故外壳根与所有 body/head 门户都必须被一个
 * `.canvas-rich` 包裹元素套住，库样式才命中、`--rte-*` 令牌才沿 DOM 树继承进去。
 *
 * 关键不变量：用「包裹 div」而非「给已有根加 class」。`.canvas-rich .rte-shell` 不匹配
 * `.canvas-rich` 元素自身，若把 class 直接加到 `.rte-shell` 上，其自身那条规则反而不命中。
 * 包裹 div 用 `display:contents`：对 flex/grid 布局完全透明（不产生盒、不占位），纯作为
 * CSS 后代作用域祖先存在，故 demo 视觉/布局零变化。
 *
 * 全局足迹：仅注入一条全局规则 `.canvas-rich{display:contents}`（{@link ensureScopeStyle}，
 * 页面级幂等单例）。这是库唯一进全局的 CSS，零布局影响、不与宿主冲突。
 *
 * 分层：editor（编辑装配层；纯 DOM 工具，不接业务）。
 */

/** 作用域祖先类名（与构建期 `build/scope-css.ts` 的 `SCOPE_CLASS` 保持一致）。 @internal */
export const SCOPE_CLASS = 'canvas-rich';

/** 注入全局规则的 `<style>` id（幂等守卫）。 */
const SCOPE_STYLE_ID = 'canvas-rich-scope-style';

/**
 * 幂等注入全局唯一规则 `.canvas-rich{display:contents}`（页面级单例，跨实例共享）。
 * 这是 wrapper 生效的前提：让包裹 div 对布局透明，又作为后代作用域祖先存在。
 * @internal
 */
export function ensureScopeStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SCOPE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SCOPE_STYLE_ID;
  style.textContent = `.${SCOPE_CLASS}{display:contents}`;
  document.head.appendChild(style);
}

/**
 * 用一个 `display:contents` 的 `.canvas-rich` 包裹 div 套住 `el`（作 CSS 后代作用域祖先），
 * 返回该包裹 div（供调用方挂载到目标父级 / destroy 时整体移除）。
 *
 * 注意：本函数不把 wrapper append 到任何父级（由调用方决定挂载点：外壳挂宿主 target，
 * 各门户挂 document.body）。`el` 被移入 wrapper（`append` 会自动从原父级搬移）。
 *
 * @param el - 被作用域包裹的元素（外壳根或某门户根）。
 * @returns 包裹 div（class=`canvas-rich`，`display:contents`）。
 * @internal
 */
export function wrapScoped(el: HTMLElement): HTMLElement {
  ensureScopeStyle();
  const wrap = document.createElement('div');
  wrap.className = SCOPE_CLASS;
  wrap.style.display = 'contents';
  wrap.appendChild(el);
  return wrap;
}
