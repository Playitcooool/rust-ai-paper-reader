# Paper Reader

<div align="center">

**A local-first desktop workspace for reading, organizing, annotating, and synthesizing academic papers**  
**一个以本地优先为核心的桌面论文工作台，用于阅读、整理、标注与研究综述生成**

Paper Reader combines a native-feeling document library, a focused reading surface, and an AI research workspace in one app. Import PDFs, DOCX files, EPUB books, and citation records, then move from collection management to review drafting without leaving the desktop.  
Paper Reader 将原生感的文献库、专注阅读界面与 AI 研究工作区整合到一个应用中。你可以导入 PDF、DOCX、EPUB 和引文记录，从资料管理一路走到综述草稿生成，全程不离开桌面端。

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC107?style=flat&logo=tauri&logoColor=white)](https://tauri.app/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript 5](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-powered-CE422B?style=flat&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-local_storage-003B57?style=flat&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
![License](https://img.shields.io/badge/License-MIT-2E8B57?style=flat)

[Why Paper Reader](#why-paper-reader--为什么选择-paper-reader) · [What You Can Do](#what-you-can-do--你可以用它做什么) · [Quick Start](#quick-start--快速开始) · [Architecture](#architecture--架构)

</div>

---

## Why Paper Reader · 为什么选择 Paper Reader

Most paper workflows are fragmented: one app for storage, another for reading, another for notes, another for AI prompts. Paper Reader pulls those steps into a single desktop product built for serious reading.  
大多数论文工作流都是割裂的：一个工具存资料，一个工具读文档，一个工具记笔记，另一个工具跑 AI。Paper Reader 把这些步骤收拢到一个桌面产品里，专门为严肃阅读和研究整理而设计。

- **Read deeply, not just store files**: open PDFs, DOCX, and EPUBs in a workspace designed for long-form technical reading.  
  **不只是存文件，而是真正进入阅读**：在一个适合长篇技术文档阅读的工作区里打开 PDF、DOCX 和 EPUB。
- **Keep your library structured**: organize material into nested collections, tag papers, batch-move items, and search across titles and extracted text.  
  **让资料库保持结构化**：支持层级 collection、标签、批量移动，以及基于标题和提取文本的搜索。
- **Turn reading into output**: use built-in AI tasks to summarize papers, compare methods, explain terms, and draft review-style notes.  
  **把阅读直接变成输出**：内置 AI 任务可做论文总结、方法比较、术语解释和综述草稿。
- **Stay local-first**: metadata, notes, sessions, and search stay in a local SQLite-backed library.  
  **坚持本地优先**：元数据、笔记、AI session 和搜索索引都保留在本地 SQLite 文献库中。
- **Handle real-world PDFs**: native OCR support helps when the text layer is missing or incomplete.  
  **适配真实世界里的 PDF**：当文本层缺失或质量很差时，可借助原生 OCR 继续工作。

## What You Can Do · 你可以用它做什么

### Build a serious research library · 搭建真正可用的研究资料库

- Import `PDF`, `DOCX`, `EPUB`, and citation records into a structured desktop library.  
  导入 `PDF`、`DOCX`、`EPUB` 和 citation 记录，形成结构化桌面资料库。
- Create nested collections for topics, courses, labs, or literature review streams.  
  用嵌套 collection 管理课题、课程、实验室方向或综述项目。
- Track metadata like title, authors, year, source, DOI, and attachment status.  
  管理标题、作者、年份、来源、DOI 与附件状态等元信息。
- Filter by tags, readiness, missing attachments, or citation-only records.  
  可按标签、可读状态、缺失附件或 citation-only 条目筛选。
- Search across the library with full-text indexing.  
  通过全文索引在整个资料库中检索内容。

### Read with focus · 专注阅读

- Open documents in a clean reader with zoom, fit-width, page navigation, and find-in-document.  
  在整洁的阅读器中打开文档，支持缩放、适配宽度、页码跳转和文内搜索。
- Use PDF focus mode and continuous reading flows for long technical sessions.  
  使用 PDF focus mode 与连续阅读流程，适合长时间技术阅读。
- Highlight passages and keep annotations tied to the underlying paper.  
  高亮重点内容，并把 annotation 绑定到对应论文。
- Handle imperfect source files with OCR and fallback content extraction.  
  对不完美的源文件使用 OCR 与内容提取兜底。

### Work with AI as a research copilot · 把 AI 当作研究副驾

- Run **paper-level tasks** like summary, translation, terminology explanation, and freeform Q&A.  
  运行 **单篇论文级任务**，如总结、翻译、术语解释和自由问答。
- Run **collection-level tasks** like bulk summaries, theme maps, method comparisons, and review drafts.  
  运行 **collection 级任务**，如批量总结、主题图谱、方法比较与综述草稿。
- Run **session-level tasks** across selected references to synthesize multiple papers in one thread.  
  运行 **session 级任务**，跨多个参考文献在同一线程中做综合分析。
- Save AI outputs as editable research notes and export them as Markdown.  
  把 AI 输出保存为可编辑 research note，并导出为 Markdown。
- Switch between `OpenAI` and `Anthropic` provider profiles inside the app.  
  在应用内切换 `OpenAI` 与 `Anthropic` provider 配置。

### Keep outputs connected to evidence · 让输出始终回到证据

- Add papers or collections as AI session references.  
  把论文或 collection 加入 AI session 作为上下文参考。
- Revisit previous sessions, artifacts, and notes from the same workspace.  
  在同一个工作区中回看之前的 session、artifact 和 note。
- Export citations in multiple formats and export notes to disk.  
  导出多种格式的 citation，并把笔记导出到本地磁盘。
- Clear or replace provider keys without storing plaintext secrets in the database.  
  清除或替换 provider key，同时避免在数据库中明文存储密钥。

## Product Highlights · 产品亮点

| Area | What stands out | 中文说明 |
| --- | --- | --- |
| Reading | Native desktop reader, PDF focus workflows, OCR fallback | 原生桌面阅读器、PDF 专注阅读流程、OCR 兜底 |
| Library | Collections, tags, metadata editing, batch actions, citation-first import | collection、标签、元数据编辑、批量操作、citation-first 导入 |
| AI | Per-paper, per-collection, and per-session research tasks | 覆盖单篇、集合和 session 三个层级的研究任务 |
| Notes | Research notes generated from artifacts and editable in-app | 由 artifact 生成的研究笔记，可在应用内继续编辑 |
| Security | Local database plus secure storage for AI credentials | 本地数据库加安全凭据存储 |
| Desktop UX | Tauri shell, native dialogs, local files, fast startup | Tauri 桌面壳、原生对话框、本地文件、启动快速 |

## Quick Start · 快速开始

### Prerequisites · 环境要求

- `Node.js 18+`
- `Rust` toolchain
- `npm`

### Install and run · 安装与启动

```bash
npm install
npm run tauri:dev
```

### Run checks · 运行检查

```bash
npm test
npm run build
cargo test
```

### Build the desktop app · 构建桌面应用

```bash
npm run tauri:build
```

## Architecture · 架构

Paper Reader is a hybrid desktop app designed to keep UI responsiveness and document-heavy logic in the right places.  
Paper Reader 是一个混合式桌面应用，把界面交互响应和文档密集型逻辑放在各自最合适的位置。

```text
Tauri desktop shell
├─ React + TypeScript frontend
│  ├─ library workspace
│  ├─ document readers
│  └─ AI / notes interface
└─ Rust backend
   ├─ app-core domain services
   ├─ SQLite library storage
   ├─ PDF rendering + OCR helpers
   └─ local file + export commands
```

### Core stack · 核心技术栈

- **Desktop shell**: `Tauri v2`  
  **桌面壳**：`Tauri v2`
- **Frontend**: `React 18`, `TypeScript`, `Vite`  
  **前端**：`React 18`、`TypeScript`、`Vite`
- **Backend core**: Rust workspace with `crates/app-core`  
  **后端核心**：Rust workspace，核心逻辑位于 `crates/app-core`
- **Storage**: `SQLite` + local managed files  
  **存储**：`SQLite` 加本地管理文件
- **Rendering**: `pdf.js` on the frontend plus native PDF helpers on the backend  
  **渲染**：前端 `pdf.js`，后端原生 PDF 辅助能力
- **OCR**: `Tesseract`  
  **OCR**：`Tesseract`
- **Markdown**: `react-markdown` + `remark-gfm`  
  **Markdown**：`react-markdown` + `remark-gfm`
- **Testing**: `Vitest` + Testing Library + Rust tests  
  **测试**：`Vitest` + Testing Library + Rust tests

## Project Layout · 项目结构

```text
src/                 React app and UI state
src/components/      Reader components and reading utilities
src/lib/             Runtime API contracts and browser helpers
src-tauri/           Desktop shell, native commands, app config
crates/app-core/     Library, import, AI, note, and search services
docs/                Supporting documentation
```

## Current Status · 当前状态

Paper Reader already covers the core desktop research loop:  
Paper Reader 目前已经覆盖桌面研究工作的核心闭环：

- local library management / 本地资料库管理
- multi-format reading / 多格式阅读
- search and metadata editing / 搜索与元数据编辑
- annotations and notes / 标注与笔记
- AI-powered research tasks / AI 驱动的研究任务
- secure provider configuration / 安全的 provider 配置

The project is still a product in motion, with room to keep refining the desktop UX, onboarding, and presentation layer.  
这个项目仍在持续演进，桌面体验、上手流程和展示层都还有继续打磨的空间。

## Who It Is For · 适合谁使用

- graduate students building literature reviews  
  正在做文献综述的研究生
- researchers comparing methods across many papers  
  需要跨多篇论文比较方法的研究者
- engineers maintaining a personal technical reading archive  
  希望长期维护个人技术阅读库的工程师
- teams exploring a local-first alternative to fragmented reading workflows  
  想寻找本地优先、替代碎片化阅读工作流的团队

## License · 许可证

MIT
