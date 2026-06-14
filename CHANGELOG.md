# 更新日志 · Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- **改为库模式**：从单体 Vite 应用重构为「可 `import` 的核心库（`src/`）+ 示例站点（`examples/`）」，
  对标 ProseMirror / CodeMirror 6 / Lexical。新增公共入口 `src/index.ts` 与工厂
  `createEditor(target, options)`（在容器内自建 DOM 外壳，状态全进闭包以支持同页多实例）。

  **BREAKING**：入口由 `index.html` 应用改为 `createEditor` 工厂，不再有全局 DOM id 约定。
- HarfBuzz 字体路径改用构建 `BASE_URL` 解析，支持站点部署在子路径。

### Added
- GitHub Pages 自动部署示例站点（`.github/workflows/deploy-pages.yml`）。
- 可发布库配置：`exports` / `types` / `style.css`，库构建（Vite lib 模式，external 重依赖）+ `.d.ts` 生成。

## [0.1.0] - 2026-06-12

首个开源基线。GPU 自绘 canvas 富文本编辑内核。

### Added
- **渲染**：字形进多页 2048² 图集，WebGL2 / WebGPU 批量合成；上下文丢失自动恢复。
- **文档与排版**：19 种块 + 12 种行内 marks；块级增量布局缓存 + 视口剔除；BiDi 双向算法；HarfBuzz 复杂文字整形与脚本字体回退。
- **视图**：web 连续 / word A4 分页；50–200% 缩放；亮 / 暗主题。
- **编辑**：跨块选区、词级导航、双击选词、拖拽移动文本、撤销合并、IME 组合中间态预览。
- **工具**：查找 / 替换、富文本剪贴板、打印 / 导出 PDF、自动保存与草稿恢复。
- **触屏**：单指滚动 + 惯性、长按选词、选区手柄、捏合缩放、虚拟键盘避让。
- **导入导出**：Markdown / HTML / JSON（互逆）。
- **架构**：插件化注册表、统一命令总线、类型化事件发射器。
- **安全**：URL 协议过滤、iframe 沙箱、导出转义与样式白名单、CSP 友好。

[Unreleased]: https://github.com/go-xworks/canvas-rich/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/go-xworks/canvas-rich/releases/tag/v0.1.0
