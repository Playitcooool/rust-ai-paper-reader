import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type {
  Annotation,
  PdfDocumentInfo,
  PdfEngineGetPageBundleInput,
  ReaderView,
} from "../../lib/contracts";
import { safeScrollIntoView } from "../../lib/dom";
import { logEvent, textForLog } from "../../lib/clientEventLog";
import { computeFitWidthZoomPct } from "./pdfFit";
import {
  buildPdfTextSelectionFromRange,
  parsePdfTextAnchor,
  type PdfTextAnchor,
  type PdfTextSelection,
} from "./pdfSelection";
import { installPdfJsTextLayerSelectionSupport } from "./pdfTextLayerSelectionSupport";
import { buildRustPdfTextLayer, pageWidthAtScale1FromPoints } from "./pdfRustTextLayer";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const arrayBufferForBytes = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

type PdfReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  fitMode?: "manual" | "fit_width";
  mode?: "workspace" | "focus";
  getPdfDocumentInfo: (primaryAttachmentId: number) => Promise<PdfDocumentInfo>;
  getPdfPageBundle: (input: PdfEngineGetPageBundleInput) => Promise<{
    png_bytes: Uint8Array;
    width_px: number;
    height_px: number;
    page_width_pt: number;
    page_height_pt: number;
    spans: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>;
  }>;
  onPageCountChange?: (pageCount: number) => void;
  onNavigateToPage?: (pageIndex0: number) => void;
  searchQuery?: string;
  activeSearchMatchIndex?: number;
  annotations?: Annotation[];
  onSelectionChange?: (selection: PdfTextSelection | null) => void;
  onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
};

export function PdfReader({
  view,
  page,
  zoom,
  fitMode = "fit_width",
  mode = "workspace",
  getPdfDocumentInfo,
  getPdfPageBundle,
  onPageCountChange,
  onNavigateToPage: _onNavigateToPage,
  searchQuery = "",
  activeSearchMatchIndex = 0,
  annotations = [],
  onSelectionChange,
  onSearchMatchesChange,
}: PdfReaderProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textLayerHostRef = useRef<HTMLDivElement | null>(null);
  const textDivsRef = useRef<HTMLElement[]>([]);
  const textDivStringsRef = useRef<string[]>([]);
  const textLayerSelectionCleanupRef = useRef<(() => void) | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  const [pageCount, setPageCount] = useState(view.page_count ?? 1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [stageWidth, setStageWidth] = useState(0);
  const [pageWidthAtScale1, setPageWidthAtScale1] = useState<number | null>(null);
  const [imageUrl, setImageUrl] = useState<string>("");
  const [renderedWidthCssPx, setRenderedWidthCssPx] = useState(0);
  const [renderedHeightCssPx, setRenderedHeightCssPx] = useState(0);
  const [textLayerReady, setTextLayerReady] = useState(false);
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);

  const textEnabled = true;
  const loweredSearch = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
  const effectiveZoom = useMemo(() => {
    if (fitMode !== "fit_width") return zoom;
    if (!pageWidthAtScale1) return zoom;
    return computeFitWidthZoomPct({
      containerWidth: stageWidth,
      pageWidthAtScale1,
      marginPx: 40,
      minZoomPct: 70,
      maxZoomPct: 180,
    });
  }, [fitMode, pageWidthAtScale1, stageWidth, zoom]);
  const desiredWidthCssPx = useMemo(() => {
    const base = pageWidthAtScale1 ?? Math.max(640, stageWidth > 0 ? stageWidth - 40 : 816);
    return Math.max(1, Math.round(base * (effectiveZoom / 100)));
  }, [effectiveZoom, pageWidthAtScale1, stageWidth]);

  useEffect(() => {
    const nextCount = Math.max(1, view.page_count ?? 1);
    setPageCount(nextCount);
    onPageCountChange?.(nextCount);
  }, [onPageCountChange, view.page_count]);

  useEffect(() => {
    let cancelled = false;
    const primaryAttachmentId = view.primary_attachment_id;
    if (!primaryAttachmentId) return;

    void (async () => {
      try {
        const info = await getPdfDocumentInfo(primaryAttachmentId);
        if (cancelled) return;
        const nextCount = Math.max(1, info.page_count || view.page_count || 1);
        setPageCount(nextCount);
        onPageCountChange?.(nextCount);
        const firstPage = info.pages[0];
        if (firstPage?.width_pt) {
          setPageWidthAtScale1(pageWidthAtScale1FromPoints(firstPage.width_pt));
        }
      } catch {
        // If metadata fetch fails, page bundle rendering still provides a fallback path.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getPdfDocumentInfo, onPageCountChange, view.page_count, view.primary_attachment_id]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setStageWidth(width);
    });
    observer.observe(element);
    setStageWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const host = textLayerHostRef.current;
    const primaryAttachmentId = view.primary_attachment_id;
    if (!host || !primaryAttachmentId) return;

    setStatus("loading");
    setErrorMessage("");
    setTextLayerReady(false);
    textLayerSelectionCleanupRef.current?.();
    textLayerSelectionCleanupRef.current = null;
    textDivsRef.current = [];
    textDivStringsRef.current = [];
    host.replaceChildren();

    void (async () => {
      try {
        const renderStart = performance.now();
        logEvent("pdf_render_start", {
          pageIndex0: page,
          zoomPct: effectiveZoom,
          targetWidthPx: desiredWidthCssPx,
        });
        const bundle = await getPdfPageBundle({
          primary_attachment_id: primaryAttachmentId,
          page_index0: page,
          target_width_px: desiredWidthCssPx,
        });
        if (cancelled) return;

        setPageWidthAtScale1(pageWidthAtScale1FromPoints(bundle.page_width_pt));
        setRenderedWidthCssPx(bundle.width_px);
        setRenderedHeightCssPx(bundle.height_px);

        const blobUrl = URL.createObjectURL(new Blob([arrayBufferForBytes(bundle.png_bytes)], { type: "image/png" }));
        if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = blobUrl;
        setImageUrl(blobUrl);

        logEvent("textlayer_render_start", {
          pageIndex0: page,
          itemsLength: bundle.spans.length,
        });
        const built = buildRustPdfTextLayer({
          host,
          bundle,
          renderedWidthCssPx: bundle.width_px,
          renderedHeightCssPx: bundle.height_px,
        });
        textDivsRef.current = built.divs;
        textDivStringsRef.current = built.strings;
        const ready = built.divs.length > 0;
        setTextLayerReady(ready);
        setTextLayerEpoch((current) => current + 1);
        if (ready) textLayerSelectionCleanupRef.current = installPdfJsTextLayerSelectionSupport(host);

        setStatus("ready");
        logEvent("pdf_render_done", {
          pageIndex0: page,
          zoomPct: effectiveZoom,
          durationMs: Math.round(performance.now() - renderStart),
        });
        logEvent("textlayer_render_done", {
          pageIndex0: page,
          itemsLength: bundle.spans.length,
          divCount: built.divs.length,
          ready,
        });
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unknown PDF rendering error.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [desiredWidthCssPx, effectiveZoom, getPdfPageBundle, page, view.primary_attachment_id]);

  useEffect(() => {
    return () => {
      textLayerSelectionCleanupRef.current?.();
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  const searchMatches = useMemo(() => {
    if (!textEnabled) return [];
    if (loweredSearch.length === 0) return [];
    if (status !== "ready") return [];
    const divStrings = textDivStringsRef.current;
    const matches: Array<{ divIndex: number; start: number; end: number }> = [];
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
  }, [loweredSearch, status, textEnabled, textLayerEpoch]);

  useEffect(() => {
    if (!onSearchMatchesChange) return;
    if (!textEnabled || status !== "ready" || loweredSearch.length === 0) {
      onSearchMatchesChange({ total: 0, activeIndex: -1 });
      return;
    }
    const total = searchMatches.length;
    const normalized = total > 0 ? ((activeSearchMatchIndex % total) + total) % total : -1;
    onSearchMatchesChange({ total, activeIndex: normalized });
  }, [activeSearchMatchIndex, loweredSearch, onSearchMatchesChange, searchMatches.length, status, textEnabled]);

  const anchorsForPage = useMemo(() => {
    if (!textEnabled) return [];
    const pageNumber = page + 1;
    return annotations
      .map((annotation) => ({ annotation, anchor: parsePdfTextAnchor(annotation.anchor) }))
      .filter((entry) => entry.anchor && entry.anchor.page === pageNumber && entry.annotation.kind === "highlight")
      .map((entry) => entry.anchor as PdfTextAnchor);
  }, [annotations, page, textEnabled]);

  useEffect(() => {
    if (!textEnabled || status !== "ready") return;
    const divs = textDivsRef.current;
    const plain = textDivStringsRef.current;
    if (divs.length === 0 || plain.length === 0) return;

    const annotationRangesByDiv = new Map<number, Array<{ start: number; end: number; color?: string }>>();
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
        current.push({ start, end, color: anchor.color });
        annotationRangesByDiv.set(divIndex, current);
      }
    }

    const totalMatches = searchMatches.length;
    const normalizedActive = totalMatches > 0 ? ((activeSearchMatchIndex % totalMatches) + totalMatches) % totalMatches : -1;

    for (let divIndex = 0; divIndex < divs.length; divIndex += 1) {
      const div = divs[divIndex];
      const text = plain[divIndex] ?? "";
      const paints = new Array<string | null>(text.length).fill(null);
      for (const range of annotationRangesByDiv.get(divIndex) ?? []) {
        const start = Math.max(0, Math.min(range.start, text.length));
        const end = Math.max(0, Math.min(range.end, text.length));
        for (let i = start; i < end; i += 1) paints[i] = range.color ?? "__default";
      }

      const annotationRanges: Array<{ start: number; end: number; color?: string }> = [];
      let paintCursor = 0;
      while (paintCursor < paints.length) {
        const color = paints[paintCursor];
        if (!color) {
          paintCursor += 1;
          continue;
        }
        let end = paintCursor + 1;
        while (end < paints.length && paints[end] === color) end += 1;
        annotationRanges.push({ start: paintCursor, end, color: color === "__default" ? undefined : color });
        paintCursor = end;
      }

      const searchRanges: Array<{ start: number; end: number; hitIndex: number }> = [];
      for (let hitIndex = 0; hitIndex < searchMatches.length; hitIndex += 1) {
        const match = searchMatches[hitIndex];
        if (match.divIndex !== divIndex) continue;
        let overlapsAnnotation = false;
        for (let i = Math.max(0, match.start); i < Math.min(text.length, match.end); i += 1) {
          if (paints[i]) {
            overlapsAnnotation = true;
            break;
          }
        }
        if (!overlapsAnnotation) searchRanges.push({ start: match.start, end: match.end, hitIndex });
      }

      const segments: Array<
        | { kind: "text"; value: string }
        | { kind: "annotation"; value: string; color?: string }
        | { kind: "search"; value: string; hitIndex: number }
      > = [];
      const pushText = (value: string) => {
        if (value.length > 0) segments.push({ kind: "text", value });
      };

      const all = [
        ...annotationRanges.map((range) => ({ ...range, kind: "annotation" as const })),
        ...searchRanges.map((range) => ({ ...range, kind: "search" as const })),
      ].sort((a, b) => a.start - b.start || a.end - b.end);

      let cursor = 0;
      for (const range of all) {
        if (range.start > cursor) pushText(text.slice(cursor, range.start));
        const slice = text.slice(range.start, range.end);
        if (!slice) continue;
        if (range.kind === "annotation") segments.push({ kind: "annotation", value: slice, color: range.color });
        else segments.push({ kind: "search", value: slice, hitIndex: range.hitIndex });
        cursor = range.end;
      }
      if (cursor < text.length) pushText(text.slice(cursor));

      div.innerHTML = segments
        .map((segment) => {
          if (segment.kind === "text") return escapeHtml(segment.value);
          if (segment.kind === "annotation") {
            const attr = segment.color ? ` data-color="${escapeHtml(segment.color)}"` : "";
            return `<span class="pdf-annotation-highlight"${attr}>${escapeHtml(segment.value)}</span>`;
          }
          const active = segment.hitIndex === normalizedActive ? " pdf-search-hit-active" : "";
          return `<span class="pdf-search-hit${active}" data-hit-index="${segment.hitIndex}">${escapeHtml(segment.value)}</span>`;
        })
        .join("");
      div.dataset.divIndex = String(divIndex);
    }

    if (normalizedActive >= 0) {
      const active = textLayerHostRef.current?.querySelector(
        `.pdf-search-hit[data-hit-index="${normalizedActive}"]`,
      ) as HTMLElement | null;
      if (active) safeScrollIntoView(active, { block: "center" });
    }
  }, [activeSearchMatchIndex, anchorsForPage, searchMatches, status, textEnabled, textLayerEpoch]);

  useEffect(() => {
    if (!onSelectionChange) return;

    const keyFor = (selection: PdfTextSelection | null) => {
      if (!selection) return "";
      const { left, top, right, bottom } = selection.rect;
      return `${selection.anchor}|${selection.quote}|${left},${top},${right},${bottom}`;
    };

    let lastKey = "";
    const onSelectionChangeEvent = () => {
      const host = textLayerHostRef.current;
      const selection = window.getSelection?.();
      let next: PdfTextSelection | null = null;
      if (host && selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const quote = selection.toString();
        if (quote.trim() && host.contains(range.commonAncestorContainer)) {
          next = buildPdfTextSelectionFromRange({
            quote,
            range,
            host,
            divs: textDivsRef.current,
            pageNumber1: page + 1,
          });
        }
      }

      const nextKey = keyFor(next);
      if (nextKey === lastKey) return;
      lastKey = nextKey;

      const quote = selection?.toString?.() ?? "";
      const quoteMeta = textForLog(quote) ?? { text_len: 0, text_snippet: "" };
      let insideTextLayer = false;
      let nearestDivIndex: string | null = null;
      try {
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          insideTextLayer = host ? host.contains(range.commonAncestorContainer) : false;
          const element =
            range.startContainer.nodeType === Node.ELEMENT_NODE
              ? (range.startContainer as Element)
              : range.startContainer.parentElement;
          const nearest = element?.closest?.("[data-div-index]") as HTMLElement | null;
          nearestDivIndex = nearest?.dataset.divIndex ?? null;
        }
      } catch {
        // ignore
      }
      logEvent("selection_change", {
        pageIndex0: page,
        rangeCount: selection?.rangeCount ?? 0,
        insideTextLayer,
        nearestDivIndex,
        ...quoteMeta,
      });
      onSelectionChange(next);
    };

    document.addEventListener("selectionchange", onSelectionChangeEvent);
    return () => document.removeEventListener("selectionchange", onSelectionChangeEvent);
  }, [onSelectionChange, page]);

  const showChrome = mode === "workspace";
  const pageShellStyleVars = useMemo((): CSSProperties => ({ width: `${renderedWidthCssPx}px` }), [renderedWidthCssPx]);

  return (
    <section className={`pdf-reader ${showChrome ? "pdf-reader-workspace" : "pdf-reader-focus"}`} data-testid="pdf-reader">
      {showChrome ? (
        <div className="reader-location-bar">
          <span className="meta-count">
            {view.primary_attachment_path ? view.primary_attachment_path.split("/").pop() : "No attachment path"}
          </span>
          {effectiveZoom !== 100 ? <span className="meta-count">Zoom {effectiveZoom}%</span> : null}
        </div>
      ) : null}

      <div className={showChrome ? "citation-card" : "pdf-stage"} ref={stageRef}>
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

        <div style={{ position: "relative", display: status === "error" ? "none" : "block", ...pageShellStyleVars }}>
          {imageUrl ? (
            <img
              alt={`PDF page ${page + 1}`}
              aria-label="PDF page image"
              src={imageUrl}
              style={{ display: "block", width: `${renderedWidthCssPx}px`, height: `${renderedHeightCssPx}px` }}
            />
          ) : null}
          <div
            aria-label="PDF text layer"
            className="pdf-text-layer textLayer"
            ref={textLayerHostRef}
            style={{
              position: "absolute",
              inset: 0,
              width: `${renderedWidthCssPx}px`,
              height: `${renderedHeightCssPx}px`,
              pointerEvents: textEnabled && textLayerReady ? "auto" : "none",
              userSelect: textEnabled && textLayerReady ? "text" : "none",
              WebkitUserSelect: textEnabled && textLayerReady ? "text" : "none",
            }}
          />
        </div>
      </div>
    </section>
  );
}
