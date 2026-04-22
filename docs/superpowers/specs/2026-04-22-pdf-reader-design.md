# PDF Reader Design

## Goal

在不破坏现有文献管理、DOCX/EPUB 归一化阅读、批注与右栏工作区的前提下，为桌面端引入一个真正的 PDF 阅读路径。V1 的优先级是“轻、快、稳”，因此 PDF 渲染先由前端 `pdf.js` 负责，Rust 继续承担文献库、附件路径、批注持久化与后续 AI 读取边界。

## Why This Slice

当前应用把所有文献都转成 `normalized_html` 后用同一套分页 UI 展示，这对 `DOCX/EPUB` 足够，但对 PDF 有两个结构性问题：

- 不是原始 PDF 页面渲染，版式、页码、坐标都不真实。
- 后续高亮、跳转、缩略图、文本层搜索都缺少可靠页面基准。

因此这一步不继续堆前端假分页能力，而是先把阅读器拆成两条路径：

- `PDF`：走 `PdfReader`，直接渲染原文件。
- `DOCX/EPUB`：继续走现有 `normalized_html` 阅读器。

## Chosen Approach

推荐方案是“混合阅读器协议”：

- `ReaderView` 扩展为通用壳层，显式返回 `reader_kind`、`attachment_format`、`primary_attachment_path`、页数/标题等基础元数据。
- 前端根据 `reader_kind` 切换组件，而不是让一个组件猜测如何渲染。
- PDF 路径使用 `pdfjs-dist` 加载本地附件，先落地真实页面渲染、缩放、页码跳转与缩略页导航。
- 现有基于 HTML 的搜索、书签、历史、批注管理只保留在 `normalized` 阅读器路径，避免第一阶段把 PDF 文本层和坐标锚点一口气做太重。

没有选择的方案：

- 全部继续伪装成 HTML：实现快，但无法真正提升 PDF 体验。
- 立即引入原生 PDFKit / Rust 渲染：理论上更“原生”，但集成成本更高、调试更慢，不符合当前“最轻最快”的目标。

## Reader Contract

新的 `ReaderView` 保持单一入口，但增加分流字段：

- `reader_kind`: `"pdf" | "normalized"`
- `attachment_format`: `"pdf" | "docx" | "epub" | "unknown"`
- `primary_attachment_id`
- `primary_attachment_path`: 主附件的绝对路径，供 PDF 读取
- `page_count`: PDF 可提供真实页数，其它格式可为空
- `normalized_html`: 仅 `normalized` 阅读器消费
- `plain_text`: 继续用于右栏摘要预览、旧搜索回退与测试数据

约束：

- `pdf` 阅读器不依赖 `normalized_html`。
- `normalized` 阅读器不要求真实文件路径。
- 缺失附件仍由外层状态统一拦截，避免 PDF 组件自己处理失联状态。

## UI Design

中栏阅读区继续保留现有 VSCode 风格壳层：

- 顶部标签栏不变。
- 工具栏继续承载返回/前进、页码输入、缩放。
- 左侧页轨在 `pdf` 模式下改为真实页缩略/页码列表；在 `normalized` 模式下保留原分页跳转。

PDF 第一阶段的用户可见能力：

- 打开 PDF 后显示真实页面画布。
- 支持上一页/下一页。
- 支持输入页码跳转。
- 支持缩放。
- 支持基础页缩略导航。

暂不在这一阶段承诺：

- PDF 文本层搜索
- PDF 框选高亮
- PDF 坐标级批注回写
- 双页/并排阅读

## Data Flow

1. 左栏选择文献或导入后打开文献。
2. 前端调用 `reader.get_reader_view(item_id)`。
3. Rust 从数据库读取主附件格式与路径，返回增强后的 `ReaderView`。
4. `App.tsx` 根据 `reader_kind` 选择 `PdfReader` 或 `NormalizedReader`。
5. `PdfReader` 通过 `pdf.js` 加载本地路径并管理页渲染状态。

## Error Handling

- `primary_attachment_path` 为空或文件不可用时，PDF 区域显示错误态，不让页面空白。
- `pdf.js` 加载失败时展示可重试错误卡片，并保留当前标签与元数据面板。
- 对 `DOCX/EPUB` 不改变既有行为，避免 PDF 改造影响已有阅读入口。

## Testing Strategy

本阶段只验证“路径切换”和“真实 PDF UI 容器接入”，不把 PDF 像素渲染当成单元测试目标。

- 前端测试：
  - PDF 文献打开后进入 `PdfReader`
  - DOCX/EPUB 继续走 `normalized` 阅读器
  - PDF 工具栏显示 PDF 专属状态文案和页码信息
- 后端测试：
  - `ReaderView` 能正确返回 `reader_kind` 与附件格式
  - 缺少文件路径时不污染其它格式
- 验证：
  - `npm test`
  - `npm run build`
  - `cargo check -p paper-reader-desktop`

## Out of Scope

- AI 扩展
- OCR
- 原生系统 PDFKit 替换
- PDF 文本层搜索与选区坐标锚点
- 批注模型升级为矩形坐标
