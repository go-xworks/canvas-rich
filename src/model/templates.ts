// 预置文档模板（model 层）：用现有 block/heading/para/对齐/color mark 构造合法 Doc。
// 提供「空白 / 红头文件 / 会议纪要 / 简历」四种内置模板，外加用户自定义模板的本地存储读写。
// replaceDoc(doc) 消费这些 Doc：进撤销栈、替换 blocks、光标归位文首。
// 分层位置：model 层，纯数据构造，不依赖 DOM/视图（localStorage 读写做了环境护栏，便于单测）。
import { Doc, Block, block, para, text, sanitizeStoredBlocks } from './schema';

/** 公文红头标准红（近似国标 GB 红，过白底可读）。 @public */
export const GOV_RED = '#c00000';

/** 一个预置模板：名称 + 产出合法 Doc 的工厂。 @public */
export interface DocTemplate {
  /** 下拉显示名（唯一）。 */
  name: string;
  /** 构造该模板的一份全新 Doc（每次调用返回新对象，互不共享引用）。 */
  build(): Doc;
}

// 红色 color mark 便捷封装：把一段文字染成公文红。
const red = (s: string): Block['inlines'][number] => text(s, [{ type: 'color', attrs: { color: GOV_RED } }]);

/** 空白模板：单个空段落。 @public */
function buildBlank(): Doc {
  return { blocks: [para([text('')])] };
}

/**
 * 红头文件（公文）模板：居中红色大标题 + 主送机关 + 正文段落 + 落款居右 + 日期居右。
 * 标题用居中对齐的 H1 + 红色 color mark 近似红头效果。
 * @public
 */
function buildGovDoc(): Doc {
  return {
    blocks: [
      block('heading', [red('XX 单位关于 XX 工作的通知')], { level: 1, align: 'center' }),
      para([red('〔2026〕 1 号')], { align: 'center' }),
      para([text('XX 部门：')]),
      para([text('　　根据有关工作部署，现就 XX 事项通知如下，请遵照执行。')]),
      para([text('　　一、提高认识，加强领导。')]),
      para([text('　　二、明确分工，落实责任。')]),
      para([text('　　三、按时反馈，确保实效。')]),
      para([text('　　特此通知。')]),
      para([text('XX 单位（盖章）')], { align: 'right' }),
      para([text('2026 年 6 月 9 日')], { align: 'right' }),
    ],
  };
}

/** 会议纪要模板：标题 + 会议要素段落 + 议题/决议小标题与列表。 @public */
function buildMeetingMinutes(): Doc {
  return {
    blocks: [
      block('heading', [text('会议纪要')], { level: 1, align: 'center' }),
      para([text('会议时间：2026 年 6 月 9 日')]),
      para([text('会议地点：第一会议室')]),
      para([text('主持人：（待填）')]),
      para([text('参会人员：（待填）')]),
      block('heading', [text('一、会议议题')], { level: 2 }),
      block('bullet_item', [text('议题一：（待填）')]),
      block('bullet_item', [text('议题二：（待填）')]),
      block('heading', [text('二、会议决议')], { level: 2 }),
      block('ordered_item', [text('决议一：（待填）')]),
      block('ordered_item', [text('决议二：（待填）')]),
      block('heading', [text('三、后续行动')], { level: 2 }),
      block('task_item', [text('待办一：（负责人 / 截止日期）')]),
      block('task_item', [text('待办二：（负责人 / 截止日期）')]),
    ],
  };
}

/** 简历模板：姓名标题 + 联系方式 + 教育/工作/技能分节与列表。 @public */
function buildResume(): Doc {
  return {
    blocks: [
      block('heading', [text('张三')], { level: 1, align: 'center' }),
      para([text('电话：138-0000-0000　|　邮箱：zhangsan@example.com')], { align: 'center' }),
      block('heading', [text('教育经历')], { level: 2 }),
      block('bullet_item', [text('XX 大学　计算机科学与技术　本科　2018 - 2022')]),
      block('heading', [text('工作经历')], { level: 2 }),
      block('bullet_item', [text('XX 公司　前端工程师　2022 - 至今')]),
      block('bullet_item', [text('负责 XX 项目，承担 XX 工作，取得 XX 成果。')], { depth: 1 }),
      block('heading', [text('专业技能')], { level: 2 }),
      block('bullet_item', [text('TypeScript / 前端工程 / 图形渲染')]),
      block('heading', [text('自我评价')], { level: 2 }),
      para([text('（在此填写自我评价。）')]),
    ],
  };
}

/** 全部内置模板（按下拉顺序）。 @public */
export const BUILTIN_TEMPLATES: DocTemplate[] = [
  { name: '空白', build: buildBlank },
  { name: '红头文件', build: buildGovDoc },
  { name: '会议纪要', build: buildMeetingMinutes },
  { name: '简历', build: buildResume },
];

// —— 用户模板（localStorage 持久化）——
/** 用户模板在 localStorage 中的键。 @public */
export const USER_TEMPLATES_KEY = 'rte.userTemplates';

/** 序列化存储的用户模板项：名称 + 文档快照。 @public */
export interface StoredTemplate {
  name: string;
  doc: Doc;
}

// 安全取 localStorage（SSR/单测/隐私模式下不存在则返回 null）。
function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 读取已保存的用户模板列表（无/损坏时返回空数组）。
 * 逐块结构校验（schema 的 {@link sanitizeStoredBlocks}）：被篡改/跨版本损坏的畸形块
 * 剔除并 warn，原有合法块但清洗后无一存活的条目整条跳过——applyTemplate 经
 * replaceDoc→cloneDoc 不再可能因损坏条目抛 TypeError（与 URL 双层校验的纵深防御对称）。
 * @public
 */
export function loadUserTemplates(): StoredTemplate[] {
  const store = ls();
  if (!store) return [];
  try {
    const raw = store.getItem(USER_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredTemplate[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const t = item as { name?: unknown; doc?: unknown };
      if (typeof t.name !== 'string' || !t.doc || typeof t.doc !== 'object') continue;
      const rawBlocks = (t.doc as { blocks?: unknown }).blocks;
      if (!Array.isArray(rawBlocks)) continue;
      const blocks = sanitizeStoredBlocks(rawBlocks, `用户模板「${t.name}」`);
      if (rawBlocks.length > 0 && blocks.length === 0) {
        console.warn(`[templates] 跳过损坏的用户模板「${t.name}」（无合法块）`);
        continue;
      }
      out.push({ name: t.name, doc: { blocks } });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 保存一个用户模板（同名覆盖），返回更新后的列表。
 * doc 会被序列化存入 localStorage；无可用存储时仅返回内存结果。
 * @public
 */
export function saveUserTemplate(name: string, doc: Doc): StoredTemplate[] {
  const list = loadUserTemplates().filter((t) => t.name !== name);
  list.push({ name, doc });
  const store = ls();
  if (store) {
    try {
      store.setItem(USER_TEMPLATES_KEY, JSON.stringify(list));
    } catch {
      /* 配额/隐私模式 */
    }
  }
  return list;
}

/** 把存储的用户模板转换为 DocTemplate（build 返回其文档的深副本由 replaceDoc 负责拷贝）。 @public */
export function userTemplateToDocTemplate(t: StoredTemplate): DocTemplate {
  return { name: t.name, build: () => t.doc };
}
