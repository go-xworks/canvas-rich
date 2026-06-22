/**
 * 微型类型化事件总线（editor 层，抽象③ Observer）：把装配层「内容变 / 选区变 / 视图变」
 * 三类时机从单一 onContentChanged 回调 + 手动逐个 sync 调用，解耦为命名事件的发布-订阅。
 * 无 payload —— 订阅者回调内自行读取当前 rd / zoom / viewMode 等状态，避免事件携带快照。
 * 分层：editor（编辑装配层；不 import ui/model 之外的状态，纯结构）。
 */

/**
 * 编辑器事件枚举：
 * - `doc:changed` 内容变更（重排 + ARIA 镜像 + 面板，= 旧 markDirty 语义）；
 * - `selection:changed` 仅视图/选区变更（重绘 + 工具栏回填，不重排，= 旧 viewChanged/afterNav 语义）；
 * - `view:changed` 视图模式/缩放/整形器/主题切换（重绘 + 工具栏 + 状态栏回填）。
 * @public
 */
export type EditorEvent = 'doc:changed' | 'selection:changed' | 'view:changed';

/** 取消订阅句柄：调用即从总线移除对应监听器。@public */
export type Unsub = () => void;

/**
 * 类型化事件总线：`on` 订阅返回 unsub，`emit` 同步广播（无 payload）。
 * @public
 */
export interface Emitter {
  /** 订阅某事件，返回退订句柄。同一回调重复订阅按 Set 去重。 */
  on(ev: EditorEvent, fn: () => void): Unsub;
  /** 退订某事件的指定回调（未订阅则 no-op）；与 on 返回的 unsub 等效但意图自解释。 */
  off(ev: EditorEvent, fn: () => void): void;
  /** 同步广播某事件：快照遍历当前监听器（容忍回调内退订/再订阅）。 */
  emit(ev: EditorEvent): void;
}

/**
 * 创建一个空事件总线。监听器按事件分桶存 Set；emit 时对当前监听器拍快照再遍历，
 * 故回调内的退订（unsub）或新订阅不影响本轮广播，也不会漏触发已存在的监听器。
 * @public
 */
export function createEmitter(): Emitter {
  const map: Record<EditorEvent, Set<() => void>> = {
    'doc:changed': new Set(),
    'selection:changed': new Set(),
    'view:changed': new Set(),
  };
  return {
    on(ev, fn) {
      map[ev].add(fn);
      return () => map[ev].delete(fn);
    },
    off(ev, fn) {
      map[ev].delete(fn);
    },
    emit(ev) {
      // 拍快照再遍历：容忍回调内退订/再订阅（spread 是本意，非冗余）
      // oxlint-disable-next-line no-useless-spread
      for (const fn of [...map[ev]]) fn();
    },
  };
}
