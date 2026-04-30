import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReaderView } from "../../lib/contracts";
import { PdfReader } from "./PdfReader";

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

const makeBundle = (text = "Hello world") => ({
  png_bytes: new Uint8Array([137, 80, 78, 71]),
  width_px: 800,
  height_px: 1000,
  page_width_pt: 600,
  page_height_pt: 750,
  spans: [{ text, x0: 10, y0: 700, x1: 200, y1: 720 }],
});

const getPdfDocumentInfo = vi.fn().mockResolvedValue({
  page_count: 3,
  pages: [
    { width_pt: 600, height_pt: 750 },
    { width_pt: 600, height_pt: 750 },
    { width_pt: 600, height_pt: 750 },
  ],
});

describe("PdfReader", () => {
  beforeEach(() => {
    if (!("createObjectURL" in URL)) {
      Object.defineProperty(URL, "createObjectURL", { value: () => "blob:pdf-page", writable: true });
    }
    if (!("revokeObjectURL" in URL)) {
      Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf-page");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the Rust-backed page image and text layer", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle());

    render(
      <PdfReader
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(getPdfPageBundle).toHaveBeenCalledWith({
        primary_attachment_id: 101,
        page_index0: 0,
        target_width_px: expect.any(Number),
      });
    });

    expect(screen.getByLabelText("PDF page image")).toBeInTheDocument();
    const textLayer = screen.getByLabelText("PDF text layer");
    expect(textLayer.querySelector(".endOfContent")).toBeTruthy();
    expect(textLayer.textContent).toContain("Hello world");
  });

  it("reports search matches from Rust text spans", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle("Alpha beta alpha"));
    const onSearchMatchesChange = vi.fn();

    render(
      <PdfReader
        getPdfPageBundle={getPdfPageBundle}
        getPdfDocumentInfo={getPdfDocumentInfo}
        page={0}
        searchQuery="alpha"
        view={pdfView}
        zoom={100}
        onSearchMatchesChange={onSearchMatchesChange}
      />,
    );

    await waitFor(() => {
      expect(onSearchMatchesChange).toHaveBeenLastCalledWith({ total: 2, activeIndex: 0 });
    });
    expect(document.querySelectorAll(".pdf-search-hit").length).toBeGreaterThan(0);
  });

  it("renders persisted highlight anchors on top of Rust spans", async () => {
    const getPdfPageBundle = vi.fn().mockResolvedValue(makeBundle("Hello world"));
    const onHighlightActivate = vi.fn();
    const highlightAnchor = JSON.stringify({
      type: "pdf_text",
      page: 1,
      startDivIndex: 0,
      startOffset: 0,
      endDivIndex: 0,
      endOffset: 5,
      quote: "Hello",
      color: "yellow",
    });

    render(
      <PdfReader
        annotations={[
          {
            id: 7,
            item_id: pdfView.item_id,
            kind: "highlight",
            body: "",
            anchor: highlightAnchor,
          },
        ]}
        getPdfDocumentInfo={getPdfDocumentInfo}
        getPdfPageBundle={getPdfPageBundle}
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
    expect(highlight.dataset.annotationId).toBe("7");

    fireEvent.click(highlight);
    expect(onHighlightActivate).toHaveBeenCalledWith({
      annotationId: 7,
      rect: expect.objectContaining({
        left: expect.any(Number),
        top: expect.any(Number),
        right: expect.any(Number),
        bottom: expect.any(Number),
      }),
    });
  });
});
