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
    expect(screen.getByRole("button", { name: /Rename Machine Learning/i })).toBeInTheDocument();
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

  it("creates and renames collections inline in the tree", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("button", { name: "New folder" }));
    const createInput = await screen.findByRole("textbox", { name: "New collection name" });
    await user.type(createInput, "Fresh Notes{enter}");
    expect(await screen.findByRole("treeitem", { name: /Fresh Notes/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Machine Learning" }));
    await user.click(screen.getByRole("button", { name: /Rename Machine Learning/i }));
    const renameInput = await screen.findByRole("textbox", { name: "Rename collection" });
    await user.clear(renameInput);
    await user.type(renameInput, "ML Library{enter}");
    expect(await screen.findByRole("treeitem", { name: /ML Library/i })).toBeInTheDocument();
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

  it("renders session controls and reference chips in the AI panel", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));

    expect(screen.getByRole("textbox", { name: "AI prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Session" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "History Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Reference" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Current Paper" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Transformer Scaling Laws ×/i })).toBeInTheDocument();
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

  it("renders quick actions as user chat entries, hides the strip while active, and restores it after completion", async () => {
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
    expect(container.querySelector(".ai-quick-actions")).toBeNull();
    expect(Array.from(container.querySelectorAll(".ai-message-user p")).some((node) => node.textContent === "Summarize")).toBe(true);
    expect(screen.queryByText("Streaming")).not.toBeInTheDocument();
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
    expect((await screen.findAllByText("Key Points")).length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();
    });
    expect(screen.getAllByText("Axis").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Signal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("The paper argues for predictable scaling trends.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("loss ~= f(model, data, compute)").length).toBeGreaterThan(0);
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
  });

  it("restores quick actions after creating a new session", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.click(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    await user.click(screen.getByRole("button", { name: "Open AI panel" }));
    await user.click(screen.getByRole("button", { name: "Summarize" }));

    expect(screen.queryByRole("button", { name: "Summarize" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New Session" }));
    expect(await screen.findByRole("button", { name: "Summarize" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Add Reference" }));
    await user.click(screen.getAllByRole("button", { name: "Machine Learning" })[1]);
    await user.clear(screen.getByRole("textbox", { name: "AI prompt" }));
    await user.type(screen.getByRole("textbox", { name: "AI prompt" }), "Compare the papers.");
    await user.click(screen.getByRole("button", { name: "Send AI prompt" }));

    expect((await screen.findAllByText("Compare the papers.")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Reading Q&A/i)).length).toBeGreaterThan(0);
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

    await user.click(screen.getByText("Task History"));
    const taskHistory = screen.getByText("Task History").closest("details");
    expect(taskHistory).not.toBeNull();
    expect(within(taskHistory as HTMLDetailsElement).getByText("Ask")).toBeInTheDocument();
    expect(within(taskHistory as HTMLDetailsElement).getByText("succeeded")).toBeInTheDocument();
    expect(within(taskHistory as HTMLDetailsElement).queryByText("Summarize")).not.toBeInTheDocument();
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
