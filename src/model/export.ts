import { Doc, Block, TextRun, getMark, hasMarkType } from './schema';

// 文档树 → HTML / Markdown / JSON。块按类型分组（连续列表项合并为 <ul>/<ol>，连续代码行合并为 <pre>）。
// 分层位置：model 层的导出/序列化端，把文档树落地为外部格式。

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escHtml(s).replace(/"/g, '&quot;');

function runHtml(run: TextRun): string {
  let s = escHtml(run.text);
  const m = run.marks;
  if (hasMarkType(m, 'code')) s = `<code>${s}</code>`;
  if (hasMarkType(m, 'bold')) s = `<strong>${s}</strong>`;
  if (hasMarkType(m, 'italic')) s = `<em>${s}</em>`;
  if (hasMarkType(m, 'underline')) s = `<u>${s}</u>`;
  if (hasMarkType(m, 'strikethrough')) s = `<s>${s}</s>`;
  if (hasMarkType(m, 'highlight')) s = `<mark>${s}</mark>`;
  if (hasMarkType(m, 'superscript')) s = `<sup>${s}</sup>`;
  if (hasMarkType(m, 'subscript')) s = `<sub>${s}</sub>`;
  const fontFamily = getMark(m, 'fontFamily')?.attrs?.fontFamily;
  if (fontFamily) s = `<span style="font-family:${escAttr(fontFamily)}">${s}</span>`;
  const fontSize = getMark(m, 'fontSize')?.attrs?.size;
  if (fontSize) s = `<span style="font-size:${escAttr(fontSize)}px">${s}</span>`;
  const color = getMark(m, 'color')?.attrs?.color;
  if (color) s = `<span style="color:${escAttr(color)}">${s}</span>`;
  const href = getMark(m, 'link')?.attrs?.href;
  if (href) s = `<a href="${escAttr(href)}">${s}</a>`;
  return s;
}
const inlinesHtml = (b: Block) => b.inlines.map(runHtml).join('');
const alignAttr = (b: Block) => (b.attrs.align && b.attrs.align !== 'left' ? ` style="text-align:${b.attrs.align}"` : '');
/** 标题级别夹回 1..6（缺省 1）。 @internal */
const headingLevel = (b: Block): number => { const l = b.attrs.level ?? 1; return l < 1 ? 1 : l > 6 ? 6 : l; };

/** 把文档树序列化为 HTML（连续列表项/代码行合并为 ul/ol/pre）。 @public */
export function toHtml(doc: Doc): string {
  const out: string[] = [];
  const bs = doc.blocks;
  let i = 0;
  while (i < bs.length) {
    const b = bs[i];
    if (b.type === 'bullet_item' || b.type === 'ordered_item') {
      const tag = b.type === 'bullet_item' ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < bs.length && bs[i].type === b.type) { items.push(`  <li>${inlinesHtml(bs[i])}</li>`); i++; }
      out.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
      continue;
    }
    if (b.type === 'task_item') {
      // GFM 任务列表：<ul> 内每项前置 disabled checkbox（checked 决定勾选态）
      const items: string[] = [];
      while (i < bs.length && bs[i].type === 'task_item') {
        const checked = bs[i].attrs.checked ? ' checked' : '';
        items.push(`  <li><input type="checkbox" disabled${checked} /> ${inlinesHtml(bs[i])}</li>`);
        i++;
      }
      out.push(`<ul class="task-list">\n${items.join('\n')}\n</ul>`);
      continue;
    }
    if (b.type === 'code_block') {
      const lines: string[] = [];
      while (i < bs.length && bs[i].type === 'code_block') { lines.push(escHtml(bs[i].inlines.map((r) => r.text).join(''))); i++; }
      out.push(`<pre><code>${lines.join('\n')}</code></pre>`);
      continue;
    }
    if (b.type === 'image') { out.push(`<img src="${escAttr(b.attrs.src ?? '')}" alt="" />`); i++; continue; }
    if (b.type === 'formula') { out.push(`<p>\\(${escHtml(b.attrs.latex ?? '')}\\)</p>`); i++; continue; }
    if (b.type === 'table') {
      const rows = b.attrs.rows ?? [];
      const trs = rows.map((r) => `  <tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('\n');
      out.push(`<table>\n${trs}\n</table>`); i++; continue;
    }
    if (b.type === 'heading') { const lv = headingLevel(b); out.push(`<h${lv}${alignAttr(b)}>${inlinesHtml(b)}</h${lv}>`); }
    else if (b.type === 'blockquote') out.push(`<blockquote${alignAttr(b)}>${inlinesHtml(b)}</blockquote>`);
    else out.push(`<p${alignAttr(b)}>${inlinesHtml(b)}</p>`);
    i++;
  }
  return out.join('\n');
}

function runMd(run: TextRun): string {
  let s = run.text;
  const m = run.marks;
  if (hasMarkType(m, 'code')) s = '`' + s + '`';
  if (hasMarkType(m, 'bold')) s = `**${s}**`;
  if (hasMarkType(m, 'italic')) s = `*${s}*`;
  if (hasMarkType(m, 'strikethrough')) s = `~~${s}~~`;
  if (hasMarkType(m, 'highlight')) s = `==${s}==`;
  if (hasMarkType(m, 'underline')) s = `<u>${s}</u>`; // MD 无下划线，回退 HTML
  if (hasMarkType(m, 'superscript')) s = `<sup>${s}</sup>`; // MD 无上标，回退 HTML
  if (hasMarkType(m, 'subscript')) s = `<sub>${s}</sub>`;  // MD 无下标，回退 HTML
  const color = getMark(m, 'color')?.attrs?.color;
  if (color) s = `<span style="color:${color}">${s}</span>`;
  const href = getMark(m, 'link')?.attrs?.href;
  if (href) s = `[${s}](${href})`;
  return s;
}
const inlinesMd = (b: Block) => b.inlines.map(runMd).join('');

/** 把文档树序列化为 Markdown（有序列表续号，下划线回退为 HTML）。 @public */
export function toMarkdown(doc: Doc): string {
  const out: string[] = [];
  const bs = doc.blocks;
  let i = 0, ordinal = 0;
  while (i < bs.length) {
    const b = bs[i];
    if (b.type === 'ordered_item') ordinal++; else ordinal = 0;
    switch (b.type) {
      case 'heading': out.push(`${'#'.repeat(headingLevel(b))} ${inlinesMd(b)}`); break;
      case 'bullet_item': out.push(`- ${inlinesMd(b)}`); break;
      case 'ordered_item': out.push(`${ordinal}. ${inlinesMd(b)}`); break;
      case 'task_item': out.push(`- [${b.attrs.checked ? 'x' : ' '}] ${inlinesMd(b)}`); break;
      case 'blockquote': out.push(`> ${inlinesMd(b)}`); break;
      case 'image': out.push(`![](${b.attrs.src ?? ''})`); break;
      case 'formula': out.push(`$$\n${b.attrs.latex ?? ''}\n$$`); break;
      case 'table': {
        const rows = b.attrs.rows ?? [];
        if (rows.length) {
          const md = [`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)];
          out.push(md.join('\n'));
        }
        break;
      }
      case 'code_block': {
        const lines: string[] = [];
        while (i < bs.length && bs[i].type === 'code_block') { lines.push(bs[i].inlines.map((r) => r.text).join('')); i++; }
        out.push('```\n' + lines.join('\n') + '\n```');
        continue;
      }
      default: out.push(inlinesMd(b));
    }
    i++;
  }
  return out.join('\n\n');
}

/** 把文档树序列化为缩进 2 空格的 JSON 字符串。 @public */
export function toJson(doc: Doc): string {
  return JSON.stringify(doc, null, 2);
}
