# Rakkan 开发计划

> 每个字都有落款 · Every character, signed.

本文件是开发计划，规范以 [SPEC.md](../SPEC.md) 为准。

## 结构

一个仓库、一个 `package.json`，分三层：

```
src/core/      纯 TypeScript 解析器：不 import obsidian，不碰 Node、DOM
src/cm6/       实时预览装饰 + 自动标注，只依赖 @codemirror/*
src/obsidian/  设置、命令、状态栏、阅读视图
scripts/       统计脚本等小工具（用 core，跑在 Node 上）
tests/         vitest 单元测试；tests/fixtures 是样例库（全是假数据）
```

- `@codemirror/*`、`obsidian` 在打包时设为 external
- core 逐字扫描，不用正则 lookbehind（iOS 16.4 以下不支持）
- manifest `isDesktopOnly: false`

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | SPEC.md + 测试样例库（冲突表每行都有样例） | 完成 |
| M1 | core 解析器 + 统计脚本 + 增量解析 | 完成（逐行记忆化，和整篇解析随机对拍） |
| M1.5 | 手机输入法原型（用完即扔，需要真机） | 待做 |
| M2 | 阅读视图上色 + 未闭合围栏提醒 | 已实现，待在 Obsidian 里手测；嵌入、悬停预览的兜底待做 |
| M3 | 实时预览给字上色 + 藏标记 | 已实现，浏览器 harness 里验证过；待在 Obsidian 里手测 |
| M4 | 自动标注（输入法、撤销、合并、清理、链接整体包） | 改写引擎（合并、清理、链接整体包、转义）已完成；打字时自动包、输入法、移动行待做 |
| M5 | 复制去标记 + 库内粘贴 + 粘贴修改 + 搜索（忽略格式） | 复制、库内粘贴、搜索已完成；粘贴修改待做 |
| M6 | 引文和署名簿（**署名簿格式待定**） | 引文解析、按 key 上色已完成；署名簿、「粘贴为引文」补全待做 |
| M7 | 设置面板 + 三层样式 + 写作 / 审阅模式 | 基本完成 |
| M8 | 代码块声明 + 公式 | 解析、公式提醒已完成；自动加声明、挑长度、接管复制按钮、一键改 `\$` 待做 |
| M9 | 取消 | — |
| M10 | iA 互转 + Pandoc 过滤器 + 导出 | 待做 |
| M11 | README、demo vault、BRAT、社区商店 | 待做 |

## git 约定

- `main` 保持可构建；每个里程碑一个或几个提交，提交信息用 Conventional Commits（`feat(core): …`）
- 仓库根目录的 Markdown 一律忽略，只放行 README.md、SPEC.md、CHANGELOG.md
- 测试样例、示例、截图里的 AI 署名只用模型家族名（Claude、GPT），不拷任何真实笔记

## 测试

- core：vitest 单元测试 + 样例库 + 增量解析与整篇解析的对拍（随机编辑）
- cm6：以后用 Playwright 搭最小 CodeMirror 页面
- 最后在 Obsidian 里手测，包括手机端
