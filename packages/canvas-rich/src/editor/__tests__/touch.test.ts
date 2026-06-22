import { describe, it, expect } from 'vitest';
import {
  TouchGesture,
  GestureScheduler,
  pointerDist,
  pinchZoom,
  visibleCanvasHeightDev,
  decayVelocity,
  exceedsThreshold,
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  INERTIA_MIN_V,
} from '../touch';

// 触屏手势基元：单指判型状态机（平移/长按/点按分流）、捏合缩放、键盘可视高换算、惯性衰减。
// 触屏无真机：长按计时经注入的假调度器手动触发，分流判定纯逻辑直测（批E 验证策略）。

/** 手动触发的假调度器：fire() 模拟长按计时到点，cancelled 记录停表。 */
function fakeScheduler() {
  let cb: (() => void) | null = null;
  let ms = -1;
  let cancelled = 0;
  const schedule: GestureScheduler = (fn, t) => {
    cb = fn;
    ms = t;
    return () => {
      cancelled++;
      cb = null;
    };
  };
  return {
    schedule,
    fire: () => cb?.(),
    get ms() {
      return ms;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe('TouchGesture — 单指判型状态机', () => {
  it('初始 idle；down 进入 pending 并以 LONG_PRESS_MS 启动长按计时', () => {
    const t = fakeScheduler();
    const g = new TouchGesture({ onLongPress: () => {}, schedule: t.schedule });
    expect(g.mode).toBe('idle');
    g.down(100, 100);
    expect(g.mode).toBe('pending');
    expect(t.ms).toBe(LONG_PRESS_MS);
  });

  it('pending 中位移超容差 → pan（长按停表），up 返回 pan', () => {
    const t = fakeScheduler();
    const g = new TouchGesture({
      onLongPress: () => {
        throw new Error('不应触发长按');
      },
      schedule: t.schedule,
    });
    g.down(100, 100);
    const r1 = g.move(100, 100 + TOUCH_SLOP_PX); // 恰好容差：仍 pending（严格大于才判型）
    expect(r1.mode).toBe('pending');
    const r2 = g.move(100, 100 + TOUCH_SLOP_PX + 30);
    expect(r2.mode).toBe('pan');
    expect(r2.dy).toBe(30);
    expect(t.cancelled).toBe(1); // 长按停表
    t.fire(); // 已取消的计时即使误触发也不改判型
    expect(g.mode).toBe('pan');
    expect(g.up()).toBe('pan');
    expect(g.mode).toBe('idle');
  });

  it('容差内静止 → 计时到点切 select 并回调长按坐标（按下原点）', () => {
    const t = fakeScheduler();
    let lp: [number, number] | null = null;
    const g = new TouchGesture({
      onLongPress: (x, y) => {
        lp = [x, y];
      },
      schedule: t.schedule,
    });
    g.down(50, 60);
    g.move(53, 62); // 容差内抖动不取消
    t.fire();
    expect(g.mode).toBe('select');
    expect(lp).toEqual([50, 60]);
    expect(g.up()).toBe('select');
  });

  it('select 后继续 move 保持 select（选区拖拽），位移增量正确', () => {
    const t = fakeScheduler();
    const g = new TouchGesture({ onLongPress: () => {}, schedule: t.schedule });
    g.down(10, 10);
    t.fire();
    const r = g.move(20, 25);
    expect(r.mode).toBe('select');
    expect(r.dx).toBe(10);
    expect(r.dy).toBe(15);
  });

  it('快速点按（无位移未到时）up 返回 pending（= tap）并停表', () => {
    const t = fakeScheduler();
    const g = new TouchGesture({
      onLongPress: () => {
        throw new Error('不应触发');
      },
      schedule: t.schedule,
    });
    g.down(0, 0);
    expect(g.up()).toBe('pending');
    expect(t.cancelled).toBe(1);
    t.fire(); // 抬起后计时残响不得改状态
    expect(g.mode).toBe('idle');
  });

  it('cancel（pointercancel/进入捏合）静默复位 idle，长按停表，不残留拖拽态', () => {
    const t = fakeScheduler();
    const g = new TouchGesture({
      onLongPress: () => {
        throw new Error('不应触发');
      },
      schedule: t.schedule,
    });
    g.down(0, 0);
    g.cancel();
    expect(g.mode).toBe('idle');
    expect(t.cancelled).toBe(1);
    expect(g.move(50, 50)).toEqual({ mode: 'idle', dx: 0, dy: 0 }); // idle 下 move 零作用
  });

  it('自定义 longPressMs / slop 生效', () => {
    const t = fakeScheduler();
    const g = new TouchGesture({ onLongPress: () => {}, longPressMs: 800, slop: 2, schedule: t.schedule });
    g.down(0, 0);
    expect(t.ms).toBe(800);
    expect(g.move(0, 3).mode).toBe('pan'); // 3 > slop 2
  });
});

describe('pointerDist / pinchZoom — 捏合缩放计算', () => {
  it('两触点欧氏距离', () => {
    expect(pointerDist(0, 0, 3, 4)).toBe(5);
    expect(pointerDist(10, 10, 10, 10)).toBe(0);
  });

  it('zoom 随两指距等比跟手：张开放大、收拢缩小', () => {
    expect(pinchZoom(1, 100, 150)).toBeCloseTo(1.5);
    expect(pinchZoom(1, 100, 50)).toBeCloseTo(0.5);
    expect(pinchZoom(1.2, 200, 300)).toBeCloseTo(1.8);
  });

  it('夹到 [0.5, 2]（缺省界）与自定义界', () => {
    expect(pinchZoom(1, 100, 500)).toBe(2);
    expect(pinchZoom(1, 100, 10)).toBe(0.5);
    expect(pinchZoom(1, 100, 500, 0.8, 3)).toBe(3);
  });

  it('起始/当前距非正（防除零）→ 返回夹界后的起始 zoom', () => {
    expect(pinchZoom(1.3, 0, 100)).toBeCloseTo(1.3);
    expect(pinchZoom(5, 100, 0)).toBe(2); // 越界起始值也被夹回
  });
});

describe('visibleCanvasHeightDev — 虚拟键盘可视高换算', () => {
  // 画布顶在 CSS 100px、全高 1600 设备 px、dpr=2（即 CSS 高 800）
  it('键盘占下半屏：可视高 = (视口底 - 画布顶) × dpr', () => {
    // visualViewport: offsetTop 0、height 500 → 底界 500css → (500-100)×2 = 800
    expect(visibleCanvasHeightDev(100, 1600, 0, 500, 2)).toBe(800);
  });
  it('无键盘（视口底深于画布底）→ 夹回画布全高', () => {
    expect(visibleCanvasHeightDev(100, 1600, 0, 2000, 2)).toBe(1600);
  });
  it('画布完全被遮 → 夹 0（调用方回退全高）', () => {
    expect(visibleCanvasHeightDev(600, 1600, 0, 500, 2)).toBe(0);
  });
});

describe('decayVelocity / exceedsThreshold — 惯性与阈值', () => {
  it('速度按帧基准指数衰减，低于停止阈值归零', () => {
    const v1 = decayVelocity(10, 16.7);
    expect(v1).toBeLessThan(10);
    expect(v1).toBeGreaterThan(0);
    expect(decayVelocity(INERTIA_MIN_V, 16.7)).toBe(0); // 衰减后必低于阈值
    expect(decayVelocity(-10, 16.7)).toBeLessThan(0); // 方向保留
  });
  it('dt 越大衰减越多（时间基准而非帧数基准）', () => {
    expect(Math.abs(decayVelocity(10, 33.4))).toBeLessThan(Math.abs(decayVelocity(10, 16.7)));
  });
  it('拖文本启动阈值：欧氏距离 ≥ threshold', () => {
    expect(exceedsThreshold(3, 4, 5)).toBe(true);
    expect(exceedsThreshold(3, 3, 5)).toBe(false);
    expect(exceedsThreshold(-5, 0, 5)).toBe(true);
  });
});
