import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    searchQuery,
    activeSearchMatchIndex = 0,
    onSearchMatchesChange,
    onHighlightActivate: _onHighlightActivate,
  }: {
    view: { title: string; page_count: number | null };
    page: number;
    onPageCountChange?: (pageCount: number) => void;
    searchQuery?: string;
    activeSearchMatchIndex?: number;
    onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
    onHighlightActivate?: (highlight: unknown) => void;
  }) {
    useEffect(() => {
      onPageCountChange?.(view.page_count ?? 1);
    }, [onPageCountChange, view.page_count]);

    useEffect(() => {
      if (!(searchQuery ?? "").trim()) {
        onSearchMatchesChange?.({ total: 0, activeIndex: -1 });
        return;
      }
      onSearchMatchesChange?.({ total: 3, activeIndex: activeSearchMatchIndex % 3 });
    }, [activeSearchMatchIndex, onSearchMatchesChange, searchQuery]);

    return (
      <section data-testid="pdf-reader">
        <h3>{view.title}</h3>
        <p>Mock PDF reader page {page + 1}</p>
      </section>
    );
  }

  return { PdfReader: MockPdfReader };
});

vi.mock("./components/readers/PdfContinuousReader", () => {
  function MockPdfContinuousReader({
    view,
    page,
    onPageCountChange,
    onSelectionChange,
    onHighlightActivate,
    searchQuery,
    activeSearchMatchIndex = 0,
    onSearchMatchesChange,
  }: {
    view: { title: string; page_count: number | null };
    page: number;
    onPageCountChange?: (pageCount: number) => void;
    searchQuery?: string;
    onSelectionChange?: (selection: unknown) => void;
    onHighlightActivate?: (highlight: unknown) => void;
    activeSearchMatchIndex?: number;
    onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
  }) {
    useEffect(() => {
      onPageCountChange?.(view.page_count ?? 1);
    }, [onPageCountChange, view.page_count]);

    useEffect(() => {
      onSelectionChange?.(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (!(searchQuery ?? "").trim()) {
        onSearchMatchesChange?.({ total: 0, activeIndex: -1 });
        return;
      }
      onSearchMatchesChange?.({ total: 3, activeIndex: activeSearchMatchIndex % 3 });
    }, [activeSearchMatchIndex, onSearchMatchesChange, searchQuery]);

    return (
      <section data-testid="pdf-reader">
        <p>Mock PDF continuous reader page {page + 1}</p>
        <button
          type="button"
          aria-label="Mock select PDF text"
          onClick={() =>
            onSelectionChange?.({
              anchor: JSON.stringify({
                type: "pdf_text",
                page: page + 1,
                startDivIndex: 0,
                startOffset: 0,
                endDivIndex: 0,
                endOffset: 5,
                quote: "Hello",
              }),
              quote: "Hello",
              rect: { left: 100, top: 120, right: 160, bottom: 140 },
            })
          }
        >
          Select
        </button>
        <button
          type="button"
          aria-label="Mock activate highlight"
          onClick={() =>
            onHighlightActivate?.({
              annotationId: 500,
              rect: { left: 100, top: 120, right: 190, bottom: 142 },
            })
          }
        >
          Activate highlight
        </button>
      </section>
    );
  }

  return { PdfContinuousReader: MockPdfContinuousReader };
});

import App from "./App";
import { failNextFakeAiStream, fakeApi, replaceFakeApiState, resetFakeApi } from "./test/fakeApi";

beforeEach(() => {
  resetFakeApi();
  window.localStorage.clear();
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
  it("renders the compact resource tree", async () => {
    const { container } = render(<App api={fakeApi} />);

    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Transformer Scaling Laws/i })).toBeInTheDocument();
    expect(container.querySelectorAll(".resource-tree-leading-icon")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Collapse Machine Learning/i })).toBeInTheDocument();
  });

  it("single-clicking a pdf opens workspace preview while double-click enters focus", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    const pdfNode = await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i });
    await user.click(pdfNode);

    expect(screen.queryByRole("toolbar", { name: /pdf focus toolbar/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("pdf-reader")).toHaveTextContent("Mock PDF reader page 1");
    expect(screen.queryByRole("button", { name: "Find in document" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reader page input" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Annotations/i)).not.toBeInTheDocument();

    await user.dblClick(pdfNode);
    expect(await screen.findByRole("toolbar", { name: /pdf focus toolbar/i })).toBeInTheDocument();
  });

  it("keeps non-pdf items in workspace mode", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Graph Neural Survey/i }));

    expect(screen.queryByRole("toolbar", { name: /pdf focus toolbar/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("normalized-reader")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find in document" })).toBeInTheDocument();
  });

  it("renders focus mode immediately while the reader context is still loading", async () => {
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

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));

    expect(screen.getByRole("toolbar", { name: /pdf focus toolbar/i })).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-reader")).not.toBeInTheDocument();

    resolve(await fakeApi.getReaderView(1));
    expect(await screen.findByTestId("pdf-reader")).toBeInTheDocument();
  });

  it("shows a focus highlight color bar and persists color into the anchor", async () => {
    const user = userEvent.setup();
    const createAnnotationSpy = vi.spyOn(fakeApi, "createAnnotation");

    render(<App api={fakeApi} />);
    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Mock select PDF text" }));
    expect(await screen.findByRole("toolbar", { name: "PDF highlight colors" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Highlight yellow" }));

    await waitFor(() => {
      expect(createAnnotationSpy).toHaveBeenCalled();
    });
    expect((createAnnotationSpy.mock.calls[0]?.[0] as { anchor?: string } | undefined)?.anchor).toContain(
      '"color":"yellow"',
    );
  });

  it("leaves pdf focus when switching to a non-pdf tab", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Graph Neural Survey/i }));
    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    expect(await screen.findByRole("toolbar", { name: /pdf focus toolbar/i })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Graph Neural Survey" }));

    await waitFor(() => {
      expect(screen.queryByRole("toolbar", { name: /pdf focus toolbar/i })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("normalized-reader")).toBeInTheDocument();
  });

  it("supports escape and back button to exit focus", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    expect(await screen.findByRole("toolbar", { name: /pdf focus toolbar/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("toolbar", { name: /pdf focus toolbar/i })).not.toBeInTheDocument();
    });

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Back to library" }));
    await waitFor(() => {
      expect(screen.queryByRole("toolbar", { name: /pdf focus toolbar/i })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("pdf-reader")).toBeInTheDocument();
  });

  it("opens the find HUD in document workspace and pdf focus", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Graph Neural Survey/i }));
    await user.click(screen.getByRole("button", { name: "Find in document" }));
    expect(await screen.findByRole("textbox", { name: "Find in document" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in document" }), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Find in document" })).not.toBeInTheDocument();
    });

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(within(screen.getByRole("toolbar", { name: /pdf focus toolbar/i })).getByRole("button", { name: "Find in document" }));
    expect(await screen.findByRole("textbox", { name: "Find in document" })).toHaveFocus();
  });

  it("creates and renames collections inline in the tree from root actions and the context menu", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("button", { name: "New folder" }));
    const createInput = await screen.findByRole("textbox", { name: "New collection name" });
    await user.type(createInput, "Fresh Notes{enter}");
    expect(await screen.findByRole("treeitem", { name: /Fresh Notes/i })).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Machine Learning" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const renameInput = await screen.findByRole("textbox", { name: "Rename collection" });
    await user.clear(renameInput);
    await user.type(renameInput, "ML Library{enter}");
    expect(await screen.findByRole("treeitem", { name: /ML Library/i })).toBeInTheDocument();
  });

  it("shows resource context menus for collections and items", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: "Machine Learning" }));
    expect(screen.getByRole("menuitem", { name: "New Folder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "New Folder" })).not.toBeInTheDocument();
    });

    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("toggles the docked AI panel from workspace and focus", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    expect(screen.getByLabelText("AI panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close AI panel" }));
    expect(screen.queryByLabelText("AI panel")).not.toBeInTheDocument();

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    expect(screen.getByLabelText("AI panel")).toBeInTheDocument();
  });

  it("sends freeform prompts to the active AI session", async () => {
    const user = userEvent.setup();
    const runSessionTaskSpy = vi.spyOn(fakeApi, "runAiSessionTask");

    render(<App api={fakeApi} />);
    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    await user.type(screen.getByRole("textbox", { name: "AI prompt" }), "What is the key result?");
    await user.click(screen.getByRole("button", { name: "Send AI prompt" }));

    await waitFor(() => {
      expect(runSessionTaskSpy).toHaveBeenCalledWith({
        session_id: 910,
        kind: "session.ask",
        prompt: "What is the key result?",
        stream_id: expect.any(String),
      });
    });
  });

  it("keeps the composer editable while a session task is pending and disables send controls", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    const prompt = screen.getByRole("textbox", { name: "AI prompt" });
    const sendButton = screen.getByRole("button", { name: "Send AI prompt" });
    const summarizeButton = screen.getByRole("button", { name: "Summarize" });
    const readerTab = screen.getByRole("tab", { name: "Transformer Scaling Laws" });

    await user.type(prompt, "What is the key result?");
    await user.click(sendButton);

    expect(await screen.findByLabelText("AI response loading")).toBeInTheDocument();
    expect(prompt).toHaveValue("");
    expect(prompt).toBeEnabled();
    expect(sendButton).toBeDisabled();
    expect(summarizeButton).toBeDisabled();

    await user.type(prompt, "Follow-up draft");
    expect(prompt).toHaveValue("Follow-up draft");

    await user.click(readerTab);
    expect(readerTab).toHaveAttribute("aria-selected", "true");

    expect((await screen.findAllByText(/Reading Q&A: Transformer Scaling Laws/i)).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(summarizeButton).toBeEnabled();
    });
  });

  it("renders compact session controls and reference chips in the AI panel", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    expect(screen.getByRole("textbox", { name: "AI prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain Terms" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Theme Map" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review Draft" })).not.toBeInTheDocument();
    expect(screen.getByText("Copilot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Session" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "History Sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Artifacts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Research Notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add AI reference" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Reference" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Current Paper" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove Transformer Scaling Laws/i })).toBeInTheDocument();
  });

  it("removes a highlight from the floating highlight action bar", async () => {
    const user = userEvent.setup();
    const removeAnnotationSpy = vi.spyOn(fakeApi, "removeAnnotation");
    render(<App api={fakeApi} />);

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Mock activate highlight" }));
    expect(await screen.findByRole("toolbar", { name: "PDF highlight actions" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Highlight" }));

    await waitFor(() => {
      expect(removeAnnotationSpy).toHaveBeenCalledWith({ annotation_id: 500 });
    });
    await waitFor(() => {
      expect(screen.queryByRole("toolbar", { name: "PDF highlight actions" })).not.toBeInTheDocument();
    });
  });

  it("opens settings from the native menu and supports save plus clear-key actions", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => callback,
      invoke: vi.fn(async () => null),
    };
    const user = userEvent.setup();
    const getAiSettingsSpy = vi.spyOn(fakeApi, "getAiSettings");
    const updateAiSettingsSpy = vi.spyOn(fakeApi, "updateAiSettings");
    render(<App api={fakeApi} />);

    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();
    menuListeners.get("menu:open-settings")?.();

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(getAiSettingsSpy).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("AI Providers")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Default paper sort"), "title");
    await user.selectOptions(screen.getByLabelText("Default attachment filter"), "citation_only");
    await user.selectOptions(screen.getByLabelText("PDF default fit mode"), "manual");
    fireEvent.change(screen.getByLabelText("PDF default zoom"), { target: { value: "130" } });

    await user.clear(screen.getByLabelText("OpenAI model"));
    await user.type(screen.getByLabelText("OpenAI model"), "gpt-4.1");
    await user.type(screen.getByLabelText("OpenAI API key"), "new-openai-key");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateAiSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          active_provider: "openai",
          openai_model: "gpt-4.1",
          openai_api_key: "new-openai-key",
        }),
      );
    });
    await waitFor(() => {
      expect(window.localStorage.getItem("paper-reader.item-sort")).toBe("title");
      expect(window.localStorage.getItem("paper-reader.attachment-filter")).toBe("citation_only");
      expect(window.localStorage.getItem("paper-reader.reader-fit-mode")).toBe("manual");
      expect(window.localStorage.getItem("paper-reader.reader-zoom")).toBe("130");
    });

    await user.click(screen.getByRole("button", { name: "Manage library" }));
    expect(screen.getByLabelText("Sort papers")).toHaveValue("title");
    expect(screen.getByLabelText("Attachment filter")).toHaveValue("citation_only");

    menuListeners.get("menu:open-settings")?.();
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear saved key" })[0]);

    await waitFor(() => {
      expect(updateAiSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          clear_openai_api_key: true,
        }),
      );
    });
  });

  it("recursively deletes a collection subtree from the resource tree", async () => {
    replaceFakeApiState({
      collections: [
        { id: 1, name: "Machine Learning", parent_id: null },
        { id: 4, name: "Scaling Papers", parent_id: 1 },
        { id: 2, name: "Systems", parent_id: null },
      ],
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
          plainText: "Scaling behavior emerges.",
          normalizedHtml: "<article><h1>Transformer Scaling Laws</h1></article>",
        },
        {
          id: 2,
          title: "Graph Neural Survey",
          collection_id: 4,
          primary_attachment_id: 102,
          attachment_format: "docx",
          attachment_status: "ready",
          authors: "Wu et al.",
          publication_year: 2021,
          source: "IEEE TPAMI",
          doi: "10.1000/gnn-survey",
          tags: [],
          plainText: "Graph representation learning.",
          normalizedHtml: "<article><h1>Graph Neural Survey</h1></article>",
        },
        {
          id: 3,
          title: "Distributed Consensus Notes",
          collection_id: 2,
          primary_attachment_id: 103,
          attachment_format: "epub",
          attachment_status: "ready",
          authors: "Ongaro & Ousterhout",
          publication_year: 2014,
          source: "USENIX",
          doi: "10.1000/raft",
          tags: [],
          plainText: "Consensus protocols coordinate replicas.",
          normalizedHtml: "<article><h1>Distributed Consensus Notes</h1></article>",
        },
      ] as never,
    });

    const user = userEvent.setup();
    const removeCollectionSpy = vi.spyOn(fakeApi, "removeCollection");
    render(<App api={fakeApi} />);

    const rootNode = await screen.findByRole("treeitem", { name: "Machine Learning" });
    fireEvent.contextMenu(rootNode);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    const confirm = await screen.findByRole("dialog", { name: "Confirm delete" });
    expect(within(confirm).getByText(/2 papers/i)).toBeInTheDocument();
    expect(within(confirm).getByText(/1 nested collection/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(removeCollectionSpy).toHaveBeenCalledWith({ collection_id: 1 });
    });
    expect(screen.queryByRole("treeitem", { name: "Machine Learning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "Scaling Papers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Transformer Scaling Laws/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Graph Neural Survey/i })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Systems" })).toBeInTheDocument();
  });

  it("clears open papers, active paper state, and AI references after recursive collection delete", async () => {
    replaceFakeApiState({
      collections: [
        { id: 1, name: "Machine Learning", parent_id: null },
        { id: 4, name: "Scaling Papers", parent_id: 1 },
        { id: 2, name: "Systems", parent_id: null },
      ],
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
          plainText: "Scaling behavior emerges.",
          normalizedHtml: "<article><h1>Transformer Scaling Laws</h1></article>",
        },
        {
          id: 2,
          title: "Graph Neural Survey",
          collection_id: 4,
          primary_attachment_id: 102,
          attachment_format: "docx",
          attachment_status: "ready",
          authors: "Wu et al.",
          publication_year: 2021,
          source: "IEEE TPAMI",
          doi: "10.1000/gnn-survey",
          tags: [],
          plainText: "Graph representation learning.",
          normalizedHtml: "<article><h1>Graph Neural Survey</h1></article>",
        },
      ] as never,
    });

    const user = userEvent.setup();
    const removeCollectionSpy = vi.spyOn(fakeApi, "removeCollection");
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    expect(await screen.findByText("Transformer Scaling Laws", { selector: ".ai-reference-chip-label" })).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Machine Learning" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(removeCollectionSpy).toHaveBeenCalledWith({ collection_id: 1 });
    });
    expect(screen.queryByText("Transformer Scaling Laws", { selector: ".ai-reference-chip-label" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Transformer Scaling Laws" })).not.toBeInTheDocument();
    expect(container.querySelector(".reader-panel-workspace h2")?.textContent).toBe("No paper selected");
  });

  it("keeps workspace pdf preview and ai composer inside the fixed-height layout", async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    expect(container.querySelector(".app-shell.app-shell-workspace.app-shell-ai-open")).not.toBeNull();
    const workspacePanel = container.querySelector(".reader-panel-workspace");
    expect(workspacePanel).not.toBeNull();
    expect(screen.getByTestId("pdf-reader").closest(".reader-panel-workspace")).toBe(workspacePanel);
    expect(screen.getByLabelText("AI panel")).toContainElement(screen.getByRole("textbox", { name: "AI prompt" }));
  });

  it("renders quick actions in the dock and appends them to the AI chat history", async () => {
    const user = userEvent.setup();
    const runSessionTaskSpy = vi.spyOn(fakeApi, "runAiSessionTask");
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Summarize" }));

    await waitFor(() => {
      expect(runSessionTaskSpy).toHaveBeenCalledWith({
        session_id: 910,
        kind: "session.summarize",
        prompt: undefined,
        stream_id: expect.any(String),
      });
    });
    expect(container.querySelector(".ai-bottom-dock .ai-quick-actions")).not.toBeNull();
    expect(Array.from(container.querySelectorAll(".ai-message-user p")).some((node) => node.textContent === "Summarize")).toBe(true);
    expect(screen.queryByText("Streaming")).not.toBeInTheDocument();
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
    expect((await screen.findAllByText("Key Points")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("The paper argues for predictable scaling trends.").length).toBeGreaterThan(0);
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
  });

  it("keeps quick actions available after creating a new session", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "New Session" }));
    expect(await screen.findByRole("button", { name: "Summarize" })).toBeInTheDocument();
  });

  it("shows current papers before collections in the empty context picker", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Add AI reference" }));

    const popover = screen.getByRole("dialog", { name: "Add AI reference" });
    const searchInput = within(popover).getByRole("searchbox", { name: "Search context" });
    expect(searchInput).toHaveFocus();
    expect(within(popover).getByRole("button", { name: /Transformer Scaling Laws/i })).toBeDisabled();
    expect(within(popover).getByRole("button", { name: /Graph Neural Survey/i })).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: /Distributed Consensus Notes/i })).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();
  });

  it("preserves full long context names through truncation affordances", async () => {
    const longPaperTitle =
      "Graph Neural Survey for Production Systems with Very Long Context Labels That Should Ellipsize Cleanly in the Picker";
    const longCollectionName =
      "Machine Learning Research Program with a Long Collection Name That Should Stay Readable via Title Text";
    replaceFakeApiState({
      collections: (await fakeApi.listCollections()).map((collection) =>
        collection.id === 1 ? { ...collection, name: longCollectionName } : collection,
      ),
      items: (await fakeApi.listItems()).map((item) =>
        item.id === 2 ? { ...item, title: longPaperTitle } : item,
      ) as never,
    });

    const user = userEvent.setup();
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Add AI reference" }));

    const popover = screen.getByRole("dialog", { name: "Add AI reference" });
    const longPaperButton = await within(popover).findByRole("button", { name: new RegExp(longPaperTitle) });
    expect(longPaperButton).toHaveAttribute("title", expect.stringContaining(longPaperTitle));
    expect(within(longPaperButton).getByText(longPaperTitle)).toHaveClass("ai-reference-result-label");

    const longCollectionButton = within(popover).getByRole("button", { name: new RegExp(longCollectionName) });
    expect(longCollectionButton).toHaveAttribute("title", expect.stringContaining(longCollectionName));

    await user.click(longPaperButton);

    const chip = container.querySelector(`.ai-reference-chip[title="${longPaperTitle}"]`);
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".ai-reference-chip-label")).not.toBeNull();
  });

  it("keeps ask prompts and assistant replies in one message flow for AI sessions", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.type(screen.getByRole("textbox", { name: "AI prompt" }), "What is the key result?");
    await user.click(screen.getByRole("button", { name: "Send AI prompt" }));

    expect((await screen.findAllByText("What is the key result?")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Reading Q&A: Transformer Scaling Laws/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add AI reference" }));
    expect(screen.getByRole("dialog", { name: "Add AI reference" })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search context" }), "Machine");
    await user.click(within(screen.getByRole("dialog", { name: "Add AI reference" })).getByRole("button", { name: /Machine Learning/i }));
    await user.clear(screen.getByRole("textbox", { name: "AI prompt" }));
    await user.type(screen.getByRole("textbox", { name: "AI prompt" }), "Compare the papers.");
    await user.click(screen.getByRole("button", { name: "Send AI prompt" }));

    expect((await screen.findAllByText("Compare the papers.")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Reading Q&A/i)).length).toBeGreaterThan(0);
  });

  it("submits on Enter, inserts a newline on Shift+Enter, and ignores Enter during IME composition", async () => {
    const user = userEvent.setup();
    const runSessionTaskSpy = vi.spyOn(fakeApi, "runAiSessionTask");
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    const prompt = screen.getByRole("textbox", { name: "AI prompt" });

    await user.type(prompt, "Line 1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(prompt, "Line 2");
    expect(prompt).toHaveValue("Line 1\nLine 2");

    fireEvent.keyDown(prompt, { key: "Enter", isComposing: true });
    await waitFor(() => {
      expect(runSessionTaskSpy).not.toHaveBeenCalled();
    });

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(runSessionTaskSpy).toHaveBeenCalledWith({
        session_id: 910,
        kind: "session.ask",
        prompt: "Line 1\nLine 2",
        stream_id: expect.any(String),
      });
    });
  });

  it("keeps pending work scoped to the originating session when switching chats", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    await user.click(screen.getByRole("button", { name: "New Session" }));
    await user.click(screen.getByRole("button", { name: "Chat History" }));
    const historyPanel = screen.getByLabelText("Chat History panel");
    const firstSessionButton = within(historyPanel).getByRole("button", { name: /Transformer Scaling Laws Open/i });
    const secondSessionButton = within(historyPanel).getByRole("button", { name: /New Chat Active/i });

    await user.type(screen.getByRole("textbox", { name: "AI prompt" }), "What is the key result?");
    await user.click(screen.getByRole("button", { name: "Send AI prompt" }));
    expect(await screen.findByLabelText("AI response loading")).toBeInTheDocument();

    await user.click(firstSessionButton);
    expect(screen.queryByLabelText("AI response loading")).not.toBeInTheDocument();
    expect(screen.queryByText("What is the key result?")).not.toBeInTheDocument();

    await user.click(secondSessionButton);
    expect(await screen.findByText("What is the key result?")).toBeInTheDocument();
    expect(await screen.findByText(/Reading Q&A: Transformer Scaling Laws/i)).toBeInTheDocument();
  });

  it("opens the quick picker, focuses search, and adds a searched paper reference", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    await user.click(screen.getByRole("button", { name: "Add AI reference" }));
    const popover = screen.getByRole("dialog", { name: "Add AI reference" });
    const searchInput = within(popover).getByRole("searchbox", { name: "Search context" });
    expect(searchInput).toHaveFocus();

    await user.type(searchInput, "Graph");
    await user.click(await within(popover).findByRole("button", { name: /Graph Neural Survey/i }));

    expect(screen.queryByRole("dialog", { name: "Add AI reference" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove Graph Neural Survey/i })).toBeInTheDocument();
  });

  it("keeps the AI reference popover outside header overflow clipping", async () => {
    // @ts-expect-error Vitest runs this test in Node, even though the app TS config omits Node types.
    const { readFileSync } = await import("fs");
    const styles = readFileSync("src/styles.css", "utf8");

    expect(styles).toMatch(/\.ai-composer-header\s*\{[^}]*overflow:\s*visible;/s);
    expect(styles).toMatch(/\.ai-reference-chip-list\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
    expect(styles).toMatch(/\.ai-reference-picker-shell\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s);
    expect(styles).toMatch(/\.ai-reference-popover\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*12;/s);
    expect(styles).toMatch(/\.ai-session-history-panel\s*\{[^}]*right:\s*0;[^}]*left:\s*0;[^}]*width:\s*100%;/s);
    expect(styles).not.toMatch(/\.ai-session-history-panel\s*\{[^}]*right:\s*-[0-9]/s);
  });

  it("keeps selected references in a single chip row inside the composer", async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Add AI reference" }));
    await user.click(await within(screen.getByRole("dialog", { name: "Add AI reference" })).findByRole("button", { name: /Graph Neural Survey/i }));
    await user.click(screen.getByRole("button", { name: "Add AI reference" }));
    await user.type(within(screen.getByRole("dialog", { name: "Add AI reference" })).getByRole("searchbox", { name: "Search context" }), "Machine");
    await user.click(await within(screen.getByRole("dialog", { name: "Add AI reference" })).findByRole("button", { name: /Machine Learning/i }));

    const chipRow = container.querySelector(".ai-reference-chip-list");
    expect(chipRow).not.toBeNull();
    expect(chipRow?.querySelectorAll(".ai-reference-chip").length).toBeGreaterThanOrEqual(3);
    expect(chipRow?.querySelector(".ai-reference-chip .ai-reference-chip-label")).not.toBeNull();
  });

  it("searches collections, marks added references, and gates compare on two unique papers", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add AI reference" }));
    const popover = screen.getByRole("dialog", { name: "Add AI reference" });
    expect(within(popover).getByRole("button", { name: /Transformer Scaling Laws/i })).toBeDisabled();
    expect(within(popover).getByRole("button", { name: /Graph Neural Survey/i })).toBeInTheDocument();
    expect(within(popover).getAllByText("Added").length).toBeGreaterThan(0);

    const searchInput = within(popover).getByRole("searchbox", { name: "Search context" });
    await user.type(searchInput, "Machine");
    await user.click(await within(popover).findByRole("button", { name: /Machine Learning/i }));

    expect(screen.getByRole("button", { name: /Remove Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add AI reference" }));
    const graphSearch = within(screen.getByRole("dialog", { name: "Add AI reference" })).getByRole("searchbox", {
      name: "Search context",
    });
    await user.type(graphSearch, "Graph");
    await user.click(await within(screen.getByRole("dialog", { name: "Add AI reference" })).findByRole("button", { name: /Graph Neural Survey/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compare" })).toBeEnabled();
    });
  });

  it("opens icon-only AI dock controls from the header", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    for (const label of ["Chat History", "New Session", "Artifacts", "Task History", "Research Notes", "Close Copilot"]) {
      expect(screen.getByRole("button", { name: label }).textContent?.trim()).toBe("");
    }

    await user.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(screen.getByLabelText("Artifacts panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Task History" }));
    expect(screen.getByLabelText("Task History panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Research Notes" }));
    expect(screen.getByLabelText("Research Notes panel")).toBeInTheDocument();
  });

  it("opens chat history from the header and switches sessions from the slide-out", async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "New Session" }));

    await user.click(screen.getByRole("button", { name: "Chat History" }));
    const historyPanel = screen.getByLabelText("Chat History panel");
    expect(historyPanel).toBeInTheDocument();
    await user.click(within(historyPanel).getByRole("button", { name: /Transformer Scaling Laws Open/i }));

    expect(screen.getByText("Transformer Scaling Laws", { selector: ".meta-count" })).toBeInTheDocument();
    expect(container.querySelector(".ai-session-history-panel")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("deletes a non-current chat session without switching the active chat", async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "New Session" }));
    expect(screen.getByText("New Chat", { selector: ".meta-count" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chat History" }));
    const historyPanel = screen.getByLabelText("Chat History panel");
    await user.click(within(historyPanel).getByRole("button", { name: "Delete Transformer Scaling Laws" }));

    expect(screen.getByText("New Chat", { selector: ".meta-count" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Confirm delete" })).toHaveTextContent(
      "This deletes the chat history, tasks, artifacts, references, and research notes for this session.",
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(within(historyPanel).queryByRole("button", { name: /Transformer Scaling Laws Open/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText("New Chat", { selector: ".meta-count" })).toBeInTheDocument();
    expect(container.querySelector(".ai-session-history-panel")?.getAttribute("aria-hidden")).toBe("false");
  });

  it("deletes the active chat and switches to the newest remaining session", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "New Session" }));
    expect(screen.getByText("New Chat", { selector: ".meta-count" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chat History" }));
    const historyPanel = screen.getByLabelText("Chat History panel");
    await user.click(within(historyPanel).getByRole("button", { name: "Delete New Chat" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByText("Transformer Scaling Laws", { selector: ".meta-count" })).toBeInTheDocument();
    });
    expect(within(historyPanel).queryByRole("button", { name: /New Chat/i })).not.toBeInTheDocument();
  });

  it("creates a new empty chat after deleting the last session", async () => {
    const user = userEvent.setup();
    const createAiSessionSpy = vi.spyOn(fakeApi, "createAiSession");
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Chat History" }));
    const historyPanel = screen.getByLabelText("Chat History panel");
    await user.click(within(historyPanel).getByRole("button", { name: "Delete Transformer Scaling Laws" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(createAiSessionSpy).toHaveBeenCalled();
      expect(screen.getByText("New Chat", { selector: ".meta-count" })).toBeInTheDocument();
    });
    expect(within(historyPanel).getByRole("button", { name: /New Chat Active/i })).toBeInTheDocument();
  });

  it("deletes a paper from the resource context menu and clears matching ai references", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    expect(screen.getByRole("button", { name: /Remove Transformer Scaling Laws/i })).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Confirm delete" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("treeitem", { name: /Transformer Scaling Laws/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Remove Transformer Scaling Laws/i })).not.toBeInTheDocument();
  });

  it("shows stream failures without corrupting task history", async () => {
    const user = userEvent.setup();
    failNextFakeAiStream("Network stream dropped.");
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Summarize" }));

    expect(await screen.findByText("Network stream dropped.")).toBeInTheDocument();
    expect(screen.getAllByText("Summarize").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Task History" }));
    const taskHistory = screen.getByLabelText("Task History panel");
    expect(within(taskHistory).getByText("No tasks yet.")).toBeInTheDocument();
    expect(within(taskHistory).queryByText("Summarize")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize" })).toBeEnabled();
  });

  it("renders rejected AI session tasks inside the chat thread", async () => {
    const user = userEvent.setup();
    vi.spyOn(fakeApi, "runAiSessionTask").mockRejectedValueOnce(new Error("Provider missing API key."));
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Summarize" }));

    expect(await screen.findByText("Provider missing API key.")).toBeInTheDocument();
    expect(screen.getAllByText("Summarize").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Summarize" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Task History" }));
    const taskHistory = screen.getByLabelText("Task History panel");
    expect(within(taskHistory).getByText("No tasks yet.")).toBeInTheDocument();
  });

  it("keeps completed AI session replies at the bottom of the chat thread while task history stays newest-first", async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    const thread = container.querySelector(".ai-chat-history");
    expect(thread).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Summarize" }));
    expect(await screen.findByLabelText("AI response streaming")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByLabelText("AI response streaming")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Explain Terms" }));
    expect(await screen.findByLabelText("AI response streaming")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByLabelText("AI response streaming")).not.toBeInTheDocument();
    });

    const threadEntries = Array.from(thread?.querySelectorAll(".ai-thread-entry") ?? []);
    expect(threadEntries).toHaveLength(2);
    expect(threadEntries[0]).toHaveTextContent("Summarize");
    expect(threadEntries[1]).toHaveTextContent("Explain Terms");

    await user.click(screen.getByRole("button", { name: "Task History" }));
    const historyPanel = screen.getByLabelText("Task History panel");
    const historyRows = Array.from(historyPanel.querySelectorAll(".export-row"));
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toHaveTextContent("Explain Terms");
    expect(historyRows[1]).toHaveTextContent("Summarize");
  });

  it("responds to native menu import events and native drag-and-drop", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => callback,
      invoke: vi.fn(async () => null),
    };

    const importFiles = vi.fn((input: { collection_id: number; paths: string[] }) => fakeApi.importFiles(input as never));
    const pickImportPaths = vi.fn(async () => ["/Users/test/dragged.pdf"]);
    const api = { ...fakeApi, importFiles, pickImportPaths };

    render(<App api={api} />);
    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();

    menuListeners.get("menu:import-documents")?.();
    await waitFor(() => {
      expect(importFiles).toHaveBeenCalledWith({
        collection_id: 1,
        paths: ["/Users/test/dragged.pdf"],
      });
    });

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

  it("filters the resource tree from the sidebar search", async () => {
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

    await user.type(await screen.findByRole("textbox", { name: "Search papers" }), "scaling");

    expect(screen.getByRole("treeitem", { name: /Machine Learning/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Transformers/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Expand Transformers/i }));
    expect(screen.getByRole("treeitem", { name: /Transformer Scaling Laws/i })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Graph Neural Survey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Systems/i })).not.toBeInTheDocument();
  });
});
