import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfReader } from "./PdfReader";
import type { ReaderView } from "../../lib/contracts";

const { getDocumentMock, getPageMock, renderMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
  getPageMock: vi.fn(),
  renderMock: vi.fn(),
}));

const { getLegacyDocumentMock, getLegacyPageMock, legacyRenderMock } = vi.hoisted(() => ({
  getLegacyDocumentMock: vi.fn(),
  getLegacyPageMock: vi.fn(),
  legacyRenderMock: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: getDocumentMock,
  TextLayer: class TextLayerMock {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    #container: HTMLElement;
    #textContentSource: unknown;

    constructor({
      textContentSource,
      container,
    }: {
      textContentSource: unknown;
      container: HTMLElement;
      viewport: unknown;
    }) {
      this.#container = container;
      this.#textContentSource = textContentSource;
    }

    async render() {
      const items = (this.#textContentSource as { items?: Array<{ str?: string }> }).items ?? [];
      this.textContentItemsStr = items.map((item) => item.str ?? "");
      this.textDivs = this.textContentItemsStr.map((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        this.#container.appendChild(span);
        return span;
      });
    }

    cancel() {}
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: getLegacyDocumentMock,
  TextLayer: class TextLayerMock {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    #container: HTMLElement;
    #textContentSource: unknown;

    constructor({
      textContentSource,
      container,
    }: {
      textContentSource: unknown;
      container: HTMLElement;
      viewport: unknown;
    }) {
      this.#container = container;
      this.#textContentSource = textContentSource;
    }

    async render() {
      const items = (this.#textContentSource as { items?: Array<{ str?: string }> }).items ?? [];
      this.textContentItemsStr = items.map((item) => item.str ?? "");
      this.textDivs = this.textContentItemsStr.map((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        this.#container.appendChild(span);
        return span;
      });
    }

    cancel() {}
  },
}));

const pdfView: ReaderView = {
  item_id: 1,
  title: "Native PDF Paper",
  reader_kind: "pdf",
  attachment_format: "pdf",
  primary_attachment_id: 101,
  primary_attachment_path: "/mock/native-pdf-paper.pdf",
  page_count: null,
  content_status: "ready",
  content_notice: null,
  normalized_html: "<article><p>Fallback</p></article>",
  plain_text: "PDF preview",
};

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("PdfReader", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    getDocumentMock.mockReset();
    getPageMock.mockReset();
    renderMock.mockReset();
    getLegacyDocumentMock.mockReset();
    getLegacyPageMock.mockReset();
    legacyRenderMock.mockReset();

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({}) as CanvasRenderingContext2D,
    );
  });

  it("renders multi-page PDFs without crashing when jumping across pages", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock
      .mockResolvedValueOnce({
        getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale }),
        getTextContent: () => Promise.resolve({ items: [{ str: "Page one scaling" }], styles: {} }),
        render: legacyRenderMock,
      })
      .mockResolvedValueOnce({
        getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale }),
        getTextContent: () => Promise.resolve({ items: [{ str: "Page two scaling" }], styles: {} }),
        render: legacyRenderMock,
      });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: getLegacyPageMock,
      }),
    });

    const { rerender } = render(
      <PdfReader loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes} page={0} view={pdfView} zoom={100} />,
    );

    await waitFor(() => {
      expect(getLegacyPageMock).toHaveBeenCalledWith(1);
      expect(legacyRenderMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <PdfReader loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes} page={1} view={pdfView} zoom={100} />,
    );

    await waitFor(() => {
      expect(getLegacyPageMock).toHaveBeenCalledWith(2);
      expect(legacyRenderMock).toHaveBeenCalledTimes(2);
    });

    expect(screen.queryByText(/Unable to load this PDF/i)).not.toBeInTheDocument();
  });

  it("falls back when replaceChildren is unavailable", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    const original = (Element.prototype as unknown as { replaceChildren?: unknown }).replaceChildren;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).replaceChildren = undefined;

    try {
      legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
      getLegacyPageMock.mockResolvedValue({
        getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale }),
        getTextContent: () => Promise.resolve({ items: [{ str: "Alpha scaling" }], styles: {} }),
        render: legacyRenderMock,
      });
      getLegacyDocumentMock.mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage: getLegacyPageMock,
        }),
      });

      render(
        <PdfReader loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes} page={0} view={pdfView} zoom={100} />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText("PDF page canvas")).toBeInTheDocument();
      });
      expect(screen.queryByText(/Unable to load this PDF/i)).not.toBeInTheDocument();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Element.prototype as any).replaceChildren = original;
    }
  });

  it("does not rely on scrollIntoView options support", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    const original = HTMLElement.prototype.scrollIntoView;
    // Older runtimes accept only boolean or no args; simulate throwing on options objects.
    HTMLElement.prototype.scrollIntoView = ((arg?: unknown) => {
      if (arg && typeof arg === "object") throw new TypeError("Unsupported scrollIntoView options");
    }) as unknown as typeof HTMLElement.prototype.scrollIntoView;

    try {
      legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
      getLegacyPageMock.mockResolvedValue({
        getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale }),
        getTextContent: () => Promise.resolve({ items: [{ str: "scaling one" }, { str: "two scaling" }], styles: {} }),
        render: legacyRenderMock,
      });
      getLegacyDocumentMock.mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage: getLegacyPageMock,
        }),
      });

      render(
        <PdfReader
          loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
          page={0}
          searchQuery="scaling"
          view={pdfView}
          zoom={100}
        />,
      );

      await waitFor(() => {
        expect(document.querySelector(".pdf-search-hit")).toBeTruthy();
      });
      expect(screen.queryByText(/Unable to load this PDF/i)).not.toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("loads bytes through the injected attachment loader and passes them to pdf.js", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "Alpha scaling" }, { str: "Beta" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 4,
        getPage: getLegacyPageMock,
      }),
    });

    render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(loadPrimaryAttachmentBytes).toHaveBeenCalledWith(101);
      expect(getLegacyDocumentMock).toHaveBeenCalledWith({ data: bytes });
      expect(getLegacyPageMock).toHaveBeenCalledWith(1);
      expect(legacyRenderMock).toHaveBeenCalled();
    });

    expect(screen.getByLabelText("PDF page canvas")).toBeInTheDocument();
    expect(screen.getByLabelText("PDF text layer")).toBeInTheDocument();
    expect(screen.getByText(/native-pdf-paper\.pdf/i)).toBeInTheDocument();
  });

  it("hides reader chrome when rendered in focus mode", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "Alpha scaling" }, { str: "Beta" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 4,
        getPage: getLegacyPageMock,
      }),
    });

    render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        mode="focus"
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(loadPrimaryAttachmentBytes).toHaveBeenCalledWith(101);
      expect(legacyRenderMock).toHaveBeenCalled();
    });

    expect(screen.getByLabelText("PDF page canvas")).toBeInTheDocument();
    expect(screen.getByLabelText("PDF text layer")).toBeInTheDocument();
    expect(screen.queryByText(/native pdf reader/i)).not.toBeInTheDocument();
    expect(screen.queryByText(pdfView.title)).not.toBeInTheDocument();
    expect(screen.queryByText(/pdf mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/native-pdf-paper\.pdf/i)).not.toBeInTheDocument();
  });

  it("shows a specific error when the attachment id is missing", async () => {
    render(
      <PdfReader
        loadPrimaryAttachmentBytes={vi.fn()}
        page={0}
        view={{ ...pdfView, primary_attachment_id: null }}
        zoom={100}
      />,
    );

    expect(
      await screen.findByText(/primary attachment id is missing/i),
    ).toBeInTheDocument();
  });

  it.each([
    "Primary attachment was not found.",
    "Primary attachment file is missing.",
    "Primary attachment is not a PDF.",
    "Failed to read primary attachment bytes.",
  ])("surfaces byte-loading errors: %s", async (message) => {
    render(
      <PdfReader
        loadPrimaryAttachmentBytes={vi.fn().mockRejectedValue(new Error(message))}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    expect(await screen.findByText(new RegExp(message, "i"))).toBeInTheDocument();
  });

  it("cancels an in-flight render before starting a replacement render", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const firstRender = createDeferred<void>();
    const cancelFirstRender = vi.fn(() => {
      firstRender.reject(new Error("RenderingCancelledException"));
    });
    const secondRender = createDeferred<void>();
    const cancelSecondRender = vi.fn();

    legacyRenderMock
      .mockReturnValueOnce({ promise: firstRender.promise, cancel: cancelFirstRender })
      .mockReturnValueOnce({ promise: secondRender.promise, cancel: cancelSecondRender });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "Alpha scaling" }, { str: "Beta" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 4,
        getPage: getLegacyPageMock,
      }),
      destroy: vi.fn(),
    });

    const { rerender } = render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(legacyRenderMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={1}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(cancelFirstRender).toHaveBeenCalledTimes(1);
      expect(legacyRenderMock).toHaveBeenCalledTimes(2);
    });

    secondRender.resolve();

    expect(cancelSecondRender).not.toHaveBeenCalled();
  });

  it("does not reload or rerender only because onPageCountChange gets a new identity", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const onPageCountChange = vi.fn();

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "Alpha scaling" }, { str: "Beta" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 4,
        getPage: getLegacyPageMock,
      }),
      destroy: vi.fn(),
    });

    const { rerender } = render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        onPageCountChange={onPageCountChange}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(loadPrimaryAttachmentBytes).toHaveBeenCalledTimes(1);
      expect(legacyRenderMock).toHaveBeenCalledTimes(1);
      expect(onPageCountChange).toHaveBeenCalledWith(4);
    });

    rerender(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        onPageCountChange={vi.fn()}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(loadPrimaryAttachmentBytes).toHaveBeenCalledTimes(1);
      expect(getLegacyDocumentMock).toHaveBeenCalledTimes(1);
      expect(legacyRenderMock).toHaveBeenCalledTimes(1);
    });
  });

  it("treats cancelled renders as normal control flow instead of a user-visible error", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const renderDeferred = createDeferred<void>();
    const cancelRender = vi.fn(() => {
      renderDeferred.reject(new Error("RenderingCancelledException"));
    });

    legacyRenderMock.mockReturnValue({ promise: renderDeferred.promise, cancel: cancelRender });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "Alpha scaling" }, { str: "Beta" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 4,
        getPage: getLegacyPageMock,
      }),
      destroy: vi.fn(),
    });

    const { unmount } = render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(legacyRenderMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    await waitFor(() => {
      expect(cancelRender).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText(/RenderingCancelledException/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unable to load this PDF/i)).not.toBeInTheDocument();
  });

  it("renders a text layer and highlights search matches when content is ready", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "scaling one" }, { str: "two scaling" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
      }),
    });

    render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        searchQuery="scaling"
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".pdf-search-hit")).toBeTruthy();
      expect(document.querySelector(".pdf-search-hit-active")).toBeTruthy();
    });
  });

  it("reports search match counts and honors activeSearchMatchIndex", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const onSearchMatchesChange = vi.fn();

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "scaling one" }, { str: "two scaling" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
      }),
    });

    const { rerender } = render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        onSearchMatchesChange={onSearchMatchesChange}
        page={0}
        searchQuery="scaling"
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(onSearchMatchesChange).toHaveBeenCalledWith({ total: 2, activeIndex: 0 });
    });

    await waitFor(() => {
      expect(document.querySelector('.pdf-search-hit[data-hit-index="0"]')).toBeTruthy();
    });

    rerender(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        onSearchMatchesChange={onSearchMatchesChange}
        page={0}
        searchQuery="scaling"
        activeSearchMatchIndex={1}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.pdf-search-hit[data-hit-index="1"].pdf-search-hit-active')).toBeTruthy();
      expect(onSearchMatchesChange).toHaveBeenCalledWith({ total: 2, activeIndex: 1 });
    });
  });

  it("repaints persisted highlight annotations on the current page", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "Alpha scaling" }, { str: "Beta" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
      }),
    });

    const highlightAnchor = JSON.stringify({
      type: "pdf_text",
      page: 1,
      startDivIndex: 0,
      startOffset: 0,
      endDivIndex: 0,
      endOffset: 5,
      quote: "Alpha",
    });

    render(
      <PdfReader
        annotations={[
          {
            id: 1,
            item_id: 1,
            kind: "highlight",
            body: "Alpha",
            anchor: highlightAnchor,
          },
        ]}
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".pdf-annotation-highlight")).toBeTruthy();
    });
  });

  it("does not enable the text layer for partial/unavailable content", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [{ str: "scaling one" }, { str: "two scaling" }],
          styles: {},
        }),
      render: legacyRenderMock,
    });
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
      }),
    });

    render(
      <PdfReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        searchQuery="scaling"
        view={{ ...pdfView, content_status: "partial" }}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(loadPrimaryAttachmentBytes).toHaveBeenCalledWith(101);
      expect(legacyRenderMock).toHaveBeenCalled();
    });

    expect(document.querySelector(".pdf-search-hit")).toBeFalsy();
    expect(document.querySelector(".pdf-annotation-highlight")).toBeFalsy();
  });
});
