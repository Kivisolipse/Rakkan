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
| M3 | 实时预览给字上色 + 藏标记 | 已实现，待在 Obsidian 里手测 |
| M4 | 自动标注（输入法、撤销、合并、清理、链接整体包） | 代码和单元测试完成：打字自动包（和打的字同一步撤销）、Enter 不跨岛、删光清理空岛、删掉中间文字合并岛、链接和加粗整体包；中文输入法停顿 0.6 秒后包，不进撤销栈。**待在 Obsidian 里手测输入法和撤销**；引文里打字（M6）、代码里打字（M8）、移动行保持归属待做 |
| M5 | 复制去标记 + 库内粘贴 + 粘贴修改 + 搜索（忽略格式） | 全部完成，待在 Obsidian 里手测：粘贴修改按词对比（中文按字），只标改动的地方，可以选模型 |
| M6 | 引文和署名簿 | 完成，待在 Obsidian 里手测：署名簿用列表格式（`- @key: 名字 (标识) · 种类 · #颜色`）；按作者上色、`[@` 补全、`【@` 自动换成 `[@`、粘贴为引文、引文里打字自动标亲笔 |
| M7 | 设置面板 + 三层样式 + 写作 / 审阅模式 | 基本完成 |
| M8 | 代码块声明 + 公式 | 完成，待在 Obsidian 里手测：AI 块里的代码打字自动加声明、挑长度并包 `@@`，岛删光后连声明一起删，复制按钮（阅读视图、实时预览）去掉标记，公式吞掉标记时一键改成 \$。公式内部精确到字、在代码里手打标记时当场加长声明，仍未做 |
| M9 | 取消 | — |
| M10 | iA 互转 + Pandoc 过滤器 + 导出 | 基本完成，待在 Obsidian 里手测：去掉标记、Pandoc 格式（配 pandoc/rakkan.lua，PDF 带颜色）、iA 标注格式导出和导入（SHA-256 哈希、字形计数）。三个导出命令写新笔记、不动原文；导入改当前笔记（Ctrl+Z 一步撤销）。自带的「导出为 PDF…」（隐藏窗口 + 主进程的 print-to-pdf，分段渲染，待手测）。未做：iA 的参考标注转成引文、作者名往返 |
| M11 | README、demo vault、BRAT、社区商店 | 待做 |

## git 约定

- `main` 保持可构建；每个里程碑一个或几个提交，提交信息用 Conventional Commits（`feat(core): …`）
- 仓库根目录的 Markdown 一律忽略，只放行 README.md、SPEC.md、CHANGELOG.md
- 测试样例、示例、截图里的 AI 署名只用模型家族名（Claude、GPT），不拷任何真实笔记

## 测试

- core：vitest 单元测试 + 样例库 + 增量解析与整篇解析的对拍（随机编辑）
- 编辑器和阅读视图一律在 Obsidian 里测（demo-vault），包括手机端
