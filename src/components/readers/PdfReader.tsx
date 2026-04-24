import { useEffect, useRef, useState } from "react";

import type { ReaderView } from "../../lib/contracts";

type PdfReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  loadPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  onPageCountChange?: (pageCount: number) => void;
};

export function PdfReader({
  view,
  page,
  zoom,
  loadPrimaryAttachmentBytes,
  onPageCountChange,
}: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageCount, setPageCount] = useState(view.page_count);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

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

      setStatus("loading");
      setErrorMessage("");

      try {
        const [pdfjsModule, workerModule] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        pdfjsModule.GlobalWorkerOptions.workerSrc = workerModule.default;

        const bytes = await loadPrimaryAttachmentBytes(view.primary_attachment_id);
        const pdfDocument = await pdfjsModule.getDocument({ data: bytes }).promise;
        if (cancelled) return;

        const nextPageCount = pdfDocument.numPages ?? view.page_count ?? 1;
        setPageCount(nextPageCount);
        onPageCountChange?.(nextPageCount);

        const currentPage = await pdfDocument.getPage(Math.min(page + 1, nextPageCount));
        if (cancelled) return;

        const viewport = currentPage.getViewport({ scale: zoom / 100 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await currentPage.render({
          canvas,
          canvasContext: context,
          viewport,
        }).promise;

        if (cancelled) return;
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Unknown PDF rendering error.",
        );
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
    };
  }, [loadPrimaryAttachmentBytes, onPageCountChange, page, view.page_count, view.primary_attachment_id, zoom]);

  return (
    <section className="pdf-reader" data-testid="pdf-reader">
      <div className="reader-location-bar">
        <span className="status-pill">PDF mode</span>
        <span className="meta-count">
          {view.primary_attachment_path ? view.primary_attachment_path.split("/").pop() : "No attachment path"}
        </span>
        <span className="meta-count">Zoom {zoom}%</span>
      </div>
      <div className="citation-card">
        <p className="eyebrow">Native PDF Reader</p>
        <h3>{view.title}</h3>
        <p>
          Page {page + 1}
          {pageCount ? ` of ${pageCount}` : ""}
        </p>
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
