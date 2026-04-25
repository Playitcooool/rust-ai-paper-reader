import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("hides reader chrome when rendered in focus mode", async () => {
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
        mode="focus"
        page={0}
        view={pdfView}
        zoom={100}
      />,
    );

    await waitFor(() => {
      expect(loadPrimaryAttachmentBytes).toHaveBeenCalledWith(101);
      expect(renderMock).toHaveBeenCalled();
    });

    expect(screen.getByLabelText("PDF page canvas")).toBeInTheDocument();
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

    renderMock
      .mockReturnValueOnce({ promise: firstRender.promise, cancel: cancelFirstRender })
      .mockReturnValueOnce({ promise: secondRender.promise, cancel: cancelSecondRender });
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
      expect(renderMock).toHaveBeenCalledTimes(1);
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
      expect(renderMock).toHaveBeenCalledTimes(2);
    });

    secondRender.resolve();

    expect(cancelSecondRender).not.toHaveBeenCalled();
  });

  it("does not reload or rerender only because onPageCountChange gets a new identity", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const onPageCountChange = vi.fn();

    renderMock.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
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
      expect(renderMock).toHaveBeenCalledTimes(1);
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
      expect(getDocumentMock).toHaveBeenCalledTimes(1);
      expect(renderMock).toHaveBeenCalledTimes(1);
    });
  });

  it("treats cancelled renders as normal control flow instead of a user-visible error", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const loadPrimaryAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const renderDeferred = createDeferred<void>();
    const cancelRender = vi.fn(() => {
      renderDeferred.reject(new Error("RenderingCancelledException"));
    });

    renderMock.mockReturnValue({ promise: renderDeferred.promise, cancel: cancelRender });
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
      expect(renderMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    await waitFor(() => {
      expect(cancelRender).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText(/RenderingCancelledException/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unable to load this PDF/i)).not.toBeInTheDocument();
  });
});
