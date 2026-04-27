import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-shell";

import { getLegacyDocumentMock } from "../../test/pdfjsLegacyMock";
import { PdfContinuousReader } from "./PdfContinuousReader";
import type { ReaderView } from "../../lib/contracts";

const { getLegacyPageMock, legacyRenderMock } = vi.hoisted(() => ({
  getLegacyPageMock: vi.fn(),
  legacyRenderMock: vi.fn(),
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

describe("PdfContinuousReader", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).IntersectionObserver;
  });

  beforeEach(() => {
    getLegacyDocumentMock.mockReset();
    getLegacyPageMock.mockReset();
    legacyRenderMock.mockReset();

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({}) as CanvasRenderingContext2D,
    );

    // IntersectionObserver isn't implemented in jsdom; provide a minimal mock.
    // Only auto-intersect the "lazy render" observer (threshold ~0.01).
    // The "dominant page" observer uses thresholds around 0.55/0.7; keep it quiet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IntersectionObserver = class IntersectionObserverMock {
      #callback: IntersectionObserverCallback;
      #options: IntersectionObserverInit | undefined;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.#callback = callback;
        this.#options = options;
      }
      observe = (target: Element) => {
        const threshold = this.#options?.threshold;
        const isDominant =
          Array.isArray(threshold) && threshold.some((value) => Number(value) >= 0.55);
        if (isDominant) return;
        this.#callback(
          [
            {
              target,
              isIntersecting: true,
              intersectionRatio: 1,
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
      };
      unobserve = () => {};
      disconnect = () => {};
      takeRecords = () => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    };
  });

  it("renders page shells and scrolls when the controlled page changes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    getLegacyPageMock.mockImplementation(async (pageNumber: number) => ({
      getViewport: ({ scale }: { scale: number }) => {
        const width = 800 * scale;
        const height = 1000 * scale;
        return {
          width,
          height,
          convertToViewportRectangle: (rect: number[]) => rect,
          clone: () => ({ width, height, clone: () => ({ width, height }) }),
        };
      },
      getTextContent: () => Promise.resolve({ items: [{ str: `Page ${pageNumber}` }], styles: {} }),
      getAnnotations: () => Promise.resolve([]),
      render: legacyRenderMock,
    }));

    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage: getLegacyPageMock,
        destroy: vi.fn(),
      }),
      destroy: vi.fn(),
    });

    const scrolled: string[] = [];
    if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
      HTMLElement.prototype.scrollIntoView = (() => {}) as unknown as typeof HTMLElement.prototype.scrollIntoView;
    }
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      const element = this;
      const index = element.dataset.pageIndex;
      if (index) scrolled.push(index);
    });

    const { rerender } = render(
      <PdfContinuousReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(document.querySelectorAll(".pdf-page-shell")).toHaveLength(3);
    });

    const textLayer = screen.getByLabelText("PDF page 1 text layer");
    expect(textLayer).toHaveClass("pdf-text-layer");
    expect(textLayer).toHaveClass("textLayer");
    expect(textLayer.querySelector(".endOfContent")).toBeTruthy();
    expect((screen.getByLabelText("PDF page 1 canvas") as HTMLCanvasElement).style.maxWidth).toBe("");

    rerender(
      <PdfContinuousReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        page={2}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(scrolled[scrolled.length - 1]).toBe("2");
    });
  });

  it("renders an external link overlay and opens it via the Tauri shell (http/https only)", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    getLegacyPageMock.mockImplementation(async (pageNumber: number) => ({
      getViewport: ({ scale }: { scale: number }) => {
        const width = 800 * scale;
        const height = 1000 * scale;
        return {
          width,
          height,
          convertToViewportRectangle: (rect: number[]) => rect,
          clone: () => ({ width, height, clone: () => ({ width, height }) }),
        };
      },
      getTextContent: () => Promise.resolve({ items: [{ str: `Page ${pageNumber}` }], styles: {} }),
      getAnnotations: () =>
        Promise.resolve([{ subtype: "Link", url: "https://example.com/continuous", rect: [10, 10, 110, 30] }]),
      render: legacyRenderMock,
    }));

    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
        destroy: vi.fn(),
      }),
      destroy: vi.fn(),
    });

    render(
      <PdfContinuousReader loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes} page={0} view={pdfView} zoom={100} />,
    );

    const link = await screen.findByTestId("external-link");
    fireEvent.click(link);

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith("https://example.com/continuous");
    });
  });

  it("resolves internal PDF destinations and calls onNavigateToPage", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const onNavigateToPage = vi.fn();

    const ref = { num: 9, gen: 0 };
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
        getDestination: vi.fn(async () => [ref, { name: "XYZ" }, 0, 0, null]),
        getPageIndex: vi.fn(async () => 7),
        destroy: vi.fn(),
      }),
      destroy: vi.fn(),
    });

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => {
        const width = 800 * scale;
        const height = 1000 * scale;
        return {
          width,
          height,
          convertToViewportRectangle: (rect: number[]) => rect,
          clone: () => ({ width, height, clone: () => ({ width, height }) }),
        };
      },
      getTextContent: () => Promise.resolve({ items: [{ str: "Link page" }], styles: {} }),
      getAnnotations: () =>
        Promise.resolve([{ subtype: "Link", dest: "bib", rect: [10, 10, 110, 30] }]),
      render: legacyRenderMock,
    });

    render(
      <PdfContinuousReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        onNavigateToPage={onNavigateToPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    const link = await screen.findByTestId("internal-link");
    fireEvent.click(link);

    await waitFor(() => {
      expect(onNavigateToPage).toHaveBeenCalledWith(7);
    });
  });

  it("treats numeric PDF destinations as 0-based page indexes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const onNavigateToPage = vi.fn();

    const getPageIndex = vi.fn();
    getLegacyDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getLegacyPageMock,
        getDestination: vi.fn(async () => [1, { name: "XYZ" }, 0, 0, null]),
        getPageIndex,
        destroy: vi.fn(),
      }),
      destroy: vi.fn(),
    });

    legacyRenderMock.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    getLegacyPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => {
        const width = 800 * scale;
        const height = 1000 * scale;
        return {
          width,
          height,
          convertToViewportRectangle: (rect: number[]) => rect,
          clone: () => ({ width, height, clone: () => ({ width, height }) }),
        };
      },
      getTextContent: () => Promise.resolve({ items: [{ str: "Numeric destination page" }], styles: {} }),
      getAnnotations: () =>
        Promise.resolve([{ subtype: "Link", dest: "numeric", rect: [10, 10, 110, 30] }]),
      render: legacyRenderMock,
    });

    render(
      <PdfContinuousReader
        loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
        onNavigateToPage={onNavigateToPage}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    const link = await screen.findByTestId("internal-link");
    fireEvent.click(link);

    await waitFor(() => {
      expect(onNavigateToPage).toHaveBeenCalledWith(1);
    });
    expect(getPageIndex).not.toHaveBeenCalled();
  });
});
