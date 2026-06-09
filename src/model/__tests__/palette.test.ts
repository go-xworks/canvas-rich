import { describe, it, expect } from 'vitest';
import { parseHex, RGBA } from '../palette';

// parseHex：6 位十六进制（可带 #）→ 归一化 RGBA，非法输入回退 fallback。
// 自定义 hex 颜色/高亮输入直接依赖此解析。
const FB: RGBA = [0.1, 0.2, 0.3, 1];

describe('parseHex', () => {
  it('解析带 # 的 6 位 hex', () => {
    expect(parseHex('#2563eb', FB)).toEqual([0x25 / 255, 0x63 / 255, 0xeb / 255, 1]);
  });

  it('解析不带 # 的 6 位 hex', () => {
    expect(parseHex('2563eb', FB)).toEqual([0x25 / 255, 0x63 / 255, 0xeb / 255, 1]);
  });

  it('大小写不敏感', () => {
    expect(parseHex('#AABBCC', FB)).toEqual(parseHex('#aabbcc', FB));
  });

  it('黑/白边界值', () => {
    expect(parseHex('#000000', FB)).toEqual([0, 0, 0, 1]);
    expect(parseHex('#ffffff', FB)).toEqual([1, 1, 1, 1]);
  });

  it('两侧空白被裁剪后仍可解析', () => {
    expect(parseHex('  #2563eb  ', FB)).toEqual([0x25 / 255, 0x63 / 255, 0xeb / 255, 1]);
  });

  it('alpha 分量恒为 1', () => {
    expect(parseHex('#123456', FB)[3]).toBe(1);
  });

  it.each([
    ['空串', ''],
    ['3 位简写（不支持）', '#abc'],
    ['含非法字符', '#12345g'],
    ['位数过多', '#1234567'],
    ['纯文字', 'red'],
  ])('非法输入回退 fallback：%s', (_label, input) => {
    expect(parseHex(input, FB)).toBe(FB);
  });
});
