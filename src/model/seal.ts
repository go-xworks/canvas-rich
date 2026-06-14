// 印章 SVG 生成（model 层，框架无关、零 UI 依赖）：把印章文字渲染为红色圆形公章 SVG —
// 外圈红环 + 沿上弧排布的单位/公司名文字 + 中心五角星。纯字符串拼接，可内联渲染或转 dataURL。
// 分层位置：model 层的「印章原子块」内容生成器，供覆盖层（ui）按 attrs.text 重绘、export 落地。

/** 印章默认边长（逻辑 px，与 doc-layout / overlays 的默认尺寸一致）。 @public */
export const SEAL_SIZE = 120;
// 公章红（朱砂红）：常用印章色，亮/暗主题下均清晰；不取 --rte-* 以保印章语义色恒定。
const SEAL_RED = '#c0341d';

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * 生成中心五角星的 SVG `points` 串：以 (cx,cy) 为心、外接半径 rOut 的标准五角星
 * （首点朝正上方），10 个顶点（外/内交替，内径 = 外径 × 0.382 即正五角星比例）。
 * @internal
 */
function starPoints(cx: number, cy: number, rOut: number): string {
  const rIn = rOut * 0.382; // 正五角星内外径比
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5; // 首点正上方，每 36° 一个顶点
    const r = i % 2 === 0 ? rOut : rIn;
    pts.push(`${(cx + r * Math.cos(ang)).toFixed(2)},${(cy + r * Math.sin(ang)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/**
 * 生成红色圆形印章 SVG 字符串（外圈红环 + 沿上弧排布的文字 + 中心五角星）。
 *
 * @param text 印章文字（单位/公司名）；沿上半弧居中排布，自动 XML 转义防注入。
 * @param size 印章边长（逻辑 px），默认 {@link SEAL_SIZE}；viewBox 与之等比。
 * @returns 合法的独立 SVG 文档字符串（含 xmlns，可直接内联或 encodeURIComponent 转 dataURL）。
 * @public
 */
export function sealSvg(text: string, size = SEAL_SIZE): string {
  const s = size;
  const cx = s / 2, cy = s / 2;
  const ringW = Math.max(2, s * 0.03);           // 外环线宽
  const rRing = s / 2 - ringW;                   // 外环半径（留出线宽不被裁切）
  const rText = rRing - Math.max(6, s * 0.09);   // 文字基线所在弧半径（位于环内侧）
  const fontSize = Math.max(8, s * 0.12);
  const star = starPoints(cx, cy, s * 0.16);
  // 文字弧：上半圆，从左下绕到右下（sweep=1），令 textPath 居中(50%)时文字头朝上、可读。
  const arc = `M ${(cx - rText).toFixed(2)} ${cy.toFixed(2)} A ${rText.toFixed(2)} ${rText.toFixed(2)} 0 1 1 ${(cx + rText).toFixed(2)} ${cy.toFixed(2)}`;
  const label = escXml(text);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">`
    + `<defs><path id="seal-arc" d="${arc}"/></defs>`
    + `<circle cx="${cx}" cy="${cy}" r="${rRing.toFixed(2)}" fill="none" stroke="${SEAL_RED}" stroke-width="${ringW.toFixed(2)}"/>`
    + `<polygon points="${star}" fill="${SEAL_RED}"/>`
    + `<text fill="${SEAL_RED}" font-family="serif" font-weight="bold" font-size="${fontSize.toFixed(2)}" `
    + `letter-spacing="${(s * 0.01).toFixed(2)}" text-anchor="middle">`
    + `<textPath href="#seal-arc" startOffset="50%">${label}</textPath></text>`
    + `</svg>`;
}

/**
 * 把印章文字转为可直接用于 `<img src>` / CSS 的 data URL（utf8 + encodeURIComponent）。
 * @public
 */
export function sealDataUrl(text: string, size = SEAL_SIZE): string {
  return 'data:image/svg+xml,' + encodeURIComponent(sealSvg(text, size));
}
