# Paper Reader

<div align="center">

**A desktop application for reading, organizing, and researching academic papers**

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC107?style=flat&logo=tauri&logoColor=white)](https://tauri.app/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-1.70+-CE422B?style=flat&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat)]()

[Features](#features) · [Tech Stack](#tech-stack) · [Getting Started](#getting-started) · [License](#license)

</div>

---

## Features

### Reading

| Feature | Description |
|---------|-------------|
| **Multi-format** | Read PDF, DOCX, and EPUB files |
| **PDF Focus Mode** | Distraction-free reading with page navigation and zoom |
| **Continuous Scroll** | Smooth scrolling through documents |
| **Full-text Search** | Find content within any document |

### Library Management

| Feature | Description |
|---------|-------------|
| **Hierarchical Collections** | Organize papers in nested folders |
| **Custom Tags** | Label and filter papers with tags |
| **Metadata** | Track authors, year, and source |
| **Batch Operations** | Move and tag multiple papers at once |
| **Drag & Drop Import** | Import files by dragging into the app |

### AI Workspace

| Task Type | Capabilities |
|-----------|--------------|
| **Per-Paper** | Summarize, translate, explain terminology, Q&A |
| **Collection** | Bulk summarize, generate theme maps, compare methods, draft reviews |
| **Notes** | Save AI outputs as editable Markdown |

### Annotations

| Feature | Description |
|---------|-------------|
| **Highlights** | Create highlights from PDF selections |
| **Annotation Panel** | View and filter by page |
| **Export** | Export notes to Markdown |

---

## Tech Stack

```
┌─────────────────────────────────────────────────────────────┐
│                      Desktop Shell                          │
│                      Tauri v2 (Rust)                       │
├─────────────────────────────────────────────────────────────┤
│                      Backend Core                           │
│                   app-core (Rust crate)                    │
├─────────────────────────────────────────────────────────────┤
│  Database  │     AI Service    │  Document Parser            │
│  SQLite    │  (OpenAI/Claude) │  PDF · DOCX · EPUB         │
├─────────────────────────────────────────────────────────────┤
│                      Frontend                               │
│           React 18 + TypeScript + Vite                      │
└─────────────────────────────────────────────────────────────┘
```

| Layer | Technology |
|-------|------------|
| Desktop Framework | [Tauri](https://tauri.app/) v2 |
| Frontend | React 18 + TypeScript + Vite |
| PDF Rendering | pdf.js (frontend) + pdf_oxide (Rust backend) |
| OCR | Tesseract (for scanned PDFs) |
| Markdown | react-markdown + remark-gfm |
| Testing | Vitest + Testing Library |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Rust 1.70+
- pnpm 8+

### Install

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm tauri:dev

# Run tests
pnpm test
```

### Build

```bash
# Build frontend
pnpm build

# Build desktop application
pnpm tauri:build
```

---

## Project Structure

```
paper-reader/
├── src/                      # React frontend
│   ├── components/readers/  # PDF/DOCX/EPUB reader components
│   ├── lib/                 # API contracts and utilities
│   ├── test/                # Test utilities
│   └── App.tsx              # Main application
├── src-tauri/               # Tauri desktop shell
├── crates/
│   └── app-core/           # Core Rust logic
└── docs/                   # Documentation
```

---

## License

MIT