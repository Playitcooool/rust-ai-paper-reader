import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock, menuListeners, setDragHandler, getDragHandler } = vi.hoisted(() => {
  const menuListeners = new Map<string, () => void>();
  let dragHandler: null | ((event: { payload: { type: string; paths?: string[] } }) => void) = null;
  return {
    menuListeners,
    listenMock: vi.fn(async (eventName: string, handler: () => void) => {
      menuListeners.set(eventName, handler);
      return () => {
        menuListeners.delete(eventName);
      };
    }),
    setDragHandler: (handler: typeof dragHandler) => {
      dragHandler = handler;
    },
    getDragHandler: () => dragHandler,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: { payload: { type: string; paths?: string[] } }) => void) => {
      setDragHandler(handler as never);
      return () => setDragHandler(null);
    },
  }),
}));

vi.mock("./components/readers/PdfReader", () => {
  function MockPdfReader({
    view,
    page,
    onPageCountChange,
    mode,
    onSelectionChange,
    searchQuery,
    activeSearchMatchIndex = 0,
    onSearchMatchesChange,
  }: {
    view: {
      title: string;
      page_count: number | null;
    };
    page: number;
    onPageCountChange?: (pageCount: number) => void;
    mode?: "workspace" | "focus";
    searchQuery?: string;
    annotations?: unknown[];
    onSelectionChange?: (selection: unknown) => void;
    activeSearchMatchIndex?: number;
    onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
  }) {
    useEffect(() => {
      onPageCountChange?.(view.page_count ?? 1);
    }, [onPageCountChange, view.page_count]);

    useEffect(() => {
      onSelectionChange?.(null);
    }, [onSelectionChange]);

    useEffect(() => {
      if (!(searchQuery ?? "").trim()) {
        onSearchMatchesChange?.({ total: 0, activeIndex: -1 });
        return;
      }
      onSearchMatchesChange?.({ total: 3, activeIndex: activeSearchMatchIndex % 3 });
    }, [activeSearchMatchIndex, onSearchMatchesChange, searchQuery]);

    return (
      <section data-testid="pdf-reader">
        {mode !== "focus" ? <h3>{view.title}</h3> : null}
        <p>Mock PDF reader page {page + 1}</p>
      </section>
    );
  }

  return { PdfReader: MockPdfReader };
});

import App from "./App";
import { fakeApi, replaceFakeApiState, resetFakeApi } from "./test/fakeApi";

beforeEach(() => {
  resetFakeApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__TAURI_INTERNALS__;
  menuListeners.clear();
  setDragHandler(null);
});

describe("App reading workspace", () => {
  it("renders a resource tree instead of the current collection card list", async () => {
    render(<App api={fakeApi} />);

    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();
    expect(screen.queryByText("Current Collection")).not.toBeInTheDocument();
    expect(screen.queryByText("paper-card")).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Machine Learning/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Transformer Scaling Laws/i })).toBeInTheDocument();
  });

  it("single-clicking a pdf enters focus mode (non-pdf stays in workspace)", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    const docxNode = await screen.findByRole("treeitem", { name: /Graph Neural Survey/i });
    await user.click(docxNode);

    expect(screen.getByRole("tab", { name: "Graph Neural Survey" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    const pdfNode = await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i });
    await user.click(pdfNode);

    expect(screen.getByRole("tab", { name: "Transformer Scaling Laws" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();
    expect(screen.queryByText(/text capabilities/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("pdf-reader")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open AI Workspace" })).not.toBeInTheDocument();
  });

  it("enters pdf focus immediately even while reader context is still loading", async () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res;
    });

    const apiWithDelay = {
      ...fakeApi,
      getReaderView: vi.fn(() => promise),
    } as typeof fakeApi;

    const user = userEvent.setup();
    render(<App api={apiWithDelay} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));

    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: /pdf focus/i })).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-reader")).not.toBeInTheDocument();

    const view = await fakeApi.getReaderView(1);
    resolve(view);

    expect(await screen.findByTestId("pdf-reader")).toBeInTheDocument();
  });

  it("leaves pdf focus when switching to a non-pdf tab", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    const pdfNode = await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i });
    const docxNode = screen.getByRole("treeitem", { name: /Graph Neural Survey/i });

    await user.click(docxNode);
    expect(screen.getByRole("tab", { name: "Graph Neural Survey" })).toBeInTheDocument();

    await user.click(pdfNode);
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Graph Neural Survey" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("normalized-reader")).toBeInTheDocument();
  });

  it("escape exits pdf focus but only when the current target is not an editor", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    });

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const searchInput = await screen.findByRole("textbox", { name: "Find in document" });
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("gates pdf text tools for partial and unavailable content while keeping page rendering", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Scanned PDF",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "",
          normalizedHtml: "<article><p>Fallback content.</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/scanned.pdf",
          pageCount: 2,
          contentStatus: "partial",
          contentNotice: "This PDF can be read by page, but only part of the text layer is reliable.",
        } as never,
      ],
    });

    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Scanned PDF/i }));

    expect(await screen.findByTestId("pdf-reader")).toBeInTheDocument();
    expect(screen.queryByText(/only part of the text layer is reliable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/text capabilities/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Find in document" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open AI Workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Reader Content/i)).not.toBeInTheDocument();
  });

  it("keeps pdf focus when switching between pdf tabs", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Transformer Scaling Laws",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_format: "pdf",
          attachment_status: "ready",
          authors: "Kaplan et al.",
          publication_year: 2020,
          source: "OpenAI",
          doi: "10.1000/scaling-laws",
          tags: [],
          plainText:
            "Overview. Scaling behavior emerges when model size, data volume, and compute are balanced. Methods. This paper discusses predictable loss curves and practical planning heuristics.",
          normalizedHtml:
            "<article><h1>Transformer Scaling Laws</h1><p>Scaling behavior emerges when model size, data volume, and compute are balanced.</p><h2>Methods</h2><p>This paper discusses predictable loss curves and practical planning heuristics.</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/transformer-scaling-laws.pdf",
          pageCount: 2,
        } as never,
        {
          id: 4,
          title: "Second PDF",
          collection_id: 1,
          primary_attachment_id: 104,
          attachment_format: "pdf",
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "Second PDF plain text.",
          normalizedHtml: "<article><h1>Second PDF</h1><p>Second PDF</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/second.pdf",
          pageCount: 1,
        } as never,
      ],
    });

    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));

    await user.click(await screen.findByRole("treeitem", { name: /Second PDF/i }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Transformer Scaling Laws" }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("filters imported placeholder metadata in pdf focus", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Imported Placeholder PDF",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Imported Author",
          publication_year: null,
          source: "Imported PDF",
          doi: null,
          tags: [],
          plainText: "",
          normalizedHtml: "<article><p>Imported</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/imported.pdf",
          pageCount: 1,
          contentStatus: "ready",
          contentNotice: null,
        } as never,
      ],
    });

    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Imported Placeholder PDF/i }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();

    expect(document.querySelector(".reader-focus-subtitle")).toBeNull();
    expect(screen.queryByText(/Imported Author/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Imported PDF/i)).not.toBeInTheDocument();
  });

  it("responds to native menu import events and removes legacy import controls", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};

    const importFiles = vi.fn((input: { collection_id: number; paths: string[] }) => fakeApi.importFiles(input as never));
    const pickImportPaths = vi.fn(async () => ["/Users/test/dragged.pdf"]);
    const api = { ...fakeApi, importFiles, pickImportPaths };

    render(<App api={api} />);

    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Import mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import Citations/i })).not.toBeInTheDocument();

    menuListeners.get("menu:import-documents")?.();

    await waitFor(() => {
      expect(pickImportPaths).toHaveBeenCalledTimes(1);
      expect(importFiles).toHaveBeenCalledWith({
        collection_id: 1,
        paths: ["/Users/test/dragged.pdf"],
      });
    });
  });

  it("imports PDFs via native drag & drop paths in the desktop runtime", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};

    const importFiles = vi.fn((input: { collection_id: number; paths: string[] }) => fakeApi.importFiles(input as never));
    const api = { ...fakeApi, importFiles };

    render(<App api={api} />);
    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();

    // Wait for the effect to register the drag handler.
    await waitFor(() => {
      expect(getDragHandler()).not.toBeNull();
    });

    getDragHandler()?.({ payload: { type: "drop", paths: ["/Users/test/absolute.pdf"] } });

    await waitFor(() => {
      expect(importFiles).toHaveBeenCalledWith({
        collection_id: 1,
        paths: ["/Users/test/absolute.pdf"],
      });
    });
  });

  it("filters the resource tree when the sidebar search is active", async () => {
    replaceFakeApiState({
      collections: [
        { id: 1, name: "Machine Learning", parent_id: null },
        { id: 3, name: "Transformers", parent_id: 1 },
        { id: 2, name: "Systems", parent_id: null },
      ],
      items: [
        {
          id: 1,
          title: "Transformer Scaling Laws",
          collection_id: 3,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Kaplan et al.",
          publication_year: 2020,
          source: "OpenAI",
          doi: "10.1000/scaling-laws",
          tags: [],
          plainText: "",
          normalizedHtml: "<article><p>Scaling</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/transformer-scaling-laws.pdf",
          pageCount: 2,
          contentStatus: "ready",
          contentNotice: null,
        } as never,
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
          plainText: "",
          normalizedHtml: "<article><p>Graph</p></article>",
          attachmentFormat: "docx",
          primaryAttachmentPath: "/mock/graph-neural-survey.docx",
          pageCount: 1,
          contentStatus: "ready",
          contentNotice: null,
        } as never,
        {
          id: 3,
          title: "Distributed Consensus Notes",
          collection_id: 2,
          primary_attachment_id: 103,
          attachment_status: "ready",
          authors: "Ongaro & Ousterhout",
          publication_year: 2014,
          source: "USENIX",
          doi: "10.1000/raft",
          tags: [],
          plainText: "",
          normalizedHtml: "<article><p>Consensus</p></article>",
          attachmentFormat: "epub",
          primaryAttachmentPath: "/mock/distributed-consensus-notes.epub",
          pageCount: 2,
          contentStatus: "ready",
          contentNotice: null,
        } as never,
      ],
    });

    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    const searchInput = await screen.findByRole("textbox", { name: "Search papers" });
    await user.type(searchInput, "scaling");

    expect(screen.getByRole("treeitem", { name: /Machine Learning/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Transformers/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Expand Transformers/i }));
    expect(screen.getByRole("treeitem", { name: /Transformer Scaling Laws/i })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Graph Neural Survey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Systems/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Distributed Consensus Notes/i })).not.toBeInTheDocument();
  });

  it("opens and closes the find HUD with Command/Ctrl+F and Escape", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Graph Neural Survey/i }));
    expect(screen.queryByRole("textbox", { name: "Find in document" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in document" });
    expect(input).toHaveFocus();

    await user.type(input, "representation");

    await waitFor(() => {
      expect(document.querySelector("mark.reader-search-hit")).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Find in document" })).not.toBeInTheDocument();
      expect(document.querySelector("mark.reader-search-hit")).toBeFalsy();
    });
  });

  it("navigates normalized reader matches from the find HUD with Enter and Shift+Enter", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Graph Neural Survey/i }));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in document" });
    await user.type(input, "graph");

    await waitFor(() => {
      expect(document.querySelectorAll("mark.reader-search-hit").length).toBeGreaterThan(1);
      expect(document.querySelector("mark.reader-search-hit-active")?.textContent?.toLowerCase()).toBe("graph");
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });
  });

  it("navigates PDF matches from the find HUD with Enter and Shift+Enter", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in document" });
    await user.type(input, "scaling");

    await waitFor(() => {
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByText("2 / 3")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => {
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });
  });

  it("does not open the find HUD for partial PDFs", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Scanned PDF",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "",
          normalizedHtml: "<article><p>Fallback content.</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/scanned.pdf",
          pageCount: 2,
          contentStatus: "partial",
          contentNotice: "This PDF can be read by page, but only part of the text layer is reliable.",
        } as never,
      ],
    });

    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.dblClick(await screen.findByRole("treeitem", { name: /Scanned PDF/i }));
    fireEvent.keyDown(window, { key: "f", metaKey: true });

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Find in document" })).not.toBeInTheDocument();
    });
  });
});
