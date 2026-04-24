import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./components/readers/PdfReader", () => {
  function MockPdfReader({
    view,
    page,
    zoom,
    onPageCountChange,
  }: {
    view: {
      title: string;
      page_count: number | null;
      primary_attachment_path: string | null;
    };
    page: number;
    zoom: number;
    onPageCountChange?: (pageCount: number) => void;
  }) {
    useEffect(() => {
      onPageCountChange?.(view.page_count ?? 1);
    }, [onPageCountChange, view.page_count]);

    return (
      <section className="pdf-reader" data-testid="pdf-reader">
        <div className="reader-location-bar">
          <span className="status-pill">PDF mode</span>
          <span className="meta-count">
            {view.primary_attachment_path ? view.primary_attachment_path.split("/").pop() : "No attachment path"}
          </span>
          <span className="meta-count">Zoom {zoom}%</span>
        </div>
        <div className="citation-card">
          <p className="eyebrow">Native PDF Reader</p>
          <h3>{view.title}</h3>
          <p>Mock PDF reader page {page + 1}</p>
        </div>
      </section>
    );
  }

  return { PdfReader: MockPdfReader };
});

import App from "./App";
import { fakeApi, replaceFakeApiState, resetFakeApi } from "./test/fakeApi";

const readerPageCountMatcher =
  (page: number, total: number) => (_content: string, element: Element | null) =>
    Boolean(
      element?.classList.contains("meta-count") &&
        element.textContent === `Page ${page} of ${total}`,
    );

const findReaderPageCount = (page: number, total: number) =>
  screen.findByText(readerPageCountMatcher(page, total));

beforeEach(() => {
  resetFakeApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App workspace", () => {
  it("renders a dedicated pdf reader when the active item is a pdf", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Native PDF Paper",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "PDF text preview",
          normalizedHtml: "<article><h1>PDF fallback</h1><p>Fallback content.</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/native-pdf-paper.pdf",
        } as never,
      ],
      annotations: [],
      tasks: [],
      artifacts: [],
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByTestId("pdf-reader")).toBeInTheDocument();
    expect(screen.getByText(/PDF mode/i)).toBeInTheDocument();
  });

  it("keeps the normalized reader for docx items", async () => {
    replaceFakeApiState({
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
          plainText: "Graph representation learning...",
          normalizedHtml:
            "<article><h1>Graph Neural Survey</h1><p>Graph representation learning...</p></article>",
          attachmentFormat: "docx",
          primaryAttachmentPath: "/mock/graph-neural-survey.docx",
        } as never,
      ],
      annotations: [],
      tasks: [],
      artifacts: [],
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByTestId("normalized-reader")).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-reader")).not.toBeInTheDocument();
  });

  it("renders the three-pane workspace and lets the user switch tabs", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      screen.getByRole("heading", { name: "Collections", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Current Paper" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Current Collection" })).toBeInTheDocument();
    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", { name: /Graph Neural Survey/i }),
    );
    expect(
      screen.getByRole("heading", { name: "Graph Neural Survey", level: 2 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    expect(screen.getByText("Generate Review Draft")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Machine Learning", level: 3 }),
    ).toBeInTheDocument();
  });

  it("loads data from the api layer and updates research output when an AI action runs", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Summarize document" }));
    expect((await screen.findAllByText(/item\.summarize/i)).length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));

    expect(
      await screen.findByText(/# Review Draft: Machine Learning/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as Research Note" })).toBeInTheDocument();
  });

  it("imports files into the current collection from the import action", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("tab", { name: "Fresh Import Paper" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Imported 2 files \(duplicates 0, failed 0\) into Machine Learning from picker\./i),
    ).toBeInTheDocument();
  });

  it("shows a true empty-library workspace when no collections exist", async () => {
    replaceFakeApiState({
      collections: [],
      items: [],
      tags: [],
      itemTags: [],
      annotations: [],
      tasks: [],
      artifacts: [],
      notes: [],
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByText(/Start with a collection/i)).toBeInTheDocument();
    expect(screen.getByText(/Create a root collection on the left/i)).toBeInTheDocument();
    expect(screen.getByText(/No collection selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Create your first collection to start building the desktop library/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Import Citations" })).toBeDisabled();
  });

  it("imports dropped files into the active collection", async () => {
    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    const dropZone = screen.getByLabelText("Collection drop zone");
    const files = [
      new File(["pdf"], "dragged-paper.pdf", { type: "application/pdf" }),
      new File(["epub"], "lab-notes.epub", { type: "application/epub+zip" }),
    ];
    const dataTransfer = {
      files,
      types: ["Files"],
    };

    fireEvent.dragEnter(dropZone, { dataTransfer });
    expect(screen.getByText(/Drop 2 files into Machine Learning/i)).toBeInTheDocument();

    fireEvent.drop(dropZone, { dataTransfer });

    expect(await screen.findByRole("tab", { name: "Dragged Paper" })).toBeInTheDocument();
    expect(
      screen.getByText(/Imported 2 files \(duplicates 0, failed 0\) into Machine Learning from drag & drop\./i),
    ).toBeInTheDocument();
  });

  it("removes the active paper from the library and closes its reader tab", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove from Library" }));

    expect(await screen.findByText(/Removed Transformer Scaling Laws from the library/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Transformer Scaling Laws" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Graph Neural Survey", level: 2 })).toBeInTheDocument();
  });

  it("moves the active paper into another collection", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Move paper destination"), "2");
    await user.click(screen.getByRole("button", { name: "Move Paper" }));

    expect(await screen.findByText(/Moved Transformer Scaling Laws to Systems/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Transformer Scaling Laws", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Systems · ready · PDF/i)).toBeInTheDocument();
  });

  it("lets the reader jump between outline sections", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const methodsButton = screen.getByRole("button", { name: "Methods" });
    await user.click(methodsButton);

    expect(methodsButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Focused reader outline on Methods/i)).toBeInTheDocument();
  });

  it("navigates reader pages and updates zoom controls", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    expect(await findReaderPageCount(1, 2)).toBeInTheDocument();
    expect(screen.getByLabelText("Reader zoom level")).toHaveTextContent("100%");

    await user.click(screen.getByRole("button", { name: "Next Page" }));
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();

    const pageInput = screen.getByLabelText("Reader page input");
    await user.clear(pageInput);
    await user.type(pageInput, "1");
    await user.keyboard("{Enter}");
    expect(await findReaderPageCount(1, 2)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByLabelText("Reader zoom level")).toHaveTextContent("110%");
  });

  it("jumps between reader pages from the sidebar and keyboard", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Jump to reader page 2" }));
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");
    expect(await findReaderPageCount(1, 2)).toBeInTheDocument();
  });

  it("bookmarks reader pages and jumps back from the bookmark list", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Page" }));
    await user.click(screen.getByRole("button", { name: "Bookmark Page" }));

    expect(await screen.findByText(/Bookmarked page 2 in Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Bookmark" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Jump to reader page 1" }));
    expect(await findReaderPageCount(1, 2)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Jump to reader page 2" }));
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();
  });

  it("finds matches inside the active document and jumps to the matching page", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Find in document"), "heuristics");

    expect(screen.getByText(/1 \/ 1 matches/i)).toBeInTheDocument();
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();
  });

  it("sorts the visible papers by newest year in the current collection", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Sort papers"), "year_desc");

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    const paperButtons = within(collectionPanel).getAllByRole("button", {
      name: /Transformer Scaling Laws|Graph Neural Survey/i,
    });
    expect(paperButtons[0]).toHaveTextContent("Graph Neural Survey");
    expect(paperButtons[1]).toHaveTextContent("Transformer Scaling Laws");
  });

  it("filters the visible papers by attachment state", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Systems/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Systems/i }));
    await user.selectOptions(screen.getByLabelText("Attachment filter"), "missing");
    await user.click(screen.getByRole("tab", { name: "Current Collection" }));

    expect(
      await screen.findByRole("heading", { name: "Distributed Consensus Notes", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Filtered by attachment: missing/i)).toBeInTheDocument();
    expect(screen.getByText(/1 papers included/i)).toBeInTheDocument();
  });

  it("jumps back to an annotation anchor from the reader chips", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const annotationJump = screen.getByRole("button", {
      name: /Jump to annotation section-1/i,
    });
    await user.click(annotationJump);

    expect(screen.getByText(/Jumped to annotation section-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Active anchor: section-1/i)).toBeInTheDocument();
  });

  it("creates a page-linked annotation from the active reader page", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Page" }));
    await user.type(screen.getByLabelText("Annotation note"), "Keep this for the review");
    await user.click(screen.getByRole("button", { name: "Highlight" }));

    expect(await screen.findByText(/Added highlight on page 2 to Transformer Scaling Laws/i)).toBeInTheDocument();

    const pageAnnotation = screen.getByRole("button", { name: /Jump to annotation page-2/i });
    expect(pageAnnotation).toHaveTextContent(/Keep this for the review/i);

    await user.click(screen.getByRole("button", { name: "Jump to reader page 1" }));
    expect(await findReaderPageCount(1, 2)).toBeInTheDocument();

    await user.click(pageAnnotation);
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();
    expect(screen.getByText(/Active anchor: page-2/i)).toBeInTheDocument();
  });

  it("filters annotations for the current page and search matches", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Page" }));
    await user.type(screen.getByLabelText("Annotation note"), "Heuristic evidence");
    await user.click(screen.getByRole("button", { name: "Highlight" }));

    expect(await screen.findByRole("heading", { name: "Annotations", level: 3 })).toBeInTheDocument();
    expect(screen.getByText(/2 annotations/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Current Page Annotations" }));
    expect(screen.getByRole("button", { name: /Jump to annotation page-2/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Jump to annotation section-1/i }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Find in document"), "heuristics");
    await user.click(screen.getByRole("button", { name: "Search Match Annotations" }));
    expect(screen.getByRole("button", { name: /Jump to annotation page-2/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Jump to annotation section-1/i }),
    ).not.toBeInTheDocument();
  });

  it("deletes annotations from the annotation panel", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const deleteButton = screen.getByRole("button", { name: "Delete annotation section-1" });
    await user.click(deleteButton);

    expect(await screen.findByText(/Removed annotation section-1 from Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Jump to annotation section-1/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/0 annotations/i)).toBeInTheDocument();
  });

  it("preserves reader state per open paper tab", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Page" }));
    await user.click(screen.getByRole("button", { name: "Zoom In" }));
    await user.type(screen.getByLabelText("Find in document"), "heuristics");

    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();
    expect(screen.getByLabelText("Reader zoom level")).toHaveTextContent("110%");

    await user.click(screen.getByRole("tab", { name: "Graph Neural Survey" }));
    expect(screen.getByRole("heading", { name: "Graph Neural Survey", level: 2 })).toBeInTheDocument();
    expect(await findReaderPageCount(1, 1)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Transformer Scaling Laws" }));

    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();
    expect(screen.getByLabelText("Reader zoom level")).toHaveTextContent("110%");
    expect(screen.getByLabelText("Find in document")).toHaveValue("heuristics");
    expect(screen.getByText(/1 \/ 1 matches/i)).toBeInTheDocument();
  });

  it("supports keyboard shortcuts for focusing and clearing document search", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.keyboard("{Meta>}f{/Meta}");
    expect(screen.getByLabelText("Find in document")).toHaveFocus();

    await user.type(screen.getByLabelText("Find in document"), "heuristics");
    expect(screen.getByText(/1 \/ 1 matches/i)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Find in document")).toHaveValue("");
    expect(screen.getByText(/0 \/ 0 matches/i)).toBeInTheDocument();
  });

  it("tracks reader navigation history across page jumps", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Page" }));
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reader Back" }));
    expect(await findReaderPageCount(1, 2)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reader Forward" }));
    expect(await findReaderPageCount(2, 2)).toBeInTheDocument();
  });

  it("jumps from AI source references back into the reader anchor", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const sourceButton = screen.getByRole("button", { name: /Source: section-1/i });
    await user.click(sourceButton);

    expect(screen.getByText(/Jumped to annotation section-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Active anchor: section-1/i)).toBeInTheDocument();
  });

  it("shows paper task history and reruns a paper task from history", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Translate selection" }));
    expect(await screen.findByText(/Completed item\.translate for Transformer Scaling Laws\./i)).toBeInTheDocument();

    expect(screen.getByText(/Paper Task History/i)).toBeInTheDocument();
    expect(screen.getAllByText(/item\.translate/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Run Again item\.summarize/i }));

    expect(await screen.findByText(/Completed item\.summarize for Transformer Scaling Laws\./i)).toBeInTheDocument();
    expect(screen.getAllByText(/item\.summarize/i).length).toBeGreaterThan(1);
  });

  it("renders task-specific paper outputs", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Translate selection" }));
    expect(await screen.findByText(/# Translation: Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(screen.getByText(/## Translated Passage/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Explain terminology" }));
    expect(await screen.findByText(/# Terminology Notes: Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(screen.getByText(/## Key Terms/i)).toBeInTheDocument();
  });

  it("creates and updates a research note from the collection workspace", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));
    await user.click(screen.getByRole("button", { name: "Save as Research Note" }));

    const editor = await screen.findByLabelText("Research note editor");
    await user.clear(editor);
    await user.type(editor, "# Updated Review Note");
    await user.click(screen.getByRole("button", { name: "Save Note Edits" }));

    expect(screen.getByDisplayValue("# Updated Review Note")).toBeInTheDocument();
    expect(screen.getByText(/Saved note edits for Machine Learning/i)).toBeInTheDocument();
  });

  it("lists research notes, switches the active note, and exports the selected note", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));
    await user.click(screen.getByRole("button", { name: "Save as Research Note" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));
    await user.click(screen.getByRole("button", { name: "Save as Research Note" }));

    expect(screen.getByText(/Research Notes/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Open research note/i }).length).toBeGreaterThan(1);

    await user.click(screen.getAllByRole("button", { name: /Open research note .*Review Draft: Machine Learning/i })[0]);
    expect(await screen.findByDisplayValue(/# Review Draft: Machine Learning/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(await screen.findByText(/Saved Markdown to \/exports\/Review Draft Machine Learning\.md/i)).toBeInTheDocument();
  });

  it("shows collection review scope and included papers in the AI workspace", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));

    expect(screen.getByText(/Review Scope/i)).toBeInTheDocument();
    expect(screen.getByText(/2 papers included/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Transformer Scaling Laws/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Graph Neural Survey/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Filter tag Scaling" }));
    await user.click(screen.getByRole("tab", { name: "Current Collection" }));

    expect(screen.getByText(/Filtered by tag: Scaling/i)).toBeInTheDocument();
    expect(screen.getByText(/1 papers included/i)).toBeInTheDocument();
  });

  it("shows the latest collection task kind in the workspace after running it", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));

    expect(await screen.findByText(/Latest Run/i)).toBeInTheDocument();
    expect(screen.getAllByText(/collection\.theme_map/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Machine Learning/i).length).toBeGreaterThan(0);
  });

  it("renders task-specific collection outputs and history previews", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));

    expect(await screen.findByText(/# Theme Map: Machine Learning/i)).toBeInTheDocument();
    expect(screen.getByText(/## Themes/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compare Methods" }));

    expect(await screen.findByText(/# Method Comparison: Machine Learning/i)).toBeInTheDocument();
    expect(screen.getByText(/## Comparison Matrix/i)).toBeInTheDocument();
    expect(screen.getByText(/Theme clusters across 2 visible papers\./i)).toBeInTheDocument();
    expect(screen.getAllByText(/Method comparison across 2 visible papers\./i).length).toBeGreaterThan(0);
  });

  it("reruns a collection task from task history", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));
    await user.click(await screen.findByRole("button", { name: /Run Again collection\.theme_map/i }));

    expect(await screen.findByText(/Completed collection\.theme_map for Machine Learning/i)).toBeInTheDocument();
    expect(screen.getAllByText(/collection\.theme_map/i).length).toBeGreaterThan(1);
  });

  it("marks the latest collection draft stale when the visible scope changes", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));
    await user.click(screen.getByRole("button", { name: "Filter tag Scaling" }));

    expect(await screen.findByText(/Stale Draft/i)).toBeInTheDocument();
    expect(screen.getByText(/generated from 2 papers, but the current view shows 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as Research Note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Run Again collection\.review_draft/i })).toBeEnabled();
  });

  it("reruns collection history against the current visible scope", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));
    await user.click(screen.getByRole("button", { name: "Filter tag Scaling" }));
    await user.click(await screen.findByRole("button", { name: /Run Again collection\.theme_map/i }));

    expect(await screen.findByText(/Completed collection\.theme_map for Machine Learning/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Theme clusters across 1 visible papers\./i).length).toBeGreaterThan(0);
  });

  it("creates a new collection from the sidebar", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Reading Queue");
    await user.click(screen.getByRole("button", { name: "Add Collection" }));

    expect(await screen.findByRole("button", { name: /Reading Queue/i })).toBeInTheDocument();
    expect(screen.getByText(/Created collection Reading Queue/i)).toBeInTheDocument();
  });

  it("creates a nested collection under the current collection", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Theory");
    await user.click(screen.getByRole("button", { name: "Add Nested Collection" }));

    expect(
      await screen.findByRole("button", { name: /Open collection Machine Learning \/ Theory/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Created nested collection Theory under Machine Learning/i)).toBeInTheDocument();
  });

  it("moves the selected collection under a new parent", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Systems/i }));
    await user.selectOptions(screen.getByLabelText("Move collection destination"), "1");
    await user.click(screen.getByRole("button", { name: "Move Collection" }));

    expect(
      await screen.findByRole("button", { name: /Open collection Machine Learning \/ Systems/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Moved Systems into Machine Learning/i)).toBeInTheDocument();
  });

  it("renames the selected collection from the sidebar", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Rename collection"));
    await user.type(screen.getByLabelText("Rename collection"), "ML Library");
    await user.click(screen.getByRole("button", { name: "Rename Collection" }));

    expect(await screen.findByRole("button", { name: /ML Library/i })).toBeInTheDocument();
    expect(screen.getByText(/Renamed collection to ML Library/i)).toBeInTheDocument();
  });

  it("deletes an empty collection from the sidebar", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Temporary");
    await user.click(screen.getByRole("button", { name: "Add Collection" }));
    await user.click(await screen.findByRole("button", { name: /Temporary/i }));
    await user.click(screen.getByRole("button", { name: "Delete Collection" }));

    expect(await screen.findByText(/Deleted collection Temporary/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Temporary/i })).not.toBeInTheDocument();
  });

  it("filters the current collection by tag from the sidebar", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter tag Scaling" }));

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    expect(
      within(collectionPanel).getByRole("button", { name: /Transformer Scaling Laws/i }),
    ).toBeInTheDocument();
    expect(
      within(collectionPanel).queryByRole("button", { name: /Graph Neural Survey/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^All Tags/ }));

    expect(
      within(collectionPanel).getByRole("button", { name: /Graph Neural Survey/i }),
    ).toBeInTheDocument();
  });

  it("creates a tag and assigns it to the current paper", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("New tag name"), "Foundations");
    await user.click(screen.getByRole("button", { name: "Add Tag to Current Paper" }));

    expect(await screen.findByRole("button", { name: "Filter tag Foundations" })).toBeInTheDocument();
    expect(screen.getByText(/Tagged Transformer Scaling Laws with Foundations/i)).toBeInTheDocument();
  });

  it("batch-tags the selected visible papers", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select Visible Papers" }));
    await user.type(screen.getByLabelText("Batch tag papers"), "Batch Read");
    await user.click(screen.getByRole("button", { name: "Tag Selected" }));

    expect(await screen.findByRole("button", { name: "Filter tag Batch Read" })).toBeInTheDocument();
    expect(screen.getByText(/Tagged 2 papers with Batch Read/i)).toBeInTheDocument();
  });

  it("batch-moves the selected visible papers into another collection", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select Visible Papers" }));
    await user.selectOptions(screen.getByLabelText("Batch move papers"), "2");
    await user.click(screen.getByRole("button", { name: "Move Selected" }));

    expect(await screen.findByText(/Moved 2 papers to Systems/i)).toBeInTheDocument();
    expect(screen.getByText(/Systems · ready · PDF/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    expect(screen.getByText(/3 papers included/i)).toBeInTheDocument();
  });

  it("shows the latest formatted citation in the reader panel", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy Citation" }));

    expect(await screen.findByText(/Latest Citation/i)).toBeInTheDocument();
    expect(screen.getByText(/APA 7 · Kaplan et al\./i)).toBeInTheDocument();
    expect(screen.getByText(/Saved APA 7 citation to \/exports\/Transformer Scaling Laws-apa7\.txt/i)).toBeInTheDocument();
  });

  it("shows author and year metadata in the reader panel and supports author search", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    expect(screen.getAllByText(/Kaplan et al\./i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/2020 · OpenAI/i).length).toBeGreaterThanOrEqual(2);

    await user.clear(screen.getByLabelText("Search papers"));
    await user.type(screen.getByLabelText("Search papers"), "Kaplan");

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    expect(
      await within(collectionPanel).findByRole("button", { name: /Transformer Scaling Laws/i }),
    ).toBeInTheDocument();
    expect(
      within(collectionPanel).queryByRole("button", { name: /Graph Neural Survey/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an expanded metadata panel for the active paper", async () => {
    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    expect(screen.getByText(/Document Metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/^Authors$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Kaplan et al\.$/i)).toBeInTheDocument();
    expect(screen.getByText(/^DOI$/i)).toBeInTheDocument();
    expect(screen.getByText(/10\.1000\/scaling-laws/i)).toBeInTheDocument();
    expect(screen.getByText(/^Attachment$/i)).toBeInTheDocument();
    expect(screen.getByText(/^ready · PDF$/i)).toBeInTheDocument();
  });

  it("renders the real attachment format instead of inferring it from the title", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 11,
          title: "Untitled Import",
          collection_id: 1,
          primary_attachment_id: 301,
          attachment_format: "docx",
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "Docx content",
          normalizedHtml: "<article><h1>Untitled Import</h1><p>Docx content</p></article>",
          attachmentFormat: "docx",
          primaryAttachmentPath: "/mock/untitled-import.docx",
        } as never,
      ],
      annotations: [],
      tasks: [],
      artifacts: [],
      notes: [],
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByText(/^DOCX$/i)).toBeInTheDocument();
    expect(screen.getByText(/^ready · DOCX$/i)).toBeInTheDocument();
  });

  it("edits metadata for the active paper from the reader panel", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit Metadata" }));
    await user.clear(screen.getByLabelText("Metadata title"));
    await user.type(screen.getByLabelText("Metadata title"), "Edited Scaling Laws");
    await user.clear(screen.getByLabelText("Metadata authors"));
    await user.type(screen.getByLabelText("Metadata authors"), "OpenAI Research");
    await user.clear(screen.getByLabelText("Metadata year"));
    await user.type(screen.getByLabelText("Metadata year"), "2024");
    await user.clear(screen.getByLabelText("Metadata source"));
    await user.type(screen.getByLabelText("Metadata source"), "NeurIPS");
    await user.clear(screen.getByLabelText("Metadata DOI"));
    await user.type(screen.getByLabelText("Metadata DOI"), "10.1000/edited-scaling");
    await user.click(screen.getByRole("button", { name: "Save Metadata" }));

    expect(await screen.findByRole("heading", { name: "Edited Scaling Laws", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText(/OpenAI Research · 2024 · NeurIPS/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/10\.1000\/edited-scaling/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Edited Scaling Laws/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "Save Metadata" })).not.toBeInTheDocument();
  });

  it("exports BibTeX and RIS citations for the active paper", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export BibTeX" }));
    expect(await screen.findByText(/@article\{/i)).toBeInTheDocument();
    expect(screen.getByText(/Saved BIBTEX to \/exports\/Transformer Scaling Laws\.bib/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export RIS" }));
    expect(await screen.findByText(/TY\s*-\s*JOUR/i)).toBeInTheDocument();
    expect(screen.getByText(/Saved RIS to \/exports\/Transformer Scaling Laws\.ris/i)).toBeInTheDocument();
  });

  it("imports citation records into the current collection", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Citations" }));

    expect(await screen.findByRole("tab", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Imported 2 citation records \(duplicates 0, failed 0\) into Machine Learning\./i,
      ),
    ).toBeInTheDocument();
  });

  it("shows a relink guidance state for missing attachments", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("button", { name: /Systems/i }));
    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", {
        name: /Distributed Consensus Notes/i,
      }),
    );

    expect(screen.getByText(/Source file missing/i)).toBeInTheDocument();
    expect(screen.getByText(/Relink this attachment to restore reading and AI actions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Relink Source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
  });

  it("shows a metadata-only state for citation imports", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Citations" }));
    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", { name: /Attention Is All You Need/i }),
    );

    expect(screen.getByText(/Metadata-only entry/i)).toBeInTheDocument();
    expect(screen.getByText(/Import a PDF, DOCX, or EPUB later to enable full reading and AI extraction/i)).toBeInTheDocument();
    expect(screen.getByText(/Citation metadata is available for export and organization right now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
  });

  it("relinks a missing linked attachment from the reader actions", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("button", { name: /Systems/i }));
    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", {
        name: /Distributed Consensus Notes/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Relink Source" }));

    expect(await screen.findByText(/Relinked source for Distributed Consensus Notes/i)).toBeInTheDocument();
    expect(screen.getByText(/Systems · ready · EPUB/i)).toBeInTheDocument();
  });

  it("shows a partial extraction notice while keeping paper actions enabled", async () => {
    const user = userEvent.setup();

    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Partial PDF",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "Only part of the PDF text was extracted.",
          normalizedHtml: "<article><h1>Partial PDF</h1><p>Only part of the PDF text was extracted.</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/partial.pdf",
          pageCount: 1,
          contentStatus: "partial",
          contentNotice: "This PDF loaded successfully, but text extraction only found partial content.",
        } as never,
      ],
      annotations: [],
      tasks: [],
      artifacts: [],
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByText(/Partial content extracted/i)).toBeInTheDocument();
    expect(
      screen.getByText(/This PDF loaded successfully, but text extraction only found partial content/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Summarize document" }));
    expect((await screen.findAllByText(/item\.summarize/i)).length).toBeGreaterThanOrEqual(1);
  });

  it("shows an unavailable extraction state and disables paper actions", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Unreadable EPUB",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "",
          normalizedHtml: "<article><h1>Unreadable EPUB</h1></article>",
          attachmentFormat: "epub",
          primaryAttachmentPath: "/mock/unreadable.epub",
          pageCount: 1,
          contentStatus: "unavailable",
          contentNotice: "No readable text could be extracted from this document yet.",
        } as never,
      ],
      annotations: [],
      tasks: [],
      artifacts: [],
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByText(/Reader content unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/No readable text could be extracted from this document yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Highlight" })).toBeDisabled();
  });

  it("renders detailed import batch results for imported duplicates and failures", async () => {
    const user = userEvent.setup();

    replaceFakeApiState({
      importFileResults: {
        imported: [
          {
            id: 1001,
            title: "Fresh Import Paper",
            primary_attachment_id: 1002,
          },
        ],
        duplicates: [
          {
            path: "/imports/already-owned.pdf",
            status: "duplicate",
            message: "Duplicate of existing library item Transformer Scaling Laws.",
            item: {
              id: 1,
              title: "Transformer Scaling Laws",
              primary_attachment_id: 101,
            },
          },
        ],
        failed: [
          {
            path: "/imports/broken.epub",
            status: "failed",
            message: "Unsupported attachment format.",
            item: null,
          },
        ],
        results: [
          {
            path: "/imports/fresh-import-paper.pdf",
            status: "imported",
            message: "Imported successfully.",
            item: {
              id: 1001,
              title: "Fresh Import Paper",
              primary_attachment_id: 1002,
            },
          },
          {
            path: "/imports/already-owned.pdf",
            status: "duplicate",
            message: "Duplicate of existing library item Transformer Scaling Laws.",
            item: {
              id: 1,
              title: "Transformer Scaling Laws",
              primary_attachment_id: 101,
            },
          },
          {
            path: "/imports/broken.epub",
            status: "failed",
            message: "Unsupported attachment format.",
            item: null,
          },
        ],
      },
    });

    render(<App api={fakeApi} />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("tab", { name: "Fresh Import Paper" })).toBeInTheDocument();
    expect(
      screen.getByText(/Imported 1 files \(duplicates 1, failed 1\) into Machine Learning from picker\./i),
    ).toBeInTheDocument();
    const importResults = screen.getByText(/Recent import results/i).closest(".citation-card");
    expect(importResults).not.toBeNull();
    expect(within(importResults as HTMLElement).getByText(/^duplicate$/i)).toBeInTheDocument();
    expect(within(importResults as HTMLElement).getByText(/^failed$/i)).toBeInTheDocument();
    expect(screen.getByText(/Duplicate of existing library item Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(screen.getByText(/Unsupported attachment format/i)).toBeInTheDocument();
  });

  it("closes reader tabs and keeps the workspace stable", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      within(collectionPanel).getByRole("button", { name: /Graph Neural Survey/i }),
    );
    expect(await screen.findByRole("tab", { name: "Graph Neural Survey" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close tab Graph Neural Survey" }));
    expect(screen.queryByRole("tab", { name: "Graph Neural Survey" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close tab Transformer Scaling Laws" }));
    expect(screen.queryByRole("tab", { name: "Transformer Scaling Laws" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No paper selected", level: 2 })).toBeInTheDocument();
  });

  it("clears stale reader context when switching to an empty collection", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Inbox");
    await user.click(screen.getByRole("button", { name: "Add Collection" }));

    expect(screen.getByRole("heading", { name: "No paper selected", level: 2 })).toBeInTheDocument();
    expect(await screen.findAllByText("Open a paper to see its extracted text.")).toHaveLength(2);
    expect(screen.getByText(/No papers in this collection yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Import PDF, DOCX, EPUB, or citation files to start this workspace/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
  });
});
