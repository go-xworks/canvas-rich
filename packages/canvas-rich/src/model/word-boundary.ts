// 按 UAX#29 词边界计量（Intl.Segmenter word 粒度）：⌥←/→ 词跳转、⌥⌫/⌥Del 删词的文本基元。
// 分层位置：model 层文本计量基元（grapheme.ts 的 word 粒度姊妹件），供编辑/选区按词推进。
import { createSegmenter } from './segmenter';

/** UAX#29 词切分器（最小类型声明共享自 ./segmenter）；环境不支持 Intl.Segmenter 时为 null，回退到词字符类扫描。 @internal */
const wordSegmenter = createSegmenter('word');

// 回退词字符类（无 Intl.Segmenter 环境）：字母/数字/下划线视为词字符，其余（空白/标点）为非词。
const RE_WORD_CHAR = /[\p{L}\p{N}_]/u;

// 词段：[start,end) 的 UTF-16 区间 + 是否「词样」（isWordLike；空白/标点/孤立符号为 false）。
interface WordSpan {
  start: number;
  end: number;
  wordLike: boolean;
}

// 把字符串切为词段序列：优先 Intl.Segmenter（CJK 词典分词），缺失时按词字符类归并连续段。
function wordSpans(textStr: string): WordSpan[] {
  const out: WordSpan[] = [];
  if (wordSegmenter) {
    for (const s of wordSegmenter.segment(textStr)) {
      out.push({ start: s.index, end: s.index + s.segment.length, wordLike: !!s.isWordLike });
    }
    return out;
  }
  let i = 0;
  while (i < textStr.length) {
    const wordLike = RE_WORD_CHAR.test(textStr[i]);
    let j = i + 1;
    while (j < textStr.length && RE_WORD_CHAR.test(textStr[j]) === wordLike) j++;
    out.push({ start: i, end: j, wordLike });
    i = j;
  }
  return out;
}

/**
 * 严格大于 offset 的下一个「词尾」边界（⌥→/⌥Del 语义：跳到当前或下一个词的末尾，
 * 途经空白/标点一并跨过）；其后再无词时返回串长。
 * @public
 */
export function nextWordBoundary(textStr: string, offset: number): number {
  for (const s of wordSpans(textStr)) if (s.wordLike && s.end > offset) return s.end;
  return textStr.length;
}

/**
 * 严格小于 offset 的上一个「词首」边界（⌥←/⌥⌫ 语义：跳到当前或上一个词的开头，
 * 途经空白/标点一并跨过）；其前再无词时返回 0。
 * @public
 */
export function prevWordBoundary(textStr: string, offset: number): number {
  let best = 0;
  for (const s of wordSpans(textStr)) {
    if (s.wordLike && s.start < offset) best = s.start;
    else if (s.start >= offset) break;
  }
  return best;
}

/**
 * offset 所在词的 [start,end) 区间（双击选词 / 触屏长按选词）：取含 offset 的词段
 * （start ≤ offset < end；offset = 串长时取末段）；offset 恰落在「词尾｜空白起」边界时
 * 偏向左侧词（双击词尾选中该词，而非右侧空白）；落点在空白/标点段内则返回该段自身
 * （与浏览器双击空白选中空白连段一致）。空串返回 [0,0]。
 * @public
 */
export function wordRangeAt(textStr: string, offset: number): { start: number; end: number } {
  const spans = wordSpans(textStr);
  if (spans.length === 0) return { start: 0, end: 0 };
  const o = Math.max(0, Math.min(offset, textStr.length));
  let hit = spans.find((s) => s.start <= o && o < s.end) ?? spans[spans.length - 1];
  if (!hit.wordLike) {
    const left = spans.find((s) => s.wordLike && s.end === o);
    if (left) hit = left;
  }
  return { start: hit.start, end: hit.end };
}
