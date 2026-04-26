import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

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

type PdfContinuousReaderProps = {
  view: ReaderView;
  page: number; // 0-based active page
  zoom: number;
  loadPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  onPageCountChange?: (pageCount: number) => void;
  searchQuery?: string;
  activeSearchMatchIndex?: number;
  annotations?: Annotation[];
  onSelectionChange?: (selection: { anchor: string; quote: string } | null) => void;
  onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
  onActivePageChange?: (pageIndex0: number) => void;
  onNavigateToPage?: (pageIndex0: number) => void;
};

type RenderWork = {
  renderTask: RenderTask | null;
  textLayer: TextLayer | null;
  token: symbol;
};

export function PdfContinuousReader({
  view,
  page,
  zoom,
  loadPrimaryAttachmentBytes,
  onPageCountChange,
  searchQuery = "",
  activeSearchMatchIndex = 0,
  annotations = [],
  onSelectionChange,
  onSearchMatchesChange,
  onActivePageChange,
  onNavigateToPage,
}: PdfContinuousReaderProps) {
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(view.page_count ?? 1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const onPageCountChangeRef = useRef(onPageCountChange);
  const onSearchMatchesChangeRef = useRef(onSearchMatchesChange);
  const onActivePageChangeRef = useRef(onActivePageChange);
  const onNavigateToPageRef = useRef(onNavigateToPage);

  const pageShellByIndexRef = useRef(new Map<number, HTMLDivElement>());
  const canvasByIndexRef = useRef(new Map<number, HTMLCanvasElement>());
  const textLayerHostByIndexRef = useRef(new Map<number, HTMLDivElement>());
  const annotationLayerHostByIndexRef = useRef(new Map<number, HTMLDivElement>());

  const renderWorkByIndexRef = useRef(new Map<number, RenderWork>());
  const renderedAtZoomByIndexRef = useRef(new Map<number, number>());
  const textDivsByIndexRef = useRef(new Map<number, HTMLElement[]>());
  const textDivStringsByIndexRef = useRef(new Map<number, string[]>());
  const [textLayerReadyByPage, setTextLayerReadyByPage] = useState<Record<number, boolean>>({});
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);
  const dominantPageIndexRef = useRef(0);

  // PDF text selection/search/highlights are driven by pdf.js' TextLayer, not server-side content_status.
  // If the TextLayer can't render, we keep canvas + annotation layers and disable text tools per page.
  const textEnabled = true;
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

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    onSearchMatchesChangeRef.current = onSearchMatchesChange;
  }, [onSearchMatchesChange]);

  useEffect(() => {
    onActivePageChangeRef.current = onActivePageChange;
  }, [onActivePageChange]);

  useEffect(() => {
    onNavigateToPageRef.current = onNavigateToPage;
  }, [onNavigateToPage]);

  const cancelAllRenderWork = () => {
    for (const work of renderWorkByIndexRef.current.values()) {
      work.renderTask?.cancel();
      work.textLayer?.cancel();
    }
    renderWorkByIndexRef.current.clear();
    renderedAtZoomByIndexRef.current.clear();
    textDivsByIndexRef.current.clear();
    textDivStringsByIndexRef.current.clear();
    setTextLayerReadyByPage({});
    setTextLayerEpoch((current) => current + 1);

    for (const host of textLayerHostByIndexRef.current.values()) clearChildren(host);
    for (const host of annotationLayerHostByIndexRef.current.values()) clearChildren(host);
  };

  useEffect(() => {
    let cancelled = false;

    const destroyActiveDocument = async () => {
      cancelAllRenderWork();

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
      setPageCount(view.page_count ?? 1);

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
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        if (isCancellationError(error)) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unknown PDF rendering error.");
      }
    }

    void loadDocument();

    return () => {
      cancelled = true;
      void destroyActiveDocument();
    };
  }, [loadPrimaryAttachmentBytes, view.page_count, view.primary_attachment_id]);

  // When zoom changes, clear existing per-page render state so pages rerender lazily at the new scale.
  useEffect(() => {
    cancelAllRenderWork();
    // Keep the current page feeling responsive even without IntersectionObserver support.
    void Promise.resolve().then(() => {
      const shell = pageShellByIndexRef.current.get(page);
      if (shell) shell.dataset.needsRender = "true";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pdfDocument]);

  const pageShellStyleVars = useMemo((): CSSProperties => {
    const scale = zoom / 100;
    return {
      // pdf.js layer sizing depends on these vars via setLayerDimensions().
      // Keep them on the page shell so text/annotation layers inherit.
      ["--scale-factor" as never]: String(scale),
      ["--user-unit" as never]: "1",
      ["--scale-round-x" as never]: "1px",
      ["--scale-round-y" as never]: "1px",
      ["--total-scale-factor" as never]: "calc(var(--scale-factor) * var(--user-unit))",
    } as unknown as CSSProperties;
  }, [zoom]);

  const createLinkService = (pdfDocument: PDFDocumentProxy) => {
    const goToDestination = async (dest: unknown) => {
      try {
        const destArray =
          typeof dest === "string"
            ? await pdfDocument.getDestination(dest)
            : Array.isArray(dest)
              ? dest
              : null;
        if (!destArray || destArray.length === 0) return;
        const target = destArray[0];
        if (!target) return;

        let pageIndex = -1;
        if (typeof target === "number") {
          // Per pdf.js semantics: a numeric explicitDest[0] is already a 0-based page index.
          pageIndex = Math.max(0, target);
        } else {
          pageIndex = await pdfDocument.getPageIndex(target as never);
        }
        if (pageIndex < 0) return;
        onNavigateToPageRef.current?.(pageIndex);
      } catch (error) {
        if (isCancellationError(error)) return;
        // eslint-disable-next-line no-console
        console.warn("Unable to resolve PDF destination:", error);
      }
    };

    return {
      isInPresentationMode: false,
      getAnchorUrl: () => "#",
      getDestinationHash: () => "#",
      addLinkAttributes: (link: HTMLAnchorElement) => {
        // Ignore external URLs for now; we still want the annotation rectangle
        // so internal link hit targets behave similarly.
        link.href = "#";
        link.rel = "noreferrer noopener";
        link.target = "_self";
        link.onclick = () => false;
      },
      executeNamedAction: () => {},
      executeSetOCGState: async () => {},
      navigateTo: (dest: unknown) => void goToDestination(dest),
      goToDestination: (dest: unknown) => void goToDestination(dest),
    };
  };

  const renderPageIfNeeded = async (pageIndex0: number) => {
    const doc = pdfDocumentRef.current;
    if (!doc) return;
    if (pdfDocument !== doc) return;
    if (renderedAtZoomByIndexRef.current.get(pageIndex0) === zoom) return;

    const canvas = canvasByIndexRef.current.get(pageIndex0);
    const textHost = textLayerHostByIndexRef.current.get(pageIndex0);
    const annotationHost = annotationLayerHostByIndexRef.current.get(pageIndex0);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !textHost || !annotationHost) return;

    const token = Symbol(`render-page-${pageIndex0}-${zoom}`);
    const previous = renderWorkByIndexRef.current.get(pageIndex0);
    previous?.renderTask?.cancel();
    previous?.textLayer?.cancel();
    renderWorkByIndexRef.current.set(pageIndex0, { renderTask: null, textLayer: null, token });

    setTextLayerReadyByPage((current) => (current[pageIndex0] ? { ...current, [pageIndex0]: false } : current));
    clearChildren(textHost);
    clearChildren(annotationHost);
    textDivsByIndexRef.current.delete(pageIndex0);
    textDivStringsByIndexRef.current.delete(pageIndex0);

    try {
      const pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pageProxy = await doc.getPage(pageIndex0 + 1);
      const viewport = pageProxy.getViewport({ scale: zoom / 100 });

      // Canvas render
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const renderTask = pageProxy.render({ canvasContext: ctx, canvas, viewport });
      renderWorkByIndexRef.current.set(pageIndex0, { renderTask, textLayer: null, token });
      await renderTask.promise;

      const activeWork = renderWorkByIndexRef.current.get(pageIndex0);
      if (!activeWork || activeWork.token !== token) return;
      renderWorkByIndexRef.current.set(pageIndex0, { renderTask: null, textLayer: null, token });

      renderedAtZoomByIndexRef.current.set(pageIndex0, zoom);

      // Text layer (optional)
      if (textEnabled) {
        try {
          const textContent = await pageProxy.getTextContent();
          const textLayer = new pdfjsModule.TextLayer({
            textContentSource: textContent,
            container: textHost,
            viewport,
          }) as TextLayer;
          renderWorkByIndexRef.current.set(pageIndex0, { renderTask: null, textLayer, token });
          await textLayer.render();

          const latest = renderWorkByIndexRef.current.get(pageIndex0);
          if (!latest || latest.token !== token) return;
          renderWorkByIndexRef.current.set(pageIndex0, { renderTask: null, textLayer: null, token });

          const divs = textLayer.textDivs as unknown as HTMLElement[];
          const strings = textLayer.textContentItemsStr.slice();
          divs.forEach((div, index) => {
            div.dataset.divIndex = String(index);
          });
          textDivsByIndexRef.current.set(pageIndex0, divs);
          textDivStringsByIndexRef.current.set(pageIndex0, strings);
          setTextLayerReadyByPage((current) => ({ ...current, [pageIndex0]: divs.length > 0 }));
          setTextLayerEpoch((current) => current + 1);
        } catch (error) {
          if (isCancellationError(error)) return;
          clearChildren(textHost);
          setTextLayerReadyByPage((current) => ({ ...current, [pageIndex0]: false }));
        }
      }

      // Annotation layer (internal reference links)
      try {
        const annotations = await pageProxy.getAnnotations({ intent: "display" });
        const linkService = createLinkService(doc);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const annotationLayer = new (pdfjsModule as any).AnnotationLayer({
          div: annotationHost,
          page: pageProxy,
          viewport: viewport.clone({ dontFlip: true }),
          linkService,
        });
        await annotationLayer.render({ annotations, renderForms: false });
      } catch (error) {
        if (isCancellationError(error)) return;
        // Non-fatal.
        clearChildren(annotationHost);
      }
    } catch (error) {
      if (isCancellationError(error)) return;
      // eslint-disable-next-line no-console
      console.warn("Unable to render PDF page:", error);
    }
  };

  // Lazy render pages as they approach the viewport.
  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    if (!pdfDocument) return;
    if (typeof IntersectionObserver !== "function") {
      void renderPageIfNeeded(page);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          const index = Number(target.dataset.pageIndex);
          if (!Number.isFinite(index)) continue;
          void renderPageIfNeeded(index);
        }
      },
      { root, rootMargin: "1200px 0px", threshold: 0.01 },
    );

    for (const shell of pageShellByIndexRef.current.values()) observer.observe(shell);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDocument, pageCount, zoom]);

  // Track which page is dominant in the viewport (for toolbar sync).
  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    if (!pdfDocument) return;
    if (typeof IntersectionObserver !== "function") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => ({
            index: Number((entry.target as HTMLElement).dataset.pageIndex),
            ratio: entry.intersectionRatio,
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
  }, [pdfDocument, pageCount]);

  // Scroll when the controlled "page" changes (but don't fight scroll-driven updates).
  useEffect(() => {
    const shell = pageShellByIndexRef.current.get(page);
    if (!shell) return;
    if (dominantPageIndexRef.current === page) return;
    safeScrollIntoView(shell, { block: "start" });
  }, [page]);

  const searchMatches = useMemo(() => {
    if (!textEnabled) return [];
    if (loweredSearch.length === 0) return [];
    if (!textLayerReadyByPage[page]) return [];

    const divStrings = textDivStringsByIndexRef.current.get(page) ?? [];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loweredSearch, page, textEnabled, textLayerEpoch, zoom, view.primary_attachment_id]);

  useEffect(() => {
    const report = onSearchMatchesChangeRef.current;
    if (!report) return;
    if (!textEnabled || loweredSearch.length === 0 || !textLayerReadyByPage[page]) {
      report({ total: 0, activeIndex: -1 });
      return;
    }
    const total = searchMatches.length;
    const normalized = total > 0 ? ((activeSearchMatchIndex % total) + total) % total : -1;
    report({ total, activeIndex: normalized });
  }, [
    activeSearchMatchIndex,
    loweredSearch,
    page,
    searchMatches.length,
    textEnabled,
    textLayerReadyByPage,
  ]);

  const anchorsForActivePage = useMemo(() => {
    if (!textEnabled) return [];
    const pageNumber = page + 1;
    return annotations
      .map((annotation) => ({ annotation, anchor: parsePdfTextAnchor(annotation.anchor) }))
      .filter((entry) => entry.anchor && entry.anchor.page === pageNumber && entry.annotation.kind === "highlight")
      .map((entry) => entry.anchor as PdfTextAnchor);
  }, [annotations, page, textEnabled]);

  useEffect(() => {
    if (!textEnabled) return;
    if (!textLayerReadyByPage[page]) return;

    const host = textLayerHostByIndexRef.current.get(page);
    const divs = textDivsByIndexRef.current.get(page) ?? [];
    const plain = textDivStringsByIndexRef.current.get(page) ?? [];
    if (!host || divs.length === 0 || plain.length === 0) return;

    const annotationRangesByDiv = new Map<number, Array<{ start: number; end: number }>>();
    for (const anchor of anchorsForActivePage) {
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

    if (normalizedActive >= 0) {
      const active = host.querySelector(
        `.pdf-search-hit[data-hit-index="${normalizedActive}"]`,
      ) as HTMLElement | null;
      if (active) safeScrollIntoView(active, { block: "center" });
    }
  }, [
    activeSearchMatchIndex,
    anchorsForActivePage,
    loweredSearch,
    page,
    searchMatches,
    textEnabled,
    textLayerEpoch,
    textLayerReadyByPage,
  ]);

  const offsetWithinDiv = (div: HTMLElement, container: Node, offset: number) => {
    if (!div.contains(container)) return 0;
    if (container.nodeType === Node.TEXT_NODE) {
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

  const closestPageIndex = (node: Node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const shell = element?.closest?.("[data-page-index]") as HTMLElement | null;
    const index = shell?.dataset.pageIndex ? Number(shell.dataset.pageIndex) : NaN;
    return Number.isFinite(index) ? index : null;
  };

  const buildSelectionAnchor = (): { anchor: string; quote: string } | null => {
    if (!textEnabled) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    const quote = selection.toString();
    if (!quote || quote.trim().length === 0) return null;

    const range = selection.getRangeAt(0);
    const startPage = closestPageIndex(range.startContainer);
    const endPage = closestPageIndex(range.endContainer);
    if (startPage === null || endPage === null) return null;
    if (startPage !== endPage) return null;

    const host = textLayerHostByIndexRef.current.get(startPage);
    if (!host) return null;
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;

    const divs = textDivsByIndexRef.current.get(startPage) ?? [];
    if (divs.length === 0) return null;
    const startDivIndex = divs.findIndex((div) => div.contains(range.startContainer));
    const endDivIndex = divs.findIndex((div) => div.contains(range.endContainer));
    if (startDivIndex < 0 || endDivIndex < 0) return null;

    const startOffset = offsetWithinDiv(divs[startDivIndex], range.startContainer, range.startOffset);
    const endOffset = offsetWithinDiv(divs[endDivIndex], range.endContainer, range.endOffset);

    const anchor: PdfTextAnchor = {
      type: "pdf_text",
      page: startPage + 1,
      startDivIndex,
      startOffset,
      endDivIndex,
      endOffset,
      quote,
    };
    return { anchor: JSON.stringify(anchor), quote };
  };

  return (
    <section className="pdf-reader pdf-reader-focus" data-testid="pdf-reader" ref={scrollRootRef}>
      <div
        className="pdf-stage"
        onMouseUp={() => onSelectionChange?.(buildSelectionAnchor())}
        onKeyUp={() => onSelectionChange?.(buildSelectionAnchor())}
      >
        {status === "loading" ? <p>Loading PDF...</p> : null}
        {status === "error" ? <p>Unable to load this PDF. {errorMessage}</p> : null}

        {Array.from({ length: Math.max(1, pageCount) }).map((_, index) => (
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
            <div
              style={{ position: "relative", maxWidth: "100%" }}
              onPointerDownCapture={() => {
                textLayerHostByIndexRef.current.get(index)?.classList.add("selecting");
              }}
              onPointerUpCapture={() => {
                textLayerHostByIndexRef.current.get(index)?.classList.remove("selecting");
              }}
              onPointerCancelCapture={() => {
                textLayerHostByIndexRef.current.get(index)?.classList.remove("selecting");
              }}
            >
              <canvas
                aria-label={`PDF page ${index + 1} canvas`}
                ref={(element) => {
                  if (!element) {
                    canvasByIndexRef.current.delete(index);
                    return;
                  }
                  canvasByIndexRef.current.set(index, element);
                }}
                style={{ display: "block", maxWidth: "100%" }}
              />
              <div
                aria-label={`PDF page ${index + 1} text layer`}
                className="pdf-text-layer"
                ref={(element) => {
                  if (!element) {
                    textLayerHostByIndexRef.current.delete(index);
                    return;
                  }
                  textLayerHostByIndexRef.current.set(index, element);
                }}
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: textEnabled && textLayerReadyByPage[index] ? "auto" : "none",
                  userSelect: textEnabled && textLayerReadyByPage[index] ? "text" : "none",
                }}
              />
              <div
                aria-label={`PDF page ${index + 1} annotation layer`}
                className="annotationLayer"
                ref={(element) => {
                  if (!element) {
                    annotationLayerHostByIndexRef.current.delete(index);
                    return;
                  }
                  annotationLayerHostByIndexRef.current.set(index, element);
                }}
                style={{ position: "absolute", inset: 0 }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
