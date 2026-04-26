# Paper Reader

A desktop application for reading, organizing, and researching academic papers.

## 论文阅读器

一个用于阅读、整理和研究学术论文的桌面应用程序。

---

## Features | 功能特点

### Reading | 阅读
- **Multi-format support** - Read PDF, DOCX, and EPUB files
- **PDF focus mode** - Distraction-free PDF reading with page navigation and zoom
- **Continuous scroll mode** - Smooth scrolling through PDF documents
- **Full-text search** - Find content within documents

### Library Management | 库管理
- **Collections** - Organize papers into hierarchical collections
- **Tags** - Label and filter papers with custom tags
- **Metadata** - Track authors, publication year, and source
- **Batch operations** - Move and tag multiple papers at once
- **Drag & drop import** - Import files by dragging them into the app

### AI Workspace | AI 工作区
- **Per-paper AI tasks** - Summarize, translate, explain terminology, or ask questions about any paper
- **Collection AI tasks** - Bulk summarize, generate theme maps, compare methods, draft reviews
- **Research notes** - Save AI outputs as editable Markdown notes

### Annotations | 批注
- **Highlights** - Create highlights from PDF selections
- **Annotation panel** - View all annotations or filter by current page
- **Export** - Export notes to Markdown

---

## Tech Stack | 技术栈

| Layer | Technology |
|-------|------------|
| Desktop Framework | [Tauri](https://tauri.app/) v2 |
| Frontend | React 18 + TypeScript |
| Build Tool | Vite |
| PDF Rendering | pdf.js (pdfjs-dist) |
| Testing | Vitest + Testing Library |
| Backend Core | Rust (`app-core` crate) |

---

## Getting Started | 开始使用

### Prerequisites | 前置要求

- Node.js 18+
- Rust 1.70+
- pnpm (recommended) or npm

### Install Dependencies | 安装依赖

```bash
pnpm install
```

### Development | 开发

```bash
# Run frontend only (web mode)
pnpm dev

# Run full desktop app
pnpm tauri:dev
```

### Build | 构建

```bash
pnpm build          # Build frontend
pnpm tauri:build   # Build desktop app
```

### Test | 测试

```bash
pnpm test
```

---

## Project Structure | 项目结构

```
paper-reader/
├── src/                      # React frontend
│   ├── components/
│   │   └── readers/         # PDF/DOCX/EPUB reader components
│   ├── lib/                  # Contracts and API utilities
│   ├── test/                 # Test utilities
│   └── App.tsx               # Main application component
├── src-tauri/               # Tauri/Rust backend
│   └── Cargo.toml
├── crates/
│   └── app-core/            # Core Rust application logic
└── docs/                    # Documentation
```

---

## Keyboard Shortcuts | 键盘快捷键

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + F` | Find in document |
| `Escape` | Exit focus mode / Close search |
| `Enter` (in search) | Go to next match |

---

## License | 许可证

Private - All rights reserved.
