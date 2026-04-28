import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type { Annotation, PdfEngineGetPageBundleInput, ReaderView } from "../../lib/contracts";
import { clearChildren, safeScrollIntoView } from "../../lib/dom";
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

type PdfContinuousReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  fitMode?: "manual" | "fit_width";
  getPdfPageBundle: (input: PdfEngineGetPageBundleInput) => Promise<{
    png_bytes: Uint8Array;
    width_px: number;
    height_px: number;
    page_width_pt: number;
    page_height_pt: number;
    spans: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>;
  }>;
  onPageCountChange?: (pageCount: number) => void;
  onActivePageChange?: (pageIndex0: number) => void;
  onNavigateToPage?: (pageIndex0: number) => void;
  searchQuery?: string;
  activeSearchMatchIndex?: number;
  annotations?: Annotation[];
  onSelectionChange?: (selection: PdfTextSelection | null) => void;
  onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
};

type RenderedPageState = {
  imageUrl: string;
  width: number;
  height: number;
};

export function PdfContinuousReader({
  view,
  page,
  zoom,
  fitMode = "fit_width",
  getPdfPageBundle,
  onPageCountChange,
  onActivePageChange,
  onNavigateToPage: _onNavigateToPage,
  searchQuery = "",
  activeSearchMatchIndex = 0,
  annotations = [],
  onSelectionChange,
  onSearchMatchesChange,
}: PdfContinuousReaderProps) {
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const pageShellByIndexRef = useRef(new Map<number, HTMLElement>());
  const textLayerHostByIndexRef = useRef(new Map<number, HTMLElement>());
  const textLayerSelectionCleanupByIndexRef = useRef(new Map<number, () => void>());
  const textDivsByIndexRef = useRef(new Map<number, HTMLElement[]>());
  const textDivStringsByIndexRef = useRef(new Map<number, string[]>());
  const imageUrlsByIndexRef = useRef(new Map<number, string>());
  const dominantPageIndexRef = useRef(0);

  const [pageCount, setPageCount] = useState(Math.max(1, view.page_count ?? 1));
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [stageWidth, setStageWidth] = useState(0);
  const [pageWidthAtScale1, setPageWidthAtScale1] = useState<number | null>(null);
  const [pages, setPages] = useState<Record<number, RenderedPageState>>({});
  const [textLayerReadyByPage, setTextLayerReadyByPage] = useState<Record<number, boolean>>({});
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);

  const onPageCountChangeRef = useRef(onPageCountChange);
  const onActivePageChangeRef = useRef(onActivePageChange);
  const onSearchMatchesChangeRef = useRef(onSearchMatchesChange);
  onPageCountChangeRef.current = onPageCountChange;
  onActivePageChangeRef.current = onActivePageChange;
  onSearchMatchesChangeRef.current = onSearchMatchesChange;

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
  const pageShellStyleVars = useMemo(
    (): CSSProperties => ({ width: desiredWidthCssPx > 0 ? `${desiredWidthCssPx}px` : undefined }),
    [desiredWidthCssPx],
  );

  useEffect(() => {
    const nextCount = Math.max(1, view.page_count ?? 1);
    setPageCount(nextCount);
    onPageCountChangeRef.current?.(nextCount);
  }, [view.page_count]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setStageWidth(width);
    });
    observer.observe(root);
    setStageWidth(root.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const primaryAttachmentId = view.primary_attachment_id;
    if (!primaryAttachmentId) return;

    setStatus("loading");
    setErrorMessage("");
    setTextLayerReadyByPage({});
    setPages({});
    setTextLayerEpoch((current) => current + 1);

    for (const cleanup of textLayerSelectionCleanupByIndexRef.current.values()) cleanup();
    textLayerSelectionCleanupByIndexRef.current.clear();
    for (const url of imageUrlsByIndexRef.current.values()) URL.revokeObjectURL(url);
    imageUrlsByIndexRef.current.clear();
    textDivsByIndexRef.current.clear();
    textDivStringsByIndexRef.current.clear();

    void (async () => {
      try {
        for (let pageIndex0 = 0; pageIndex0 < pageCount; pageIndex0 += 1) {
          const host = textLayerHostByIndexRef.current.get(pageIndex0);
          if (host) clearChildren(host);

          logEvent("pdf_render_start", {
            pageIndex0,
            zoomPct: effectiveZoom,
            targetWidthPx: desiredWidthCssPx,
          });
          const bundle = await getPdfPageBundle({
            primary_attachment_id: primaryAttachmentId,
            page_index0: pageIndex0,
            target_width_px: desiredWidthCssPx,
          });
          if (cancelled) return;

          if (pageIndex0 === 0) setPageWidthAtScale1(pageWidthAtScale1FromPoints(bundle.page_width_pt));

          const blobUrl = URL.createObjectURL(
            new Blob([arrayBufferForBytes(bundle.png_bytes)], { type: "image/png" }),
          );
          imageUrlsByIndexRef.current.set(pageIndex0, blobUrl);
          setPages((current) => ({
            ...current,
            [pageIndex0]: {
              imageUrl: blobUrl,
              width: bundle.width_px,
              height: bundle.height_px,
            },
          }));

          const currentHost = textLayerHostByIndexRef.current.get(pageIndex0);
          if (!currentHost) continue;
          const built = buildRustPdfTextLayer({
            host: currentHost,
            bundle,
            renderedWidthCssPx: bundle.width_px,
            renderedHeightCssPx: bundle.height_px,
          });
          textDivsByIndexRef.current.set(pageIndex0, built.divs);
          textDivStringsByIndexRef.current.set(pageIndex0, built.strings);
          if (built.divs.length > 0) {
            textLayerSelectionCleanupByIndexRef.current.set(
              pageIndex0,
              installPdfJsTextLayerSelectionSupport(currentHost),
            );
          }
          setTextLayerReadyByPage((current) => ({ ...current, [pageIndex0]: built.divs.length > 0 }));
          setTextLayerEpoch((current) => current + 1);
          logEvent("pdf_render_done", {
            pageIndex0,
            zoomPct: effectiveZoom,
          });
          logEvent("textlayer_render_done", {
            pageIndex0,
            itemsLength: bundle.spans.length,
            divCount: built.divs.length,
            ready: built.divs.length > 0,
          });
        }
        if (!cancelled) setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unknown PDF rendering error.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [desiredWidthCssPx, effectiveZoom, getPdfPageBundle, pageCount, view.primary_attachment_id]);

  useEffect(() => {
    return () => {
      for (const cleanup of textLayerSelectionCleanupByIndexRef.current.values()) cleanup();
      for (const url of imageUrlsByIndexRef.current.values()) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => ({
            ratio: entry.intersectionRatio,
            index: Number((entry.target as HTMLElement).dataset.pageIndex),
          }))
          .filter((entry) => Number.isFinite(entry.index));
        if (visible.length === 0) return;
        visible.sort((a, b) => b.ratio - a.ratio);
        const next = visible[0]?.index ?? 0;
        if (next === dominantPageIndexRef.current) return;
        dominantPageIndexRef.current = next;
        onActivePageChangeRef.current?.(next);
      },
      { root, threshold: [0.55, 0.7] },
    );
    for (const shell of pageShellByIndexRef.current.values()) observer.observe(shell);
    return () => observer.disconnect();
  }, [pageCount]);

  useEffect(() => {
    const shell = pageShellByIndexRef.current.get(page);
    if (!shell) return;
    if (dominantPageIndexRef.current === page) return;
    safeScrollIntoView(shell, { block: "start" });
  }, [page]);

  const searchMatches = useMemo(() => {
    if (!textEnabled || loweredSearch.length === 0) return [];
    const renderedPages = Object.keys(textLayerReadyByPage).map(Number).filter((p) => textLayerReadyByPage[p]);
    const matches: Array<{ pageIndex: number; divIndex: number; start: number; end: number }> = [];
    for (const pageIndex of renderedPages) {
      const divStrings = textDivStringsByIndexRef.current.get(pageIndex) ?? [];
      for (let divIndex = 0; divIndex < divStrings.length; divIndex += 1) {
        const text = divStrings[divIndex] ?? "";
        const lowered = text.toLowerCase();
        let cursor = 0;
        while (cursor < lowered.length) {
          const index = lowered.indexOf(loweredSearch, cursor);
          if (index === -1) break;
          matches.push({ pageIndex, divIndex, start: index, end: index + loweredSearch.length });
          cursor = index + Math.max(1, loweredSearch.length);
        }
      }
    }
    return matches;
  }, [loweredSearch, textEnabled, textLayerEpoch, textLayerReadyByPage]);

  useEffect(() => {
    const report = onSearchMatchesChangeRef.current;
    if (!report) return;
    if (!textEnabled || loweredSearch.length === 0 || searchMatches.length === 0) {
      report({ total: 0, activeIndex: -1 });
      return;
    }
    const total = searchMatches.length;
    const normalized = total > 0 ? ((activeSearchMatchIndex % total) + total) % total : -1;
    report({ total, activeIndex: normalized });
  }, [activeSearchMatchIndex, loweredSearch, searchMatches.length, textEnabled]);

  const anchorsForActivePage = useMemo(() => {
    if (!textEnabled) return [];
    return annotations
      .map((annotation) => ({ annotation, anchor: parsePdfTextAnchor(annotation.anchor) }))
      .filter((entry) => entry.anchor && entry.annotation.kind === "highlight")
      .map((entry) => entry.anchor as PdfTextAnchor);
  }, [annotations, textEnabled]);

  useEffect(() => {
    if (!textEnabled) return;
    const renderedPages = Object.keys(textLayerReadyByPage).map(Number).filter((p) => textLayerReadyByPage[p]);
    if (renderedPages.length === 0) return;

    const totalMatches = searchMatches.length;
    const normalizedActive = totalMatches > 0 ? ((activeSearchMatchIndex % totalMatches) + totalMatches) % totalMatches : -1;
    let activeMatchPageIndex: number | null = null;

    for (const pageIndex of renderedPages) {
      const host = textLayerHostByIndexRef.current.get(pageIndex);
      const divs = textDivsByIndexRef.current.get(pageIndex) ?? [];
      const plain = textDivStringsByIndexRef.current.get(pageIndex) ?? [];
      if (!host || divs.length === 0 || plain.length === 0) continue;

      const annotationRangesByDiv = new Map<number, Array<{ start: number; end: number; color?: string }>>();
      for (const anchor of anchorsForActivePage) {
        const anchorPage = anchor.page - 1;
        if (anchorPage !== pageIndex) continue;
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

      const pageMatches = searchMatches.filter((m) => m.pageIndex === pageIndex);
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
        for (const match of pageMatches) {
          if (match.divIndex !== divIndex) continue;
          let overlapsAnnotation = false;
          for (let i = Math.max(0, match.start); i < Math.min(text.length, match.end); i += 1) {
            if (paints[i]) {
              overlapsAnnotation = true;
              break;
            }
          }
          if (overlapsAnnotation) continue;
          const hitIndex = searchMatches.indexOf(match);
          if (hitIndex === normalizedActive) activeMatchPageIndex = pageIndex;
          searchRanges.push({ start: match.start, end: match.end, hitIndex });
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
    }

    if (normalizedActive >= 0 && activeMatchPageIndex !== null) {
      const activeHost = textLayerHostByIndexRef.current.get(activeMatchPageIndex);
      const active = activeHost?.querySelector(".pdf-search-hit-active") as HTMLElement | null;
      if (active) {
        safeScrollIntoView(active, { block: "center" });
        if (activeMatchPageIndex !== dominantPageIndexRef.current) onActivePageChangeRef.current?.(activeMatchPageIndex);
      }
    }
  }, [activeSearchMatchIndex, anchorsForActivePage, searchMatches, textEnabled, textLayerEpoch, textLayerReadyByPage]);

  const closestPageIndex = (node: Node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const shell = element?.closest?.("[data-page-index]") as HTMLElement | null;
    const index = shell?.dataset.pageIndex ? Number(shell.dataset.pageIndex) : NaN;
    return Number.isFinite(index) ? index : null;
  };

  useEffect(() => {
    if (!onSelectionChange) return;
    const keyFor = (selection: PdfTextSelection | null) => {
      if (!selection) return "";
      const { left, top, right, bottom } = selection.rect;
      return `${selection.anchor}|${selection.quote}|${left},${top},${right},${bottom}`;
    };
    let lastKey = "";
    const onSelectionChangeEvent = () => {
      const selection = window.getSelection?.();
      let next: PdfTextSelection | null = null;
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const quote = selection.toString();
        const startPage = closestPageIndex(range.startContainer);
        const endPage = closestPageIndex(range.endContainer);
        if (quote.trim() && startPage !== null && startPage === endPage) {
          const host = textLayerHostByIndexRef.current.get(startPage);
          const divs = textDivsByIndexRef.current.get(startPage) ?? [];
          if (host && host.contains(range.commonAncestorContainer)) {
            next = buildPdfTextSelectionFromRange({ quote, range, host, divs, pageNumber1: startPage + 1 });
          }
        }
      }
      const nextKey = keyFor(next);
      if (nextKey === lastKey) return;
      lastKey = nextKey;

      const quote = selection?.toString?.() ?? "";
      const quoteMeta = textForLog(quote) ?? { text_len: 0, text_snippet: "" };
      let insideTextLayer = false;
      let nearestDivIndex: string | null = null;
      let pageIndex0: number | null = null;
      try {
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          pageIndex0 = closestPageIndex(range.startContainer);
          if (pageIndex0 !== null) {
            const host = textLayerHostByIndexRef.current.get(pageIndex0);
            insideTextLayer = host ? host.contains(range.commonAncestorContainer) : false;
          }
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
        pageIndex0,
        rangeCount: selection?.rangeCount ?? 0,
        insideTextLayer,
        nearestDivIndex,
        ...quoteMeta,
      });
      onSelectionChange(next);
    };
    document.addEventListener("selectionchange", onSelectionChangeEvent);
    return () => document.removeEventListener("selectionchange", onSelectionChangeEvent);
  }, [onSelectionChange]);

  return (
    <section className="pdf-reader pdf-reader-focus" data-testid="pdf-reader" ref={scrollRootRef}>
      <div className="pdf-stage">
        {status === "loading" ? <p>Loading PDF...</p> : null}
        {status === "error" ? <p>Unable to load this PDF. {errorMessage}</p> : null}

        {Array.from({ length: Math.max(1, pageCount) }).map((_, index) => {
          const rendered = pages[index];
          return (
            <div
              key={index}
              className="pdf-page-shell"
              data-page-index={index}
              ref={(element) => {
                if (!element) {
                  pageShellByIndexRef.current.delete(index);
                  return;
                }
                pageShellByIndexRef.current.set(index, element);
              }}
              style={pageShellStyleVars}
            >
              <div style={{ position: "relative" }}>
                {rendered ? (
                  <img
                    alt={`PDF page ${index + 1}`}
                    aria-label={`PDF page ${index + 1} image`}
                    src={rendered.imageUrl}
                    style={{ display: "block", width: `${rendered.width}px`, height: `${rendered.height}px` }}
                  />
                ) : null}
                <div
                  aria-label={`PDF page ${index + 1} text layer`}
                  className="pdf-text-layer textLayer"
                  ref={(element) => {
                    if (!element) {
                      textLayerSelectionCleanupByIndexRef.current.get(index)?.();
                      textLayerSelectionCleanupByIndexRef.current.delete(index);
                      textLayerHostByIndexRef.current.delete(index);
                      return;
                    }
                    textLayerHostByIndexRef.current.set(index, element);
                  }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: rendered ? `${rendered.width}px` : undefined,
                    height: rendered ? `${rendered.height}px` : undefined,
                    pointerEvents: textEnabled && textLayerReadyByPage[index] ? "auto" : "none",
                    userSelect: textEnabled && textLayerReadyByPage[index] ? "text" : "none",
                    WebkitUserSelect: textEnabled && textLayerReadyByPage[index] ? "text" : "none",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
