// mark ↔ HTML 标签映射（单一信息源 SSOT）：导出端（model/export 包裹标签）、导入端
// （editor/import 的内联标签解析）与单元格回写端（editor/cell-dom 的标签解析）统一查此表，
// 不再各处重复维护 tag↔MarkType 对照。
// 分层位置：model 层的序列化映射常量，仅依赖 schema 的类型。
import type { MarkType } from './schema';

/**
 * 外观 mark → HTML 包裹标签（导出端写出的规范标签）。
 * 顺序即包裹次序：先列者最内层（code 最内、subscript 在标签层最外），
 * 与历史 wrapAppearanceMarks 的逐 if 包裹序一致——改变顺序会改变导出 HTML 字节序列。
 * link 不在表内：由调用方按场景另裹（导出 <a> / 单元格降级 span[data-href]）。
 * @public
 */
export const MARK_WRAP_TAGS: readonly { mark: MarkType; tag: string }[] = [
  { mark: 'code', tag: 'code' },
  { mark: 'bold', tag: 'strong' },
  { mark: 'italic', tag: 'em' },
  { mark: 'underline', tag: 'u' },
  { mark: 'strikethrough', tag: 's' },
  { mark: 'highlight', tag: 'mark' },
  { mark: 'superscript', tag: 'sup' },
  { mark: 'subscript', tag: 'sub' },
];

/**
 * 经 `<span style>` 承载的外观 mark（无独立 HTML 标签）：
 * attrKey = mark attrs 的取值键；cssName = CSS 属性名；suffix = 写出值后缀（fontSize 拼 px）。
 * 顺序即包裹次序（fontFamily 最内、color 最外），与历史导出字节序列一致。
 * @public
 */
export const SPAN_STYLE_MARKS: readonly { mark: MarkType; attrKey: string; cssName: string; suffix: string }[] = [
  { mark: 'fontFamily', attrKey: 'fontFamily', cssName: 'font-family', suffix: '' },
  { mark: 'fontSize', attrKey: 'size', cssName: 'font-size', suffix: 'px' },
  { mark: 'color', attrKey: 'color', cssName: 'color', suffix: '' },
];

// 解析端同义标签 → mark（导出规范标签之外的别名：b/i/strike/del）。
const TAG_MARK_ALIASES: Record<string, MarkType> = {
  b: 'bold',
  i: 'italic',
  strike: 'strikethrough',
  del: 'strikethrough',
};

// 标签（小写）→ mark 的查找表：规范包裹标签 + 同义别名，模块加载时由上两表派生一次。
const TAG_TO_MARK: Record<string, MarkType> = (() => {
  const m: Record<string, MarkType> = { ...TAG_MARK_ALIASES };
  for (const { mark, tag } of MARK_WRAP_TAGS) m[tag] = mark;
  return m;
})();

/**
 * HTML 内联标签 → mark 类型（大小写不敏感；同义标签归并）。
 * 非外观标签（a/span/img 等另有专门处理）返回 undefined。
 * @public
 */
export function markTypeOfTag(tag: string): MarkType | undefined {
  return TAG_TO_MARK[tag.toLowerCase()];
}

// —— style 类 mark 值白名单（导出/导入双端共用的纵深防御，对称于 shared/url 的链接协议白名单）——
// escAttr 只挡标签/属性逃逸（& < > "），不中和 CSS 元字符（; : ( )）：裸值
// 'Arial;position:fixed;inset:0;background:url(http://evil/leak)' 经 escAttr 仍原样进 style 属性，
// 在单元格 innerHTML 与导出 HTML 中形成实时 CSS 注入。本白名单保证序列化进 style 的值
// 不可能携带额外声明或 url() 回传；非法值由调用方跳过（导出不产 span style，导入不产 mark）。

// #hex：3/4/6/8 位十六进制。
const RE_HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// rgb()/rgba()：逗号或空格语法，含可选 alpha（, a 或 / a）；括号内只允许数字/小数点/百分号与分隔符。
const RE_FUNC_COLOR = /^rgba?\(\s*[\d.%]+(?:[\s,]+[\d.%]+){2}(?:\s*[,/]\s*[\d.%]+)?\s*\)$/i;
// 具名色（red/transparent/…）：纯字母无注入面，不维护完整 CSS 颜色名表（非法名仅渲染无效，无害）。
const RE_NAMED_COLOR = /^[a-zA-Z]{1,30}$/;
// 字体族安全字符集：字母数字下划线 / CJK（基本区 U+4E00-9FFF + 扩展 A U+3400-4DBF，
// 中文字体名如「微软雅黑」）/ 空白 / 逗号 / 引号 / 连字符——不含 ; : ( ) 等 CSS 元字符，
// 无法注入额外声明或函数值。
const RE_FONT_FAMILY = /^[\w㐀-䶿一-鿿\s,'"-]+$/;
// 字号：裸数值（schema.fontSizeFromCss 的不变量——存储恒裸数值，序列化端拼 px）。
const RE_FONT_SIZE = /^[0-9]+(?:\.[0-9]+)?$/;

/** 判定颜色值是否在白名单内（#hex / rgb()/rgba() / 纯字母具名色），非法即拒。 @public */
export function isSafeCssColor(v: string): boolean {
  return RE_HEX_COLOR.test(v) || RE_FUNC_COLOR.test(v) || RE_NAMED_COLOR.test(v);
}

/** 判定字体族值是否在安全字符集内（无 CSS 元字符，杜绝 style 注入；长度 ≤200）。 @public */
export function isSafeFontFamily(v: string): boolean {
  return v.length > 0 && v.length <= 200 && RE_FONT_FAMILY.test(v);
}

/**
 * 按 style 类 mark 校验其序列化值：color/highlight 走颜色白名单、fontFamily 走安全字符集、
 * fontSize 须为裸数值；非 style 类 mark 恒 false（不经 span style 通道）。 @public
 */
export function isSafeSpanStyleValue(mark: MarkType, value: string): boolean {
  switch (mark) {
    case 'color':
    case 'highlight':
      return isSafeCssColor(value);
    case 'fontFamily':
      return isSafeFontFamily(value);
    case 'fontSize':
      return RE_FONT_SIZE.test(value);
    default:
      return false;
  }
}
