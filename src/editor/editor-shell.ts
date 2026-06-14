/**
 * 编辑器外壳（editor 层）：在宿主 target 容器内**程序化构建** DOM 外壳，替代旧 index.html
 * 写死的 `#app/#toolbar/#left-panel/#editor>#c/#status-bar/#ime` 结构。createEditor 据此装配，
 * 库消费者无需在页面预置任何 id。
 *
 * @remarks
 * 外壳作用域化（库化前提）：旧 shell.css 用全局 id（`#app/#editor/#ime…`）+ 裸 `canvas` 选择器，
 * 库化后多实例/宿主页面共存会冲突、裸 canvas 会污染消费者所有画布。此处全部改用 `.rte-shell`
 * 作用域 class，shell.css 同步改写（视觉/布局逐字等价，仅选择器从「全局 id」改「作用域 class」）。
 * 每实例各持一份外壳与独立 ime（旧版 body 级单例 `#ime`），故同页多实例互不抢焦点。
 * chrome 开关决定是否构建 toolbar / left-panel / status-bar 子树（关掉的部件不建 DOM）。
 *
 * 分层：editor（编辑装配层；只建结构、不接业务，业务由 create-editor 注入）。
 */

/** 外壳子部件开关（缺省全开，复刻现 demo 整套外壳）。 @internal */
export interface ShellChrome {
  /** 顶部 Ribbon 工具栏。 */
  toolbar?: boolean;
  /** 左侧大纲面板（含折叠按钮）。 */
  outline?: boolean;
  /** 底部状态栏（字数/缩放）。 */
  statusBar?: boolean;
}

/**
 * createShell 返回的外壳引用集：createEditor 持这些局部引用接线（替代旧 mustEl(id) 全局抓取）。
 * toolbarEl / leftPanel / leftBody / leftCollapse / statusBarEl 在对应 chrome 关闭时为 null。
 * @internal
 */
export interface Shell {
  /** 外壳根（= target 内新建的 `.rte-shell`；供消费者样式定位、destroy 时整树移除）。 */
  root: HTMLElement;
  /** 工具栏挂载容器（chrome.toolbar=false 时为 null）。 */
  toolbarEl: HTMLElement | null;
  /** 中部横向区（左面板 | 编辑器）。 */
  bodyEl: HTMLElement;
  /** 左大纲面板根（chrome.outline=false 时为 null）。 */
  leftPanel: HTMLElement | null;
  /** 左大纲面板内容容器（chrome.outline=false 时为 null）。 */
  leftBody: HTMLElement | null;
  /** 左大纲折叠按钮（chrome.outline=false 时为 null）。 */
  leftCollapse: HTMLButtonElement | null;
  /** 编辑器容器（canvas + 覆盖层的定位上下文）。 */
  editorEl: HTMLElement;
  /** GPU 自绘画布。 */
  canvas: HTMLCanvasElement;
  /** 隐藏输入代理（承接键盘 + IME）：每实例独立，append 到外壳根。 */
  ime: HTMLTextAreaElement;
  /** 状态栏挂载容器（chrome.statusBar=false 时为 null）。 */
  statusBarEl: HTMLElement | null;
}

/**
 * 在 target 容器内构建编辑器外壳 DOM（结构同旧 index.html，选择器作用域化为 `.rte-shell`）。
 * @param target - 宿主容器（外壳根 append 到此）。
 * @param chrome - 子部件开关（缺省全开）。
 * @returns 外壳引用集（供 createEditor 接线）。
 * @internal
 */
export function createShell(target: HTMLElement, chrome: ShellChrome = {}): Shell {
  const showToolbar = chrome.toolbar !== false;
  const showOutline = chrome.outline !== false;
  const showStatusBar = chrome.statusBar !== false;

  const root = document.createElement('div');
  root.className = 'rte-shell';

  // 顶部工具栏挂载点
  let toolbarEl: HTMLElement | null = null;
  if (showToolbar) {
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'rte-toolbar';
    root.appendChild(toolbarEl);
  }

  // 中部横向区：左大纲面板 | 中编辑器
  const bodyEl = document.createElement('div');
  bodyEl.className = 'rte-body';

  let leftPanel: HTMLElement | null = null;
  let leftBody: HTMLElement | null = null;
  let leftCollapse: HTMLButtonElement | null = null;
  if (showOutline) {
    leftPanel = document.createElement('div');
    leftPanel.className = 'rte-left-panel';

    const head = document.createElement('div');
    head.className = 'rte-panel-head';
    const headLabel = document.createElement('span');
    headLabel.textContent = '大纲';
    leftCollapse = document.createElement('button');
    leftCollapse.className = 'rte-panel-collapse';
    leftCollapse.title = '折叠大纲';
    leftCollapse.setAttribute('aria-label', '折叠大纲');
    leftCollapse.textContent = '‹';
    head.append(headLabel, leftCollapse);

    leftBody = document.createElement('div');
    leftBody.className = 'rte-panel-body';

    leftPanel.append(head, leftBody);
    bodyEl.appendChild(leftPanel);
  }

  const editorEl = document.createElement('div');
  editorEl.className = 'rte-editor';
  const canvas = document.createElement('canvas');
  editorEl.appendChild(canvas);
  bodyEl.appendChild(editorEl);

  root.appendChild(bodyEl);

  // 底部状态栏挂载点
  let statusBarEl: HTMLElement | null = null;
  if (showStatusBar) {
    statusBarEl = document.createElement('div');
    statusBarEl.className = 'rte-status-bar';
    root.appendChild(statusBarEl);
  }

  // 隐藏输入代理：每实例独立（旧版 body 级单例 #ime），append 到外壳根。
  // fixed 定位由渲染帧用 canvas.getBoundingClientRect() 换算（已相对视口），无需 body 级。
  const ime = document.createElement('textarea');
  ime.className = 'rte-ime';
  ime.setAttribute('autocapitalize', 'off');
  ime.setAttribute('autocomplete', 'off');
  ime.setAttribute('autocorrect', 'off');
  ime.setAttribute('spellcheck', 'false');
  root.appendChild(ime);

  target.appendChild(root);

  return { root, toolbarEl, bodyEl, leftPanel, leftBody, leftCollapse, editorEl, canvas, ime, statusBarEl };
}
