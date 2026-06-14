// 断行算法（纯函数，脱离 canvas / atlas，可在 node 下单测）。属于 text 分层的排版子模块。
// 贪心断行：遇 '\n' 硬换行；宽度超 maxWidth 时在最后一个空格后折行，无空格则硬断。

/** 断行输入单元：一个可断字符的宽度与空格/换行标记。@public */
export interface BreakItem {
  advance: number;
  isSpace: boolean;
  isNewline: boolean;
}

/**
 * 把 items 贪心断成多行，返回每行的「item 下标数组」。@public
 *
 * 不变量：换行点只落在空格后或行硬断处；非空行的累计宽度尽量不超 maxWidth
 * （单 item 宽于 maxWidth 时该行仅含此 item）；输出行数组的下标并集 = [0,n) 且有序。
 * - '\n' 作为该行最后一个 item 并触发换行。
 * - 宽度溢出且行内有可折空格时，在该空格后折行并把余下 item 移到下一行（并重算下一行宽度）。
 * - 无可折空格则硬断。
 * - 循环结束 push 最后一行（最后一行可能为空，对应文末空行）。
 */
export function breakLines(items: BreakItem[], maxWidth: number): number[][] {
  const n = items.length;
  const lines: number[][] = [];
  let line: number[] = [];
  let lineW = 0;
  let lastSpaceInLine = -1; // line 数组内的下标
  for (let i = 0; i < n; i++) {
    if (items[i].isNewline) {
      line.push(i);
      lines.push(line);
      line = [];
      lineW = 0;
      lastSpaceInLine = -1;
      continue;
    }
    const adv = items[i].advance;
    if (lineW + adv > maxWidth && line.length > 0) {
      if (lastSpaceInLine >= 0 && lastSpaceInLine < line.length - 1) {
        // 在最后一个空格后折行
        const rest = line.slice(lastSpaceInLine + 1);
        line = line.slice(0, lastSpaceInLine + 1);
        lines.push(line);
        line = rest;
        lineW = 0;
        for (const idx of rest) lineW += items[idx].advance;
        lastSpaceInLine = -1;
      } else {
        // 无可折空格：硬断
        lines.push(line);
        line = [];
        lineW = 0;
        lastSpaceInLine = -1;
      }
    }
    line.push(i);
    lineW += adv;
    if (items[i].isSpace) lastSpaceInLine = line.length - 1;
  }
  lines.push(line); // 最后一行（可能为空，对应文末空行）
  return lines;
}
