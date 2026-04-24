import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PdfReader } from "./PdfReader";
import type { ReaderView } from "../../lib/contracts";

const { getDocumentMock, getPageMock, renderMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
  getPageMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: getDocumentMock,
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

describe("PdfReader", () => {
  beforeEach(() => {
    getDocumentMock.mockReset();
    getPageMock.mockReset();
    renderMock.mockReset();

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({}) as CanvasRenderingContext2D,
    );
  });

  it("loads bytes through the injected attachment loader and passes them to pdf.js", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);

    renderMock.mockReturnValue({ promise: Promise.resolve() });
    getPageMock.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
      }),
      render: renderMock,
    });
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 4,
        getPage: getPageMock,
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
      expect(getDocumentMock).toHaveBeenCalledWith({ data: bytes });
      expect(getPageMock).toHaveBeenCalledWith(1);
      expect(renderMock).toHaveBeenCalled();
    });

    expect(screen.getByLabelText("PDF page canvas")).toBeInTheDocument();
    expect(screen.getByText(/native-pdf-paper\.pdf/i)).toBeInTheDocument();
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
});
