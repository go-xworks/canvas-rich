import { Doc } from '../model/schema';
import { toHtml } from '../model/export';
import { wrapScoped } from '../editor/scope';

// 平行 ARIA 无障碍树（参考 Google Docs / 腾讯文档）：
// - canvas 设 aria-hidden（否则读屏报成无名图）。
// - 一个「离屏但可被读屏访问」的语义镜像（裁剪法，非 display:none），浏览模式可读文档结构。
// - 一个 aria-live=polite 区域，主动播报「语义事件」（块类型、格式开关、插入等），不逐字播报。
// 分层：ui（呈现层，由 model/export 生成语义 HTML 镜像，供读屏访问）。

const CSS = `
.rte-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
`;

/**
 * 无障碍树句柄：刷新语义镜像、播报 live 区域语义事件、销毁（移除 head 样式 + body 镜像/live 节点）。
 * @internal
 */
export interface AriaTree {
  update(doc: Doc): void;
  announce(msg: string): void;
  destroy(): void;
}

/**
 * 构建平行 ARIA 无障碍树：隐藏 canvas、标注 IME，挂接离屏语义镜像与 live 播报区。
 * 不变量：live 区域初始为空，update 仅在 HTML 变化时重写镜像（避免无意义播报）。
 * @internal
 */
export function createAriaTree(canvas: HTMLElement, ime: HTMLElement): AriaTree {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  canvas.setAttribute('aria-hidden', 'true');
  ime.setAttribute('aria-label', '富文本编辑器，使用箭头键浏览，工具栏设置格式');
  ime.setAttribute('aria-multiline', 'true');

  // 语义镜像（读屏浏览模式可遍历）
  const mirror = document.createElement('div');
  mirror.className = 'rte-sr-only';
  mirror.setAttribute('role', 'document');
  mirror.setAttribute('aria-label', '文档内容');

  // live region（初始必须为空，否则加载时的内容不被当作变化播报）
  const live = document.createElement('div');
  live.className = 'rte-sr-only';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  // mirror + live 共用一个 .canvas-rich(display:contents) wrapper 挂 body。注意：上面的 .rte-sr-only
  // 是本文件运行时直接注入 document.head 的裸全局规则（const CSS，未经 build 作用域插件改写），故镜像/
  // live 节点本不依赖 .canvas-rich 祖先即可命中。包裹的真实作用是：与其它门户保持一致的统一回收路径，
  // 并让 --rte-* 令牌沿 wrapper 继承（若 mirror 内将来用到作用域化 utility/令牌则需要）。wrapper 用
  // display:contents 对布局透明，不破坏 .rte-sr-only 的 position:absolute 裁剪（destroy 移除 wrapper）。
  const scopeWrap = wrapScoped(mirror);
  scopeWrap.appendChild(live);
  document.body.appendChild(scopeWrap);

  let lastHtml = '';
  return {
    update(doc: Doc) {
      const html = toHtml(doc);
      if (html !== lastHtml) {
        mirror.innerHTML = html;
        lastHtml = html;
      }
    },
    announce(msg: string) {
      // 先清空再写，确保相同/重复消息也被重新播报
      live.textContent = '';
      window.setTimeout(() => {
        live.textContent = msg;
      }, 30);
    },
    destroy() {
      style.remove();
      scopeWrap.remove(); // 连同内部 mirror + live 一并回收
    },
  };
}
