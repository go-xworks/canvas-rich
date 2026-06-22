// 电子签名弹层（ui 层）：模态画板，pointer 事件手绘签名笔迹，含「清除」「确定」。
// 确定时 canvas.toDataURL('image/png') 产出透明底签名 PNG dataURL；取消返回 null。
// 亮色/暗色均用 --rte-* 变量；笔迹色取墨黑（恒定，不随主题，保签名落地一致）。
// 分层：纯 DOM 控件，不依赖 model。
import { icon } from './icons';
import { wrapScoped } from '../editor/scope';

/** 签名弹层句柄：弹出画板并解析为签名 PNG dataURL（取消/空白返回 null）；销毁（移除 body 门户节点）。 @internal */
export interface SignatureDialog {
  open(): Promise<string | null>;
  destroy(): void;
}

// 画板逻辑尺寸（CSS px）；内部按 dpr 放大物理像素，保手绘笔迹清晰不糊。
const PAD_W = 420;
const PAD_H = 170;
// 签名笔迹色（墨黑）：恒定，不取 --rte-*，使导出 PNG 在任意背景上语义一致。
const INK = '#1a1a2e';
const LINE_W = 2.4;

/**
 * 创建挂到 document.body 的单例签名画板弹层。
 * @internal
 */
export function createSignatureDialog(): SignatureDialog {
  const scrim = document.createElement('div');
  scrim.className = 'fixed inset-0 bg-[var(--rte-scrim)] hidden items-center justify-center z-[70]';
  const card = document.createElement('div');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '手写签名');
  card.className =
    'w-[min(480px,94vw)] bg-[var(--rte-overlay-bg)] border border-[var(--rte-overlay-border)] ' +
    'rounded-[10px] shadow-[var(--rte-shadow)] flex flex-col overflow-hidden font-sans';
  const titleEl = document.createElement('div');
  titleEl.className = 'px-4 pt-4 pb-1 text-[14px] font-medium text-[var(--rte-text)]';
  titleEl.textContent = '手写签名';
  const hint = document.createElement('div');
  hint.className = 'px-4 text-[12px] text-[var(--rte-muted)]';
  hint.textContent = '在下方区域按住并拖动书写签名';
  const body = document.createElement('div');
  body.className = 'px-4 py-2 flex flex-col gap-2';

  // 画板：CSS 尺寸固定、物理像素按 dpr 放大；透明底（toDataURL 保留透明，便于叠加文档）。
  const pad = document.createElement('canvas');
  pad.className =
    'w-full rounded-md border border-[var(--rte-overlay-border)] bg-[var(--rte-canvas)] touch-none cursor-crosshair';
  pad.style.height = PAD_H + 'px';
  pad.setAttribute('aria-label', '签名画板');
  body.appendChild(pad);

  const footer = document.createElement('div');
  footer.className = 'px-4 py-3 flex justify-end gap-2';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className =
    'px-3 py-1.5 mr-auto rounded-md border border-[var(--rte-overlay-border)] bg-transparent ' +
    'text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer appearance-none inline-flex items-center gap-1 ' +
    'hover:bg-[var(--rte-chrome-hover)]';
  clearBtn.innerHTML = icon('eraser', 14) + '<span>清除</span>';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  cancelBtn.className =
    'px-3 py-1.5 rounded-md border border-[var(--rte-overlay-border)] bg-transparent ' +
    'text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer appearance-none hover:bg-[var(--rte-chrome-hover)]';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.textContent = '确定';
  okBtn.className =
    'px-3.5 py-1.5 rounded-md border-0 bg-[var(--rte-accent)] text-white text-[13px] cursor-pointer ' +
    'appearance-none hover:opacity-90 disabled:opacity-40 disabled:cursor-default';
  footer.append(clearBtn, cancelBtn, okBtn);

  card.append(titleEl, hint, body, footer);
  scrim.appendChild(card);
  // 作用域包裹：scrim 进 .canvas-rich(display:contents) wrapper 再挂 body（作用域化 utility 命中 + 令牌继承）。
  const scopeWrap = wrapScoped(scrim);
  document.body.appendChild(scopeWrap);

  let resolver: ((v: string | null) => void) | null = null;
  let drawing = false;
  let dirty = false; // 是否落过笔（空白画板不应产出签名）
  let dpr = 1;

  const ctx = (): CanvasRenderingContext2D => pad.getContext('2d')!;

  // 重置画板物理像素 + 透明清空 + 笔触参数（每次打开按当前 dpr / 实际 CSS 宽度初始化）。
  const reset = (): void => {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = pad.clientWidth || PAD_W;
    pad.width = Math.round(cssW * dpr);
    pad.height = Math.round(PAD_H * dpr);
    const c = ctx();
    c.setTransform(dpr, 0, 0, dpr, 0, 0); // 逻辑 px 坐标系
    c.clearRect(0, 0, cssW, PAD_H); // 透明底
    c.lineWidth = LINE_W;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = INK;
    dirty = false;
    okBtn.disabled = true;
  };

  // 事件坐标 → 画板逻辑 px（CSS 坐标，已由 setTransform 映射到物理像素）。
  const localXY = (e: PointerEvent): { x: number; y: number } => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件/无效指针 */
    }
    drawing = true;
    const { x, y } = localXY(e);
    const c = ctx();
    c.beginPath();
    c.moveTo(x, y);
    // 单击点也留一个点（极短笔画），使「点一下」也算签名内容
    c.lineTo(x + 0.01, y + 0.01);
    c.stroke();
    dirty = true;
    okBtn.disabled = false;
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = localXY(e);
    const c = ctx();
    c.lineTo(x, y);
    c.stroke();
  });
  const endStroke = (e: PointerEvent): void => {
    if (!drawing) return;
    drawing = false;
    try {
      pad.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
  };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  const close = (v: string | null): void => {
    if (!resolver) return;
    const r = resolver;
    resolver = null;
    scrim.classList.add('hidden');
    scrim.classList.remove('flex');
    r(v);
  };

  clearBtn.onclick = (e) => {
    e.preventDefault();
    reset();
  };
  cancelBtn.onclick = (e) => {
    e.preventDefault();
    close(null);
  };
  okBtn.onclick = (e) => {
    e.preventDefault();
    if (dirty) close(pad.toDataURL('image/png'));
  };
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close(null);
  });
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(null);
    }
  });

  return {
    open(): Promise<string | null> {
      if (resolver) close(null);
      return new Promise<string | null>((resolve) => {
        resolver = resolve;
        scrim.classList.remove('hidden');
        scrim.classList.add('flex');
        // rAF：scrim 可见后画板已具实际 CSS 宽度，再据其初始化物理像素，避免 0 宽。
        requestAnimationFrame(() => reset());
      });
    },
    destroy() {
      close(null); // 解决可能挂起的 open（避免悬空 Promise）
      scopeWrap.remove();
    },
  };
}
