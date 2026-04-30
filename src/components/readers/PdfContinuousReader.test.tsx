import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfContinuousReader } from "./PdfContinuousReader";
import type { ReaderView } from "../../lib/contracts";

const pdfView: ReaderView = {
  item_id: 1,
  title: "Native PDF Paper",
  reader_kind: "pdf",
  attachment_format: "pdf",
  primary_attachment_id: 101,
  primary_attachment_path: "/mock/native-pdf-paper.pdf",
  page_count: 3,
  content_status: "ready",
  content_notice: null,
  normalized_html: "<article><p>Fallback</p></article>",
  plain_text: "PDF preview",
};

const makeBundle = (text: string) => ({
  png_bytes: new Uint8Array([137, 80, 78, 71]),
  width_px: 800,
  height_px: 1000,
  page_width_pt: 600,
  page_height_pt: 750,
  spans: text ? [{ text, x0: 10, y0: 700, x1: 200, y1: 720 }] : [],
});

const makeDocumentInfo = (pageCount = 3) => ({
  page_count: pageCount,
  pages: [{ width_pt: 600, height_pt: 750 }],
});

describe("PdfContinuousReader", () => {
  beforeEach(() => {
    if (!("createObjectURL" in URL)) {
      Object.defineProperty(URL, "createObjectURL", { value: () => "blob:pdf-page", writable: true });
    }
    if (!("revokeObjectURL" in URL)) {
      Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf-page");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(window, "requestIdleCallback", {
      value: ((cb: IdleRequestCallback) => {
        cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline);
        return 1;
      }) as typeof window.requestIdleCallback,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true, writable: true });
    if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
      HTMLElement.prototype.scrollIntoView = (() => {}) as unknown as typeof HTMLElement.prototype.scrollIntoView;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class ResizeObserverMock {
      observe = () => {};
      disconnect = () => {};
      unobserve = () => {};
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IntersectionObserver = class IntersectionObserverMock {
      constructor(_callback: IntersectionObserverCallback) {}
      observe = () => {};
      unobserve = () => {};
      disconnect = () => {};
      takeRecords = () => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).IntersectionObserver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).ResizeObserver;
  });

  it("renders page shells for all pages and keeps controlled page changes stable", async () => {
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(`Page ${page_index0 + 1}`),
    );
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [],
    });

    const { rerender, container } = render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".pdf-page-shell")).toHaveLength(3);
    });
    expect(getPdfPageBundle.mock.calls.length).toBeLessThanOrEqual(3);

    rerender(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={2}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".pdf-page-shell")).toHaveLength(3);
    });
  });

  it("only requests nearby pages and releases far rendered pages", async () => {
    const longPdfView: ReaderView = { ...pdfView, page_count: 20 };
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(`Page ${page_index0 + 1}`),
    );
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo(20));
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [],
    });

    const { rerender } = render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={longPdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(getPdfPageBundle.mock.calls.length).toBeLessThanOrEqual(3);
    });

    rerender(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={10}
        view={longPdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(getPdfPageBundle.mock.calls.length).toBeLessThanOrEqual(9);
      expect(getPdfPageBundle.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
  });

  it("reports search matches across rendered pages", async () => {
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(page_index0 === 1 ? "needle here" : "no match"),
    );
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) => ({
      page_index0,
      spans: [{ text: page_index0 === 1 ? "needle here" : "no match", x0: 10, y0: 700, x1: 200, y1: 720 }],
    }));
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [],
    });
    const onSearchMatchesChange = vi.fn();

    render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        searchQuery="needle"
        view={pdfView}
        zoom={100}
        onSearchMatchesChange={onSearchMatchesChange}
      />,
    );

    await waitFor(() => {
      expect(onSearchMatchesChange).toHaveBeenLastCalledWith({ total: 1, activeIndex: 0 });
    });
  });

  it("renders current page at 1x first, then upgrades visible page to high-dpi without changing css size", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true, writable: true });
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle("Sharp text"));
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [],
    });

    render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => expect(getPdfPageBundle.mock.calls.length).toBeGreaterThanOrEqual(2));
    const requestedWidths = getPdfPageBundle.mock.calls.map((call) => call[0].target_width_px);
    expect(requestedWidths).toContain(800);
    expect(requestedWidths).toContain(1600);

    const image = await screen.findByLabelText("PDF page 1 image");
    expect(image).toHaveStyle({ width: "800px", height: "1000px" });
  });

  it("falls back to OCR when native text is empty", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle(""));
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [{ text: "OCR page 1", bbox: { left: 0.1, top: 0.1, width: 0.4, height: 0.03 }, confidence: 95 }],
    });

    render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => expect(ocrPdfPage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText("OCR page 1").length).toBeGreaterThan(0));
  });

  it("falls back to OCR when native text is obviously garbled", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle("bad\uFFFDtext"));
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [{ text: "OCR repaired", bbox: { left: 0.1, top: 0.1, width: 0.4, height: 0.03 }, confidence: 95 }],
    });

    render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => expect(ocrPdfPage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText("OCR repaired").length).toBeGreaterThan(0));
  });

  it("does not call OCR when native text looks healthy", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle("healthy native text"));
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn();

    render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => expect(getPdfPageBundle).toHaveBeenCalled());
    expect(ocrPdfPage).not.toHaveBeenCalled();
  });

  it("registers a window scroll fallback listener for continuous mode", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(`Page ${page_index0 + 1}`),
    );
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [],
    });
    const { container } = render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".pdf-page-shell")).toHaveLength(3);
    });
    expect(addEventListenerSpy).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
  });

  it("only OCRs the current or visible page even if nearby prerendered pages have empty text", async () => {
    const longPdfView: ReaderView = { ...pdfView, page_count: 6 };
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(page_index0 === 0 ? "" : ""),
    );
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo(6));
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [{ text: "OCR current page", bbox: { left: 0.1, top: 0.1, width: 0.4, height: 0.03 }, confidence: 95 }],
    });

    render(
      <PdfContinuousReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        page={0}
        view={longPdfView}
        zoom={100}
      />,
    );

    await waitFor(() => expect(ocrPdfPage).toHaveBeenCalledTimes(1));
    expect(ocrPdfPage).toHaveBeenCalledWith(expect.objectContaining({ page_index0: 0 }));
  });

  it("activates persisted highlights with annotation ids", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle("Hello world"));
    const getPdfDocumentInfo = vi.fn().mockResolvedValue(makeDocumentInfo());
    const getPdfPageText = vi.fn().mockResolvedValue({ page_index0: 0, spans: [] });
    const ocrPdfPage = vi.fn().mockResolvedValue({
      primary_attachment_id: 101,
      page_index0: 0,
      lang: "eng+chi_sim",
      config_version: "test",
      lines: [],
    });
    const onHighlightActivate = vi.fn();

    render(
      <PdfContinuousReader
        annotations={[
          {
            id: 12,
            item_id: pdfView.item_id,
            kind: "highlight",
            body: "",
            anchor: JSON.stringify({
              type: "pdf_text",
              page: 1,
              startDivIndex: 0,
              startOffset: 0,
              endDivIndex: 0,
              endOffset: 5,
              quote: "Hello",
              color: "yellow",
            }),
          },
        ]}
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        getPdfPageText={getPdfPageText}
        ocrPdfPage={ocrPdfPage}
        onHighlightActivate={onHighlightActivate}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".pdf-annotation-highlight")).toBeTruthy();
    });
    const highlight = document.querySelector(".pdf-annotation-highlight") as HTMLElement;
    expect(highlight.dataset.annotationId).toBe("12");
    fireEvent.click(highlight);
    expect(onHighlightActivate).toHaveBeenCalledWith({
      annotationId: 12,
      rect: expect.objectContaining({
        left: expect.any(Number),
        top: expect.any(Number),
        right: expect.any(Number),
        bottom: expect.any(Number),
      }),
    });
  });

});
