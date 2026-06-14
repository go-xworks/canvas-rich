import { describe, it, expect, vi } from 'vitest';
import { createEmitter, EditorEvent } from '../events';

// 类型化事件总线纯逻辑单测：on/emit 基本广播、多订阅者、unsub 退订、
// 事件互不串扰、emit 快照遍历（回调内退订/再订阅不影响本轮），以及无监听器 emit 安全。

describe('createEmitter', () => {
  it('emit 触发已订阅回调', () => {
    const bus = createEmitter();
    const fn = vi.fn();
    bus.on('doc:changed', fn);
    bus.emit('doc:changed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('多订阅者全部触发，且按订阅顺序', () => {
    const bus = createEmitter();
    const order: number[] = [];
    bus.on('selection:changed', () => order.push(1));
    bus.on('selection:changed', () => order.push(2));
    bus.on('selection:changed', () => order.push(3));
    bus.emit('selection:changed');
    expect(order).toEqual([1, 2, 3]);
  });

  it('unsub 后不再触发', () => {
    const bus = createEmitter();
    const fn = vi.fn();
    const off = bus.on('view:changed', fn);
    bus.emit('view:changed');
    off();
    bus.emit('view:changed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('退订其一不影响其它订阅者', () => {
    const bus = createEmitter();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('doc:changed', a);
    bus.on('doc:changed', b);
    offA();
    bus.emit('doc:changed');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('事件之间互不串扰', () => {
    const bus = createEmitter();
    const doc = vi.fn();
    const sel = vi.fn();
    const view = vi.fn();
    bus.on('doc:changed', doc);
    bus.on('selection:changed', sel);
    bus.on('view:changed', view);
    bus.emit('selection:changed');
    expect(sel).toHaveBeenCalledTimes(1);
    expect(doc).not.toHaveBeenCalled();
    expect(view).not.toHaveBeenCalled();
  });

  it('同一回调重复订阅按 Set 去重（仅触发一次）', () => {
    const bus = createEmitter();
    const fn = vi.fn();
    bus.on('doc:changed', fn);
    bus.on('doc:changed', fn);
    bus.emit('doc:changed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emit 快照遍历：回调内退订自身不影响本轮其它监听器', () => {
    const bus = createEmitter();
    const seen: string[] = [];
    let offSelf: (() => void) | null = null;
    offSelf = bus.on('doc:changed', () => { seen.push('self'); offSelf?.(); });
    bus.on('doc:changed', () => { seen.push('other'); });
    bus.emit('doc:changed');
    expect(seen).toEqual(['self', 'other']); // 本轮两个都触发
    seen.length = 0;
    bus.emit('doc:changed'); // 第二轮 self 已退订
    expect(seen).toEqual(['other']);
  });

  it('emit 快照遍历：回调内新增订阅不在本轮触发', () => {
    const bus = createEmitter();
    const late = vi.fn();
    bus.on('doc:changed', () => { bus.on('doc:changed', late); });
    bus.emit('doc:changed');
    expect(late).not.toHaveBeenCalled(); // 本轮快照不含 late
    bus.emit('doc:changed');
    expect(late).toHaveBeenCalledTimes(1); // 下一轮才触发
  });

  it('无监听器 emit 安全（不抛）', () => {
    const bus = createEmitter();
    const evts: EditorEvent[] = ['doc:changed', 'selection:changed', 'view:changed'];
    for (const ev of evts) expect(() => bus.emit(ev)).not.toThrow();
  });
});
