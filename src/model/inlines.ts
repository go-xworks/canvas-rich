// model 层：行内序列（一个 block 的 inlines）按块内字符偏移的纯函数操作集合，
// 是 schema 之上、editor 命令之下的不可变文本编辑原语。
import { Inline, Mark, MarkType, text, marksEqual, isInclusive, hasMarkType, withMark, withoutMark } from './schema';

// 行内序列（一个 block 的 inlines）按「块内字符偏移」的纯操作。
// 所有写操作出口都过 normalizeInlines：合并相邻同-marks 段 + 删空段，保证唯一表示。

/**
 * 归一化行内序列：删空段、合并相邻 marks 相等的文本段。
 * 不变量：输出至少含一个段（空时保留空段承载光标）；幂等。 @public
 */
// 归一化：删空段、合并相邻 marks 相等的文本段。幂等。
export function normalizeInlines(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inl of inlines) {
    if (inl.text === '') continue; // 删空段
    const last = out[out.length - 1];
    if (last && marksEqual(last.marks, inl.marks)) last.text += inl.text; // 合并同 marks
    else out.push({ kind: 'text', text: inl.text, marks: inl.marks });
  }
  if (out.length === 0) out.push(text('')); // 至少保留一个空段承载光标
  return out;
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
    if (s < e) out.push({ kind: 'text', text: inl.text.slice(s - a, e - a), marks: inl.marks });
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
    if (offset <= b && offset > pos) return inl.marks; // 落在该段内部/右缘
    pos = b;
  }
  const last = inlines[inlines.length - 1];
  return last ? last.marks : [];
}
function marksAfter(inlines: Inline[], offset: number): Mark[] {
  let pos = 0;
  for (const inl of inlines) {
    const b = pos + inl.text.length;
    if (offset >= pos && offset < b) return inl.marks; // 落在该段内部/左缘
    pos = b;
  }
  return [];
}
