# PDF Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real PDF reader path while preserving the existing normalized DOCX/EPUB reader and library workflows.

**Architecture:** Extend the shared reader contract so the backend exposes reader kind, attachment format, and primary attachment path. In the UI, split the current reader into `PdfReader` and `NormalizedReader`, then use `pdfjs-dist` for lightweight PDF rendering in the desktop shell.

**Tech Stack:** Tauri, Rust, React, TypeScript, Vitest, pdf.js (`pdfjs-dist`)

---

### Task 1: Record The PDF Reader Spec

**Files:**
- Create: `docs/superpowers/specs/2026-04-22-pdf-reader-design.md`
- Create: `docs/superpowers/plans/2026-04-22-pdf-reader.md`

- [ ] **Step 1: Save the approved design**

Write the PDF-first design into:

```md
docs/superpowers/specs/2026-04-22-pdf-reader-design.md
```

- [ ] **Step 2: Save this execution plan**

Write this plan into:

```md
docs/superpowers/plans/2026-04-22-pdf-reader.md
```

- [ ] **Step 3: Commit**

Run:

```bash
rtk git add docs/superpowers/specs/2026-04-22-pdf-reader-design.md docs/superpowers/plans/2026-04-22-pdf-reader.md
rtk git commit -m "docs: add pdf reader design and plan"
```

Expected: a commit containing the new spec and plan documents.

### Task 2: Add Failing Tests For Reader Mode Switching

**Files:**
- Modify: `src/App.test.tsx`
- Modify: `src/lib/mockApi.ts`
- Modify: `src/lib/contracts.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that assert:

```tsx
it("renders a dedicated pdf reader for pdf items", async () => {
  render(<App />);
  expect(await screen.findByTestId("pdf-reader")).toBeInTheDocument();
  expect(screen.getByText(/PDF mode/i)).toBeInTheDocument();
});

it("keeps normalized reading for docx items", async () => {
  replaceMockApiState({
    items: [
      {
        id: 2,
        title: "Graph Neural Survey",
        collection_id: 1,
        primary_attachment_id: 102,
        attachment_status: "ready",
        authors: "Wu et al.",
        publication_year: 2021,
        source: "IEEE TPAMI",
        doi: "10.1000/gnn-survey",
        tags: [],
        attachmentFormat: "docx",
        primaryAttachmentPath: "/mock/graph-neural-survey.docx",
        plainText: "Graph representation learning...",
        normalizedHtml: "<article><h1>Graph Neural Survey</h1><p>Graph representation learning...</p></article>",
      },
    ],
  });

  render(<App />);
  expect(await screen.findByTestId("normalized-reader")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
rtk npm test -- src/App.test.tsx
```

Expected: FAIL because the current app has no `pdf-reader` / `normalized-reader` split and the contracts do not yet provide reader mode fields.

- [ ] **Step 3: Commit**

Run:

```bash
rtk git add src/App.test.tsx src/lib/mockApi.ts src/lib/contracts.ts
rtk git commit -m "test: cover pdf reader mode switching"
```

Expected: a commit with failing-test-first coverage for the new reader split.

### Task 3: Extend Reader Contracts And Backend Payload

**Files:**
- Modify: `src/lib/contracts.ts`
- Modify: `src/lib/mockApi.ts`
- Modify: `crates/app-core/src/service.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add reader metadata to the shared contract**

Extend the contract with:

```ts
export type ReaderKind = "pdf" | "normalized";
export type AttachmentFormat = "pdf" | "docx" | "epub" | "unknown";

export type ReaderView = {
  item_id: number;
  title: string;
  reader_kind: ReaderKind;
  attachment_format: AttachmentFormat;
  primary_attachment_id: number | null;
  primary_attachment_path: string | null;
  page_count: number | null;
  normalized_html: string;
  plain_text: string;
};
```

- [ ] **Step 2: Populate the mock API**

Update mock reader data so:

```ts
Transformer Scaling Laws -> pdf + /mock/transformer-scaling-laws.pdf
Graph Neural Survey -> docx + /mock/graph-neural-survey.docx
Distributed Consensus Notes -> epub + /mock/distributed-consensus-notes.epub
```

and return matching `reader_kind` values from `getReaderView`.

- [ ] **Step 3: Populate the Rust service**

Update the Rust `ReaderView` struct and `get_reader_view` implementation so it infers:

```rust
reader_kind = if attachment_format == "pdf" { "pdf" } else { "normalized" };
```

and returns the primary attachment path from the attachments table when present.

- [ ] **Step 4: Run focused verification**

Run:

```bash
rtk npm test -- src/App.test.tsx
rtk cargo check -p paper-reader-desktop
```

Expected: tests still fail on missing UI split before Task 4, but Rust type checks succeed after contract updates.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add src/lib/contracts.ts src/lib/mockApi.ts crates/app-core/src/service.rs src-tauri/src/main.rs
rtk git commit -m "feat: extend reader view for pdf mode"
```

Expected: the backend and contract layer expose enough metadata to select a PDF reader.

### Task 4: Split The Reader UI

**Files:**
- Modify: `src/App.tsx`
- Create: `src/components/readers/NormalizedReader.tsx`
- Create: `src/components/readers/PdfReader.tsx`

- [ ] **Step 1: Extract the normalized reader**

Move the current HTML reader body into:

```tsx
export function NormalizedReader(props: {
  view: ReaderView;
  pageHtml: string;
  zoom: number;
}) {
  return (
    <section className="reader-html" data-testid="normalized-reader">
      <div dangerouslySetInnerHTML={{ __html: props.pageHtml }} />
    </section>
  );
}
```

- [ ] **Step 2: Add the PDF reader shell**

Create:

```tsx
export function PdfReader(props: {
  view: ReaderView;
  page: number;
  zoom: number;
}) {
  return (
    <section className="pdf-reader" data-testid="pdf-reader">
      <header>PDF mode</header>
      <div>Page {props.page + 1}{props.view.page_count ? ` / ${props.view.page_count}` : ""}</div>
      <div className="pdf-reader__canvas">Loading PDF...</div>
    </section>
  );
}
```

- [ ] **Step 3: Switch by `reader_kind` in `App.tsx`**

Render:

```tsx
const isPdfReader = activeView?.reader_kind === "pdf";

{isPdfReader ? (
  <PdfReader view={activeView} page={readerSession.page} zoom={readerSession.zoom} />
) : activeView ? (
  <NormalizedReader view={activeView} pageHtml={activePageHtml} zoom={readerSession.zoom} />
) : null}
```

- [ ] **Step 4: Run the test suite**

Run:

```bash
rtk npm test -- src/App.test.tsx
```

Expected: the new PDF/normalized mode tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add src/App.tsx src/components/readers/NormalizedReader.tsx src/components/readers/PdfReader.tsx
rtk git commit -m "feat: split pdf and normalized readers"
```

Expected: the app now chooses a dedicated PDF reader shell.

### Task 5: Integrate pdf.js For Real PDF Rendering

**Files:**
- Modify: `package.json`
- Modify: `src/components/readers/PdfReader.tsx`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Add the dependency**

Add:

```json
"pdfjs-dist": "^4.10.38"
```

to frontend dependencies.

- [ ] **Step 2: Add a PDF render effect**

Implement in `PdfReader.tsx`:

```tsx
useEffect(() => {
  if (!view.primary_attachment_path || !canvasRef.current) return;
  // load document with pdf.js, fetch page, render to canvas
}, [view.primary_attachment_path, page, zoom]);
```

The minimal first pass should:

- lazy-load `pdfjs-dist`
- open the local file path
- render the current page to a canvas
- surface a friendly error message on failure

- [ ] **Step 3: Keep tests deterministic**

Stub the PDF reader in tests so UI tests assert shell behavior, not binary rendering:

```tsx
vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({ promise: Promise.reject(new Error("stub")) }),
  GlobalWorkerOptions: { workerSrc: "" },
}));
```

- [ ] **Step 4: Run verification**

Run:

```bash
rtk npm test
rtk npm run build
rtk cargo check -p paper-reader-desktop
```

Expected: tests pass, the frontend bundle builds with `pdfjs-dist`, and the desktop Rust host still type checks.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add package.json package-lock.json src/components/readers/PdfReader.tsx src/App.test.tsx
rtk git commit -m "feat: render pdf pages with pdfjs"
```

Expected: the desktop app can render real PDF pages in the middle reader pane.
