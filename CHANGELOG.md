# 更新日志 · Changelog

本项目的所有重要变更都记录于此。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 暂无。

## [0.1.0] - 2026-06-12

首个开源基线。GPU 自绘 canvas 富文本编辑内核，主要能力：

### Added
- **GPU 自绘渲染**：字形经 Canvas2D / HarfBuzz 轮廓光栅进**多页 2048² 图集**（满载按需扩页、巨字形夹紧、per-page 脏矩形上传），WebGL2/WebGPU 单 shader 批量合成；GPU 上下文丢失自动恢复。
- **文档模型与排版**：文档树（标题 H1–H6 / 列表 / 任务列表 / 引用 / 代码块 / 表格 / 媒体 / 公式等 19 种块）+ 行内 marks（粗斜下删高亮色码链接上下标字体族字号）；块级布局、BiDi 双向算法、HarfBuzz 复杂文字整形与脚本字体回退。
- **块级增量布局缓存**：编辑只重排受影响块 + 视口剔除，静止帧零分配零绘制。
- **视图与缩放**：web 连续视图 / word A4 分页视图；50–200% 功能性缩放（dpr×zoom 同步重栅）；亮 / 暗主题。
- **编辑能力**：跨块选区、grapheme 光标、词级导航（⌥←/→、删词、删至行首）、双击选词 / 三击选段、拖拽移动文本、撤销合并、IME 组合中间态预览。
- **查找 / 替换**（⌘F）、**剪贴板富文本**（copy 写 HTML / paste 接 HTML 解析）、**打印 / 导出 PDF**（⌘P）、**自动保存与草稿恢复**。
- **触屏支持**：单指滚动 + 惯性、长按选词、选区手柄、双指捏合缩放、visualViewport 虚拟键盘避让。
- **导入 / 导出**：Markdown / HTML / JSON（互逆 round-trip）。
- **架构**：插件化注册表（块行为 / 块导出 / 工具栏贡献清单）、统一命令总线（键盘 / 工具栏 / 右键三路同 id 派发）、类型化事件发射器（Observer）。
- **安全**：URL 协议过滤、iframe 沙箱、导出转义与样式白名单、CSP 友好（外壳样式外置）。
- **测试**：1000+ 单元测试（含模糊测试与 round-trip）。

[Unreleased]: https://github.com/go-xworks/canvas-rich/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/go-xworks/canvas-rich/releases/tag/v0.1.0
