import { describe, it, expect, afterEach } from 'vitest';
import { parseHex, RGBA, C, LIGHT, DARK, applyCanvasTheme, activeTheme } from '../palette';

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

// applyCanvasTheme：把 LIGHT/DARK 令牌原地拷进可变的 C（保持 C 同引用），各处下次读 C.* 即得新色。
// block-specs / styleResolver 的 theme() 在布局时读 C.*，故主题切换靠重排生效——前提是 C 被原地改写。
describe('applyCanvasTheme', () => {
  // 测试会改写全局 C / activeTheme；每例后复位为亮色，避免污染其他测试文件读到的 C。
  afterEach(() => applyCanvasTheme('light'));

  const KEYS: (keyof typeof LIGHT)[] = [
    'light',
    'muted',
    'title',
    'h2',
    'link',
    'code',
    'codeText',
    'codeBg',
    'bg',
    'selection',
    'caret',
    'marker',
    'pageGap',
  ];

  it('默认（亮色）下 C 与 LIGHT 各字段相等', () => {
    applyCanvasTheme('light');
    for (const k of KEYS) expect(C[k]).toEqual(LIGHT[k]);
    expect(activeTheme()).toBe('light');
  });

  it('切到暗色后 C 各字段变为 DARK 的值', () => {
    applyCanvasTheme('dark');
    for (const k of KEYS) expect(C[k]).toEqual(DARK[k]);
    expect(activeTheme()).toBe('dark');
  });

  it('切回亮色后 C 各字段恢复为 LIGHT 的值', () => {
    applyCanvasTheme('dark');
    applyCanvasTheme('light');
    for (const k of KEYS) expect(C[k]).toEqual(LIGHT[k]);
    expect(activeTheme()).toBe('light');
  });

  it('C 引用恒定：切换主题不替换 C 对象本身（原地改写）', () => {
    const ref = C;
    applyCanvasTheme('dark');
    expect(C).toBe(ref); // 同一对象引用，仅字段被改写
  });

  it('暗色具体值：bg 为深底、caret/title 为浅色（深底可见）', () => {
    applyCanvasTheme('dark');
    expect(C.bg).toEqual([0.102, 0.106, 0.133, 1]); // #1a1b22
    expect(C.caret[0]).toBeGreaterThan(0.9); // 浅光标
    expect(C.title[0]).toBeGreaterThan(0.9); // 浅 H1
    expect(C.light[0]).toBeGreaterThan(0.8); // 浅正文
  });

  it('亮色具体值：bg 为白底、caret/title 为深色（白底可见）', () => {
    applyCanvasTheme('light');
    expect(C.bg).toEqual([1, 1, 1, 1]);
    expect(C.caret[0]).toBeLessThan(0.1); // 深光标
    expect(C.title[0]).toBeLessThan(0.1); // 深 H1
  });

  it('activeTheme 反映最近一次 applyCanvasTheme', () => {
    applyCanvasTheme('dark');
    expect(activeTheme()).toBe('dark');
    applyCanvasTheme('light');
    expect(activeTheme()).toBe('light');
  });

  it('LIGHT 与 DARK 在所有字段上互不相同（成对完整覆盖）', () => {
    for (const k of KEYS) expect(LIGHT[k]).not.toEqual(DARK[k]);
  });
});
