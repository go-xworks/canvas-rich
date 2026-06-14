import { Doc, Block, BlockType, Inline, Mark, TableCell, cellText, getMark, hasMarkType, isInlineAtom } from './schema';
import { MARK_WRAP_TAGS, SPAN_STYLE_MARKS, isSafeSpanStyleValue, isSafeCssColor, isSafeFontFamily } from './mark-html';
import { sanitizeLinkHref } from '../shared/url';
import { tableColCount, sanitizeMerges } from './table-utils';
import { clampDepth, meta, ExportHelpers, BlockExporter } from './block-specs';
import { sealSvg } from './seal';
import { scanToc } from './toc';

// 文档树 → HTML / Markdown / JSON。块按类型分组（连续列表项合并为 <ul>/<ol>，连续代码行合并为 <pre>）。
// 分层位置：model 层的导出/序列化端，把文档树落地为外部格式。
//
// 块导出抽象②（Strategy-over-Visitor）：单块单出口的类型分支收进 BLOCK_EXPORTERS 注册表
// （image/audio/video/iframe/attachment/signature/seal/textbox/formula/table/toc/heading/blockquote），
// 每项的字符串模板照搬自原 if/switch 分支，输出字节级不变。toHtml/toMarkdown 的主循环顶部仍保留
// 跨块「聚类合并」判定（bullet/ordered 续 <ul>/<ol>、task-list、code_block 续 <pre>/```），
// 这些分支会推进游标 i、跨多块合并，不能按单块钩子拆分，故不进表。新增块类型：内置块在 BLOCK_EXPORTERS
// 加一条钩子；外部插件可仅经 block-specs 的 meta.exporter 注入（export 主循环优先查 meta.exporter，回退本表）。

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escHtml(s).replace(/"/g, '&quot;');

// 把已转义的文本按 marks 包裹外观标签（包裹标签 + span style 序均查 model/markHtml 的 SSOT 表，
// 表序即包裹序，输出字节级不变）。link 由调用方按场景另裹（导出走 <a>，
// 表格单元格编辑态降级为 span[data-href]，避免单元格内可点链接干扰 contenteditable）。
function wrapAppearanceMarks(s: string, m: readonly Mark[]): string {
  for (const { mark, tag } of MARK_WRAP_TAGS) {
    if (hasMarkType(m, mark)) s = `<${tag}>${s}</${tag}>`;
  }
  for (const { mark, attrKey, cssName, suffix } of SPAN_STYLE_MARKS) {
    const v = getMark(m, mark)?.attrs?.[attrKey];
    // 值白名单（mark-html）：escAttr 不中和 CSS 元字符（; : ( )），程序化注入的裸值
    // （如 'x;position:fixed'）在此整体跳过——不产该层 span style（导出防线，与 URL 对称）。
    if (v && isSafeSpanStyleValue(mark, v)) s = `<span style="${cssName}:${escAttr(v)}${suffix}">${s}</span>`;
  }
  return s;
}

function runHtml(run: Inline): string {
  // 行内原子（行内图片）→ <img>（无 alt；尺寸属性按需输出）
  if (isInlineAtom(run)) {
    const a = run.attrs;
    const dim = (a.width ? ` width="${a.width}"` : '') + (a.height ? ` height="${a.height}"` : '');
    return `<img src="${escAttr(a.src ?? '')}"${dim} alt="">`;
  }
  let s = wrapAppearanceMarks(escHtml(run.text), run.marks);
  // 导出防线（defense-in-depth）：危险协议 href 不产 <a>（仅留内层文本），
  // 即便历史/程序化构造的文档绕过了导入/弹层过滤，导出的 HTML 文件也无可点脚本。
  const href = sanitizeLinkHref(getMark(run.marks, 'link')?.attrs?.href ?? '');
  if (href) s = `<a href="${escAttr(href)}">${s}</a>`;
  return s;
}

/**
 * 把表格单元格的行内序列渲染为 contenteditable 内可编辑的 HTML 片段：
 * 文本转义防注入、'\n' → <br>、外观 marks 包裹同导出 HTML；链接降级为
 * `<span data-href>`（不产可点 <a> 以免干扰编辑；视觉样式由覆盖层 CSS 按
 * `span[data-href]` 提供——刻意不写 inline style，否则 domToInlines 回读 style.color
 * 会把 var(--rte-accent) 误还原成 color mark），data-href 供 domToInlines 还原 link mark。
 * 行内原子（行内图片）在单元格内不支持，丢弃——不变量「td 不承载行内原子」的渲染端：
 * 产 cell 的路径（HTML 表格导入/单元格回写）经 model/inlines 的 normalizeCellInlines 过滤，
 * 本函数对漏网原子兜底丢弃（回读端 domToInlines 亦无原子还原路径，保编辑往返自洽）。
 * @public
 */
export function inlinesToCellHtml(inlines: Inline[]): string {
  let out = '';
  for (const run of inlines) {
    if (isInlineAtom(run)) continue; // 单元格不承载行内原子
    let s = wrapAppearanceMarks(escHtml(run.text).replace(/\n/g, '<br>'), run.marks);
    const href = sanitizeLinkHref(getMark(run.marks, 'link')?.attrs?.href ?? ''); // 同 runHtml 的导出防线
    if (href) s = `<span data-href="${escAttr(href)}">${s}</span>`;
    out += s;
  }
  return out;
}

// 表格单元格 → 导出 HTML：完整 runHtml（含 marks/链接 <a>），单元格内换行 '\n' → <br>
//（escHtml 不触碰换行符，后置替换安全）。
const cellHtml = (c: TableCell): string => c.inlines.map(runHtml).join('').replace(/\n/g, '<br>');
const inlinesHtml = (b: Block) => b.inlines.map(runHtml).join('');
const alignAttr = (b: Block) =>
  b.attrs.align && b.attrs.align !== 'left' ? ` style="text-align:${b.attrs.align}"` : '';
/** 标题级别夹回 1..6（缺省 1）。 @internal */
const headingLevel = (b: Block): number => {
  const l = b.attrs.level ?? 1;
  return l < 1 ? 1 : l > 6 ? 6 : l;
};

// 列表项 depth → 缩进类（每级 1.5em）。仅在 depth>0 时输出 style。
const depthStyle = (b: Block): string => {
  const d = clampDepth(b.attrs.depth);
  return d > 0 ? ` style="margin-left:${d * 1.5}em"` : '';
};

// 目录块 → HTML：嵌套缩进的标题链接列表（heading 有 id 则锚接，无 id 仅文本）。
function tocHtml(doc: Doc): string {
  const entries = scanToc(doc, false);
  const items = entries.map((e) => {
    const indent = (e.level - 1) * 1.5;
    const style = indent > 0 ? ` style="margin-left:${indent}em"` : '';
    const inner = e.id ? `<a href="#${escAttr(e.id)}">${escHtml(e.text)}</a>` : escHtml(e.text);
    return `  <li${style}>${inner}</li>`;
  });
  return `<nav class="toc" aria-label="目录">\n<ul>\n${items.join('\n')}\n</ul>\n</nav>`;
}

// 段落兜底 HTML：非聚类、未注册钩子的块（含未知类型）按 <p> 输出（照搬原 else 分支）。
const defaultParaHtml = (b: Block, h: ExportHelpers): string => `<p${h.alignAttr(b)}>${h.inlinesHtml(b)}</p>`;

/**
 * 聚类合并块类型：连续多块合并为单个外层元素（<ul>/<ol>/<ul.task-list>/<pre>/```），
 * 由 toHtml/toMarkdown 主循环顶部判定（推进游标 i），不进 BLOCK_EXPORTERS 注册表。
 * 与 BLOCK_EXPORTERS 共同构成「每个块类型都有明确导出归宿」的覆盖性分区（见 export 注册表覆盖测试）。
 * @internal
 */
export const CLUSTER_EXPORT_TYPES: readonly BlockType[] = ['bullet_item', 'ordered_item', 'task_item', 'code_block'];

/**
 * 段落兜底块类型：toHtml 按 <p> 输出、toMarkdown 按 inlinesMd 输出（无专用模板）。
 * paragraph 自身归此；shape（分隔线/形状原子块）历史上也无专用导出，沿用段落降级（与原 else/default 分支一致）。
 * 同时是未注册新块类型的安全回退。
 * @internal
 */
export const PARAGRAPH_FALLBACK_TYPES: readonly BlockType[] = ['paragraph', 'shape'];

/** 把文档树序列化为 HTML（连续列表项/代码行合并为 ul/ol/pre）。 @public */
export function toHtml(doc: Doc): string {
  const out: string[] = [];
  const bs = doc.blocks;
  const helpers = makeHelpers(doc);
  let i = 0;
  while (i < bs.length) {
    const b = bs[i];
    // —— 聚类合并分支（推进游标 i、跨多块合并）：保留在循环顶部，不进 BLOCK_EXPORTERS ——
    if (b.type === 'bullet_item' || b.type === 'ordered_item') {
      const tag = b.type === 'bullet_item' ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < bs.length && bs[i].type === b.type) {
        items.push(`  <li${depthStyle(bs[i])}>${inlinesHtml(bs[i])}</li>`);
        i++;
      }
      out.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
      continue;
    }
    if (b.type === 'task_item') {
      // GFM 任务列表：<ul> 内每项前置 disabled checkbox（checked 决定勾选态）
      const items: string[] = [];
      while (i < bs.length && bs[i].type === 'task_item') {
        const checked = bs[i].attrs.checked ? ' checked' : '';
        items.push(`  <li${depthStyle(bs[i])}><input type="checkbox" disabled${checked} /> ${inlinesHtml(bs[i])}</li>`);
        i++;
      }
      out.push(`<ul class="task-list">\n${items.join('\n')}\n</ul>`);
      continue;
    }
    if (b.type === 'code_block') {
      const lines: string[] = [];
      while (i < bs.length && bs[i].type === 'code_block') {
        lines.push(escHtml(bs[i].inlines.map((r) => r.text).join('')));
        i++;
      }
      out.push(`<pre><code>${lines.join('\n')}</code></pre>`);
      continue;
    }
    // —— 单块单出口分支：先看 block-specs 的 meta.exporter（插件扩展点），回退内置 BLOCK_EXPORTERS，
    // 二者皆无则段落兜底。内置块 meta.exporter 留空，故对现有类型恒走 BLOCK_EXPORTERS（输出字节级不变）。——
    const ex = meta(b.type).exporter?.html ?? BLOCK_EXPORTERS[b.type]?.html;
    out.push(ex ? ex(b, helpers) : defaultParaHtml(b, helpers));
    i++;
  }
  return out.join('\n');
}

function runMd(run: Inline): string {
  // 行内原子（行内图片）→ Markdown 图片语法 ![](src)
  if (isInlineAtom(run)) return `![](${run.attrs.src ?? ''})`;
  let s = run.text;
  const m = run.marks;
  if (hasMarkType(m, 'code')) s = '`' + s + '`';
  if (hasMarkType(m, 'bold')) s = `**${s}**`;
  if (hasMarkType(m, 'italic')) s = `*${s}*`;
  if (hasMarkType(m, 'strikethrough')) s = `~~${s}~~`;
  if (hasMarkType(m, 'highlight')) s = `==${s}==`;
  if (hasMarkType(m, 'underline')) s = `<u>${s}</u>`; // MD 无下划线，回退 HTML
  if (hasMarkType(m, 'superscript')) s = `<sup>${s}</sup>`; // MD 无上标，回退 HTML
  if (hasMarkType(m, 'subscript')) s = `<sub>${s}</sub>`; // MD 无下标，回退 HTML
  // fontFamily/fontSize：MD 无对应语法，回退 <span style>（与 toHtml 同形，保 MD↔HTML 不丢）。
  // 同 wrapAppearanceMarks 的值白名单：MD 端拼接未经 escAttr，非法值（CSS 元字符）必须跳过。
  const fontFamily = getMark(m, 'fontFamily')?.attrs?.fontFamily;
  if (fontFamily && isSafeFontFamily(fontFamily)) s = `<span style="font-family:${fontFamily}">${s}</span>`;
  const fontSize = getMark(m, 'fontSize')?.attrs?.size;
  if (fontSize && isSafeSpanStyleValue('fontSize', fontSize)) s = `<span style="font-size:${fontSize}px">${s}</span>`;
  const color = getMark(m, 'color')?.attrs?.color;
  if (color && isSafeCssColor(color)) s = `<span style="color:${color}">${s}</span>`;
  const href = getMark(m, 'link')?.attrs?.href;
  if (href) s = `[${s}](${href})`;
  return s;
}
const inlinesMd = (b: Block) => b.inlines.map(runMd).join('');

/**
 * 构造一次导出的 ExportHelpers（转义 + 已配置的行内/单元格渲染器 + 当前 doc）。
 * 注入给 BLOCK_EXPORTERS 各钩子复用；block-specs 仅声明契约、实现在此闭包内（不反向依赖）。
 */
const makeHelpers = (doc: Doc): ExportHelpers => ({ escHtml, escAttr, inlinesHtml, inlinesMd, alignAttr, doc });

// 表格块 MD：管道表格降级为纯文本（cellText 拼接、单元格内换行 '\n' → '<br>'）。
// 空表（rows.length===0）返回 ''——toMarkdown 对该退化态不 push（照搬原 case 'table' 的 if(rows.length) 守卫）。
function tableMd(b: Block): string {
  const rows = b.attrs.rows ?? [];
  if (!rows.length) return '';
  const cellMd = (r: TableCell[]): string => r.map((c) => cellText(c).replace(/\n/g, '<br>')).join(' | ');
  const md = [
    `| ${cellMd(rows[0])} |`,
    `| ${rows[0].map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${cellMd(r)} |`),
  ];
  return md.join('\n');
}

// 表格块 HTML：合并区锚点格写 colspan/rowspan、被覆盖格不输出（经 sanitizeMerges 防御越界/不一致）。
function tableHtml(b: Block): string {
  const rows = b.attrs.rows ?? [];
  // 合并区：被覆盖格不输出，锚点格写 colspan/rowspan（与覆盖层渲染一致）。
  // 先经 sanitizeMerges 防御：rows 与 merges 不一致（历史/外部文档）时丢弃锚点越界的区、
  // clamp 跨度到表格边界，避免产出 colspan/rowspan 超界或「被覆盖却无锚点」的破损 HTML。
  const covered = new Set<string>();
  const span = new Map<string, { rowspan: number; colspan: number }>();
  for (const m of sanitizeMerges(b.attrs.merges ?? [], rows.length, tableColCount(rows))) {
    span.set(`${m.r},${m.c}`, { rowspan: m.rowspan, colspan: m.colspan });
    for (let dr = 0; dr < m.rowspan; dr++)
      for (let dc = 0; dc < m.colspan; dc++) {
        if (dr || dc) covered.add(`${m.r + dr},${m.c + dc}`);
      }
  }
  const trs = rows
    .map((r, ri) => {
      const cells = r
        .map((c, ci) => {
          if (covered.has(`${ri},${ci}`)) return '';
          const sp = span.get(`${ri},${ci}`);
          const a = sp
            ? `${sp.colspan > 1 ? ` colspan="${sp.colspan}"` : ''}${sp.rowspan > 1 ? ` rowspan="${sp.rowspan}"` : ''}`
            : '';
          return `<td${a}>${cellHtml(c)}</td>`;
        })
        .join('');
      return `  <tr>${cells}</tr>`;
    })
    .join('\n');
  return `<table>\n${trs}\n</table>`;
}

/**
 * 块导出注册表（Strategy）：单块单出口类型 → HTML/MD 钩子。
 * 每项字符串模板照搬自原 toHtml 的 if 分支 / toMarkdown 的 switch case，输出字节级不变。
 * 不含聚类合并类型（bullet/ordered/task/code_block）——那些跨多块合并、推进游标，留在 export 主循环顶部。
 * 内置块在此加一条钩子（未填 html→toHtml 回退 <p> 兜底；未填 md→toMarkdown 回退 inlinesMd）。
 * 外部插件可改走 block-specs 的 meta.exporter——export 主循环对每块优先查 meta.exporter?.html/.md，回退本表。
 * @internal
 */
export const BLOCK_EXPORTERS: Partial<Record<BlockType, BlockExporter>> = {
  heading: {
    html: (b, h) => {
      const lv = headingLevel(b);
      const idAttr = b.attrs.id ? ` id="${h.escAttr(b.attrs.id)}"` : '';
      return `<h${lv}${idAttr}${h.alignAttr(b)}>${h.inlinesHtml(b)}</h${lv}>`;
    },
    md: (b, h) => `${'#'.repeat(headingLevel(b))} ${h.inlinesMd(b)}`,
  },
  toc: {
    html: (_b, h) => tocHtml(h.doc),
    md: (_b, h) => {
      const entries = scanToc(h.doc, false); // 扫描全文 heading
      return entries.map((e) => `${'  '.repeat(e.level - 1)}- ${e.text}`).join('\n');
    },
  },
  blockquote: {
    html: (b, h) => `<blockquote${h.alignAttr(b)}>${h.inlinesHtml(b)}</blockquote>`,
    md: (b, h) => `> ${h.inlinesMd(b)}`,
  },
  image: {
    html: (b, h) => `<img src="${h.escAttr(b.attrs.src ?? '')}" alt="" />`,
    md: (b) => `![](${b.attrs.src ?? ''})`,
  },
  audio: {
    html: (b, h) => `<audio controls src="${h.escAttr(b.attrs.src ?? '')}"></audio>`,
    md: (b) => `[音频](${b.attrs.src ?? ''})`,
  },
  video: {
    html: (b, h) => {
      const dim =
        (b.attrs.width ? ` width="${b.attrs.width}"` : '') + (b.attrs.height ? ` height="${b.attrs.height}"` : '');
      return `<video controls src="${h.escAttr(b.attrs.src ?? '')}"${dim}></video>`;
    },
    md: (b) => `[视频](${b.attrs.src ?? ''})`,
  },
  iframe: {
    html: (b, h) => {
      const dim =
        (b.attrs.width ? ` width="${b.attrs.width}"` : '') + (b.attrs.height ? ` height="${b.attrs.height}"` : '');
      // sandbox 不含 allow-same-origin：与 allow-scripts 组合时同源内容可经 window.parent 触达
      // 宿主文档（沙箱逃逸/XSS 组合风险）。导出 HTML 与覆盖层（ui/overlays）保持同一安全基线。
      return `<iframe src="${h.escAttr(b.attrs.src ?? '')}"${dim} sandbox="allow-scripts allow-popups"></iframe>`;
    },
    md: (b) => `[内嵌网页](${b.attrs.src ?? ''})`,
  },
  attachment: {
    html: (b, h) => {
      const src = b.attrs.src ?? '',
        name = b.attrs.name || src;
      return `<a href="${h.escAttr(src)}" download="${h.escAttr(name)}">${h.escHtml(name)}</a>`;
    },
    md: (b) => `[${b.attrs.name || b.attrs.src || '附件'}](${b.attrs.src ?? ''})`,
  },
  signature: {
    // 电子签名：手绘 PNG dataURL → <img alt="签名">（尺寸属性按需输出）；MD → 图片语法。
    html: (b, h) => {
      const dim =
        (b.attrs.width ? ` width="${b.attrs.width}"` : '') + (b.attrs.height ? ` height="${b.attrs.height}"` : '');
      return `<img src="${h.escAttr(b.attrs.src ?? '')}"${dim} alt="签名" />`;
    },
    md: (b) => `![签名](${b.attrs.src ?? ''})`,
  },
  seal: {
    // 印章：内联红色公章 SVG（由印章文字现生成，与覆盖层一致），无文字时输出占位文本；MD → 占位文本。
    html: (b) => {
      const t = b.attrs.text ?? '';
      return t ? sealSvg(t) : '<span class="seal">[印章]</span>';
    },
    md: (b) => `[印章：${b.attrs.text ?? ''}]`,
  },
  textbox: {
    // 文本框：纯文本内容 → <div class="textbox">；换行转 <br>（v1 纯文本，无行内 mark）；MD → 段落纯文本。
    html: (b, h) => {
      const content = h.escHtml(b.attrs.content ?? '').replace(/\n/g, '<br>');
      return `<div class="textbox">${content}</div>`;
    },
    md: (b) => b.attrs.content ?? '',
  },
  formula: {
    html: (b, h) => `<p>\\(${h.escHtml(b.attrs.latex ?? '')}\\)</p>`,
    md: (b) => `$$\n${b.attrs.latex ?? ''}\n$$`,
  },
  table: { html: tableHtml, md: tableMd },
};

/** 把文档树序列化为 Markdown（有序列表续号，下划线回退为 HTML）。 @public */
export function toMarkdown(doc: Doc): string {
  const out: string[] = [];
  const bs = doc.blocks;
  const helpers = makeHelpers(doc);
  let i = 0,
    ordinal = 0;
  while (i < bs.length) {
    const b = bs[i];
    if (b.type === 'ordered_item') ordinal++;
    else ordinal = 0;
    // —— 依赖循环状态（pad/ordinal）或聚类游标的分支：留在循环内 ——
    // 列表项 depth → Markdown 嵌套缩进（每级 2 空格）。
    const pad = '  '.repeat(clampDepth(b.attrs.depth));
    if (b.type === 'bullet_item') {
      out.push(`${pad}- ${inlinesMd(b)}`);
      i++;
      continue;
    }
    if (b.type === 'ordered_item') {
      out.push(`${pad}${ordinal}. ${inlinesMd(b)}`);
      i++;
      continue;
    }
    if (b.type === 'task_item') {
      out.push(`${pad}- [${b.attrs.checked ? 'x' : ' '}] ${inlinesMd(b)}`);
      i++;
      continue;
    }
    if (b.type === 'code_block') {
      const lines: string[] = [];
      while (i < bs.length && bs[i].type === 'code_block') {
        lines.push(bs[i].inlines.map((r) => r.text).join(''));
        i++;
      }
      out.push('```\n' + lines.join('\n') + '\n```');
      continue;
    }
    // 空表退化态：原 case 'table' 的 if(rows.length) 守卫——空表不产任何 out 元素（byte-exact 保留）。
    if (b.type === 'table' && !b.attrs.rows?.length) {
      i++;
      continue;
    }
    // —— 单块单出口分支：先看 block-specs 的 meta.exporter（插件扩展点），回退内置 BLOCK_EXPORTERS，
    // 二者皆无则 inlinesMd 段落兜底。内置块 meta.exporter 留空，故对现有类型恒走 BLOCK_EXPORTERS（输出字节级不变）。——
    const ex = meta(b.type).exporter?.md ?? BLOCK_EXPORTERS[b.type]?.md;
    out.push(ex ? ex(b, helpers) : inlinesMd(b));
    i++;
  }
  return out.join('\n\n');
}

/** 把文档树序列化为缩进 2 空格的 JSON 字符串。 @public */
export function toJson(doc: Doc): string {
  return JSON.stringify(doc, null, 2);
}
