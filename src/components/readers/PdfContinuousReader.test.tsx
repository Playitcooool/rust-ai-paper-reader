import { cleanup, render, waitFor } from "@testing-library/react";
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
  spans: [{ text, x0: 10, y0: 700, x1: 200, y1: 720 }],
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
    if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
      HTMLElement.prototype.scrollIntoView = (() => {}) as unknown as typeof HTMLElement.prototype.scrollIntoView;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IntersectionObserver = class IntersectionObserverMock {
      #callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.#callback = callback;
      }
      observe = (target: Element) => {
        this.#callback(
          [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).IntersectionObserver;
  });

  it("renders page shells for all pages and keeps controlled page changes stable", async () => {
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(`Page ${page_index0 + 1}`),
    );

    const { rerender, container } = render(
      <PdfContinuousReader getPdfPageBundle={getPdfPageBundle} page={0} view={pdfView} zoom={100} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".pdf-page-shell")).toHaveLength(3);
    });

    rerender(<PdfContinuousReader getPdfPageBundle={getPdfPageBundle} page={2} view={pdfView} zoom={100} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".pdf-page-shell")).toHaveLength(3);
    });
  });

  it("reports search matches across rendered pages", async () => {
    const getPdfPageBundle = vi.fn().mockImplementation(async ({ page_index0 }: { page_index0: number }) =>
      makeBundle(page_index0 === 1 ? "needle here" : "no match"),
    );
    const onSearchMatchesChange = vi.fn();

    render(
      <PdfContinuousReader
        getPdfPageBundle={getPdfPageBundle}
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
});
