import { useEffect, useMemo, useRef, useState } from "react";

import type { Annotation, OcrPdfPageInput, OcrPageResult, ReaderView } from "../../lib/contracts";
import { clearChildren, safeScrollIntoView } from "../../lib/dom";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { TextLayer } from "pdfjs-dist/types/src/display/text_layer";
import type { CSSProperties } from "react";

import { computeFitWidthZoomPct } from "./pdfFit";
import {
  buildPdfTextSelectionFromRange,
  parsePdfTextAnchor,
  type PdfTextAnchor,
  type PdfTextSelection,
} from "./pdfSelection";
import { installPdfJsTextLayerSelectionSupport } from "./pdfTextLayerSelectionSupport";
import { buildOcrTextLayer } from "./pdfOcrTextLayer";
import { OCR_CONFIG_VERSION } from "./pdfOcrConfig";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getRuntimePolyfillDiagnostics } from "../../lib/runtimePolyfills";
import { logEvent, textForLog } from "../../lib/clientEventLog";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type PdfReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  fitMode?: "manual" | "fit_width";
  mode?: "workspace" | "focus";
  loadPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  ocrPdfPage?: (input: OcrPdfPageInput) => Promise<OcrPageResult>;
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
  loadPrimaryAttachmentBytes,
  ocrPdfPage,
  onPageCountChange,
  onNavigateToPage,
  searchQuery = "",
  activeSearchMatchIndex = 0,
  annotations = [],
  onSelectionChange,
  onSearchMatchesChange,
}: PdfReaderProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerHostRef = useRef<HTMLDivElement | null>(null);
  const linkLayerHostRef = useRef<HTMLDivElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const textDivsRef = useRef<HTMLElement[]>([]);
  const textDivStringsRef = useRef<string[]>([]);
  const textLayerSelectionCleanupRef = useRef<(() => void) | null>(null);
  const [textLayerReady, setTextLayerReady] = useState(false);
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);
  const onPageCountChangeRef = useRef(onPageCountChange);
  const onNavigateToPageRef = useRef(onNavigateToPage);
  const [pageCount, setPageCount] = useState(view.page_count);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [stageWidth, setStageWidth] = useState(0);
  const [pageWidthAtScale1, setPageWidthAtScale1] = useState<number | null>(null);
  const readableStreamWarningShownRef = useRef(false);
  const textLayerFailureShownRef = useRef(false);
  const [textLayerFailureMessage, setTextLayerFailureMessage] = useState("");
  const [ocrNotice, setOcrNotice] = useState("");

  const textLayerFailureMessageForRuntime = () => {
    const diag = getRuntimePolyfillDiagnostics();
    if (diag.readableStreamOverrideFailed) {
      return "Text layer failed to load in this build. Text selection and search are disabled. Update Paper Reader to a newer desktop build to enable them.";
    }
    return "Text layer failed to load in this build. Text selection and search are disabled.";
  };

  // PDF text selection/search/highlights are driven by pdf.js' TextLayer, not server-side content_status.
  // If the TextLayer can't render (old WebKit, etc), we keep the canvas visible and disable tools.
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
  const pageShellStyleVars = useMemo((): CSSProperties => {
    const scale = effectiveZoom / 100;
    return {
      // pdf.js layer sizing depends on these vars via setLayerDimensions().
      ["--scale-factor" as never]: String(scale),
      ["--user-unit" as never]: "1",
      ["--scale-round-x" as never]: "1px",
      ["--scale-round-y" as never]: "1px",
      ["--total-scale-factor" as never]: "calc(var(--scale-factor) * var(--user-unit))",
    } as unknown as CSSProperties;
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

  const cancelRenderWork = () => {
    const activeRenderTask = renderTaskRef.current;
    renderTaskRef.current = null;
    activeRenderTask?.cancel();

    textLayerSelectionCleanupRef.current?.();
    textLayerSelectionCleanupRef.current = null;

    const activeTextLayer = textLayerRef.current;
    textLayerRef.current = null;
    activeTextLayer?.cancel();
    textDivsRef.current = [];
    textDivStringsRef.current = [];
    setTextLayerReady(false);
    setTextLayerEpoch((current) => current + 1);
    textLayerFailureShownRef.current = false;
    setTextLayerFailureMessage("");
    setOcrNotice("");
    if (textLayerHostRef.current) {
      clearChildren(textLayerHostRef.current);
    }
    if (linkLayerHostRef.current) {
      clearChildren(linkLayerHostRef.current);
    }
  };

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    onNavigateToPageRef.current = onNavigateToPage;
  }, [onNavigateToPage]);

  useEffect(() => {
    const element = stageRef.current;
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

      const selection = window.getSelection?.();
      const rangeCount = selection?.rangeCount ?? 0;
      const quote = selection?.toString?.() ?? "";
      const quoteMeta = textForLog(quote) ?? { text_len: 0, text_snippet: "" };
      let insideTextLayer = false;
      let nearestDivIndex: string | null = null;
      try {
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const host = textLayerHostRef.current;
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
        rangeCount,
        insideTextLayer,
        nearestDivIndex,
        ...quoteMeta,
      });
      onSelectionChange(next);
    };

    document.addEventListener("selectionchange", onSelectionChangeEvent);
    return () => document.removeEventListener("selectionchange", onSelectionChangeEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectionChange, page, status, textLayerReady, textEnabled, textLayerEpoch, view.primary_attachment_id]);

  useEffect(() => {
    const host = textLayerHostRef.current;
    if (!host) return;

    const onPointerDownCapture = (event: PointerEvent) => {
      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      logEvent("pdf_pointerdown", {
        pageIndex0: page,
        clientX: event.clientX,
        clientY: event.clientY,
        element: el
          ? {
              tag: el.tagName.toLowerCase(),
              className: el.className || "",
              ariaLabel: el.getAttribute("aria-label") || "",
            }
          : null,
      });
    };

    host.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => host.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, [page, textLayerEpoch]);

  const lastTextLayerReadyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastTextLayerReadyRef.current === textLayerReady) return;
    lastTextLayerReadyRef.current = textLayerReady;
    logEvent("textlayer_ready_state", {
      pageIndex0: page,
      ready: textLayerReady,
      divCount: textDivsRef.current.length,
      stringsCount: textDivStringsRef.current.length,
    });
  }, [page, textLayerReady, textLayerEpoch]);

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
      const renderStart = performance.now();
      const currentDocument = pdfDocumentRef.current;
      if (!currentDocument) return;
      if (pdfDocument !== currentDocument) return;

      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const textLayerHost = textLayerHostRef.current;
      const linkLayerHost = linkLayerHostRef.current;
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
      if (!linkLayerHost) {
        setStatus("error");
        setErrorMessage("Unable to load this PDF because the link layer container is unavailable.");
        return;
      }

      cancelRenderWork();
      if (cancelled) return;

      setStatus("loading");
      setErrorMessage("");
      setTextLayerReady(false);
      textLayerFailureShownRef.current = false;
      setTextLayerFailureMessage("");

      try {
        const pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const nextPageCount = currentDocument.numPages ?? view.page_count ?? 1;

        const currentPage = await currentDocument.getPage(Math.min(page + 1, nextPageCount));
        if (cancelled) return;

        const scale1Viewport = currentPage.getViewport({ scale: 1 });
        setPageWidthAtScale1(scale1Viewport.width);

        const viewport = currentPage.getViewport({ scale: effectiveZoom / 100 });
        const outputScale = Math.min(2, window.devicePixelRatio || 1);
        logEvent("pdf_render_start", {
          pageIndex0: page,
          zoomPct: effectiveZoom,
          devicePixelRatio: window.devicePixelRatio || 1,
          outputScale,
          viewport: { width: viewport.width, height: viewport.height },
        });
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const renderTask = currentPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        if (cancelled) return;
        if (renderTaskRef.current !== renderTask) return;

        renderTaskRef.current = null;

        setStatus("ready");
        logEvent("pdf_render_done", {
          pageIndex0: page,
          zoomPct: effectiveZoom,
          durationMs: Math.round(performance.now() - renderStart),
        });

        // Internal link overlay (avoid pdf.js AnnotationLayer/linkService compatibility issues).
        try {
          clearChildren(linkLayerHost);
          const annotations = await currentPage.getAnnotations({ intent: "display" });
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
                void navigateToDestination(currentDocument, link.dest);
                return;
              }
              if (link.url) {
                void openExternal(link.url).catch(() => {});
              }
            });

            linkLayerHost.appendChild(button);
          }
        } catch (error) {
          if (cancelled) return;
          if (isCancellationError(error)) return;
          clearChildren(linkLayerHost);
        }

        // Text layer is optional. Some WKWebView builds are missing modern web APIs
        // that pdf.js uses internally; keep the page visible even if text fails.
        if (textEnabled) {
          let itemsLengthForFailure = 0;
          let attemptedOcr = false;
          try {
            clearChildren(textLayerHost);
            const textLayerStart = performance.now();
            const textContent = await currentPage.getTextContent();
            const itemsLength = (textContent as unknown as { items?: unknown[] }).items?.length ?? 0;
            itemsLengthForFailure = itemsLength;
            if (cancelled) return;

            logEvent("textlayer_render_start", {
              pageIndex0: page,
              itemsLength,
            });
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
            if (
              !readableStreamWarningShownRef.current &&
              itemsLength > 0 &&
              textDivsRef.current.length === 0
            ) {
              readableStreamWarningShownRef.current = true;
              // eslint-disable-next-line no-console
              console.warn(
                "PDF text layer rendered zero spans despite non-empty textContent; ReadableStream polyfill may be incomplete.",
              );
            }
            if (itemsLength > 0 && textDivsRef.current.length === 0 && !textLayerFailureShownRef.current) {
              textLayerFailureShownRef.current = true;
              setTextLayerFailureMessage(textLayerFailureMessageForRuntime());
            }
            textDivsRef.current.forEach((div, index) => {
              div.dataset.divIndex = String(index);
            });
            const ready = textDivsRef.current.length > 0;
            setTextLayerReady(ready);
            logEvent("textlayer_render_done", {
              pageIndex0: page,
              itemsLength,
              divCount: textDivsRef.current.length,
              durationMs: Math.round(performance.now() - textLayerStart),
              ready,
            });
            if (ready) {
              textLayerSelectionCleanupRef.current =
                installPdfJsTextLayerSelectionSupport(textLayerHost);
              setOcrNotice("");
            }

            // OCR fallback: scanned/image-only PDFs often have empty textContent/items.
            if (!ready && (itemsLength === 0 || textDivsRef.current.length === 0)) {
              if (!ocrPdfPage) {
                setOcrNotice("No text layer found. OCR is unavailable in this build.");
                return;
              }
              attemptedOcr = true;
              setOcrNotice("No text layer found; running OCR...");

              const primaryAttachmentId = view.primary_attachment_id;
              if (!primaryAttachmentId) return;
              const ocrToken = Symbol(`ocr-${primaryAttachmentId}-${page}-${effectiveZoom}`);
              const offscreen = document.createElement("canvas");
              const offscreenCtx = offscreen.getContext("2d");
              if (!offscreenCtx) throw new Error("OCR canvas unavailable");

              const scale1 = currentPage.getViewport({ scale: 1 });
              const targetWidthPx = 2400;
              const ocrScale = Math.max(1, Math.min(4, targetWidthPx / Math.max(1, scale1.width)));
              const ocrViewport = currentPage.getViewport({ scale: ocrScale });
              offscreen.width = Math.floor(ocrViewport.width);
              offscreen.height = Math.floor(ocrViewport.height);
              logEvent("ocr_start", {
                pageIndex0: page,
                ocrScale,
                offscreen: { width: offscreen.width, height: offscreen.height },
              });

              const ocrRender = currentPage.render({
                canvas: offscreen,
                canvasContext: offscreenCtx,
                viewport: ocrViewport,
              });
              await ocrRender.promise;
              if (cancelled) return;
              void ocrToken; // keep token for potential future expansion

              const pngBlob: Blob | null = await new Promise((resolve) =>
                offscreen.toBlob((blob) => resolve(blob), "image/png"),
              );
              if (!pngBlob) throw new Error("Unable to rasterize page for OCR");
              const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
              logEvent("ocr_rasterized", { pageIndex0: page, pngBytesLength: pngBytes.length });

              let result: OcrPageResult;
              try {
                result = await ocrPdfPage({
                  primary_attachment_id: primaryAttachmentId,
                  page_index0: page,
                  png_bytes: pngBytes,
                  lang: "eng+chi_sim",
                  config_version: OCR_CONFIG_VERSION,
                  source_resolution: 300,
                });
              } catch (error) {
                setOcrNotice(`OCR failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                logEvent("ocr_error", {
                  pageIndex0: page,
                  error: error instanceof Error ? error.message : "unknown",
                });
                return;
              }
              if (cancelled) return;
              if (result.page_index0 !== page) return;

              const line0 = result.lines[0]?.text ?? "";
              const lineMeta = textForLog(line0) ?? { text_len: 0, text_snippet: "" };
              logEvent("ocr_done", {
                pageIndex0: page,
                linesCount: result.lines.length,
                sample: lineMeta,
              });
              clearChildren(textLayerHost);
              const built = buildOcrTextLayer({
                host: textLayerHost,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                lines: result.lines,
              });
              textDivsRef.current = built.divs;
              textDivStringsRef.current = built.strings;
              const ocrReady = built.divs.length > 0;
              setTextLayerReady(ocrReady);
              setTextLayerEpoch((current) => current + 1);
              if (ocrReady) {
                textLayerSelectionCleanupRef.current =
                  installPdfJsTextLayerSelectionSupport(textLayerHost);
                setOcrNotice("");
              } else {
                setOcrNotice("OCR completed but no text was recognized.");
                logEvent("ocr_empty", { pageIndex0: page });
              }
            }
          } catch (error) {
            if (cancelled) return;
            if (isCancellationError(error)) return;
            logEvent("textlayer_error", {
              pageIndex0: page,
              error: error instanceof Error ? error.message : "unknown",
            });
            // Best effort: if the PDF is expected to have text, make the failure visible to users.
            if (itemsLengthForFailure > 0 && !textLayerFailureShownRef.current) {
              textLayerFailureShownRef.current = true;
              setTextLayerFailureMessage(textLayerFailureMessageForRuntime());
            }
            // Non-fatal: keep the canvas, just disable text/search/highlights.
            textLayerRef.current = null;
            textDivsRef.current = [];
            textDivStringsRef.current = [];
            setTextLayerReady(false);
            setTextLayerEpoch((current) => current + 1);
            if (textLayerHostRef.current) clearChildren(textLayerHostRef.current);
            // Best effort logging for debugging old WebKit builds.
            // eslint-disable-next-line no-console
            console.warn("PDF text layer unavailable:", error);

            // If pdf.js fails to render text spans, try OCR as a last resort.
            if (!attemptedOcr && view.primary_attachment_id && ocrPdfPage) {
              try {
                setOcrNotice("Text layer failed; running OCR...");
                const primaryAttachmentId = view.primary_attachment_id;
                if (!primaryAttachmentId) return;
                const offscreen = document.createElement("canvas");
                const offscreenCtx = offscreen.getContext("2d");
                if (!offscreenCtx) return;

                const scale1 = currentPage.getViewport({ scale: 1 });
                const targetWidthPx = 2400;
                const ocrScale = Math.max(1, Math.min(4, targetWidthPx / Math.max(1, scale1.width)));
                const ocrViewport = currentPage.getViewport({ scale: ocrScale });
                offscreen.width = Math.floor(ocrViewport.width);
                offscreen.height = Math.floor(ocrViewport.height);
                logEvent("ocr_start", {
                  pageIndex0: page,
                  ocrScale,
                  offscreen: { width: offscreen.width, height: offscreen.height },
                  fallback: "textlayer_error",
                });
                const ocrRender = currentPage.render({
                  canvas: offscreen,
                  canvasContext: offscreenCtx,
                  viewport: ocrViewport,
                });
                await ocrRender.promise;
                if (cancelled) return;

                const pngBlob: Blob | null = await new Promise((resolve) =>
                  offscreen.toBlob((blob) => resolve(blob), "image/png"),
                );
                if (!pngBlob) return;
                const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
                let result: OcrPageResult;
                try {
                  result = await ocrPdfPage({
                    primary_attachment_id: primaryAttachmentId,
                    page_index0: page,
                    png_bytes: pngBytes,
                    lang: "eng+chi_sim",
                    config_version: OCR_CONFIG_VERSION,
                    source_resolution: 300,
                  });
                } catch (error) {
                  setOcrNotice(`OCR failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                  logEvent("ocr_error", {
                    pageIndex0: page,
                    error: error instanceof Error ? error.message : "unknown",
                  });
                  return;
                }
                if (cancelled) return;
                if (result.page_index0 !== page) return;
                const line0 = result.lines[0]?.text ?? "";
                const lineMeta = textForLog(line0) ?? { text_len: 0, text_snippet: "" };
                logEvent("ocr_done", {
                  pageIndex0: page,
                  linesCount: result.lines.length,
                  sample: lineMeta,
                });
                clearChildren(textLayerHost);
                const built = buildOcrTextLayer({
                  host: textLayerHost,
                  viewportWidth: viewport.width,
                  viewportHeight: viewport.height,
                  lines: result.lines,
                });
                textDivsRef.current = built.divs;
                textDivStringsRef.current = built.strings;
                const ocrReady = built.divs.length > 0;
                setTextLayerReady(ocrReady);
                setTextLayerEpoch((current) => current + 1);
                if (ocrReady) {
                  textLayerSelectionCleanupRef.current =
                    installPdfJsTextLayerSelectionSupport(textLayerHost);
                  setOcrNotice("");
                } else {
                  logEvent("ocr_empty", { pageIndex0: page });
                }
              } catch (error) {
                setOcrNotice(`OCR failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                logEvent("ocr_error", {
                  pageIndex0: page,
                  error: error instanceof Error ? error.message : "unknown",
                });
              }
            }
          }
        }
      } catch (error) {
        if (cancelled) return;
        if (isCancellationError(error)) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unknown PDF rendering error.");
        logEvent("pdf_render_error", {
          pageIndex0: page,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      cancelRenderWork();
    };
  }, [effectiveZoom, ocrPdfPage, page, pdfDocument, textEnabled, view.page_count, view.primary_attachment_id]);

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
  }, [loweredSearch, textEnabled, textLayerEpoch, status, page, effectiveZoom, view.primary_attachment_id]);

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

    // Build per-div highlight ranges for annotations. We'll "paint" per character so overlapping
    // highlights can still carry color without breaking cursor-based segment rendering.
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
    const normalizedActive =
      totalMatches > 0 ? ((activeSearchMatchIndex % totalMatches) + totalMatches) % totalMatches : -1;

    // Apply decorations div-by-div, always starting from the pdf.js-provided plain text.
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
      if (searchMatches.length > 0) {
        for (let hitIndex = 0; hitIndex < searchMatches.length; hitIndex += 1) {
          const match = searchMatches[hitIndex];
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
    textLayerEpoch,
  ]);

  const buildSelectionAnchor = (): PdfTextSelection | null => {
    if (!textEnabled) return null;
    const host = textLayerHostRef.current;
    if (!host) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    const quote = selection.toString();
    if (!quote || quote.trim().length === 0) return null;

    const range = selection.getRangeAt(0);
    return buildPdfTextSelectionFromRange({
      quote,
      range,
      host,
      divs: textDivsRef.current,
      pageNumber1: page + 1,
    });
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
          {effectiveZoom !== 100 ? <span className="meta-count">Zoom {effectiveZoom}%</span> : null}
        </div>
      ) : null}

      <div
        className={showChrome ? "citation-card" : "pdf-stage"}
        ref={stageRef}
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
        {status !== "error" && textLayerFailureMessage ? (
          <p className="pdf-text-layer-notice" role="note">
            {textLayerFailureMessage}
          </p>
        ) : null}
        {status !== "error" && ocrNotice ? (
          <p className="pdf-text-layer-notice" role="note">
            {ocrNotice}
          </p>
        ) : null}

        <div
          style={{
            position: "relative",
            display: status === "error" ? "none" : "block",
            ...pageShellStyleVars,
          }}
        >
          <canvas aria-label="PDF page canvas" ref={canvasRef} style={{ display: "block" }} />
          <div
            aria-label="PDF text layer"
            className="pdf-text-layer textLayer"
            ref={textLayerHostRef}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: textEnabled && textLayerReady ? "auto" : "none",
              userSelect: textEnabled && textLayerReady ? "text" : "none",
            }}
          />
          <div
            aria-label="PDF link layer"
            className="pdf-link-layer"
            ref={linkLayerHostRef}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          />
        </div>
      </div>
    </section>
  );
}
