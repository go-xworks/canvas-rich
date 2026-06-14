/**
 * 触屏选区手柄（ui 层）：非折叠选区时在选区首末渲染两个圆头手柄（DOM overlay），
 * 命中区 44×44 CSS px（Apple HIG / WCAG 2.5.8），拖动经装配层 hit-test 回写 anchor/focus。
 * 仅触屏交互后显示（visible 由装配层依据最近 pointerType 决定），不参与鼠标流。
 */
import type { Pos } from '../model/rich-document';

/** 手柄命中区边长（CSS px）。 @internal */
export const HANDLE_HIT_PX = 44;
/** 手柄可视圆点直径（CSS px）。 @internal */
export const HANDLE_DOT_PX = 14;
/** 拖动手柄时命中点的纵向上移量（CSS px）：手指落在行下方的圆点上，折回其标注的文本行。 */
const HANDLE_HIT_Y_OFFSET = 24;

/** 选区一端的手柄锚点几何（CSS px，相对 editor 容器；x 为光标线、top/bottom 为行界）。 @internal */
export interface HandleAnchor { x: number; top: number; bottom: number }

/** sync 输入：可见性 + 选区两端几何与文档位置（start ≤ end，已规范化）。 @internal */
export interface SelectionHandleState {
  visible: boolean;
  start: HandleAnchor | null;
  end: HandleAnchor | null;
  startPos: Pos;
  endPos: Pos;
}

/** 选区手柄的装配层依赖。 @internal */
export interface SelectionHandlesDeps {
  /** 屏幕 client 坐标 → 文档位置（拖动手柄时命中）。 */
  posAtClient(clientX: number, clientY: number): Pos;
  /** 拖动中回写选区：anchor = 固定端、focus = 拖动端（跨越固定端时选区自然翻转）。 */
  onDrag(anchor: Pos, focus: Pos): void;
}

/** 选区手柄控制器：渲染帧 sync 跟随布局，dragging() 供装配层在拖动中保持可见。 @internal */
export interface SelectionHandles {
  /** 渲染帧同步：定位/显隐两手柄（visible=false 或几何缺失时隐藏）。 */
  sync(state: SelectionHandleState): void;
  /** 是否正在拖动某个手柄。 */
  dragging(): boolean;
}

/** 创建触屏选区手柄对（DOM 圆点 + 44px 透明命中区），挂到 editor 容器。 @internal */
export function createSelectionHandles(container: HTMLElement, deps: SelectionHandlesDeps): SelectionHandles {
  let last: SelectionHandleState | null = null;
  let drag: { which: 'start' | 'end'; fixed: Pos } | null = null;

  const mkHandle = (which: 'start' | 'end'): HTMLDivElement => {
    const hit = document.createElement('div');
    // touch-action:none：手柄拖动是持续 pointermove 流，禁掉浏览器平移手势接管（防 pointercancel 中断）
    hit.style.cssText = `position:absolute;width:${HANDLE_HIT_PX}px;height:${HANDLE_HIT_PX}px;`
      + `margin-left:${-HANDLE_HIT_PX / 2}px;display:none;touch-action:none;z-index:40;`;
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;left:50%;top:0;width:${HANDLE_DOT_PX}px;height:${HANDLE_DOT_PX}px;`
      + `margin-left:${-HANDLE_DOT_PX / 2}px;border-radius:50%;background:var(--rte-accent);`
      + 'box-shadow:0 1px 4px rgba(0,0,0,0.35);';
    hit.appendChild(dot);
    hit.addEventListener('pointerdown', (e) => {
      if (!last) return;
      e.preventDefault();
      e.stopPropagation();
      hit.setPointerCapture(e.pointerId);
      // 固定端 = 另一手柄当下的文档位置（拖动期间不变，选区围绕它伸缩/翻转）
      drag = { which, fixed: which === 'start' ? last.endPos : last.startPos };
    });
    hit.addEventListener('pointermove', (e) => {
      if (!drag || drag.which !== which) return;
      deps.onDrag(drag.fixed, deps.posAtClient(e.clientX, e.clientY - HANDLE_HIT_Y_OFFSET));
    });
    const endDrag = (e: PointerEvent) => {
      if (drag?.which === which) drag = null;
      try { hit.releasePointerCapture(e.pointerId); } catch { /* 未捕获时忽略 */ }
    };
    hit.addEventListener('pointerup', endDrag);
    hit.addEventListener('pointercancel', endDrag);
    container.appendChild(hit);
    return hit;
  };

  const startEl = mkHandle('start');
  const endEl = mkHandle('end');

  const place = (el: HTMLDivElement, a: HandleAnchor) => {
    el.style.left = a.x + 'px';
    el.style.top = a.bottom + 'px'; // 圆点悬在行底之下（Android 水滴风格），命中区向下延伸
    el.style.display = '';
  };

  return {
    sync(state: SelectionHandleState): void {
      last = state;
      if (!state.visible || !state.start || !state.end) {
        startEl.style.display = 'none';
        endEl.style.display = 'none';
        return;
      }
      place(startEl, state.start);
      place(endEl, state.end);
    },
    dragging(): boolean { return drag !== null; },
  };
}
