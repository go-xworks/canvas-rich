// 工具栏悬停提示（ui 层）：把控件的原生 title 升级为自定义浮层「名称 + 快捷键 + 用法」，
// 并移除原生 title 防双重慢提示（aria-label 保留，无障碍不丢）。纯逻辑（tipParse/tipDescKey/
// TIP_DESC）可在 node 环境单测；enrichTooltips 触碰 DOM。自 src/ui/toolbar.ts 切出，逻辑不改。
import { attachTooltip, installTooltips } from '../tooltip';

/** 控件用法说明（悬停提示的描述行）。键 = 控件名开头中文连串（去括注）。 @internal */
export const TIP_DESC: Record<string, string> = {
  撤销: '撤销上一步操作', 重做: '重做被撤销的操作',
  正文: '设为普通段落', 标题: '设为 1–6 级标题，组织文档结构',
  引用: '设为引用块（缩进 + 斜体弱化）', 代码块: '设为等宽代码块（连续多行共背景）',
  项目符号: '无序列表，Tab / Shift+Tab 调整层级', 编号列表: '有序列表，自动连续编号',
  任务列表: '可勾选待办项（☐ / ☑，点击切换）',
  粗体: '把选中文字加粗', 斜体: '把选中文字变斜体', 下划线: '给选中文字加下划线',
  删除线: '给选中文字加删除线', 行内代码: '把选中文字设为等宽行内代码',
  上标: '把选中文字变上标（如 x²）', 下标: '把选中文字变下标（如 H₂O）',
  文字颜色: '设置选中文字的颜色（含自定义 hex）', 高亮颜色: '给选中文字加背景高亮（含自定义 hex）',
  清除格式: '清除选区内全部行内格式',
  字号: '设置选中文字的字号', 字体族: '设置选中文字的字体',
  块类型: '切换当前段落的块类型（正文 / 标题 / 引用 / 代码块）',
  左对齐: '段落左对齐', 居中: '段落居中对齐', 右对齐: '段落右对齐',
  两端对齐: '两端对齐：拉伸词间距填满整行（末行除外）', 分散对齐: '分散对齐：字符均匀分布填满整行',
  文字方向: '切换段落书写方向 LTR ↔ RTL',
  减少缩进: '减小段落 / 列表缩进', 增加缩进: '增大段落 / 列表缩进',
  行距: '设置行间距（1 / 1.15 / 1.5 / 2 倍）',
  // 键须与 numInput 的 title（段前间距/段后间距/字间距）经 tipDescKey 归一后的结果对齐。
  段前间距: '段落上方间距（px）', 段后间距: '段落下方间距（px）', 字间距: '字符间距（px）',
  插入图片: '插入块级图片（上传 / 拖拽 / URL / 粘贴，可缩放拖动）',
  插入行内图片: '插入随文字流动的行内图片',
  插入公式: '插入 LaTeX 数学公式（KaTeX 渲染）',
  插入表格: '可视网格选行列数后插入表格', 插入形状: '插入形状（线 / 矩形 / 椭圆 / 箭头等 9 种）',
  插入音频: '插入音频播放器（媒体 URL）', 插入视频: '插入视频播放器（媒体 URL，可缩放）',
  插入内嵌网页: '插入内嵌网页 iframe（URL，沙箱隔离，可缩放）', 插入附件: '插入可下载文件卡片（URL + 文件名）',
  插入电子签名: '弹出画板手写签名，确定后作为图片插入（可缩放）', 插入印章: '输入单位名生成红色圆形公章（可缩放）',
  插入文本框: '插入可编辑浮动文本框（直接键入，可缩放拖动）',
  链接: '给选中文字加超链接（⌘ / Ctrl + 点击打开）',
  插入目录: '插入目录，自动汇总全文标题，点击跳转', 插入分隔线: '插入一条水平分隔线',
  模板: '套用模板（红头公文 / 会议纪要 / 简历）或设为模板',
  导入: '粘贴 Markdown / HTML 文本，解析为文档',
  整形器: '切换文本整形器 Canvas / HarfBuzz（复杂文字连写）',
  切换暗色: '一键切换亮色 / 暗色主题（编辑器 + 界面同步换肤）',
  web视图: '连续滚动的网页式视图（不分页）',
  word视图: '仿 Word 的 A4 分页视图（页缝 + 纸面投影）',
  导出: '导出为 HTML / Markdown / JSON',
  打印: '打开系统打印对话框，可直接打印或存储为 PDF（A4 分页）',
};

/** 解析控件 title 为「名称 + 快捷键」（快捷键 = 末尾以修饰键符号起的串）。 @internal */
export function tipParse(raw: string): { name: string; shortcut?: string } {
  const m = raw.match(/^(.*?)\s+([⌘⌥⇧⌃][^\s（(]*)$/);
  return m ? { name: m[1].trim(), shortcut: m[2].trim() } : { name: raw.trim() };
}

/** 用法描述查找键：去括注，取开头中文连串。 @internal */
export function tipDescKey(name: string): string {
  const bare = name.replace(/[（(].*?[）)]/g, '').trim();
  return bare.match(/^[一-龥]+/)?.[0] ?? bare;
}

/** 把工具栏内每个带 title 的控件升级为自定义悬停提示（名称/快捷键/用法），并去原生 title 防双重慢提示。 @internal */
export function enrichTooltips(host: HTMLElement): void {
  installTooltips();
  host.querySelectorAll<HTMLElement>('[title]').forEach((el) => {
    const raw = el.getAttribute('title');
    if (!raw) return;
    const { name, shortcut } = tipParse(raw);
    attachTooltip(el, { title: name, shortcut, desc: TIP_DESC[tipDescKey(name)] });
    el.removeAttribute('title'); // 抑制浏览器原生慢提示（aria-label 仍在，无障碍不丢）
  });
}
