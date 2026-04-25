import { useEffect, useMemo, useRef, useState } from "react";

import type { Annotation, ReaderView } from "../../lib/contracts";
import { clearChildren, safeScrollIntoView } from "../../lib/dom";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { TextLayer } from "pdfjs-dist/types/src/display/text_layer";

type PdfTextAnchor = {
  type: "pdf_text";
  page: number; // 1-based
  startDivIndex: number;
  startOffset: number;
  endDivIndex: number;
  endOffset: number;
  quote: string;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const parsePdfTextAnchor = (anchor: string): PdfTextAnchor | null => {
  try {
    const parsed = JSON.parse(anchor) as Partial<PdfTextAnchor>;
    if (parsed.type !== "pdf_text") return null;
    if (typeof parsed.page !== "number") return null;
    if (typeof parsed.startDivIndex !== "number") return null;
    if (typeof parsed.startOffset !== "number") return null;
    if (typeof parsed.endDivIndex !== "number") return null;
    if (typeof parsed.endOffset !== "number") return null;
    if (typeof parsed.quote !== "string") return null;
    return parsed as PdfTextAnchor;
  } catch {
    return null;
  }
};

type PdfReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  mode?: "workspace" | "focus";
  loadPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  onPageCountChange?: (pageCount: number) => void;
  searchQuery?: string;
  activeSearchMatchIndex?: number;
  annotations?: Annotation[];
  onSelectionChange?: (selection: { anchor: string; quote: string } | null) => void;
  onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
};

export function PdfReader({
  view,
  page,
  zoom,
  mode = "workspace",
  loadPrimaryAttachmentBytes,
  onPageCountChange,
  searchQuery = "",
  activeSearchMatchIndex = 0,
  annotations = [],
  onSelectionChange,
  onSearchMatchesChange,
}: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerHostRef = useRef<HTMLDivElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const textDivsRef = useRef<HTMLElement[]>([]);
  const textDivStringsRef = useRef<string[]>([]);
  const onPageCountChangeRef = useRef(onPageCountChange);
  const [pageCount, setPageCount] = useState(view.page_count);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  const textEnabled = view.content_status === "ready";
  const loweredSearch = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);

  const isCancellationError = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    return (
      error.name === "RenderingCancelledException" ||
      error.name === "AbortException" ||
      /cancel|abort/i.test(error.name) ||
      /cancel|abort/i.test(error.message)
    );
  };

  const cancelRenderWork = () => {
    const activeRenderTask = renderTaskRef.current;
    renderTaskRef.current = null;
    activeRenderTask?.cancel();

    const activeTextLayer = textLayerRef.current;
    textLayerRef.current = null;
    activeTextLayer?.cancel();
    textDivsRef.current = [];
    textDivStringsRef.current = [];
    if (textLayerHostRef.current) {
      clearChildren(textLayerHostRef.current);
    }
  };

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    let cancelled = false;

    const destroyActiveDocument = async () => {
      cancelRenderWork();

      const activeLoadingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      const activeDocument = pdfDocumentRef.current;
      pdfDocumentRef.current = null;
      setPdfDocument(null);

      await Promise.allSettled([
        activeLoadingTask?.destroy(),
        typeof activeDocument?.destroy === "function" ? activeDocument.destroy() : undefined,
      ]);
    };

    async function loadDocument() {
      if (!view.primary_attachment_id) {
        setStatus("error");
        setErrorMessage("Unable to load this PDF because the primary attachment id is missing.");
        setPdfDocument(null);
        return;
      }

      await destroyActiveDocument();
      if (cancelled) return;

      setStatus("loading");
      setErrorMessage("");
      setPageCount(view.page_count);

      try {
        const [pdfjsModule, workerModule] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
        ]);
        pdfjsModule.GlobalWorkerOptions.workerSrc = workerModule.default;

        const bytes = await loadPrimaryAttachmentBytes(view.primary_attachment_id);
        if (cancelled) return;

        const loadingTask = pdfjsModule.getDocument({ data: bytes });
        loadingTaskRef.current = loadingTask;

        const pdfDocument = await loadingTask.promise;
        if (cancelled) {
          await pdfDocument.destroy();
          return;
        }
        if (loadingTaskRef.current !== loadingTask) {
          await pdfDocument.destroy();
          return;
        }

        loadingTaskRef.current = null;
        pdfDocumentRef.current = pdfDocument;
        setPdfDocument(pdfDocument);

        const nextPageCount = pdfDocument.numPages ?? view.page_count ?? 1;
        setPageCount(nextPageCount);
        onPageCountChangeRef.current?.(nextPageCount);
      } catch (error) {
        if (cancelled) return;
        if (isCancellationError(error)) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Unknown PDF rendering error.",
        );
      }
    }

    void loadDocument();

    return () => {
      cancelled = true;
      void destroyActiveDocument();
    };
  }, [
    loadPrimaryAttachmentBytes,
    view.page_count,
    view.primary_attachment_id,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      const currentDocument = pdfDocumentRef.current;
      if (!currentDocument) return;
      if (pdfDocument !== currentDocument) return;

      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const textLayerHost = textLayerHostRef.current;
      if (!canvas || !context) {
        setStatus("error");
        setErrorMessage("Unable to load this PDF because the canvas is unavailable.");
        return;
      }
      if (!textLayerHost) {
        setStatus("error");
        setErrorMessage("Unable to load this PDF because the text layer container is unavailable.");
        return;
      }

      cancelRenderWork();
      if (cancelled) return;

      setStatus("loading");
      setErrorMessage("");

      try {
        const pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const nextPageCount = currentDocument.numPages ?? view.page_count ?? 1;

        const currentPage = await currentDocument.getPage(Math.min(page + 1, nextPageCount));
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

        // Text layer is optional. Some WKWebView builds are missing modern web APIs
        // that pdf.js uses internally; keep the page visible even if text fails.
        if (textEnabled) {
          try {
            clearChildren(textLayerHost);
            const textContent = await currentPage.getTextContent();
            if (cancelled) return;

            const textLayer = new pdfjsModule.TextLayer({
              textContentSource: textContent,
              container: textLayerHost,
              viewport,
            }) as TextLayer;
            textLayerRef.current = textLayer;

            await textLayer.render();
            if (cancelled) return;
            if (textLayerRef.current !== textLayer) return;

            // Attach stable indices so we can serialize selections into anchors.
            textDivsRef.current = textLayer.textDivs as unknown as HTMLElement[];
            textDivStringsRef.current = textLayer.textContentItemsStr.slice();
            textDivsRef.current.forEach((div, index) => {
              div.dataset.divIndex = String(index);
            });
          } catch (error) {
            if (cancelled) return;
            if (isCancellationError(error)) return;
            // Non-fatal: keep the canvas, just disable text/search/highlights.
            textLayerRef.current = null;
            textDivsRef.current = [];
            textDivStringsRef.current = [];
            if (textLayerHostRef.current) clearChildren(textLayerHostRef.current);
            // Best effort logging for debugging old WebKit builds.
            // eslint-disable-next-line no-console
            console.warn("PDF text layer unavailable:", error);
          }
        }
      } catch (error) {
        if (cancelled) return;
        if (isCancellationError(error)) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unknown PDF rendering error.");
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      cancelRenderWork();
    };
  }, [page, pdfDocument, textEnabled, view.page_count, zoom]);

  const searchMatches = useMemo(() => {
    if (!textEnabled) return [];
    if (loweredSearch.length === 0) return [];
    const matches: Array<{ divIndex: number; start: number; end: number }> = [];
    const divStrings = textDivStringsRef.current;
    for (let divIndex = 0; divIndex < divStrings.length; divIndex += 1) {
      const text = divStrings[divIndex] ?? "";
      const lowered = text.toLowerCase();
      let cursor = 0;
      while (cursor < lowered.length) {
        const index = lowered.indexOf(loweredSearch, cursor);
        if (index === -1) break;
        matches.push({ divIndex, start: index, end: index + loweredSearch.length });
        cursor = index + Math.max(1, loweredSearch.length);
      }
    }
    return matches;
  }, [loweredSearch, textEnabled, status, page, zoom, view.primary_attachment_id]);

  useEffect(() => {
    if (!onSearchMatchesChange) return;
    if (!textEnabled || status !== "ready" || loweredSearch.length === 0) {
      onSearchMatchesChange({ total: 0, activeIndex: -1 });
      return;
    }
    const total = searchMatches.length;
    const normalized =
      total > 0 ? ((activeSearchMatchIndex % total) + total) % total : -1;
    onSearchMatchesChange({ total, activeIndex: normalized });
  }, [activeSearchMatchIndex, loweredSearch, onSearchMatchesChange, searchMatches.length, status, textEnabled]);

  const anchorsForPage = useMemo(() => {
    if (!textEnabled) return [];
    const pageNumber = page + 1;
    const decoded = annotations
      .map((annotation) => ({ annotation, anchor: parsePdfTextAnchor(annotation.anchor) }))
      .filter((entry) => entry.anchor && entry.anchor.page === pageNumber && entry.annotation.kind === "highlight")
      .map((entry) => entry.anchor as PdfTextAnchor);
    return decoded;
  }, [annotations, page, textEnabled]);

  useEffect(() => {
    if (!textEnabled) return;
    if (status !== "ready") return;
    const divs = textDivsRef.current;
    const plain = textDivStringsRef.current;
    if (divs.length === 0 || plain.length === 0) return;

    // Build per-div highlight ranges for annotations.
    const annotationRangesByDiv = new Map<number, Array<{ start: number; end: number }>>();
    for (const anchor of anchorsForPage) {
      const startDiv = Math.max(0, Math.min(anchor.startDivIndex, divs.length - 1));
      const endDiv = Math.max(0, Math.min(anchor.endDivIndex, divs.length - 1));
      const fromDiv = Math.min(startDiv, endDiv);
      const toDiv = Math.max(startDiv, endDiv);

      for (let divIndex = fromDiv; divIndex <= toDiv; divIndex += 1) {
        const text = plain[divIndex] ?? "";
        const len = text.length;
        const start = divIndex === startDiv ? Math.max(0, Math.min(anchor.startOffset, len)) : 0;
        const end = divIndex === endDiv ? Math.max(0, Math.min(anchor.endOffset, len)) : len;
        if (end <= start) continue;
        const current = annotationRangesByDiv.get(divIndex) ?? [];
        current.push({ start, end });
        annotationRangesByDiv.set(divIndex, current);
      }
    }

    const mergeRanges = (ranges: Array<{ start: number; end: number }>) => {
      const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
      const merged: Array<{ start: number; end: number }> = [];
      for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (!last || range.start > last.end) {
          merged.push({ start: range.start, end: range.end });
          continue;
        }
        last.end = Math.max(last.end, range.end);
      }
      return merged;
    };

    const overlaps = (range: { start: number; end: number }, block: { start: number; end: number }) =>
      range.start < block.end && block.start < range.end;

    const totalMatches = searchMatches.length;
    const normalizedActive =
      totalMatches > 0 ? ((activeSearchMatchIndex % totalMatches) + totalMatches) % totalMatches : -1;

    // Apply decorations div-by-div, always starting from the pdf.js-provided plain text.
    for (let divIndex = 0; divIndex < divs.length; divIndex += 1) {
      const div = divs[divIndex];
      const text = plain[divIndex] ?? "";
      const annotationRanges = mergeRanges(annotationRangesByDiv.get(divIndex) ?? []);

      const searchRanges: Array<{ start: number; end: number; hitIndex: number }> = [];
      if (searchMatches.length > 0) {
        for (let hitIndex = 0; hitIndex < searchMatches.length; hitIndex += 1) {
          const match = searchMatches[hitIndex];
          if (match.divIndex !== divIndex) continue;
          const range = { start: match.start, end: match.end };
          if (annotationRanges.some((block) => overlaps(range, block))) continue;
          searchRanges.push({ ...range, hitIndex });
        }
      }
      const mergedSearch = mergeRanges(searchRanges).map((range) => {
        const first = searchRanges.find((hit) => hit.start === range.start && hit.end === range.end);
        return { ...range, hitIndex: first?.hitIndex ?? -1 };
      });

      const segments: Array<
        | { kind: "text"; value: string }
        | { kind: "annotation"; value: string }
        | { kind: "search"; value: string; hitIndex: number }
      > = [];

      const pushText = (value: string) => {
        if (value.length > 0) segments.push({ kind: "text", value });
      };

      const all = [
        ...annotationRanges.map((range) => ({ ...range, kind: "annotation" as const })),
        ...mergedSearch.map((range) => ({ ...range, kind: "search" as const })),
      ].sort((a, b) => a.start - b.start || a.end - b.end);

      let cursor = 0;
      for (const range of all) {
        if (range.start > cursor) pushText(text.slice(cursor, range.start));
        const slice = text.slice(range.start, range.end);
        if (slice.length === 0) continue;
        if (range.kind === "annotation") {
          segments.push({ kind: "annotation", value: slice });
        } else {
          segments.push({
            kind: "search",
            value: slice,
            hitIndex: (range as { hitIndex: number }).hitIndex,
          });
        }
        cursor = range.end;
      }
      if (cursor < text.length) pushText(text.slice(cursor));

      div.innerHTML = segments
        .map((segment) => {
          if (segment.kind === "text") return escapeHtml(segment.value);
          if (segment.kind === "annotation") {
            return `<span class="pdf-annotation-highlight">${escapeHtml(segment.value)}</span>`;
          }
          const active = segment.hitIndex === normalizedActive ? " pdf-search-hit-active" : "";
          const attr = segment.hitIndex >= 0 ? ` data-hit-index="${segment.hitIndex}"` : "";
          return `<span class="pdf-search-hit${active}"${attr}>${escapeHtml(segment.value)}</span>`;
        })
        .join("");
    }

    // Scroll the active match into view.
    if (normalizedActive >= 0) {
      const active = textLayerHostRef.current?.querySelector(
        `.pdf-search-hit[data-hit-index="${normalizedActive}"]`,
      ) as HTMLElement | null;
      if (active) safeScrollIntoView(active, { block: "center" });
    }
  }, [
    activeSearchMatchIndex,
    anchorsForPage,
    loweredSearch,
    searchMatches,
    status,
    textEnabled,
  ]);

  const offsetWithinDiv = (div: HTMLElement, container: Node, offset: number) => {
    if (!div.contains(container)) return 0;
    if (container.nodeType === Node.TEXT_NODE) {
      // Fast path: sum lengths of text nodes until we hit the container.
      const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      let length = 0;
      while (node) {
        if (node === container) return length + offset;
        length += (node.nodeValue ?? "").length;
        node = walker.nextNode();
      }
    }
    return offset;
  };

  const buildSelectionAnchor = (): { anchor: string; quote: string } | null => {
    if (!textEnabled) return null;
    const host = textLayerHostRef.current;
    if (!host) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    const quote = selection.toString();
    if (!quote || quote.trim().length === 0) return null;

    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;

    const divs = textDivsRef.current;
    const startDivIndex = divs.findIndex((div) => div.contains(range.startContainer));
    const endDivIndex = divs.findIndex((div) => div.contains(range.endContainer));
    if (startDivIndex < 0 || endDivIndex < 0) return null;

    const startOffset = offsetWithinDiv(divs[startDivIndex], range.startContainer, range.startOffset);
    const endOffset = offsetWithinDiv(divs[endDivIndex], range.endContainer, range.endOffset);
    const pageNumber = page + 1;
    const anchor: PdfTextAnchor = {
      type: "pdf_text",
      page: pageNumber,
      startDivIndex,
      startOffset,
      endDivIndex,
      endOffset,
      quote,
    };
    return { anchor: JSON.stringify(anchor), quote };
  };

  const showChrome = mode === "workspace";

  return (
    <section
      className={`pdf-reader ${showChrome ? "pdf-reader-workspace" : "pdf-reader-focus"}`}
      data-testid="pdf-reader"
    >
      {showChrome ? (
        <div className="reader-location-bar">
          <span className="meta-count">
            {view.primary_attachment_path
              ? view.primary_attachment_path.split("/").pop()
              : "No attachment path"}
          </span>
          {zoom !== 100 ? <span className="meta-count">Zoom {zoom}%</span> : null}
        </div>
      ) : null}

      <div
        className={showChrome ? "citation-card" : "pdf-stage"}
        onMouseUp={() => onSelectionChange?.(buildSelectionAnchor())}
        onKeyUp={() => onSelectionChange?.(buildSelectionAnchor())}
      >
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

        <div style={{ position: "relative", display: status === "error" ? "none" : "block", maxWidth: "100%" }}>
          <canvas aria-label="PDF page canvas" ref={canvasRef} style={{ display: "block", maxWidth: "100%" }} />
          <div
            aria-label="PDF text layer"
            ref={textLayerHostRef}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: textEnabled && textDivsRef.current.length > 0 ? "auto" : "none",
              userSelect: textEnabled && textDivsRef.current.length > 0 ? "text" : "none",
            }}
          />
        </div>
      </div>
    </section>
  );
}
