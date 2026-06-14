import { describe, it, expect, vi, afterEach } from 'vitest';
import { mustEl } from '../dom';

// mustEl 回归：装配层取元素的 fail-fast 契约——命中返回元素本身；
// 缺失立即抛出且错误信息携带元素 id（替代 `as`/`!` 断言的延迟空指针）。
// node 环境无 DOM：用 stubGlobal 注入最小 document 桩。

afterEach(() => vi.unstubAllGlobals());

function stubDocument(present: Record<string, object>): void {
  vi.stubGlobal('document', {
    getElementById: (id: string) => (present[id] as HTMLElement | undefined) ?? null,
  });
}

describe('mustEl', () => {
  it('命中时原样返回元素', () => {
    const el = { id: 'toolbar' };
    stubDocument({ toolbar: el });
    expect(mustEl('toolbar')).toBe(el);
  });

  it('缺失时抛出带 id 的错误（fail-fast）', () => {
    stubDocument({});
    expect(() => mustEl('status-bar')).toThrowError(/#status-bar/);
  });
});
