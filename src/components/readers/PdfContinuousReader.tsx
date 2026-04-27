import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { Annotation, ReaderView } from "../../lib/contracts";
import { clearChildren, safeScrollIntoView } from "../../lib/dom";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { TextLayer } from "pdfjs-dist/types/src/display/text_layer";
import { computeFitWidthZoomPct } from "./pdfFit";
import {
  buildPdfTextSelectionFromRange,
  parsePdfTextAnchor,
  type PdfTextAnchor,
  type PdfTextSelection,
} from "./pdfSelection";
import { installPdfJsTextLayerSelectionSupport } from "./pdfTextLayerSelectionSupport";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getRuntimePolyfillDiagnostics } from "../../lib/runtimePolyfills";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type PdfContinuousReaderProps = {
  view: ReaderView;
  page: number; // 0-based active page
  zoom: number;
  fitMode?: "manual" | "fit_width";
  loadPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  onPageCountChange?: (pageCount: number) => void;
  searchQuery?: string;
  activeSearchMatchIndex?: number;
  annotations?: Annotation[];
  onSelectionChange?: (selection: PdfTextSelection | null) => void;
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
  fitMode = "fit_width",
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
  const textLayerSelectionCleanupByIndexRef = useRef(new Map<number, () => void>());
  const linkLayerHostByIndexRef = useRef(new Map<number, HTMLDivElement>());

  const renderWorkByIndexRef = useRef(new Map<number, RenderWork>());
  const renderedAtZoomByIndexRef = useRef(new Map<number, number>());
  const textDivsByIndexRef = useRef(new Map<number, HTMLElement[]>());
  const textDivStringsByIndexRef = useRef(new Map<number, string[]>());
  const [textLayerReadyByPage, setTextLayerReadyByPage] = useState<Record<number, boolean>>({});
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);
  const dominantPageIndexRef = useRef(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [pageWidthAtScale1, setPageWidthAtScale1] = useState<number | null>(null);
  const readableStreamWarningShownRef = useRef(false);
  const textLayerFailureShownRef = useRef(false);
  const [textLayerFailureMessage, setTextLayerFailureMessage] = useState("");

  const textLayerFailureMessageForRuntime = () => {
    const diag = getRuntimePolyfillDiagnostics();
    if (diag.readableStreamOverrideFailed) {
      return "Text layer failed to load in this build. Text selection and search are disabled. Update Paper Reader to a newer desktop build to enable them.";
    }
    return "Text layer failed to load in this build. Text selection and search are disabled.";
  };

  // PDF text selection/search/highlights are driven by pdf.js' TextLayer, not server-side content_status.
  // If the TextLayer can't render, we keep canvas + annotation layers and disable text tools per page.
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
  const effectiveZoomRef = useRef(effectiveZoom);
  useEffect(() => {
    effectiveZoomRef.current = effectiveZoom;
  }, [effectiveZoom]);

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

  useEffect(() => {
    const element = scrollRootRef.current;
    if (!element) return;

    const update = () => setStageWidth(element.getBoundingClientRect().width);
    update();

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => update());
      ro.observe(element);
      return () => ro.disconnect();
    }

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

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
    textLayerFailureShownRef.current = false;
    setTextLayerFailureMessage("");

    for (const cleanup of textLayerSelectionCleanupByIndexRef.current.values()) cleanup();
    textLayerSelectionCleanupByIndexRef.current.clear();

    for (const host of textLayerHostByIndexRef.current.values()) clearChildren(host);
    for (const host of linkLayerHostByIndexRef.current.values()) clearChildren(host);
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

        // Capture a stable baseline width so fit-to-width can compute zoom without CSS scaling.
        try {
          const firstPage = await pdfDocument.getPage(1);
          const viewport = firstPage.getViewport({ scale: 1 });
          setPageWidthAtScale1(viewport.width);
        } catch {
          // Non-fatal: fall back to the caller-provided zoom.
          setPageWidthAtScale1(null);
        }

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
  }, [effectiveZoom, pdfDocument]);

  const pageShellStyleVars = useMemo((): CSSProperties => {
    const scale = effectiveZoom / 100;
    return {
      // pdf.js layer sizing depends on these vars via setLayerDimensions().
      // Keep them on the page shell so text/annotation layers inherit.
      ["--scale-factor" as never]: String(scale),
      ["--user-unit" as never]: "1",
      ["--scale-round-x" as never]: "1px",
      ["--scale-round-y" as never]: "1px",
      ["--total-scale-factor" as never]: "calc(var(--scale-factor) * var(--user-unit))",
    } as unknown as CSSProperties;
  }, [effectiveZoom]);

  const navigateToDestination = async (pdfDocument: PDFDocumentProxy, dest: unknown) => {
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

  const isAllowedExternalUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const renderPageIfNeeded = async (pageIndex0: number) => {
    const doc = pdfDocumentRef.current;
    if (!doc) return;
    if (pdfDocument !== doc) return;
    const currentZoom = effectiveZoomRef.current;
    if (renderedAtZoomByIndexRef.current.get(pageIndex0) === currentZoom) return;

    const canvas = canvasByIndexRef.current.get(pageIndex0);
    const textHost = textLayerHostByIndexRef.current.get(pageIndex0);
    const linkHost = linkLayerHostByIndexRef.current.get(pageIndex0);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !textHost || !linkHost) return;

    const token = Symbol(`render-page-${pageIndex0}-${currentZoom}`);
    const previous = renderWorkByIndexRef.current.get(pageIndex0);
    previous?.renderTask?.cancel();
    previous?.textLayer?.cancel();
    renderWorkByIndexRef.current.set(pageIndex0, { renderTask: null, textLayer: null, token });

    setTextLayerReadyByPage((current) => (current[pageIndex0] ? { ...current, [pageIndex0]: false } : current));
    textLayerSelectionCleanupByIndexRef.current.get(pageIndex0)?.();
    textLayerSelectionCleanupByIndexRef.current.delete(pageIndex0);
    clearChildren(textHost);
    clearChildren(linkHost);
    textDivsByIndexRef.current.delete(pageIndex0);
    textDivStringsByIndexRef.current.delete(pageIndex0);

    try {
      const pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pageProxy = await doc.getPage(pageIndex0 + 1);
      const viewport = pageProxy.getViewport({ scale: currentZoom / 100 });

      // Canvas render
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const renderTask = pageProxy.render({ canvasContext: ctx, canvas, viewport });
      renderWorkByIndexRef.current.set(pageIndex0, { renderTask, textLayer: null, token });
      await renderTask.promise;

      const activeWork = renderWorkByIndexRef.current.get(pageIndex0);
      if (!activeWork || activeWork.token !== token) return;
      renderWorkByIndexRef.current.set(pageIndex0, { renderTask: null, textLayer: null, token });

      renderedAtZoomByIndexRef.current.set(pageIndex0, currentZoom);

      // Text layer (optional)
      if (textEnabled) {
        let itemsLengthForFailure = 0;
        try {
          const textContent = await pageProxy.getTextContent();
          const itemsLength = (textContent as unknown as { items?: unknown[] }).items?.length ?? 0;
          itemsLengthForFailure = itemsLength;
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
          if (!readableStreamWarningShownRef.current && itemsLength > 0 && divs.length === 0) {
            readableStreamWarningShownRef.current = true;
            // eslint-disable-next-line no-console
            console.warn(
              "PDF text layer rendered zero spans despite non-empty textContent; ReadableStream polyfill may be incomplete.",
            );
          }
          if (itemsLength > 0 && divs.length === 0 && !textLayerFailureShownRef.current) {
            textLayerFailureShownRef.current = true;
            setTextLayerFailureMessage(textLayerFailureMessageForRuntime());
          }
          divs.forEach((div, index) => {
            div.dataset.divIndex = String(index);
          });
          textDivsByIndexRef.current.set(pageIndex0, divs);
          textDivStringsByIndexRef.current.set(pageIndex0, strings);
          setTextLayerReadyByPage((current) => ({ ...current, [pageIndex0]: divs.length > 0 }));
          setTextLayerEpoch((current) => current + 1);
          if (divs.length > 0) {
            textLayerSelectionCleanupByIndexRef.current.set(
              pageIndex0,
              installPdfJsTextLayerSelectionSupport(textHost),
            );
          }
        } catch (error) {
          if (isCancellationError(error)) return;
          if (itemsLengthForFailure > 0 && !textLayerFailureShownRef.current) {
            textLayerFailureShownRef.current = true;
            setTextLayerFailureMessage(textLayerFailureMessageForRuntime());
          }
          clearChildren(textHost);
          setTextLayerReadyByPage((current) => ({ ...current, [pageIndex0]: false }));
        }
      }

      // Internal link overlay (avoid pdf.js AnnotationLayer/linkService compatibility issues)
      try {
        const annotations = await pageProxy.getAnnotations({ intent: "display" });
        const linkAnnotations = (annotations as Array<unknown>)
          .map(
            (annotation) =>
              annotation as Partial<{
                subtype: unknown;
                rect: unknown;
                dest: unknown;
                url: unknown;
                unsafeUrl: unknown;
              }>,
          )
          .filter(
            (annotation) =>
              annotation.subtype === "Link" &&
              Array.isArray(annotation.rect) &&
              annotation.rect.length === 4 &&
              annotation.rect.every((value) => typeof value === "number" && Number.isFinite(value)) &&
              (annotation.dest !== undefined && annotation.dest !== null
                ? true
                : typeof annotation.url === "string"
                  ? isAllowedExternalUrl(annotation.url)
                  : typeof annotation.unsafeUrl === "string"
                    ? isAllowedExternalUrl(annotation.unsafeUrl)
                    : false),
          )
          .map((annotation) => {
            const rawUrl =
              typeof annotation.url === "string"
                ? annotation.url
                : typeof annotation.unsafeUrl === "string"
                  ? annotation.unsafeUrl
                  : null;
            return {
              rect: annotation.rect as number[],
              dest: annotation.dest as unknown,
              url: rawUrl && isAllowedExternalUrl(rawUrl) ? rawUrl : null,
            };
          });

        let internalIndex = 0;
        let externalIndex = 0;
        for (let i = 0; i < linkAnnotations.length; i += 1) {
          const link = linkAnnotations[i];
          const rect =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            typeof (viewport as any).convertToViewportRectangle === "function"
              ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ((viewport as any).convertToViewportRectangle(link.rect) as number[])
              : link.rect;
          const [x1, y1, x2, y2] = rect;
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.abs(x2 - x1);
          const height = Math.abs(y2 - y1);

          const button = document.createElement("button");
          button.type = "button";
          button.className = "pdf-link-overlay";
          button.style.position = "absolute";
          button.style.left = `${left}px`;
          button.style.top = `${top}px`;
          button.style.width = `${width}px`;
          button.style.height = `${height}px`;
          button.style.background = "transparent";
          button.style.border = "none";
          button.style.padding = "0";
          button.style.margin = "0";
          button.style.cursor = "pointer";
          button.style.pointerEvents = "auto";
          const isInternal = link.dest !== undefined && link.dest !== null;
          if (isInternal) {
            if (internalIndex === 0) button.setAttribute("data-testid", "internal-link");
            internalIndex += 1;
            button.setAttribute("aria-label", "PDF internal link");
          } else if (link.url) {
            if (externalIndex === 0) button.setAttribute("data-testid", "external-link");
            externalIndex += 1;
            button.setAttribute("aria-label", "PDF external link");
          } else {
            continue;
          }

          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isInternal) {
              void navigateToDestination(doc, link.dest);
              return;
            }
            if (link.url) {
              void openExternal(link.url).catch(() => {});
            }
          });

          linkHost.appendChild(button);
        }
      } catch (error) {
        if (isCancellationError(error)) return;
        // Non-fatal.
        clearChildren(linkHost);
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
  }, [pdfDocument, pageCount, effectiveZoom]);

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
    const renderedPages = Object.keys(textLayerReadyByPage)
      .map(Number)
      .filter((p) => textLayerReadyByPage[p]);
    if (renderedPages.length === 0) return [];

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loweredSearch, textEnabled, textLayerEpoch, effectiveZoom, view.primary_attachment_id]);

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
  }, [
    activeSearchMatchIndex,
    loweredSearch,
    searchMatches.length,
    textEnabled,
  ]);

  const anchorsForActivePage = useMemo(() => {
    if (!textEnabled) return [];
    return annotations
      .map((annotation) => ({ annotation, anchor: parsePdfTextAnchor(annotation.anchor) }))
      .filter((entry) => entry.anchor && entry.annotation.kind === "highlight")
      .map((entry) => entry.anchor as PdfTextAnchor);
  }, [annotations, textEnabled]);

  useEffect(() => {
    if (!textEnabled) return;

    const renderedPages = Object.keys(textLayerReadyByPage)
      .map(Number)
      .filter((p) => textLayerReadyByPage[p]);
    if (renderedPages.length === 0) return;

    const totalMatches = searchMatches.length;
    const normalizedActive =
      totalMatches > 0 ? ((activeSearchMatchIndex % totalMatches) + totalMatches) % totalMatches : -1;
    let activeMatchPageIndex: number | null = null;

    for (const pageIndex of renderedPages) {
      const host = textLayerHostByIndexRef.current.get(pageIndex);
      const divs = textDivsByIndexRef.current.get(pageIndex) ?? [];
      const plain = textDivStringsByIndexRef.current.get(pageIndex) ?? [];
      if (!host || divs.length === 0 || plain.length === 0) continue;

      // Annotations for this page.
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

      // Search matches for this page.
      const pageMatches = searchMatches.filter((m) => m.pageIndex === pageIndex);

      for (let divIndex = 0; divIndex < divs.length; divIndex += 1) {
        const div = divs[divIndex];
        const text = plain[divIndex] ?? "";
        const paints = new Array<string | null>(text.length).fill(null);
        for (const range of annotationRangesByDiv.get(divIndex) ?? []) {
          const start = Math.max(0, Math.min(range.start, text.length));
          const end = Math.max(0, Math.min(range.end, text.length));
          for (let i = start; i < end; i += 1) {
            paints[i] = range.color ?? "__default";
          }
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
          annotationRanges.push({
            start: paintCursor,
            end,
            color: color === "__default" ? undefined : color,
          });
          paintCursor = end;
        }

        const searchRanges: Array<{ start: number; end: number; hitIndex: number }> = [];
        if (pageMatches.length > 0) {
          for (const match of pageMatches) {
            if (match.divIndex !== divIndex) continue;
            const range = { start: match.start, end: match.end };
            let overlapsAnnotation = false;
            for (let i = Math.max(0, range.start); i < Math.min(text.length, range.end); i += 1) {
              if (paints[i]) {
                overlapsAnnotation = true;
                break;
              }
            }
            if (overlapsAnnotation) continue;
            // hitIndex here is the global index from searchMatches
            const hitIndex = searchMatches.indexOf(match);
            if (hitIndex === normalizedActive) activeMatchPageIndex = pageIndex;
            searchRanges.push({ ...range, hitIndex });
          }
        }

        const mergedSearch = [...searchRanges].sort((a, b) => a.start - b.start || a.end - b.end);

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
          ...mergedSearch.map((range) => ({ ...range, kind: "search" as const })),
        ].sort((a, b) => a.start - b.start || a.end - b.end);

        let cursor = 0;
        for (const range of all) {
          if (range.start > cursor) pushText(text.slice(cursor, range.start));
          const slice = text.slice(range.start, range.end);
          if (slice.length === 0) continue;
          if (range.kind === "annotation") {
            segments.push({
              kind: "annotation",
              value: slice,
              color: (range as { color?: string }).color,
            });
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
              const attr = segment.color ? ` data-color="${escapeHtml(segment.color)}"` : "";
              return `<span class="pdf-annotation-highlight"${attr}>${escapeHtml(segment.value)}</span>`;
            }
            const active = segment.hitIndex === normalizedActive ? " pdf-search-hit-active" : "";
            const attr = segment.hitIndex >= 0 ? ` data-hit-index="${segment.hitIndex}"` : "";
            return `<span class="pdf-search-hit${active}"${attr}>${escapeHtml(segment.value)}</span>`;
          })
          .join("");
      }
    }

    if (normalizedActive >= 0 && activeMatchPageIndex !== null) {
      const activeHost = textLayerHostByIndexRef.current.get(activeMatchPageIndex);
      if (activeHost) {
        const active = activeHost.querySelector(
          `.pdf-search-hit-active`,
        ) as HTMLElement | null;
        if (active) {
          safeScrollIntoView(active, { block: "center" });
          if (activeMatchPageIndex !== dominantPageIndexRef.current) {
            onActivePageChangeRef.current?.(activeMatchPageIndex);
          }
        }
      }
    }
  }, [
    activeSearchMatchIndex,
    anchorsForActivePage,
    loweredSearch,
    searchMatches,
    textEnabled,
    textLayerEpoch,
    textLayerReadyByPage,
  ]);

  const closestPageIndex = (node: Node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const shell = element?.closest?.("[data-page-index]") as HTMLElement | null;
    const index = shell?.dataset.pageIndex ? Number(shell.dataset.pageIndex) : NaN;
    return Number.isFinite(index) ? index : null;
  };

  const buildSelectionAnchor = (): PdfTextSelection | null => {
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

    const divs = textDivsByIndexRef.current.get(startPage) ?? [];
    return buildPdfTextSelectionFromRange({
      quote,
      range,
      host,
      divs,
      pageNumber1: startPage + 1,
    });
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
      const next = buildSelectionAnchor();
      const nextKey = keyFor(next);
      if (nextKey === lastKey) return;
      lastKey = nextKey;
      onSelectionChange(next);
    };

    document.addEventListener("selectionchange", onSelectionChangeEvent);
    return () => document.removeEventListener("selectionchange", onSelectionChangeEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectionChange, page, status, textEnabled, view.primary_attachment_id, textLayerEpoch]);

  return (
    <section className="pdf-reader pdf-reader-focus" data-testid="pdf-reader" ref={scrollRootRef}>
      <div className="pdf-stage">
        {status === "loading" ? <p>Loading PDF...</p> : null}
        {status === "error" ? <p>Unable to load this PDF. {errorMessage}</p> : null}
        {status !== "error" && textLayerFailureMessage ? (
          <p className="pdf-text-layer-notice" role="note">
            {textLayerFailureMessage}
          </p>
        ) : null}

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
              style={{ position: "relative" }}
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
                style={{ display: "block" }}
              />
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
                  pointerEvents: textEnabled && textLayerReadyByPage[index] ? "auto" : "none",
                  userSelect: textEnabled && textLayerReadyByPage[index] ? "text" : "none",
                }}
              />
              <div
                aria-label={`PDF page ${index + 1} link layer`}
                className="pdf-link-layer"
                ref={(element) => {
                  if (!element) {
                    linkLayerHostByIndexRef.current.delete(index);
                    return;
                  }
                  linkLayerHostByIndexRef.current.set(index, element);
                }}
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
