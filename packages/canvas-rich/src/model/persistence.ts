// 文档草稿持久化（model 层）：把 doc JSON + 选区写入 localStorage（自动保存），启动时恢复。
// 提供序列化/反序列化（逐块结构校验，损坏 JSON 安全回退）与防抖自动保存调度器；
// 事件订阅与 beforeunload 接线在装配层 main.ts——本模块不依赖 UI/事件总线（node 可测）。
import { Doc, sanitizeStoredBlocks } from './schema';
import type { Pos } from './rich-document';

/** 文档草稿在 localStorage 中的键。 @public */
export const DRAFT_KEY = 'rte.draft';
/** 自动保存防抖延迟（ms）：doc:changed 后静默该时长才落盘。 @public */
export const DRAFT_DEBOUNCE_MS = 800;

/** 持久化的文档草稿：文档树 + 选区端点 + 保存时刻（ms 时间戳）。 @public */
export interface Draft {
  doc: Doc;
  anchor: Pos;
  focus: Pos;
  savedAt: number;
}

// 安全取 localStorage（SSR/单测/隐私模式下不存在则返回 null）；与 templates.ts 同护栏。
function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// 选区端点形状（反序列化校验）：block/offset 均为有限数。clamp 由 RichDoc 恢复时负责。
function isPosShape(v: unknown): v is Pos {
  if (!v || typeof v !== 'object') return false;
  const p = v as { block?: unknown; offset?: unknown };
  return (
    typeof p.block === 'number' && Number.isFinite(p.block) && typeof p.offset === 'number' && Number.isFinite(p.offset)
  );
}

/** 把文档 + 选区序列化为草稿 JSON 字符串。 @public */
export function serializeDraft(doc: Doc, anchor: Pos, focus: Pos, savedAt = Date.now()): string {
  return JSON.stringify({ doc, anchor, focus, savedAt } satisfies Draft);
}

/**
 * 把草稿 JSON 反序列化为 Draft：损坏 JSON / 非对象 / 无合法块时返回 null（调用方回退演示文档）。
 * 块经 schema 的 {@link sanitizeStoredBlocks} 逐块校验（畸形块剔除并 warn）；
 * 选区端点畸形时回退文首（恢复端 RichDoc.setSel 再做范围 clamp）。 @public
 */
export function parseDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const d = parsed as { doc?: { blocks?: unknown }; anchor?: unknown; focus?: unknown; savedAt?: unknown };
    const blocks = sanitizeStoredBlocks(d.doc?.blocks, '文档草稿');
    if (blocks.length === 0) return null;
    const start: Pos = { block: 0, offset: 0 };
    return {
      doc: { blocks },
      anchor: isPosShape(d.anchor) ? { block: d.anchor.block, offset: d.anchor.offset } : start,
      focus: isPosShape(d.focus) ? { block: d.focus.block, offset: d.focus.offset } : start,
      savedAt: typeof d.savedAt === 'number' && Number.isFinite(d.savedAt) ? d.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 从 localStorage 读取草稿（无存储/无草稿/损坏时返回 null）。 @public */
export function loadDraft(): Draft | null {
  const store = ls();
  if (!store) return null;
  try {
    return parseDraft(store.getItem(DRAFT_KEY));
  } catch {
    return null;
  }
}

/**
 * 把当前文档 + 选区写入 localStorage 草稿；成功返回 true。
 * 写入失败（QuotaExceeded：超大 dataURL 图片等 / 隐私模式）时降级跳过：
 * console.warn 并返回 false，不抛出、不阻塞编辑。 @public
 */
export function saveDraft(doc: Doc, anchor: Pos, focus: Pos): boolean {
  const store = ls();
  if (!store) return false;
  try {
    store.setItem(DRAFT_KEY, serializeDraft(doc, anchor, focus));
    return true;
  } catch (err) {
    console.warn('[persistence] 草稿写入失败（可能超出 localStorage 配额），本次自动保存跳过：', err);
    return false;
  }
}

/** 删除已保存的草稿（如「新建空白文档」场景；无存储时静默）。 @public */
export function clearDraft(): void {
  try {
    ls()?.removeItem(DRAFT_KEY);
  } catch {
    /* 隐私模式等：忽略 */
  }
}

/**
 * 防抖自动保存调度器句柄：`schedule` 标脏并重置防抖计时；`flush` 立即落盘（beforeunload 用）；
 * `dirty` 为「有未保存变更」标志（状态栏指示用）。 @public
 */
export interface Autosaver {
  /** 是否有未保存变更（schedule 后置位，persist 成功后复位）。 */
  readonly dirty: boolean;
  /** 内容变更时调用：标脏 + 重置防抖计时，静默 delayMs 后执行 persist。 */
  schedule(): void;
  /** 取消待定计时并立即 persist（若脏）；返回「当前已无未保存变更」。 */
  flush(): boolean;
}

/**
 * 创建防抖自动保存调度器。persist 返回是否落盘成功（失败保持脏标记，下次变更重试）；
 * onStateChange 在脏标记翻转时回调（接状态栏保存指示）。 @public
 */
export function createAutosaver(
  persist: () => boolean,
  onStateChange?: (dirty: boolean) => void,
  delayMs: number = DRAFT_DEBOUNCE_MS,
): Autosaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  const setDirty = (next: boolean): void => {
    if (dirty === next) return;
    dirty = next;
    onStateChange?.(next);
  };
  const persistNow = (): boolean => {
    if (persist()) {
      setDirty(false);
      return true;
    }
    return false;
  };
  return {
    get dirty() {
      return dirty;
    },
    schedule() {
      setDirty(true);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        persistNow();
      }, delayMs);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return dirty ? persistNow() : true;
    },
  };
}
