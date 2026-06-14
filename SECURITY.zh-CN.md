# 安全策略 · Security Policy

> [English](SECURITY.md) · **简体中文**

## 支持的版本

本项目处于早期活跃开发阶段，安全修复仅针对 `main` 分支的最新提交。

| 版本 | 安全支持 |
| --- | --- |
| `main`（最新） | ✅ |
| 历史 tag / 旧提交 | ❌ |

## 报告漏洞

**请勿通过公开 Issue 报告安全漏洞。**

请使用 GitHub 的 [Security Advisories](https://github.com/go-xworks/canvas-rich/security/advisories/new) 私密报告，或通过 GitHub 私信联系维护者 [@go-xworks](https://github.com/go-xworks)。报告请尽量包含：

- 受影响的文件 / 模块与版本（提交 SHA）；
- 复现步骤与最小复现用例；
- 影响评估（数据泄露 / 注入 / 拒绝服务等）与可能的修复方向。

我们会尽快确认收悉，并在评估后协调修复与披露时间表。

## 安全设计要点

canvas-rich 是纯前端编辑内核，自身不发起网络请求、不执行远端代码，但处理用户/外部内容，已内建以下防线：

- **URL 协议过滤**（`src/shared/url.ts`）：媒体 `src` 按场景白名单；行内链接 `href` 危险协议黑名单（拒绝 `javascript:` / `vbscript:` / `data:` / `file:`），导入 / 弹层 / 导出 / 单元格回写四处共用。
- **iframe 沙箱**：内嵌网页覆盖层使用 `sandbox`，已移除 `allow-same-origin`。
- **导出转义**：HTML 导出对文本与属性转义；样式类 mark 值（颜色 / 字体族 / 字号）白名单过滤，防 CSS 注入。
- **持久化校验**：localStorage 草稿 / 模板反序列化逐块校验结构，损坏数据安全回退。
- **CSP 友好**：外壳样式已外置（`src/styles/shell.css`），宿主可启用不依赖 `style-src 'unsafe-inline'` 的严格 CSP。

若你发现绕过上述防线的问题，欢迎按上述渠道报告。
