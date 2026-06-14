/**
 * URL 安全过滤（跨层纯工具，无 DOM 依赖）：按写入场景的协议白名单校验 src/href，
 * 防 `javascript:` 等危险协议注入。model（写 attrs 前）与 ui/overlays（写 DOM 前）
 * 双层复用——任一层被绕过（如直接构造 Doc / 历史文档反序列化）仍有另一层兜底。
 */

/**
 * URL 的写入场景种类，决定协议白名单：
 * - `link` / `iframe`：仅 `http:`/`https:`（可导航 / 可执行脚本的场景，最严格）；
 * - `image` / `signature`：另放行 `blob:` 与 `data:image/*`（本地图片 / 手绘签名 PNG dataURL）；
 * - `audio` / `video` / `attachment`：另放行 `blob:` 与任意 `data:`（媒体 / 下载文件可为任意 MIME）。
 * @public
 */
export type UrlKind = 'link' | 'iframe' | 'image' | 'signature' | 'audio' | 'video' | 'attachment';

// URL scheme 语法（RFC 3986）：字母开头 + 字母/数字/+/-/. 后跟冒号。
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/;

// 浏览器解析 URL 前会剔除的字符（C0/C1 控制符 + 空白）；归一后再识别协议，
// 防 `java\tscript:` 这类「协议走私」绕过白名单。
const CTRL_OR_WS_RE = /[\u0000-\u0020\u007f-\u009f]/g;

/**
 * 按场景白名单过滤 URL：合法返回 trim 后的原 URL，非法返回 `null`。
 *
 * 判定规则：
 * - 先按浏览器同等规则归一（剔除控制符/空白、转小写）再识别协议；归一只用于判定，
 *   返回值保留原文（trim 后），路径里的合法空格等不受影响；
 * - 未列入白名单的协议（`javascript:`/`vbscript:`/`file:` 等）一律拒绝；
 * - 无协议（相对路径 / 协议相对 `//host`）与空串一并拒绝——编辑器文档内只接受绝对 URL，
 *   避免宿主页面路径影响解析结果。
 * @param url - 待校验的原始 URL
 * @param kind - 写入场景（决定白名单，见 {@link UrlKind}）
 * @returns 合法时为 `url.trim()`，否则 `null`
 * @public
 */
export function sanitizeUrl(url: string, kind: UrlKind): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(CTRL_OR_WS_RE, '').toLowerCase();
  const m = SCHEME_RE.exec(normalized);
  if (!m) return null; // 无协议：拒绝
  const scheme = m[1];
  if (scheme === 'http' || scheme === 'https') return trimmed; // 所有场景放行
  if (kind === 'link' || kind === 'iframe') return null;       // 可导航/可执行场景：仅 http(s)
  if (scheme === 'blob') return trimmed;
  if (scheme === 'data') {
    // 图片/签名仅接受 data:image/*；音视频/附件接受任意 data:（MIME 不可枚举）
    if (kind === 'image' || kind === 'signature') return normalized.startsWith('data:image/') ? trimmed : null;
    return trimmed;
  }
  return null;
}

// 行内链接（link mark）href 的危险协议黑名单：可执行/可注入脚本的协议。
// 与 sanitizeUrl('link') 的「白名单」不同——文档链接合法地包含 mailto:/tel:/#锚点/相对路径，
// 严格 http(s)-only 会误杀；故链接用黑名单：仅拦截可触发脚本执行的协议，放行其余。
const DANGEROUS_LINK_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data', 'file']);

/**
 * 校验行内链接 href：危险协议（`javascript:`/`vbscript:`/`data:`/`file:`）一律拒绝，
 * 其余（`http`/`https`/`mailto`/`tel` 等具名协议，以及 `#锚点`/`?查询`/相对路径等无协议）放行。
 *
 * 这是「链接导出 XSS」的防线：导入（MD/HTML）、插链弹层、导出 HTML（`<a href>` 与单元格
 * `data-href`）三处共用，确保 `[x](javascript:alert(1))` 这类内容既不进模型、也不会被导出为可点脚本。
 * 与 {@link sanitizeUrl} 的 `link`/`iframe` 白名单语义不同：链接需兼容 mailto/锚点/相对，故走黑名单。
 * @param href - 待校验的链接 href（可含控制符走私，先归一再判定）
 * @returns 安全时为 `href.trim()`，危险协议时为 `null`
 * @public
 */
export function sanitizeLinkHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(CTRL_OR_WS_RE, '').toLowerCase();
  const m = SCHEME_RE.exec(normalized);
  if (m && DANGEROUS_LINK_SCHEMES.has(m[1])) return null; // 具名危险协议：拒绝
  return trimmed; // http(s)/mailto/tel/无协议（锚点/相对/查询）：放行
}
