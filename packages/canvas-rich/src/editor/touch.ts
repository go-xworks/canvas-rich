/**
 * 触屏手势基元（editor 层）：单指「平移/长按/点按」判型状态机、双指捏合缩放计算、
 * 虚拟键盘可视高度换算与惯性衰减。全部纯逻辑 + 可注入调度器，node 环境可测（无 DOM 依赖）。
 *
 * @remarks
 * canvas 自绘文本拿不到系统触控行为（区别于 DOM contenteditable），触屏语义在此分流：
 * 单指拖动默认平移滚动（跟手），按下静止约 {@link LONG_PRESS_MS} 进入选区模式（选词 + 拖拽
 * 调整），快速点按为 tap（定位光标）。装配层（main.ts）按 pointerType==='touch' 接入。
 */
import { clamp } from '../shared/util';

/** 长按判定时长（ms）：按下后静止超过该时长进入选区模式。 @public */
export const LONG_PRESS_MS = 500;
/** 单指判型移动容差（设备 px）：按下后位移超出即判为平移，长按计时取消。 @public */
export const TOUCH_SLOP_PX = 10;
/** 拖拽移动文本的启动阈值（CSS px）：选区内按下后位移超过该距离进入拖文本模式。 @public */
export const DRAG_TEXT_MIN_PX = 5;
/** 惯性滚动每帧速度衰减系数（按 16.7ms 帧基准的指数衰减底数）。 @public */
export const INERTIA_DECAY = 0.92;
/** 惯性滚动停止阈值（设备 px/帧）：速度衰减到该值以下归零停帧。 @public */
export const INERTIA_MIN_V = 0.5;

/** 单指手势判型：idle 无活动 / pending 按下未判型 / pan 平移滚动 / select 长按后选区拖拽。 @public */
export type TouchMode = 'idle' | 'pending' | 'pan' | 'select';

/** 定时调度器（可注入）：注册 ms 后回调，返回取消函数。默认 setTimeout。 @public */
export type GestureScheduler = (cb: () => void, ms: number) => () => void;

const defaultScheduler: GestureScheduler = (cb, ms) => {
  const id = setTimeout(cb, ms);
  return () => clearTimeout(id);
};

/** {@link TouchGesture} 构造参数。 @public */
export interface TouchGestureOpts {
  /** 长按触发回调（按下原点坐标，设备 px）；回调前 mode 已切到 'select'。 */
  onLongPress: (x: number, y: number) => void;
  /** 长按判定时长（ms），缺省 {@link LONG_PRESS_MS}。 */
  longPressMs?: number;
  /** 判型移动容差（设备 px），缺省 {@link TOUCH_SLOP_PX}。 */
  slop?: number;
  /** 定时调度器：单测注入手动触发的假实现（运行时时钟不直连 setTimeout）。 */
  schedule?: GestureScheduler;
}

/**
 * 单指触摸手势状态机：down → (位移超容差 → pan ｜ 静止超时 → select) → up/cancel 复位。
 * up() 返回按下区间的最终判型（'pending' 即未判型的点按 tap），cancel()（pointercancel/
 * 进入捏合）静默复位——不残留 pan/select 拖拽态（防状态泄漏）。
 * @public
 */
export class TouchGesture {
  private modeState: TouchMode = 'idle';
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private cancelTimer: (() => void) | null = null;
  private readonly longPressMs: number;
  private readonly slop: number;
  private readonly schedule: GestureScheduler;
  private readonly onLongPress: (x: number, y: number) => void;

  constructor(opts: TouchGestureOpts) {
    this.onLongPress = opts.onLongPress;
    this.longPressMs = opts.longPressMs ?? LONG_PRESS_MS;
    this.slop = opts.slop ?? TOUCH_SLOP_PX;
    this.schedule = opts.schedule ?? defaultScheduler;
  }

  /** 当前判型。 @public */
  get mode(): TouchMode {
    return this.modeState;
  }

  /** 单指按下：进入 pending 并启动长按计时。 @public */
  down(x: number, y: number): void {
    this.stopTimer();
    this.modeState = 'pending';
    this.startX = this.lastX = x;
    this.startY = this.lastY = y;
    this.cancelTimer = this.schedule(() => {
      if (this.modeState !== 'pending') return;
      this.modeState = 'select';
      this.onLongPress(this.startX, this.startY);
    }, this.longPressMs);
  }

  /** 移动：pending 下位移超容差 → pan（长按停表）；返回当前判型与相对上次的位移。 @public */
  move(x: number, y: number): { mode: TouchMode; dx: number; dy: number } {
    if (this.modeState === 'idle') return { mode: 'idle', dx: 0, dy: 0 };
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    if (this.modeState === 'pending' && Math.hypot(x - this.startX, y - this.startY) > this.slop) {
      this.stopTimer();
      this.modeState = 'pan';
    }
    return { mode: this.modeState, dx, dy };
  }

  /** 抬起：返回最终判型（'pending' = 点按 tap）并复位 idle。 @public */
  up(): TouchMode {
    const m = this.modeState;
    this.stopTimer();
    this.modeState = 'idle';
    return m;
  }

  /** 取消（pointercancel / 进入捏合）：复位 idle，长按停表。 @public */
  cancel(): void {
    this.stopTimer();
    this.modeState = 'idle';
  }

  private stopTimer(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }
}

/** 两触点距离（捏合基元，欧氏距离）。 @public */
export function pointerDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * 捏合缩放：zoom = 起始 zoom × (当前两指距 ÷ 起始两指距)，夹到 [min,max]；
 * 起始/当前距非正时返回夹界后的起始 zoom（防除零）。
 * @public
 */
export function pinchZoom(zoom0: number, d0: number, d: number, min = 0.5, max = 2): number {
  if (d0 <= 0 || d <= 0) return clamp(zoom0, min, max);
  return clamp(zoom0 * (d / d0), min, max);
}

/**
 * 虚拟键盘弹出时画布的有效可视高度（设备 px）：visualViewport 底界（offsetTop+height，
 * CSS px）减画布顶（CSS px）后 ×dpr，与画布全高取小、非正夹 0。
 * 光标跟随（ensureCaretVisible）以此替代 canvas.height 作视口下界，把光标行滚出键盘遮挡区。
 * @public
 */
export function visibleCanvasHeightDev(
  canvasTopCss: number,
  canvasHeightDev: number,
  vvOffsetTop: number,
  vvHeight: number,
  dpr: number,
): number {
  const visCss = vvOffsetTop + vvHeight - canvasTopCss;
  return clamp(Math.round(visCss * dpr), 0, canvasHeightDev);
}

/** 惯性滚动一帧衰减：v × DECAY^(dt/16.7)，低于 {@link INERTIA_MIN_V} 归零（停帧信号）。 @public */
export function decayVelocity(v: number, dtMs: number): number {
  const next = v * Math.pow(INERTIA_DECAY, dtMs / 16.7);
  return Math.abs(next) < INERTIA_MIN_V ? 0 : next;
}

/** 位移是否达到启动阈值（欧氏距离 ≥ threshold）。 @public */
export function exceedsThreshold(dx: number, dy: number, threshold: number): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
