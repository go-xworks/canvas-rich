// model 层：行内序列（一个 block 的 inlines）按块内字符偏移的纯函数操作集合，
// 是 schema 之上、editor 命令之下的不可变文本编辑原语。
import { Inline, Mark, MarkType, text, marksEqual, isInclusive, hasMarkType, withMark, withoutMark, isInlineAtom, cloneInline } from './schema';

// 行内序列（一个 block 的 inlines）按「块内字符偏移」的纯操作。
// 所有写操作出口都过 normalizeInlines：合并相邻同-marks 段 + 删空段，保证唯一表示。
//
// 行内原子（InlineAtom）：text.length 恒为 1，作为「不可分割的 1 长度单元」处理。
// 由于其长度为 1，任意区间 [from,to) 与其相交（s<e）必然 s=段首、e=段尾，
// 故下面的「按子区间重建文本段」逻辑永不会切进原子内部——只需在重建时保留原子身份。

/**
 * 块内偏移 offset 恰为某行内原子（如行内图片）的起始时返回其 src，否则 ''（src 缺省同样 ''）。
 * 覆盖层按 block:offset 把行内覆盖盒映射回原子 src 用（自 main.ts 下沉的纯查询）。 @public
 */
export function inlineAtomSrcAt(inlines: Inline[], offset: number): string {
  let pos = 0;
  for (const inl of inlines) {
    if (pos === offset && isInlineAtom(inl)) return inl.attrs.src ?? '';
    pos += inl.text.length;
  }
  return '';
}

/**
 * 按子区间 [s-a, e-a) 重建一个行内节点片段：
 * - 文本段：切出对应子串，保留 marks；
 * - 行内原子：必为整段命中（长度 1），深拷贝整段保留原子身份（不切片）。
 */
function sliceInline(inl: Inline, relStart: number, relEnd: number): Inline {
  if (isInlineAtom(inl)) return cloneInline(inl); // 原子不可分割：整段保留
  return { kind: 'text', text: inl.text.slice(relStart, relEnd), marks: inl.marks };
}

/**
 * 归一化行内序列：删空段、合并相邻 marks 相等的文本段。
 * 行内原子不参与合并（视为独立段，原样保留）。
 * 不变量：输出至少含一个段（空时保留空段承载光标）；幂等。 @public
 */
// 归一化：删空段、合并相邻 marks 相等的文本段。幂等。
export function normalizeInlines(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inl of inlines) {
    if (isInlineAtom(inl)) { out.push(cloneInline(inl)); continue; } // 原子：原样保留，不删不并
    if (inl.text === '') continue; // 删空段
    const last = out[out.length - 1];
    if (last && !isInlineAtom(last) && marksEqual(last.marks, inl.marks)) last.text += inl.text; // 合并同 marks
    else out.push({ kind: 'text', text: inl.text, marks: inl.marks });
  }
  if (out.length === 0) out.push(text('')); // 至少保留一个空段承载光标
  return out;
}

/**
 * 表格单元格行内序列的归一化入口：先剔除行内原子（InlineAtom）再 {@link normalizeInlines}。
 *
 * 不变量：**td 不承载行内原子**——单元格 contenteditable 编辑管线（export 的 inlinesToCellHtml
 * 渲染 ↔ editor/cell-dom 的 domToInlines 回读）不支持原子（渲染端丢弃、回读端无从还原），
 * 任何产 cell 的路径（HTML 表格导入 walkTable、单元格编辑回写）都必须经本入口过滤，
 * 否则混入的原子会在首次单元格编辑回写时静默丢失（且其间模型与编辑视图不一致）。 @public
 */
export function normalizeCellInlines(inlines: Inline[]): Inline[] {
  return normalizeInlines(inlines.filter((inl) => !isInlineAtom(inl)));
}

/** 取偏移区间 [from,to) 的子序列，保留各段 marks 并归一化。 @public */
// 取 [from,to) 的子序列（保留各段 marks）
export function sliceInlines(inlines: Inline[], from: number, to: number): Inline[] {
  const out: Inline[] = [];
  let pos = 0;
  for (const inl of inlines) {
    const a = pos, b = pos + inl.text.length;
    pos = b;
    const s = Math.max(from, a), e = Math.min(to, b);
    if (s < e) out.push(sliceInline(inl, s - a, e - a)); // 原子整段命中（长度 1，s<e ⇒ 整段）
    if (pos >= to) break;
  }
  return normalizeInlines(out);
}

/** 删除偏移区间 [from,to)，拼接左右两侧并归一化。 @public */
// 删除 [from,to)
export function deleteRange(inlines: Inline[], from: number, to: number): Inline[] {
  if (from >= to) return normalizeInlines(inlines);
  const left = sliceInlines(inlines, 0, from);
  const right = sliceInlines(inlines, to, Infinity);
  return normalizeInlines([...left, ...right]);
}

/** 在偏移 at 处插入带 marks 的文本并归一化。 @public */
// 在 at 处插入文本（带 marks）
export function insertText(inlines: Inline[], at: number, str: string, marks: Mark[]): Inline[] {
  if (str === '') return normalizeInlines(inlines);
  const left = sliceInlines(inlines, 0, at);
  const right = sliceInlines(inlines, at, Infinity);
  return normalizeInlines([...left, text(str, marks), ...right]);
}

/** 在偏移 at 处将行内序列拆成 [前半, 后半]（用于 Enter 拆块）。 @public */
// 拆成两半（用于 Enter 拆块）：返回 [前半 inlines, 后半 inlines]
export function splitInlines(inlines: Inline[], at: number): [Inline[], Inline[]] {
  return [sliceInlines(inlines, 0, at), sliceInlines(inlines, at, Infinity)];
}

/**
 * 判定区间 [from,to) 是否「全部」覆盖某 mark；用于 toggle 决策（全有则移除，否则添加）。
 * 依据：仅当区间内每个命中段都含该 mark 才返回 true；空区间返回 false。 @public
 */
// 区间 [from,to) 是否「全部」含某 mark（用于 toggle 判定：全有则移除，否则添加）
export function rangeHasMark(inlines: Inline[], from: number, to: number, type: MarkType): boolean {
  if (from >= to) return false;
  let pos = 0, covered = true, any = false;
  for (const inl of inlines) {
    const a = pos, b = pos + inl.text.length; pos = b;
    const s = Math.max(from, a), e = Math.min(to, b);
    if (s < e) { any = true; if (!hasMarkType(inl.marks, type)) { covered = false; break; } }
    if (pos >= to) break;
  }
  return any && covered;
}

/**
 * 给区间 [from,to) 加/去某 mark（add=true 加，attrs 走更新；false 去）。
 * 依据：被区间切中的段最多拆成左外/中(命中)/右外三块，仅中块改 marks，再归一化合并。 @public
 */
// 给 [from,to) 加/去 mark；add=true 加（attrs 走更新），false 去
export function applyMark(inlines: Inline[], from: number, to: number, mark: Mark, add: boolean): Inline[] {
  if (from >= to) return normalizeInlines(inlines);
  const out: Inline[] = [];
  let pos = 0;
  for (const inl of inlines) {
    const a = pos, b = pos + inl.text.length; pos = b;
    const s = Math.max(from, a), e = Math.min(to, b);
    if (s >= e) { out.push(inl); continue; }
    // 行内原子不参与字符级 mark：命中时原样保留（不染色、不切片）
    if (isInlineAtom(inl)) { out.push(cloneInline(inl)); continue; }
    // 段被 [from,to) 切成最多三块：左外 / 中(命中) / 右外
    if (s > a) out.push({ kind: 'text', text: inl.text.slice(0, s - a), marks: inl.marks });
    const midMarks = add ? withMark(inl.marks, mark) : withoutMark(inl.marks, mark.type);
    out.push({ kind: 'text', text: inl.text.slice(s - a, e - a), marks: midMarks });
    if (e < b) out.push({ kind: 'text', text: inl.text.slice(e - a), marks: inl.marks });
  }
  return normalizeInlines(out);
}

/**
 * 取 offset 处打字应继承的 marks。
 * 依据：以左侧段为主；块首(offset<=0)仅继承包含型；非包含 mark(link/code)若右侧不含则剔除。 @public
 */
// 取 offset 处「打字应继承」的 marks：以左侧段为主，剔除「左有右无」的非包含 mark。
export function marksAt(inlines: Inline[], offset: number): Mark[] {
  const leftMarks = marksBefore(inlines, offset);
  const rightMarks = marksAfter(inlines, offset);
  if (offset <= 0) return rightMarks.filter((m) => isInclusive(m.type)); // 块首：左侧无内容，非包含 mark(link/code)不继承
  // 左主集合中，非包含 mark 且右侧不含者剔除
  return leftMarks.filter((m) => isInclusive(m.type) || hasMarkType(rightMarks, m.type));
}

function marksBefore(inlines: Inline[], offset: number): Mark[] {
  let pos = 0;
  for (const inl of inlines) {
    const b = pos + inl.text.length;
    if (offset <= b && offset > pos) return [...inl.marks]; // 落在该段内部/右缘（原子 marks 恒空，spread 仅展平类型）
    pos = b;
  }
  const last = inlines[inlines.length - 1];
  return last ? [...last.marks] : [];
}
function marksAfter(inlines: Inline[], offset: number): Mark[] {
  let pos = 0;
  for (const inl of inlines) {
    const b = pos + inl.text.length;
    if (offset >= pos && offset < b) return [...inl.marks]; // 落在该段内部/左缘
    pos = b;
  }
  return [];
}
