import { useEffect, useRef, useState } from "react";

import type { ReaderView } from "../../lib/contracts";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";

type PdfReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  mode?: "workspace" | "focus";
  loadPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  onPageCountChange?: (pageCount: number) => void;
};

export function PdfReader({
  view,
  page,
  zoom,
  mode = "workspace",
  loadPrimaryAttachmentBytes,
  onPageCountChange,
}: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const onPageCountChangeRef = useRef(onPageCountChange);
  const [pageCount, setPageCount] = useState(view.page_count);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    let cancelled = false;

    const cancelActiveWork = async () => {
      const activeRenderTask = renderTaskRef.current;
      renderTaskRef.current = null;
      activeRenderTask?.cancel();

      const activeLoadingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      const activeDocument = pdfDocumentRef.current;
      pdfDocumentRef.current = null;

      await Promise.allSettled([
        activeLoadingTask?.destroy(),
        typeof activeDocument?.destroy === "function" ? activeDocument.destroy() : undefined,
      ]);
    };

    const isCancellationError = (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return (
        error.name === "RenderingCancelledException" ||
        error.name === "AbortException" ||
        /cancel|abort/i.test(error.name) ||
        /cancel|abort/i.test(error.message)
      );
    };

    async function renderPage() {
      if (!view.primary_attachment_id) {
        setStatus("error");
        setErrorMessage("Unable to load this PDF because the primary attachment id is missing.");
        return;
      }

      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) {
        setStatus("error");
        setErrorMessage("Unable to load this PDF because the canvas is unavailable.");
        return;
      }

      await cancelActiveWork();
      if (cancelled) return;

      setStatus("loading");
      setErrorMessage("");
      setPageCount(view.page_count);

      try {
        const [pdfjsModule, workerModule] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        pdfjsModule.GlobalWorkerOptions.workerSrc = workerModule.default;

        const bytes = await loadPrimaryAttachmentBytes(view.primary_attachment_id);
        if (cancelled) return;

        const loadingTask = pdfjsModule.getDocument({ data: bytes });
        loadingTaskRef.current = loadingTask;

        const pdfDocument = await loadingTask.promise;
        if (cancelled) return;
        if (loadingTaskRef.current !== loadingTask) {
          await pdfDocument.destroy();
          return;
        }

        loadingTaskRef.current = null;
        pdfDocumentRef.current = pdfDocument;

        const nextPageCount = pdfDocument.numPages ?? view.page_count ?? 1;
        setPageCount(nextPageCount);
        onPageCountChangeRef.current?.(nextPageCount);

        const currentPage = await pdfDocument.getPage(Math.min(page + 1, nextPageCount));
        if (cancelled) return;

        const viewport = currentPage.getViewport({ scale: zoom / 100 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderTask = currentPage.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (cancelled) return;
        if (renderTaskRef.current !== renderTask) return;
        renderTaskRef.current = null;
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        if (isCancellationError(error)) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Unknown PDF rendering error.",
        );
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      void cancelActiveWork();
    };
  }, [loadPrimaryAttachmentBytes, page, view.page_count, view.primary_attachment_id, zoom]);

  const showChrome = mode === "workspace";

  return (
    <section
      className={`pdf-reader ${showChrome ? "pdf-reader-workspace" : "pdf-reader-focus"}`}
      data-testid="pdf-reader"
    >
      {showChrome ? (
        <div className="reader-location-bar">
          <span className="status-pill">PDF mode</span>
          <span className="meta-count">
            {view.primary_attachment_path
              ? view.primary_attachment_path.split("/").pop()
              : "No attachment path"}
          </span>
          <span className="meta-count">Zoom {zoom}%</span>
        </div>
      ) : null}

      <div className={showChrome ? "citation-card" : "pdf-stage"}>
        {showChrome ? (
          <>
            <p className="eyebrow">Native PDF Reader</p>
            <h3>{view.title}</h3>
            <p>
              Page {page + 1}
              {pageCount ? ` of ${pageCount}` : ""}
            </p>
          </>
        ) : null}

        {status === "loading" ? <p>Loading PDF page...</p> : null}
        {status === "error" ? <p>Unable to load this PDF. {errorMessage}</p> : null}

        <canvas
          aria-label="PDF page canvas"
          ref={canvasRef}
          style={{
            display: status === "error" ? "none" : "block",
            maxWidth: "100%",
          }}
        />
      </div>
    </section>
  );
}
