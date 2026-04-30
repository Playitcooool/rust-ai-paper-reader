import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type {
  Annotation,
  OcrPdfPageInput,
  PdfDocumentInfo,
  PdfEngineGetPageBundleInput,
  PdfPageText,
  ReaderView,
} from "../../lib/contracts";
import { clearChildren, safeScrollIntoView } from "../../lib/dom";
import { computeFitWidthZoomPct } from "./pdfFit";
import { computeActivePageIndexFromRects } from "./pdfContinuousActivePage";
import { buildOcrTextLayer } from "./pdfOcrTextLayer";
import {
  buildPdfTextSelectionFromRange,
  parsePdfTextAnchor,
  type PdfTextAnchor,
  type PdfSelectionRect,
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

const widthBucket = (widthPx: number) => Math.max(1, Math.ceil(widthPx / 64) * 64);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const PREFETCH_PAGE_RADIUS = 2;
const SEARCH_TARGET_RENDER_RADIUS = 1;
const PAGE_TEXT_CACHE_LIMIT = 32;
const ACTIVE_PAGE_ANCHOR_RATIO = 0.38;
const OCR_CONFIG_VERSION = "pdf-native-fallback-v1";
const SUSPICIOUS_TEXT_RATIO_THRESHOLD = 0.12;
const SUSPICIOUS_CHAR_RE = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/g;
const MAX_INITIAL_RASTER_SCALE = 1;
const MAX_RASTER_SCALE = 2;
const OCR_CONCURRENCY = 1;

type PdfContinuousReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
  fitMode?: "manual" | "fit_width";
  getPdfDocumentInfo: (primaryAttachmentId: number) => Promise<PdfDocumentInfo>;
  getPdfPageBundle: (input: PdfEngineGetPageBundleInput) => Promise<{
    png_bytes: Uint8Array;
    width_px: number;
    height_px: number;
    page_width_pt: number;
    page_height_pt: number;
    spans: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>;
  }>;
  getPdfPageText: (input: { primary_attachment_id: number; page_index0: number }) => Promise<PdfPageText>;
  ocrPdfPage: (input: OcrPdfPageInput) => Promise<{
    primary_attachment_id: number;
    page_index0: number;
    lang: string;
    config_version: string;
    lines: Array<{
      text: string;
      bbox: { left: number; top: number; width: number; height: number };
      confidence: number;
    }>;
  }>;
  onPageCountChange?: (pageCount: number) => void;
  onActivePageChange?: (pageIndex0: number) => void;
  onNavigateToPage?: (pageIndex0: number) => void;
  searchQuery?: string;
  activeSearchMatchIndex?: number;
  annotations?: Annotation[];
  onSelectionChange?: (selection: PdfTextSelection | null) => void;
  onHighlightActivate?: (highlight: { annotationId: number; rect: PdfSelectionRect }) => void;
  onSearchMatchesChange?: (state: { total: number; activeIndex: number }) => void;
};

type PageTextSource = "native" | "ocr" | "none";

type RenderedPageState = {
  imageUrl: string;
  cssWidthPx: number;
  cssHeightPx: number;
  rasterWidthPx: number;
  rasterHeightPx: number;
  rasterScale: number;
  bucketWidthPx: number;
  requestKey: string;
  textSource: PageTextSource;
};

type PageShellInfo = {
  widthCssPx: number;
  heightCssPx: number;
};

type RenderRequest = {
  pageIndex0: number;
  cssWidthPx: number;
  cssHeightPx: number;
  targetRasterWidthPx: number;
  bucketWidthPx: number;
  requestKey: string;
  priority: "immediate" | "idle";
  rasterScale: number;
};

type ScrollSyncReason = "scroll" | "observer" | "page_effect";

const supportsRequestIdleCallback = () =>
  typeof window !== "undefined" && typeof window.requestIdleCallback === "function";

const scheduleIdle = (callback: () => void) => {
  if (typeof window === "undefined") return () => {};
  if (supportsRequestIdleCallback()) {
    const id = window.requestIdleCallback(() => callback(), { timeout: 180 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, 24);
  return () => window.clearTimeout(id);
};

const isScrollable = (element: HTMLElement) => {
  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY || style.overflow;
  if (!/(auto|scroll|overlay)/.test(overflowY)) return false;
  return element.scrollHeight > element.clientHeight + 1;
};

const findScrollFallbackTarget = (element: HTMLElement | null): EventTarget | null => {
  if (typeof window === "undefined" || !element) return null;
  let current = element.parentElement;
  while (current) {
    if (isScrollable(current)) return current;
    current = current.parentElement;
  }
  return window;
};

function pickPageTextSource(strings: string[]): PageTextSource {
  if (strings.length === 0) return "none";
  return "native";
}

function shouldFallbackToOcr(strings: string[]): boolean {
  const normalized = strings.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) return true;

  const joined = normalized.join(" ");
  if (!joined) return true;

  const suspiciousChars = joined.match(SUSPICIOUS_CHAR_RE) ?? [];
  if (suspiciousChars.length === 0) return false;

  const totalChars = Array.from(joined).length;
  if (totalChars <= 0) return true;
  return suspiciousChars.length / totalChars >= SUSPICIOUS_TEXT_RATIO_THRESHOLD;
}

export function PdfContinuousReader({
  view,
  page,
  zoom,
  fitMode = "fit_width",
  getPdfDocumentInfo,
  getPdfPageBundle,
  getPdfPageText,
  ocrPdfPage,
  onPageCountChange,
  onActivePageChange,
  onNavigateToPage: _onNavigateToPage,
  searchQuery = "",
  activeSearchMatchIndex = 0,
  annotations = [],
  onSelectionChange,
  onHighlightActivate,
  onSearchMatchesChange,
}: PdfContinuousReaderProps) {
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const pageShellByIndexRef = useRef(new Map<number, HTMLElement>());
  const textLayerHostByIndexRef = useRef(new Map<number, HTMLElement>());
  const textLayerSelectionCleanupByIndexRef = useRef(new Map<number, () => void>());
  const textDivsByIndexRef = useRef(new Map<number, HTMLElement[]>());
  const textDivStringsByIndexRef = useRef(new Map<number, string[]>());
  const pageTextOrderRef = useRef<number[]>([]);
  const imageUrlsByIndexRef = useRef(new Map<number, string>());
  const inFlightRenderPagesRef = useRef(new Set<number>());
  const inFlightRenderKeysRef = useRef(new Set<string>());
  const inFlightOcrPagesRef = useRef(new Set<number>());
  const pagesRef = useRef<Record<number, RenderedPageState>>({});
  const dominantPageIndexRef = useRef(0);
  const lastReportedActivePageRef = useRef(0);
  const pendingProgrammaticPageRef = useRef<number | null>(null);
  const scrollSyncRafRef = useRef<number | null>(null);
  const idleRenderCancelRef = useRef<(() => void) | null>(null);
  const programmaticPageClearRafRef = useRef<number | null>(null);

  const [pageCount, setPageCount] = useState(Math.max(1, view.page_count ?? 1));
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [stageWidth, setStageWidth] = useState(0);
  const [pdfDocumentInfo, setPdfDocumentInfo] = useState<PdfDocumentInfo | null>(null);
  const [pageWidthAtScale1, setPageWidthAtScale1] = useState<number | null>(null);
  const [pageShells, setPageShells] = useState<Record<number, PageShellInfo>>({});
  const [pages, setPages] = useState<Record<number, RenderedPageState>>({});
  const [pageTextByIndex, setPageTextByIndex] = useState<Record<number, string[]>>({});
  const [textLayerReadyByPage, setTextLayerReadyByPage] = useState<Record<number, boolean>>({});
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);
  const [dominantPageIndex, setDominantPageIndex] = useState(0);
  const [visiblePageIndexes, setVisiblePageIndexes] = useState<number[]>([]);

  const onPageCountChangeRef = useRef(onPageCountChange);
  const onActivePageChangeRef = useRef(onActivePageChange);
  const onSearchMatchesChangeRef = useRef(onSearchMatchesChange);
  onPageCountChangeRef.current = onPageCountChange;
  onActivePageChangeRef.current = onActivePageChange;
  onSearchMatchesChangeRef.current = onSearchMatchesChange;

  const textEnabled = true;
  const loweredSearch = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
  const rasterScale = useMemo(() => {
    if (typeof window === "undefined" || !Number.isFinite(window.devicePixelRatio)) return 1;
    return clamp(window.devicePixelRatio || 1, 1, 2);
  }, []);
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
  const targetRasterWidthPx = useMemo(
    () => Math.max(1, Math.round(desiredWidthCssPx * rasterScale)),
    [desiredWidthCssPx, rasterScale],
  );
  const cssWidthBucketPx = useMemo(() => widthBucket(desiredWidthCssPx), [desiredWidthCssPx]);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  const rememberPageText = useCallback((pageIndex0: number, strings: string[]) => {
    pageTextOrderRef.current = [...pageTextOrderRef.current.filter((entry) => entry !== pageIndex0), pageIndex0];
    const stale = pageTextOrderRef.current.length > PAGE_TEXT_CACHE_LIMIT ? pageTextOrderRef.current.shift() : undefined;
    setPageTextByIndex((current) => {
      const next = { ...current, [pageIndex0]: strings };
      if (stale !== undefined && stale !== pageIndex0) delete next[stale];
      return next;
    });
  }, []);

  const setTextLayerForPage = useCallback(
    (input: { pageIndex0: number; strings: string[]; divs: HTMLElement[]; textSource: PageTextSource }) => {
      const { pageIndex0, strings, divs, textSource } = input;
      const host = textLayerHostByIndexRef.current.get(pageIndex0);
      if (!host) return;

      textLayerSelectionCleanupByIndexRef.current.get(pageIndex0)?.();
      textLayerSelectionCleanupByIndexRef.current.delete(pageIndex0);
      textDivsByIndexRef.current.set(pageIndex0, divs);
      textDivStringsByIndexRef.current.set(pageIndex0, strings);
      rememberPageText(pageIndex0, strings);
      if (divs.length > 0) {
        textLayerSelectionCleanupByIndexRef.current.set(
          pageIndex0,
          installPdfJsTextLayerSelectionSupport(host),
        );
      }
      setTextLayerReadyByPage((current) => ({ ...current, [pageIndex0]: divs.length > 0 }));
      setPages((current) => {
        const existing = current[pageIndex0];
        if (!existing || existing.textSource === textSource) return existing ? current : current;
        return {
          ...current,
          [pageIndex0]: {
            ...existing,
            textSource,
          },
        };
      });
      setTextLayerEpoch((current) => current + 1);
      void textSource;
      void strings;
    },
    [rememberPageText],
  );

  const releaseRenderedPage = useCallback((pageIndex0: number) => {
    textLayerSelectionCleanupByIndexRef.current.get(pageIndex0)?.();
    textLayerSelectionCleanupByIndexRef.current.delete(pageIndex0);
    const imageUrl = imageUrlsByIndexRef.current.get(pageIndex0);
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
      imageUrlsByIndexRef.current.delete(pageIndex0);
    }
    const host = textLayerHostByIndexRef.current.get(pageIndex0);
    if (host) clearChildren(host);
    textDivsByIndexRef.current.delete(pageIndex0);
    textDivStringsByIndexRef.current.delete(pageIndex0);
    inFlightRenderPagesRef.current.delete(pageIndex0);
    inFlightOcrPagesRef.current.delete(pageIndex0);
    if (pagesRef.current[pageIndex0]) {
      const nextPages = { ...pagesRef.current };
      delete nextPages[pageIndex0];
      pagesRef.current = nextPages;
    }
  }, []);

  const syncActivePageFromViewport = useCallback(
    (reason: ScrollSyncReason) => {
      const root = scrollRootRef.current;
      if (!root) return;
      const scrollFallback = findScrollFallbackTarget(root);
      const rootRect =
        scrollFallback instanceof HTMLElement
          ? scrollFallback.getBoundingClientRect()
          : { top: 0, bottom: window.innerHeight };
      const pageRects = Array.from(pageShellByIndexRef.current.entries())
        .map(([pageIndex0, shell]) => {
          const rect = shell.getBoundingClientRect();
          return { pageIndex0, top: rect.top, bottom: rect.bottom };
        })
        .filter((rect) => Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top);
      const next = computeActivePageIndexFromRects({
        rootRect: { top: rootRect.top, bottom: rootRect.bottom },
        pageRects,
        anchorRatio: ACTIVE_PAGE_ANCHOR_RATIO,
      });
      if (next === null) return;
      if (pendingProgrammaticPageRef.current === next) pendingProgrammaticPageRef.current = null;

      if (next !== dominantPageIndexRef.current) {
        dominantPageIndexRef.current = next;
        setDominantPageIndex(next);
      }
      if (next !== lastReportedActivePageRef.current) {
        lastReportedActivePageRef.current = next;
        onActivePageChangeRef.current?.(next);
      }
    },
    [],
  );

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
    setPdfDocumentInfo(null);
    setPageWidthAtScale1(null);
    setTextLayerReadyByPage({});
    setPages({});
    setPageTextByIndex({});
    setPageShells({});
    pageTextOrderRef.current = [];
    inFlightRenderPagesRef.current.clear();
    inFlightRenderKeysRef.current.clear();
    inFlightOcrPagesRef.current.clear();
    dominantPageIndexRef.current = 0;
    lastReportedActivePageRef.current = 0;
    pendingProgrammaticPageRef.current = null;
    setDominantPageIndex(0);
    setTextLayerEpoch((current) => current + 1);

    for (const cleanup of textLayerSelectionCleanupByIndexRef.current.values()) cleanup();
    textLayerSelectionCleanupByIndexRef.current.clear();
    for (const url of imageUrlsByIndexRef.current.values()) URL.revokeObjectURL(url);
    imageUrlsByIndexRef.current.clear();
    textDivsByIndexRef.current.clear();
    textDivStringsByIndexRef.current.clear();

    void (async () => {
      try {
        const info = await getPdfDocumentInfo(primaryAttachmentId);
        if (cancelled) return;
        setPdfDocumentInfo(info);
        const nextPageCount = Math.max(1, info.page_count || view.page_count || 1);
        setPageCount(nextPageCount);
        onPageCountChangeRef.current?.(nextPageCount);
        const firstPage = info.pages[0];
        if (firstPage?.width_pt) setPageWidthAtScale1(pageWidthAtScale1FromPoints(firstPage.width_pt));
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unable to load PDF metadata.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getPdfDocumentInfo, view.page_count, view.primary_attachment_id]);

  useEffect(() => {
    if (!pdfDocumentInfo) return;
    const nextShells: Record<number, PageShellInfo> = {};
    for (let pageIndex0 = 0; pageIndex0 < pageCount; pageIndex0 += 1) {
      const pageInfo = pdfDocumentInfo.pages[pageIndex0] ?? pdfDocumentInfo.pages[0];
      if (!pageInfo?.width_pt || !pageInfo?.height_pt) continue;
      const baseWidth = pageWidthAtScale1FromPoints(pageInfo.width_pt);
      const scale = desiredWidthCssPx / Math.max(1, baseWidth);
      nextShells[pageIndex0] = {
        widthCssPx: desiredWidthCssPx,
        heightCssPx: Math.max(1, Math.round(pageInfo.height_pt * (96 / 72) * scale)),
      };
    }
    setPageShells(nextShells);
  }, [desiredWidthCssPx, pageCount, pdfDocumentInfo]);

  const searchMatches = useMemo(() => {
    if (!textEnabled || loweredSearch.length === 0) return [];
    const matches: Array<{ pageIndex: number; divIndex: number; start: number; end: number }> = [];
    for (const [pageIndexText, divStrings] of Object.entries(pageTextByIndex)) {
      const pageIndex = Number(pageIndexText);
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
  }, [loweredSearch, pageTextByIndex, textEnabled, textLayerEpoch]);

  const activeSearchTargetPage = useMemo(() => {
    if (searchMatches.length === 0) return null;
    const normalized = ((activeSearchMatchIndex % searchMatches.length) + searchMatches.length) % searchMatches.length;
    return searchMatches[normalized]?.pageIndex ?? null;
  }, [activeSearchMatchIndex, searchMatches]);

  const visiblePageSet = useMemo(() => new Set(visiblePageIndexes), [visiblePageIndexes]);

  const requestedRenderPages = useMemo(() => {
    const immediate = new Set<number>();
    const idle = new Set<number>();
    const addRange = (target: Set<number>, center: number | null, radius: number) => {
      if (center === null || center < 0) return;
      for (let pageIndex0 = Math.max(0, center - radius); pageIndex0 <= Math.min(pageCount - 1, center + radius); pageIndex0 += 1) {
        target.add(pageIndex0);
      }
    };

    addRange(immediate, page, 1);
    addRange(immediate, dominantPageIndex, 1);
    for (const visiblePageIndex of visiblePageIndexes) addRange(immediate, visiblePageIndex, 1);
    addRange(immediate, activeSearchTargetPage, SEARCH_TARGET_RENDER_RADIUS);

    addRange(idle, page, PREFETCH_PAGE_RADIUS);
    addRange(idle, dominantPageIndex, PREFETCH_PAGE_RADIUS);
    for (const pageIndex0 of immediate) idle.delete(pageIndex0);

    return {
      immediate: Array.from(immediate).sort((left, right) => left - right),
      idle: Array.from(idle).sort((left, right) => left - right),
    };
  }, [activeSearchTargetPage, dominantPageIndex, page, pageCount, visiblePageIndexes]);

  const renderRequests = useMemo(() => {
    if (!pdfDocumentInfo) return [];
    const requests: RenderRequest[] = [];
    const pushRequest = (pageIndex0: number, priority: "immediate" | "idle", scale: number) => {
      const shell = pageShells[pageIndex0];
      if (!shell) return;
      const bucketWidthPx = widthBucket(Math.max(1, Math.round(shell.widthCssPx * scale)));
      requests.push({
        pageIndex0,
        cssWidthPx: shell.widthCssPx,
        cssHeightPx: shell.heightCssPx,
        targetRasterWidthPx: Math.max(1, Math.round(shell.widthCssPx * scale)),
        bucketWidthPx,
        requestKey: `${pageIndex0}:${cssWidthBucketPx}:${scale}`,
        priority,
        rasterScale: scale,
      });
    };

    const highPriorityPages = new Set([page, dominantPageIndex, ...visiblePageIndexes].filter((entry) => entry >= 0));
    for (const pageIndex0 of requestedRenderPages.immediate) pushRequest(pageIndex0, "immediate", MAX_INITIAL_RASTER_SCALE);
    if (rasterScale > MAX_INITIAL_RASTER_SCALE) {
      for (const pageIndex0 of requestedRenderPages.immediate) {
        if (highPriorityPages.has(pageIndex0)) pushRequest(pageIndex0, "idle", rasterScale);
      }
    }
    for (const pageIndex0 of requestedRenderPages.idle) pushRequest(pageIndex0, "idle", MAX_INITIAL_RASTER_SCALE);
    return requests;
  }, [cssWidthBucketPx, dominantPageIndex, page, pageShells, pdfDocumentInfo, rasterScale, requestedRenderPages, visiblePageIndexes]);

  useEffect(() => {
    const keep = new Set([...requestedRenderPages.immediate, ...requestedRenderPages.idle]);
    const stalePages = Object.keys(pages)
      .map(Number)
      .filter((pageIndex0) => !keep.has(pageIndex0));
    if (stalePages.length === 0) return;
    for (const pageIndex0 of stalePages) releaseRenderedPage(pageIndex0);
    setPages((current) =>
      Object.fromEntries(Object.entries(current).filter(([pageIndex]) => keep.has(Number(pageIndex)))),
    );
    setTextLayerReadyByPage((current) =>
      Object.fromEntries(Object.entries(current).filter(([pageIndex]) => keep.has(Number(pageIndex)))),
    );
    setTextLayerEpoch((current) => current + 1);
  }, [pages, releaseRenderedPage, requestedRenderPages]);

  useEffect(() => {
    let cancelled = false;
    const primaryAttachmentId = view.primary_attachment_id;
    if (!primaryAttachmentId || renderRequests.length === 0 || !pdfDocumentInfo) return;

    const processRequest = async (request: RenderRequest) => {
      const existing = pagesRef.current[request.pageIndex0];
      if (existing && existing.requestKey === request.requestKey) return;
      if (inFlightRenderKeysRef.current.has(request.requestKey)) return;
      if (inFlightRenderPagesRef.current.has(request.pageIndex0) && request.priority === "idle") return;
      inFlightRenderPagesRef.current.add(request.pageIndex0);
      inFlightRenderKeysRef.current.add(request.requestKey);
      try {
        const host = textLayerHostByIndexRef.current.get(request.pageIndex0);
        if (host) clearChildren(host);

        void effectiveZoom;
        const bundle = await getPdfPageBundle({
          primary_attachment_id: primaryAttachmentId,
          page_index0: request.pageIndex0,
          target_width_px: request.targetRasterWidthPx,
        });
        if (cancelled) return;

        const previousUrl = imageUrlsByIndexRef.current.get(request.pageIndex0);
        const blobUrl = URL.createObjectURL(
          new Blob([arrayBufferForBytes(bundle.png_bytes)], { type: "image/png" }),
        );
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        imageUrlsByIndexRef.current.set(request.pageIndex0, blobUrl);

        const nextRenderedState: RenderedPageState = {
          imageUrl: blobUrl,
          cssWidthPx: request.cssWidthPx,
          cssHeightPx: request.cssHeightPx,
          rasterWidthPx: bundle.width_px,
          rasterHeightPx: bundle.height_px,
          rasterScale: request.rasterScale,
          bucketWidthPx: request.bucketWidthPx,
          requestKey: request.requestKey,
          textSource: pickPageTextSource(bundle.spans.map((span) => span.text ?? "")),
        };
        pagesRef.current = {
          ...pagesRef.current,
          [request.pageIndex0]: nextRenderedState,
        };
        setPages((current) => ({
          ...current,
          [request.pageIndex0]: nextRenderedState,
        }));
        if (!pageWidthAtScale1 && bundle.page_width_pt > 0) {
          setPageWidthAtScale1(pageWidthAtScale1FromPoints(bundle.page_width_pt));
        }

        const currentHost = textLayerHostByIndexRef.current.get(request.pageIndex0);
        if (!currentHost) return;
        const nativeLayer = buildRustPdfTextLayer({
          host: currentHost,
          bundle,
          renderedWidthCssPx: request.cssWidthPx,
          renderedHeightCssPx: request.cssHeightPx,
        });
        setTextLayerForPage({
          pageIndex0: request.pageIndex0,
          divs: nativeLayer.divs,
          strings: nativeLayer.strings,
          textSource: pickPageTextSource(nativeLayer.strings),
        });
        if (request.pageIndex0 === page) setStatus("ready");

        const ocrEligible =
          shouldFallbackToOcr(nativeLayer.strings) &&
          (request.pageIndex0 === page || visiblePageSet.has(request.pageIndex0)) &&
          !inFlightOcrPagesRef.current.has(request.pageIndex0) &&
          inFlightOcrPagesRef.current.size < OCR_CONCURRENCY;
        if (ocrEligible) {
          inFlightOcrPagesRef.current.add(request.pageIndex0);
          void (async () => {
            try {
              const result = await ocrPdfPage({
                primary_attachment_id: primaryAttachmentId,
                page_index0: request.pageIndex0,
                png_bytes: bundle.png_bytes,
                lang: "eng+chi_sim",
                config_version: OCR_CONFIG_VERSION,
                source_resolution: Math.max(72, Math.round((bundle.width_px / Math.max(1, request.cssWidthPx)) * 96)),
              });
              if (cancelled) return;
              const ocrHost = textLayerHostByIndexRef.current.get(request.pageIndex0);
              if (!ocrHost) return;
              const built = buildOcrTextLayer({
                host: ocrHost,
                viewportWidth: request.cssWidthPx,
                viewportHeight: request.cssHeightPx,
                lines: result.lines,
              });
              setTextLayerForPage({
                pageIndex0: request.pageIndex0,
                divs: built.divs,
                strings: built.strings,
                textSource: built.divs.length > 0 ? "ocr" : pickPageTextSource(nativeLayer.strings),
              });
              void result;
            } catch (error) {
              void error;
            } finally {
              inFlightOcrPagesRef.current.delete(request.pageIndex0);
            }
          })();
        }
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Unknown PDF rendering error.");
      } finally {
        inFlightRenderPagesRef.current.delete(request.pageIndex0);
        inFlightRenderKeysRef.current.delete(request.requestKey);
      }
    };

    const immediateRequests = renderRequests.filter((request) => request.priority === "immediate");
    const idleRequests = renderRequests.filter((request) => request.priority === "idle");

    void (async () => {
      for (const request of immediateRequests) {
        await processRequest(request);
        if (cancelled) return;
      }
      if (idleRequests.length === 0 || cancelled) return;
      idleRenderCancelRef.current?.();
      idleRenderCancelRef.current = scheduleIdle(() => {
        void (async () => {
          for (const request of idleRequests) {
            await processRequest(request);
            if (cancelled) return;
          }
        })();
      });
    })();

    return () => {
      cancelled = true;
      idleRenderCancelRef.current?.();
      idleRenderCancelRef.current = null;
      inFlightRenderKeysRef.current.clear();
    };
  }, [
    effectiveZoom,
    getPdfPageBundle,
    ocrPdfPage,
    page,
    pageWidthAtScale1,
    pdfDocumentInfo,
    renderRequests,
    setTextLayerForPage,
    visiblePageSet,
    view.primary_attachment_id,
  ]);

  useEffect(() => {
    const rendered = pages[page];
    const targetScale = rasterScale > MAX_INITIAL_RASTER_SCALE && (page === dominantPageIndex || visiblePageSet.has(page))
      ? rasterScale
      : MAX_INITIAL_RASTER_SCALE;
    const targetKey = `${page}:${cssWidthBucketPx}:${targetScale}`;
    const minimumKey = `${page}:${cssWidthBucketPx}:${MAX_INITIAL_RASTER_SCALE}`;
    if (rendered && (rendered.requestKey === targetKey || rendered.requestKey === minimumKey)) {
      setStatus("ready");
      return;
    }
    if (view.primary_attachment_id) setStatus("loading");
  }, [cssWidthBucketPx, dominantPageIndex, page, pages, rasterScale, view.primary_attachment_id, visiblePageSet]);

  useEffect(() => {
    return () => {
      if (scrollSyncRafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(scrollSyncRafRef.current);
      }
      if (programmaticPageClearRafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(programmaticPageClearRafRef.current);
      }
      idleRenderCancelRef.current?.();
      for (const cleanup of textLayerSelectionCleanupByIndexRef.current.values()) cleanup();
      for (const url of imageUrlsByIndexRef.current.values()) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || typeof window === "undefined") return;
    const fallbackTarget = findScrollFallbackTarget(root);

    const onScroll = () => {
      if (scrollSyncRafRef.current !== null) return;
      scrollSyncRafRef.current = window.requestAnimationFrame(() => {
        scrollSyncRafRef.current = null;
        syncActivePageFromViewport("scroll");
      });
    };

    root.addEventListener("scroll", onScroll, { passive: true });
    if (fallbackTarget && fallbackTarget !== root) fallbackTarget.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (fallbackTarget && fallbackTarget !== root) {
        fallbackTarget.removeEventListener("scroll", onScroll);
      }
      if (scrollSyncRafRef.current !== null) {
        window.cancelAnimationFrame(scrollSyncRafRef.current);
        scrollSyncRafRef.current = null;
      }
    };
  }, [syncActivePageFromViewport]);

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
        setVisiblePageIndexes(visible.map((entry) => entry.index).sort((a, b) => a - b));
        const next = visible[0]?.index ?? 0;
        if (next !== dominantPageIndexRef.current) {
          dominantPageIndexRef.current = next;
          setDominantPageIndex(next);
        }
        syncActivePageFromViewport("observer");
      },
      { root, threshold: [0.2, 0.55, 0.7], rootMargin: "280px 0px" },
    );
    for (const shell of pageShellByIndexRef.current.values()) observer.observe(shell);
    return () => {
      setVisiblePageIndexes([]);
      observer.disconnect();
    };
  }, [pageCount, syncActivePageFromViewport]);

  useEffect(() => {
    const shell = pageShellByIndexRef.current.get(page);
    if (!shell) return;
    pendingProgrammaticPageRef.current = page;
    if (dominantPageIndexRef.current !== page) safeScrollIntoView(shell, { block: "start" });
    if (programmaticPageClearRafRef.current !== null) window.cancelAnimationFrame(programmaticPageClearRafRef.current);
    window.requestAnimationFrame(() => syncActivePageFromViewport("page_effect"));
    programmaticPageClearRafRef.current = window.requestAnimationFrame(() => {
      pendingProgrammaticPageRef.current = null;
      programmaticPageClearRafRef.current = null;
    });
  }, [page, syncActivePageFromViewport]);

  useEffect(() => {
    let cancelled = false;
    const primaryAttachmentId = view.primary_attachment_id;
    if (!primaryAttachmentId || loweredSearch.length === 0 || pageCount <= 0) return;

    void (async () => {
      const scanOrder = Array.from({ length: pageCount }, (_, offset) => (page + offset) % pageCount);
      for (const pageIndex0 of scanOrder) {
        if (pageTextByIndex[pageIndex0]) continue;
        try {
          const result = await getPdfPageText({
            primary_attachment_id: primaryAttachmentId,
            page_index0: pageIndex0,
          });
          if (cancelled) return;
          rememberPageText(pageIndex0, result.spans.map((span) => span.text));
        } catch {
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getPdfPageText, loweredSearch, page, pageCount, pageTextByIndex, rememberPageText, view.primary_attachment_id]);

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
      .map((entry) => ({
        annotationId: entry.annotation.id,
        anchor: entry.anchor as PdfTextAnchor,
      }));
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

      const annotationRangesByDiv = new Map<
        number,
        Array<{ start: number; end: number; color?: string; annotationId: number }>
      >();
      for (const entry of anchorsForActivePage) {
        const anchor = entry.anchor;
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
          current.push({ start, end, color: anchor.color, annotationId: entry.annotationId });
          annotationRangesByDiv.set(divIndex, current);
        }
      }

      const pageMatches = searchMatches.filter((m) => m.pageIndex === pageIndex);
      for (let divIndex = 0; divIndex < divs.length; divIndex += 1) {
        const div = divs[divIndex];
        const text = plain[divIndex] ?? "";
        const paints = new Array<{ color?: string; annotationId: number } | null>(text.length).fill(null);
        for (const range of annotationRangesByDiv.get(divIndex) ?? []) {
          const start = Math.max(0, Math.min(range.start, text.length));
          const end = Math.max(0, Math.min(range.end, text.length));
          for (let i = start; i < end; i += 1) paints[i] = { color: range.color, annotationId: range.annotationId };
        }

        const annotationRanges: Array<{ start: number; end: number; color?: string; annotationId: number }> = [];
        let paintCursor = 0;
        while (paintCursor < paints.length) {
          const paint = paints[paintCursor];
          if (!paint) {
            paintCursor += 1;
            continue;
          }
          let end = paintCursor + 1;
          while (
            end < paints.length &&
            paints[end]?.annotationId === paint.annotationId &&
            paints[end]?.color === paint.color
          ) {
            end += 1;
          }
          annotationRanges.push({
            start: paintCursor,
            end,
            color: paint.color,
            annotationId: paint.annotationId,
          });
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
          | { kind: "annotation"; value: string; color?: string; annotationId: number }
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
          if (range.kind === "annotation") {
            segments.push({
              kind: "annotation",
              value: slice,
              color: range.color,
              annotationId: range.annotationId,
            });
          }
          else segments.push({ kind: "search", value: slice, hitIndex: range.hitIndex });
          cursor = range.end;
        }
        if (cursor < text.length) pushText(text.slice(cursor));

        div.innerHTML = segments
          .map((segment) => {
            if (segment.kind === "text") return escapeHtml(segment.value);
            if (segment.kind === "annotation") {
              const colorAttr = segment.color ? ` data-color="${escapeHtml(segment.color)}"` : "";
              return `<span class="pdf-annotation-highlight" data-annotation-id="${segment.annotationId}"${colorAttr}>${escapeHtml(segment.value)}</span>`;
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

  useEffect(() => {
    if (!onHighlightActivate) return;
    const hosts = Array.from(textLayerHostByIndexRef.current.values());
    if (hosts.length === 0) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const highlight = target.closest(".pdf-annotation-highlight[data-annotation-id]") as HTMLElement | null;
      if (!highlight) return;
      const annotationId = Number(highlight.dataset.annotationId);
      if (!Number.isFinite(annotationId)) return;
      const rect = highlight.getBoundingClientRect();
      event.preventDefault();
      event.stopPropagation();
      onHighlightActivate({
        annotationId,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
      });
    };

    for (const host of hosts) host.addEventListener("click", onClick);
    return () => {
      for (const host of hosts) host.removeEventListener("click", onClick);
    };
  }, [onHighlightActivate, textLayerEpoch, textLayerReadyByPage]);

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
      void insideTextLayer;
      void nearestDivIndex;
      void pageIndex0;
      onSelectionChange(next);
    };
    document.addEventListener("selectionchange", onSelectionChangeEvent);
    return () => document.removeEventListener("selectionchange", onSelectionChangeEvent);
  }, [onSelectionChange]);

  return (
    <section className="pdf-reader pdf-reader-focus" data-testid="pdf-reader" ref={scrollRootRef}>
      <div className="pdf-stage">
        {status === "loading" && !pages[page] ? <p className="pdf-reader-loading">Loading PDF...</p> : null}
        {status === "error" ? <p>Unable to load this PDF. {errorMessage}</p> : null}

        {Array.from({ length: Math.max(1, pageCount) }).map((_, index) => {
          const rendered = pages[index];
          const shell = pageShells[index];
          const width = rendered?.cssWidthPx ?? shell?.widthCssPx ?? desiredWidthCssPx;
          const height = rendered?.cssHeightPx ?? shell?.heightCssPx;
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
              style={{
                width: width > 0 ? `${width}px` : undefined,
                minHeight: height ? `${height}px` : undefined,
              }}
            >
              <div style={{ position: "relative" }}>
                {rendered ? (
                  <img
                    alt={`PDF page ${index + 1}`}
                    aria-label={`PDF page ${index + 1} image`}
                    src={rendered.imageUrl}
                    style={{ display: "block", width: `${rendered.cssWidthPx}px`, height: `${rendered.cssHeightPx}px` }}
                  />
                ) : height ? (
                  <div
                    aria-hidden="true"
                    className="pdf-page-skeleton"
                    style={{ width: `${width}px`, height: `${height}px` }}
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
                    width: width > 0 ? `${width}px` : undefined,
                    height: height ? `${height}px` : undefined,
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
