import { describe, it, expect } from 'vitest';
import { sealSvg, sealDataUrl, SEAL_SIZE } from '../seal';

// 集群A：印章 SVG 生成器（sealSvg / sealDataUrl）。验证产出合法 SVG、含印章文字、
// 红环 + 五角星结构、文字 XML 转义防注入、尺寸参数生效，以及 dataURL 形态。

describe('sealSvg', () => {
  it('产出合法独立 SVG（含 xmlns + 默认尺寸 viewBox）', () => {
    const svg = sealSvg('某某公司');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(`width="${SEAL_SIZE}"`);
    expect(svg).toContain(`viewBox="0 0 ${SEAL_SIZE} ${SEAL_SIZE}"`);
  });

  it('含印章文字（沿弧 textPath 排布）', () => {
    const svg = sealSvg('北京测试有限公司');
    expect(svg).toContain('北京测试有限公司');
    expect(svg).toContain('<textPath');
    expect(svg).toContain('startOffset="50%"'); // 文字居中于上弧
  });

  it('含外圈红环 + 中心五角星（圆 + 多边形）', () => {
    const svg = sealSvg('公司');
    expect(svg).toContain('<circle'); // 外环
    expect(svg).toContain('<polygon'); // 五角星
    expect(svg.toLowerCase()).toContain('stroke="#c0341d"'.toLowerCase()); // 印章红描边
  });

  it('五角星有 10 个顶点（外/内交替）', () => {
    const svg = sealSvg('x');
    const m = svg.match(/<polygon points="([^"]+)"/);
    expect(m).not.toBeNull();
    const pts = m![1].trim().split(/\s+/);
    expect(pts).toHaveLength(10);
  });

  it('文字中的 XML 特殊字符被转义（防注入）', () => {
    const svg = sealSvg('a<b>&"\'');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&quot;');
    expect(svg).toContain('&apos;');
  });

  it('尺寸参数生效（自定义 size 改写 width/height/viewBox）', () => {
    const svg = sealSvg('公司', 200);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('viewBox="0 0 200 200"');
  });

  it('空文字仍产出合法 SVG（仅无字符）', () => {
    const svg = sealSvg('');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<textPath');
  });
});

describe('sealDataUrl', () => {
  it('产出 image/svg+xml 的 data URL（encodeURIComponent 编码）', () => {
    const url = sealDataUrl('公司');
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    // 解码后应还原为同一 SVG 串
    expect(decodeURIComponent(url.slice('data:image/svg+xml,'.length))).toBe(sealSvg('公司'));
  });
});
