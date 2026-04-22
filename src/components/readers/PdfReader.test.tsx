import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PdfReader } from "./PdfReader";
import type { ReaderView } from "../../lib/contracts";

const {
  getDocumentMock,
  convertFileSrcMock,
  getPageMock,
  renderMock,
} = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
  getPageMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: getDocumentMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: convertFileSrcMock,
}));

const pdfView: ReaderView = {
  item_id: 1,
  title: "Native PDF Paper",
  reader_kind: "pdf",
  attachment_format: "pdf",
  primary_attachment_id: 101,
  primary_attachment_path: "/mock/native-pdf-paper.pdf",
  page_count: null,
  normalized_html: "<article><p>Fallback</p></article>",
  plain_text: "PDF preview",
};

describe("PdfReader", () => {
  beforeEach(() => {
    getDocumentMock.mockReset();
    getPageMock.mockReset();
    renderMock.mockReset();
    convertFileSrcMock.mockClear();

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({}) as CanvasRenderingContext2D,
    );
  });

  it("loads the local pdf through tauri asset conversion and renders a canvas", async () => {
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

    render(<PdfReader view={pdfView} page={0} zoom={100} />);

    await waitFor(() => {
      expect(convertFileSrcMock).toHaveBeenCalledWith("/mock/native-pdf-paper.pdf");
      expect(getDocumentMock).toHaveBeenCalled();
      expect(getPageMock).toHaveBeenCalledWith(1);
      expect(renderMock).toHaveBeenCalled();
    });

    expect(screen.getByLabelText("PDF page canvas")).toBeInTheDocument();
    expect(screen.getByText(/Page 1 of 4/i)).toBeInTheDocument();
  });

  it("shows a reader error when pdf loading fails", async () => {
    getDocumentMock.mockReturnValue({
      promise: Promise.reject(new Error("load failed")),
    });

    render(<PdfReader view={pdfView} page={0} zoom={100} />);

    expect(await screen.findByText(/Unable to load this PDF/i)).toBeInTheDocument();
  });
});
