import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NormalizedReader } from "./components/readers/NormalizedReader";
import { PdfContinuousReader } from "./components/readers/PdfContinuousReader";
import { PdfReader } from "./components/readers/PdfReader";
import type { PdfHighlightColor, PdfTextSelection } from "./components/readers/pdfSelection";
import { isTauriRuntime } from "./lib/api";
import { logEvent, startClientEventLog, textForLog } from "./lib/clientEventLog";
import { getRuntimePolyfillDiagnostics } from "./lib/runtimePolyfills";
import type {
  AIArtifact,
  AITask,
  Annotation,
  AnnotationFilter,
  AppApi,
  Collection,
  ImportBatchResult,
  LibraryItem,
  ReaderView,
  ResearchNote,
  Tag,
} from "./lib/contracts";

type AiPanelMode = "paper" | "collection";
type WorkspaceMode = "workspace" | "pdf_focus";
type ItemSort = "recent" | "title" | "year_desc";
type AttachmentFilter = "all" | "ready" | "missing" | "citation_only";

const itemActions = [
  { label: "Summarize document", kind: "item.summarize" },
  { label: "Translate selection", kind: "item.translate" },
  { label: "Explain terminology", kind: "item.explain_term" },
  { label: "Ask about this paper", kind: "item.ask" },
];

const collectionActions = [
  { label: "Bulk Summaries", kind: "collection.bulk_summarize" },
  { label: "Theme Map", kind: "collection.theme_map" },
  { label: "Compare Methods", kind: "collection.compare_methods" },
  { label: "Generate Review Draft", kind: "collection.review_draft" },
];

const attachmentFormatLabel = (format: LibraryItem["attachment_format"] | ReaderView["attachment_format"]) =>
  format.toUpperCase();

const formatItemMetadata = (item: LibraryItem): string | null => {
  const parts: string[] = [];

  const authors = item.authors.trim();
  if (authors.length > 0 && authors !== "Imported Author") {
    parts.push(authors);
  }

  if (item.publication_year !== null) {
    parts.push(String(item.publication_year));
  }

  const source = item.source.trim();
  if (source.length > 0 && !source.startsWith("Imported ")) {
    parts.push(source);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
};

const sanitizeFilename = (value: string) =>
  value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const filenameStem = (value: string, fallback: string) => {
  const sanitized = sanitizeFilename(value);
  return sanitized.length > 0 ? sanitized : fallback;
};

const supportedExtensions = [".pdf", ".docx", ".epub"];

const isSupportedPath = (path: string) =>
  supportedExtensions.some((extension) => path.toLowerCase().endsWith(extension));

const droppedPathsFromFileList = (files: FileList | File[]) =>
  Array.from(files)
    .map((file) => {
      const fileWithPath = file as File & { path?: string; webkitRelativePath?: string };
      return fileWithPath.path || fileWithPath.webkitRelativePath || file.name;
    })
    .filter(isSupportedPath);

const sortItems = (items: LibraryItem[], itemSort: ItemSort) => {
  const copy = [...items];
  copy.sort((left, right) => {
    if (itemSort === "title") return left.title.localeCompare(right.title);
    if (itemSort === "year_desc") return (right.publication_year ?? 0) - (left.publication_year ?? 0);
    return right.id - left.id;
  });
  return copy;
};

const filterItemsByAttachment = (items: LibraryItem[], attachmentFilter: AttachmentFilter) => {
  if (attachmentFilter === "all") return items;
  return items.filter((item) => item.attachment_status === attachmentFilter);
};

const applyTagFilter = (items: LibraryItem[], tags: Tag[], selectedTagId: number | null) => {
  if (selectedTagId === null) return items;
  const selectedTagName = tags.find((tag) => tag.id === selectedTagId)?.name;
  if (!selectedTagName) return items;
  return items.filter((item) => item.tags.includes(selectedTagName));
};

const matchesSearch = (item: LibraryItem, query: string) => {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return true;
  return [
    item.title,
    item.authors,
    item.source,
    item.doi ?? "",
    String(item.publication_year ?? ""),
    item.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
};

const scopeMatches = (left: number[] | null, right: number[]) =>
  left !== null &&
  left.length === right.length &&
  left.every((itemId, index) => itemId === right[index]);

const taskPreview = (task: AITask) =>
  (() => {
    const lines = task.output_markdown
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    return lines[lines.length - 1] ?? "No preview available.";
  })();

const noteHeading = (note: ResearchNote) =>
  note.markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"))
    ?.replace(/^#+\s*/, "") ?? note.title;

const descendantIdsForCollection = (collections: Collection[], collectionId: number) => {
  const descendants = new Set<number>();
  const stack = [collectionId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === undefined) continue;
    for (const collection of collections) {
      if (collection.parent_id === currentId && !descendants.has(collection.id)) {
        descendants.add(collection.id);
        stack.push(collection.id);
      }
    }
  }

  return descendants;
};

const childCollectionsFor = (collections: Collection[], parentId: number | null) =>
  collections
    .filter((collection) => collection.parent_id === parentId)
    .sort((left, right) => left.name.localeCompare(right.name));

const itemCountForCollection = (libraryItems: LibraryItem[], collectionId: number) =>
  libraryItems.filter((item) => item.collection_id === collectionId).length;

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);

export default function App({ api }: { api: AppApi }) {
  const getApi = () => Promise.resolve(api);
  const readerSearchInputRef = useRef<HTMLInputElement | null>(null);
  const importDocumentsRef = useRef<() => void>(() => {});
  const importCitationsRef = useRef<() => void>(() => {});
  const importPathsRef = useRef<(paths: string[], sourceLabel: string) => void>(() => {});
  const readerLoadRequestIdRef = useRef(0);

  const [collections, setCollections] = useState<Collection[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [expandedCollectionIds, setExpandedCollectionIds] = useState<number[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [openPaperIds, setOpenPaperIds] = useState<number[]>([]);
  const [activePaperId, setActivePaperId] = useState<number | null>(null);
  const [readerView, setReaderView] = useState<ReaderView | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [paperArtifact, setPaperArtifact] = useState<AIArtifact | null>(null);
  const [paperTaskRuns, setPaperTaskRuns] = useState<AITask[]>([]);
  const [collectionArtifact, setCollectionArtifact] = useState<AIArtifact | null>(null);
  const [collectionTaskRuns, setCollectionTaskRuns] = useState<AITask[]>([]);
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [aiPanelMode, setAiPanelMode] = useState<AiPanelMode>("paper");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("workspace");
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [search, setSearch] = useState("");
  const [itemSort, setItemSort] = useState<ItemSort>("recent");
  const [attachmentFilter, setAttachmentFilter] = useState<AttachmentFilter>("all");
  const [lastImportResult, setLastImportResult] = useState<ImportBatchResult | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [draggedFileCount, setDraggedFileCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState("Loading library...");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [batchTagName, setBatchTagName] = useState("");
  const [batchMoveTargetId, setBatchMoveTargetId] = useState("current");
  const [readerPage, setReaderPage] = useState(0);
  const [readerPageInput, setReaderPageInput] = useState("1");
  const [readerZoom, setReaderZoom] = useState(100);
  const [readerSearchQuery, setReaderSearchQuery] = useState("");
  const [isFindHudOpen, setIsFindHudOpen] = useState(false);
  const [readerSearchMatchIndex, setReaderSearchMatchIndex] = useState(0);
  const [readerSearchMatchCount, setReaderSearchMatchCount] = useState(0);
  const [reportedActiveSearchMatchIndex, setReportedActiveSearchMatchIndex] = useState(-1);
  const [pdfPageCounts, setPdfPageCounts] = useState<Record<number, number>>({});
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>("all");
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(null);

  // Client-side debug logging (append-only JSONL on disk).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const sessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const stop = startClientEventLog({
      sessionId,
      appendFn: (input) => api.appendClientEventLog(input),
    });
    logEvent("app_start", { session_id: sessionId });
    logEvent("runtime_feature_probe", {
      // Avoid requiring TS lib upgrades for `.at()`; we polyfill at runtime when missing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hasArrayAt: typeof (Array.prototype as any).at === "function",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hasStringAt: typeof (String.prototype as any).at === "function",
      hasPromiseWithResolvers:
        typeof Promise !== "undefined" &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (Promise as any).withResolvers === "function",
      hasReadableStreamHealthy: getRuntimePolyfillDiagnostics().readableStreamHealthy,
    });
    return stop;
  }, [api]);

  const hasCollections = collections.length > 0;

  const activeCollection = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  );

  const selectedCollectionScope = useMemo(() => {
    if (selectedCollectionId === null) return null;
    const scope = descendantIdsForCollection(collections, selectedCollectionId);
    scope.add(selectedCollectionId);
    return scope;
  }, [collections, selectedCollectionId]);

  const activeCollectionItems = useMemo(() => {
    if (!selectedCollectionScope) return [];
    return libraryItems.filter(
      (item) => selectedCollectionScope.has(item.collection_id) && matchesSearch(item, search),
    );
  }, [libraryItems, search, selectedCollectionScope]);

  const visibleItems = useMemo(
    () =>
      sortItems(
        filterItemsByAttachment(applyTagFilter(activeCollectionItems, tags, selectedTagId), attachmentFilter),
        itemSort,
      ),
    [activeCollectionItems, attachmentFilter, itemSort, selectedTagId, tags],
  );

  const visibleScopeItemIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const openPapers = useMemo(
    () =>
      openPaperIds
        .map((itemId) => libraryItems.find((item) => item.id === itemId))
        .filter((item): item is LibraryItem => Boolean(item)),
    [libraryItems, openPaperIds],
  );
  const activePaper = useMemo(
    () => libraryItems.find((item) => item.id === activePaperId) ?? openPapers[openPapers.length - 1] ?? null,
    [activePaperId, libraryItems, openPapers],
  );
  const activePaperMetadata = activePaper ? formatItemMetadata(activePaper) : null;
  const isPdfReader = readerView?.reader_kind === "pdf";
  const attachmentAvailable = Boolean(
    activePaper &&
      activePaper.attachment_status !== "missing" &&
      activePaper.attachment_status !== "citation_only",
  );
  const aiCapabilitiesEnabled = Boolean(attachmentAvailable && readerView?.content_status === "ready");
  const isPdfAttachment = Boolean(activePaper?.attachment_format === "pdf" || isPdfReader);
  const pdfTextToolsEnabled = Boolean(
    attachmentAvailable && isPdfAttachment,
  );
  const textToolsEnabled = Boolean(isPdfAttachment ? pdfTextToolsEnabled : aiCapabilitiesEnabled);
  const readyForAi = Boolean(activePaper && aiCapabilitiesEnabled);
  const readerPageCount =
    activePaper?.id && isPdfReader ? pdfPageCounts[activePaper.id] ?? readerView?.page_count ?? 1 : 1;
  const visibleAnnotations = useMemo(() => {
    if (annotationFilter !== "current_page") return annotations;
    const currentPage = readerPage + 1;
    return annotations.filter((annotation) => {
      if (annotation.anchor === `page-${currentPage}`) return true;
      try {
        const parsed = JSON.parse(annotation.anchor) as { type?: string; page?: number };
        return parsed.type === "pdf_text" && parsed.page === currentPage;
      } catch {
        return false;
      }
    });
  }, [annotationFilter, annotations, readerPage]);
  const importHasIssues = Boolean(
    lastImportResult &&
      (lastImportResult.duplicates.length > 0 || lastImportResult.failed.length > 0),
  );

  const loadLibrary = useCallback(async () => {
    const runtimeApi = await getApi();
    await runtimeApi.refreshAttachmentStatuses();
    const loadedItems = await runtimeApi.listItems();
    setLibraryItems(loadedItems);
    return loadedItems;
  }, [api]);

  const refreshCollections = useCallback(
    async (preferredCollectionId?: number | null) => {
      const runtimeApi = await getApi();
      const loadedCollections = await runtimeApi.listCollections();
      setCollections(loadedCollections);
      const rootIds = childCollectionsFor(loadedCollections, null).map((collection) => collection.id);
      setExpandedCollectionIds((current) =>
        current.length > 0 ? Array.from(new Set([...current, ...rootIds])) : rootIds,
      );
      setSelectedCollectionId((current) =>
        preferredCollectionId && loadedCollections.some((collection) => collection.id === preferredCollectionId)
          ? preferredCollectionId
          : current && loadedCollections.some((collection) => collection.id === current)
            ? current
            : loadedCollections[0]?.id ?? null,
      );
      if (loadedCollections.length === 0) {
        setStatusMessage("Create your first collection to start building the desktop library.");
      }
    },
    [api],
  );

  useEffect(() => {
    void refreshCollections();
  }, [refreshCollections]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (selectedCollectionId === null) {
      setTags([]);
      setSelectedTagId(null);
      setCollectionArtifact(null);
      setCollectionTaskRuns([]);
      setNotes([]);
      setActiveNoteId(null);
      setNoteDraft("");
      return;
    }

    let cancelled = false;
    const collectionId = selectedCollectionId;

    async function loadCollectionContext() {
      const runtimeApi = await getApi();
      const [loadedTags, artifact, collectionNotes, taskRuns] = await Promise.all([
        runtimeApi.listTags(collectionId),
        runtimeApi.getArtifact({ collection_id: collectionId }),
        runtimeApi.listNotes(collectionId),
        runtimeApi.listTaskRuns({ collection_id: collectionId }),
      ]);
      if (cancelled) return;
      setTags(loadedTags);
      setSelectedTagId((current) =>
        current && loadedTags.some((tag) => tag.id === current) ? current : null,
      );
      setCollectionArtifact(artifact);
      setCollectionTaskRuns(taskRuns);
      setNotes(collectionNotes);
      setActiveNoteId(collectionNotes[0]?.id ?? null);
      setNoteDraft(collectionNotes[0]?.markdown ?? "");
    }

    void loadCollectionContext();
    return () => {
      cancelled = true;
    };
  }, [api, selectedCollectionId]);

  useEffect(() => {
    if (!activePaperId) {
      readerLoadRequestIdRef.current += 1;
      setReaderView(null);
      setAnnotations([]);
      setPaperArtifact(null);
      setPaperTaskRuns([]);
      return;
    }

    let cancelled = false;
    const itemId = activePaperId;
    const requestId = readerLoadRequestIdRef.current + 1;
    readerLoadRequestIdRef.current = requestId;

    async function loadReaderContext() {
      const startedAt = performance.now();
      logEvent("reader_open_click", { itemId, requestId });
      setReaderView(null);
      setAnnotations([]);
      setPaperArtifact(null);
      setPaperTaskRuns([]);
      try {
        const runtimeApi = await getApi();
        const view = await runtimeApi.getReaderView(itemId);
        if (cancelled || readerLoadRequestIdRef.current !== requestId) return;
        setReaderView(view);
        setReaderPage(0);
        setReaderPageInput("1");
        setReaderSearchQuery("");
        setIsFindHudOpen(false);
        setReaderSearchMatchIndex(0);
        setReaderSearchMatchCount(0);
        setReportedActiveSearchMatchIndex(-1);
        setPdfSelection(null);
        logEvent("reader_view_loaded", {
          itemId,
          requestId,
          durationMs: Math.round(performance.now() - startedAt),
          readerKind: view.reader_kind,
          attachmentFormat: view.attachment_format,
        });

        void (async () => {
          const auxStartedAt = performance.now();
          const [annotationsResult, artifactResult, taskRunsResult] = await Promise.allSettled([
            runtimeApi.listAnnotations(itemId),
            runtimeApi.getArtifact({ item_id: itemId }),
            runtimeApi.listTaskRuns({ item_id: itemId }),
          ]);
          if (cancelled || readerLoadRequestIdRef.current !== requestId) return;
          if (annotationsResult.status === "fulfilled") setAnnotations(annotationsResult.value);
          if (artifactResult.status === "fulfilled") setPaperArtifact(artifactResult.value);
          if (taskRunsResult.status === "fulfilled") setPaperTaskRuns(taskRunsResult.value);
          logEvent("reader_aux_loaded", {
            itemId,
            requestId,
            durationMs: Math.round(performance.now() - auxStartedAt),
            annotationsOk: annotationsResult.status === "fulfilled",
            artifactOk: artifactResult.status === "fulfilled",
            taskRunsOk: taskRunsResult.status === "fulfilled",
          });
        })();
      } catch (error) {
        if (cancelled || readerLoadRequestIdRef.current !== requestId) return;
        logEvent("reader_open_failed", {
          itemId,
          requestId,
          durationMs: Math.round(performance.now() - startedAt),
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    void loadReaderContext();
    return () => {
      cancelled = true;
    };
  }, [activePaperId, api]);

  useEffect(() => {
    setSelectedItemIds((current) => current.filter((itemId) => visibleItems.some((item) => item.id === itemId)));
  }, [visibleItems]);

  useEffect(() => {
    if (!activePaper) {
      setWorkspaceMode("workspace");
      setIsAiPanelOpen(false);
      return;
    }
    if (workspaceMode === "pdf_focus" && activePaper.attachment_format !== "pdf") {
      setWorkspaceMode("workspace");
      setIsSidebarVisible(true);
    }
  }, [activePaper, workspaceMode]);

  useEffect(() => {
    if (workspaceMode === "pdf_focus") {
      setIsSidebarVisible(false);
      setIsAiPanelOpen(false);
    }
  }, [workspaceMode]);

  useEffect(() => {
    setReaderSearchMatchIndex(0);
  }, [activePaperId, readerPage, readerSearchQuery, readerView?.reader_kind]);

  useEffect(() => {
    if (textToolsEnabled) return;
    setIsFindHudOpen(false);
    setReaderSearchQuery("");
    setReaderSearchMatchIndex(0);
    setReaderSearchMatchCount(0);
    setReportedActiveSearchMatchIndex(-1);
  }, [textToolsEnabled]);

  useEffect(() => {
    if (!isFindHudOpen) return;
    readerSearchInputRef.current?.focus();
    readerSearchInputRef.current?.select();
  }, [isFindHudOpen]);

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && textToolsEnabled) {
        event.preventDefault();
        setIsFindHudOpen(true);
        logEvent("find_open", { source: "keydown" });
        return;
      }
      if (event.key === "Escape" && isFindHudOpen) {
        event.preventDefault();
        setIsFindHudOpen(false);
        setReaderSearchQuery("");
        setReaderSearchMatchIndex(0);
        setReaderSearchMatchCount(0);
        setReportedActiveSearchMatchIndex(-1);
        logEvent("find_close", { source: "escape" });
        return;
      }
      if (workspaceMode !== "pdf_focus") return;
      if (event.key === "Escape" && !isTypingTarget(event.target)) {
        setWorkspaceMode("workspace");
        setIsSidebarVisible(true);
      }
    }

    window.addEventListener("keydown", handleWindowKeydown);
    return () => window.removeEventListener("keydown", handleWindowKeydown);
  }, [isFindHudOpen, textToolsEnabled, workspaceMode]);

  useEffect(() => {
    if (!isFindHudOpen) return;
    const handle = window.setTimeout(() => {
      const meta = textForLog(readerSearchQuery) ?? { text_len: 0, text_snippet: "" };
      logEvent("find_query_change", meta);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [isFindHudOpen, readerSearchQuery]);

  const moveReaderSearchMatch = (direction: 1 | -1, source: "button" | "enter") => {
    if (readerSearchMatchCount <= 0) return;
    logEvent("find_nav", {
      source,
      direction: direction === 1 ? "next" : "prev",
      total: readerSearchMatchCount,
      activeIndex: reportedActiveSearchMatchIndex,
    });
    setReaderSearchMatchIndex((current) => {
      const base = ((current % readerSearchMatchCount) + readerSearchMatchCount) % readerSearchMatchCount;
      return (base + direction + readerSearchMatchCount) % readerSearchMatchCount;
    });
  };

  const toggleCollectionExpanded = (collectionId: number) => {
    setExpandedCollectionIds((current) =>
      current.includes(collectionId)
        ? current.filter((id) => id !== collectionId)
        : [...current, collectionId],
    );
  };

  const activateItem = useCallback(
    (item: LibraryItem, options?: { focusPdf?: boolean }) => {
      setSelectedCollectionId(item.collection_id);
      setActivePaperId(item.id);
      setOpenPaperIds((current) => (current.includes(item.id) ? current : [...current, item.id]));
      if (options?.focusPdf && item.attachment_format === "pdf") {
        setWorkspaceMode("pdf_focus");
      } else {
        setWorkspaceMode("workspace");
      }
    },
    [],
  );

  const closePaperTab = (itemId: number) => {
    setOpenPaperIds((current) => {
      const remaining = current.filter((id) => id !== itemId);
      setActivePaperId((currentActive) => {
        if (currentActive !== itemId) return currentActive;
        return remaining[remaining.length - 1] ?? null;
      });
      if (activePaperId === itemId) {
        setWorkspaceMode("workspace");
        setIsSidebarVisible(true);
      }
      return remaining;
    });
  };

  const getPdfPageBundle = useCallback(
    async (input: { primary_attachment_id: number; page_index0: number; target_width_px: number }) => {
      const runtimeApi = await getApi();
      return runtimeApi.pdfEngineGetPageBundle(input);
    },
    [api],
  );

  const getPdfDocumentInfo = useCallback(
    async (primaryAttachmentId: number) => {
      const runtimeApi = await getApi();
      return runtimeApi.pdfEngineGetDocumentInfo({ primary_attachment_id: primaryAttachmentId });
    },
    [api],
  );

  const getPdfPageText = useCallback(
    async (input: { primary_attachment_id: number; page_index0: number }) => {
      const runtimeApi = await getApi();
      return runtimeApi.pdfEngineGetPageText(input);
    },
    [api],
  );

  const ocrPdfPage = useCallback(
    async (input: {
      primary_attachment_id: number;
      page_index0: number;
      png_bytes: Uint8Array;
      lang?: string;
      config_version: string;
      source_resolution?: number;
    }) => {
      const runtimeApi = await getApi();
      return runtimeApi.ocrPdfPage(input);
    },
    [api],
  );

  const importPaths = async (paths: string[], sourceLabel: string) => {
    if (!selectedCollectionId || !activeCollection || isImporting) {
      if (!hasCollections) {
        setStatusMessage("Create a collection before importing files.");
      }
      return;
    }

    const acceptedPaths = paths.filter(isSupportedPath);
    if (acceptedPaths.length === 0) {
      setStatusMessage("Only PDF, DOCX, and EPUB files can be imported.");
      return;
    }

    const runtimeApi = await getApi();
    setIsImporting(true);
    try {
      const result = await runtimeApi.importFiles({
        collection_id: selectedCollectionId,
        paths: acceptedPaths,
      });
      setLastImportResult(result);
      await loadLibrary();
      const importedItem = result.imported[0];
      if (importedItem) {
        const item = libraryItems.find((entry) => entry.id === importedItem.id) ?? {
          id: importedItem.id,
          title: importedItem.title,
          collection_id: selectedCollectionId,
          primary_attachment_id: importedItem.primary_attachment_id,
          attachment_format: "pdf",
          attachment_status: "ready",
          authors: "",
          publication_year: null,
          source: "",
          doi: null,
          tags: [],
        };
        activateItem(item);
      }
      setStatusMessage(
        `Imported ${result.imported.length} files (duplicates ${result.duplicates.length}, failed ${result.failed.length}) into ${activeCollection.name} from ${sourceLabel}.`,
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImporting(false);
      setDraggedFileCount(0);
    }
  };

  useEffect(() => {
    importPathsRef.current = (paths: string[], sourceLabel: string) => {
      void importPaths(paths, sourceLabel);
    };
  });

  const handleImport = async () => {
    if (!selectedCollectionId || !activeCollection || isImporting) {
      if (!hasCollections) setStatusMessage("Create a collection before importing files.");
      return;
    }
    const runtimeApi = await getApi();
    const paths = await runtimeApi.pickImportPaths();
    if (paths.length === 0) {
      setStatusMessage("Import cancelled.");
      return;
    }
    await importPaths(paths, "picker");
  };

  const handleImportCitations = async () => {
    if (!selectedCollectionId || !activeCollection || isImporting) {
      if (!hasCollections) setStatusMessage("Create a collection before importing citation files.");
      return;
    }
    const runtimeApi = await getApi();
    const paths = await runtimeApi.pickCitationPaths();
    if (paths.length === 0) {
      setStatusMessage("Citation import cancelled.");
      return;
    }
    const result = await runtimeApi.importCitations({ collection_id: selectedCollectionId, paths });
    setLastImportResult(result);
    await loadLibrary();
    setStatusMessage(
      `Imported ${result.imported.length} citation records (duplicates ${result.duplicates.length}, failed ${result.failed.length}) into ${activeCollection.name}.`,
    );
  };

  // Native (desktop) menu events.
  useEffect(() => {
    importDocumentsRef.current = () => {
      void handleImport();
    };
    importCitationsRef.current = () => {
      void handleImportCitations();
    };
  });

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlistenDocs: null | (() => void) = null;
    let unlistenCitations: null | (() => void) = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenDocs = await listen("menu:import-documents", () => importDocumentsRef.current());
      unlistenCitations = await listen("menu:import-citations", () => importCitationsRef.current());
    })();

    return () => {
      unlistenDocs?.();
      unlistenCitations?.();
    };
  }, []);

  // Native drag & drop (desktop): uses absolute file paths provided by Tauri.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: null | (() => void) = null;

    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          setDraggedFileCount(event.payload.paths.filter(isSupportedPath).length);
          return;
        }
        if (event.payload.type === "leave") {
          setDraggedFileCount(0);
          return;
        }
        if (event.payload.type === "drop") {
          importPathsRef.current(event.payload.paths, "drag & drop");
        }
      });
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  const handleCreateCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) {
      setStatusMessage("Enter a collection name first.");
      return;
    }
    const runtimeApi = await getApi();
    const collection = await runtimeApi.createCollection({ name });
    await refreshCollections(collection.id);
    setNewCollectionName("");
    setStatusMessage(`Created collection ${collection.name}.`);
  };

  const handleCreateTag = async () => {
    if (!activePaper) {
      setStatusMessage("Open a paper before tagging it.");
      return;
    }
    const name = newTagName.trim();
    if (!name) {
      setStatusMessage("Enter a tag name first.");
      return;
    }
    const runtimeApi = await getApi();
    const tag = await runtimeApi.createTag({ name });
    await runtimeApi.assignTag({ item_id: activePaper.id, tag_id: tag.id });
    await loadLibrary();
    const loadedTags = await runtimeApi.listTags(selectedCollectionId ?? undefined);
    setTags(loadedTags);
    setNewTagName("");
    setStatusMessage(`Tagged ${activePaper.title} with ${tag.name}.`);
  };

  const handleBatchTag = async () => {
    if (selectedItemIds.length === 0) {
      setStatusMessage("Select at least one paper first.");
      return;
    }
    const name = batchTagName.trim();
    if (!name) {
      setStatusMessage("Enter a tag name first.");
      return;
    }
    const runtimeApi = await getApi();
    const tag = await runtimeApi.createTag({ name });
    await Promise.all(selectedItemIds.map((itemId) => runtimeApi.assignTag({ item_id: itemId, tag_id: tag.id })));
    await loadLibrary();
    setBatchTagName("");
    setStatusMessage(`Tagged ${selectedItemIds.length} papers with ${tag.name}.`);
  };

  const handleBatchMove = async () => {
    if (selectedItemIds.length === 0) {
      setStatusMessage("Select at least one paper first.");
      return;
    }
    const destinationId =
      batchMoveTargetId === "current" ? selectedCollectionId : Number(batchMoveTargetId);
    if (!destinationId) {
      setStatusMessage("Choose a destination collection first.");
      return;
    }
    const runtimeApi = await getApi();
    await Promise.all(
      selectedItemIds.map((itemId) => runtimeApi.moveItem({ item_id: itemId, collection_id: destinationId })),
    );
    await loadLibrary();
    setSelectedItemIds([]);
    setStatusMessage(`Moved ${selectedItemIds.length} papers.`);
  };

  const handleItemTask = async (kind: string) => {
    if (!activePaper || !aiCapabilitiesEnabled) return;
    const runtimeApi = await getApi();
    await runtimeApi.runItemTask({ item_id: activePaper.id, kind });
    const [artifact, taskRuns] = await Promise.all([
      runtimeApi.getArtifact({ item_id: activePaper.id }),
      runtimeApi.listTaskRuns({ item_id: activePaper.id }),
    ]);
    setPaperArtifact(artifact);
    setPaperTaskRuns(taskRuns);
    setStatusMessage(`Completed ${kind} for ${activePaper.title}.`);
  };

  const handleCollectionTask = async (kind: string) => {
    if (!activeCollection || visibleScopeItemIds.length === 0) return;
    const runtimeApi = await getApi();
    await runtimeApi.runCollectionTask({
      collection_id: activeCollection.id,
      kind,
      scope_item_ids: visibleScopeItemIds,
    });
    const [artifact, taskRuns, collectionNotes] = await Promise.all([
      runtimeApi.getArtifact({ collection_id: activeCollection.id }),
      runtimeApi.listTaskRuns({ collection_id: activeCollection.id }),
      runtimeApi.listNotes(activeCollection.id),
    ]);
    setCollectionArtifact(artifact);
    setCollectionTaskRuns(taskRuns);
    setNotes(collectionNotes);
    setStatusMessage(`Completed ${kind} for ${activeCollection.name}.`);
  };

  const handleCreateResearchNote = async () => {
    if (!collectionArtifact || !activeCollection) return;
    const runtimeApi = await getApi();
    const note = await runtimeApi.createNoteFromArtifact({ artifact_id: collectionArtifact.id });
    const collectionNotes = await runtimeApi.listNotes(activeCollection.id);
    setNotes(collectionNotes);
    setActiveNoteId(note.id);
    setNoteDraft(note.markdown);
  };

  const handleSaveNoteEdits = async () => {
    if (!activeNoteId || !activeCollection) return;
    const runtimeApi = await getApi();
    await runtimeApi.updateNote({ note_id: activeNoteId, markdown: noteDraft });
    const collectionNotes = await runtimeApi.listNotes(activeCollection.id);
    setNotes(collectionNotes);
  };

  const handleExportMarkdown = async () => {
    const note = notes.find((entry) => entry.id === activeNoteId);
    if (!note) return;
    const runtimeApi = await getApi();
    const markdown = await runtimeApi.exportNoteMarkdown(note.id);
    const path = await runtimeApi.pickSavePath({
      defaultPath: `${filenameStem(noteHeading(note), "research-note")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    await runtimeApi.writeExportFile({ path, contents: markdown });
    setStatusMessage(`Saved Markdown to ${path}.`);
  };

  const handleCreatePdfHighlight = async () => {
    if (!activePaper || !pdfTextToolsEnabled || !pdfSelection) return;
    const runtimeApi = await getApi();
    const annotation = await runtimeApi.createAnnotation({
      item_id: activePaper.id,
      anchor: pdfSelection.anchor,
      kind: "highlight",
      body: pdfSelection.quote,
    });
    setAnnotations((current) => [...current, annotation]);
    setStatusMessage("Created highlight.");
  };

  const clearDomSelection = useCallback(() => {
    try {
      window.getSelection?.()?.removeAllRanges?.();
    } catch {
      // Ignore.
    }
  }, []);

  const dismissPdfSelection = useCallback(() => {
    setPdfSelection(null);
    clearDomSelection();
  }, [clearDomSelection]);

  const addColorToPdfAnchor = useCallback((anchor: string, color: PdfHighlightColor) => {
    try {
      const parsed = JSON.parse(anchor) as { type?: string; color?: unknown };
      if (!parsed || parsed.type !== "pdf_text") return anchor;
      return JSON.stringify({ ...parsed, color });
    } catch {
      return anchor;
    }
  }, []);

  const handleCreatePdfFocusHighlight = useCallback(async (color: PdfHighlightColor) => {
    if (!activePaper || !pdfTextToolsEnabled || !pdfSelection) return;
    if (workspaceMode !== "pdf_focus") return;
    const runtimeApi = await getApi();
    const annotation = await runtimeApi.createAnnotation({
      item_id: activePaper.id,
      anchor: addColorToPdfAnchor(pdfSelection.anchor, color),
      kind: "highlight",
      body: pdfSelection.quote,
    });
    setAnnotations((current) => [...current, annotation]);
    setStatusMessage("Created highlight.");
    dismissPdfSelection();
  }, [activePaper, addColorToPdfAnchor, dismissPdfSelection, getApi, pdfSelection, pdfTextToolsEnabled, workspaceMode]);

  const handleReaderPageSubmit = () => {
    const parsed = Number(readerPageInput.trim());
    if (!Number.isFinite(parsed)) {
      setReaderPageInput(String(readerPage + 1));
      return;
    }
    const nextPage = Math.max(0, Math.min(parsed - 1, readerPageCount - 1));
    setReaderPage(nextPage);
    setReaderPageInput(String(nextPage + 1));
  };

  const currentReaderHtml = useMemo(
    () => readerView?.normalized_html ?? "<article><p>No reader view available yet.</p></article>",
    [readerView],
  );

  const selectedTagName = tags.find((tag) => tag.id === selectedTagId)?.name ?? null;
  const showHighlightAction = Boolean(activePaper && pdfTextToolsEnabled);
  const isCollectionDraftStale = Boolean(
    collectionArtifact &&
      collectionArtifact.collection_id === activeCollection?.id &&
      !scopeMatches(collectionArtifact.scope_item_ids, visibleScopeItemIds),
  );

  const pdfFocusHighlightBarRef = useRef<HTMLDivElement | null>(null);
  const showPdfFocusHighlightBar = Boolean(
    workspaceMode === "pdf_focus" && activePaper?.attachment_format === "pdf" && pdfSelection,
  );

  const pdfFocusHighlightBarStyle = useMemo(() => {
    if (!showPdfFocusHighlightBar || !pdfSelection) return {};

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

    // Approximate dimensions; keep logic simple and stable across renders.
    const BAR_WIDTH_PX = 224;
    const BAR_HEIGHT_PX = 44;
    const GAP_PX = 10;
    const PADDING_PX = 12;

    const rect = pdfSelection.rect;
    let left = rect.right + GAP_PX;
    let top = rect.top - BAR_HEIGHT_PX - GAP_PX;
    if (top < PADDING_PX) top = rect.bottom + GAP_PX;

    left = clamp(left, PADDING_PX, window.innerWidth - BAR_WIDTH_PX - PADDING_PX);
    top = clamp(top, PADDING_PX, window.innerHeight - BAR_HEIGHT_PX - PADDING_PX);

    return { left: `${left}px`, top: `${top}px` } as const;
  }, [pdfSelection, showPdfFocusHighlightBar]);

  useEffect(() => {
    if (!showPdfFocusHighlightBar) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissPdfSelection();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const bar = pdfFocusHighlightBarRef.current;
      if (bar && bar.contains(target)) return;
      dismissPdfSelection();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [dismissPdfSelection, showPdfFocusHighlightBar]);

  const treeSearchFilter = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (normalized.length === 0) return null;

    const matchingItems = activeCollectionItems;
    const allowedItemIds = new Set(matchingItems.map((item) => item.id));
    const parentById = new Map(collections.map((collection) => [collection.id, collection.parent_id]));
    const allowedCollectionIds = new Set<number>();

    for (const item of matchingItems) {
      let cursor: number | null = item.collection_id;
      while (cursor !== null && !allowedCollectionIds.has(cursor)) {
        allowedCollectionIds.add(cursor);
        cursor = parentById.get(cursor) ?? null;
      }
    }

    return { allowedItemIds, allowedCollectionIds };
  }, [activeCollectionItems, collections, search]);

  const renderTreeNodes = (parentId: number | null, depth = 0): JSX.Element[] =>
    childCollectionsFor(collections, parentId)
      .filter((collection) =>
        treeSearchFilter ? treeSearchFilter.allowedCollectionIds.has(collection.id) : true,
      )
      .flatMap((collection) => {
      const isExpanded = expandedCollectionIds.includes(collection.id);
      const collectionChildren = renderTreeNodes(collection.id, depth + 1);
      const directItems = sortItems(
        libraryItems
          .filter((item) => item.collection_id === collection.id)
          .filter((item) => (treeSearchFilter ? treeSearchFilter.allowedItemIds.has(item.id) : true)),
        "title",
      );
      const collectionCount = treeSearchFilter
        ? directItems.length
        : itemCountForCollection(libraryItems, collection.id);

      return [
        <div key={`collection-${collection.id}`} role="none">
          <div
            className={`resource-tree-row resource-tree-collection ${
              selectedCollectionId === collection.id ? "resource-tree-row-active" : ""
            }`}
            role="treeitem"
            aria-expanded={isExpanded}
            aria-label={collection.name}
          >
            <button
              aria-label={isExpanded ? `Collapse ${collection.name}` : `Expand ${collection.name}`}
              className="resource-tree-toggle"
              type="button"
              onClick={() => toggleCollectionExpanded(collection.id)}
            >
              {isExpanded ? "-" : "+"}
            </button>
            <button
              className="resource-tree-label resource-tree-collection-button"
              style={{ marginLeft: `${depth * 12}px` }}
              type="button"
              onClick={() => setSelectedCollectionId(collection.id)}
            >
              {collection.name}
            </button>
            <span className="meta-count">{collectionCount}</span>
          </div>
          {isExpanded ? (
            <div className="resource-tree-group" role="group">
              {collectionChildren}
              {directItems.map((item) => (
                <button
                  key={`item-${item.id}`}
                  aria-label={item.title}
                  className={`resource-tree-row resource-tree-item ${
                    activePaperId === item.id ? "resource-tree-row-active" : ""
                  }`}
                  role="treeitem"
                  style={{ marginLeft: `${(depth + 1) * 24}px` }}
                  type="button"
                  onClick={() =>
                    item.attachment_format === "pdf"
                      ? activateItem(item, { focusPdf: true })
                      : activateItem(item)
                  }
                  onDoubleClick={() => activateItem(item, { focusPdf: true })}
                >
                  <span>{item.title}</span>
                  <span className="meta-count">{attachmentFormatLabel(item.attachment_format)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>,
      ];
    });

  return (
    <div className={`app-shell ${workspaceMode === "pdf_focus" ? "app-shell-focus" : "app-shell-workspace"}`}>
      {isSidebarVisible ? (
        <aside className="sidebar">
          <div className="panel-header">
            <p className="eyebrow">Workspace</p>
            <h1>Library</h1>
          </div>

          <div className="toolbar-row">
            <input
              aria-label="Search papers"
              className="search-input"
              placeholder="Search papers, authors, years..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <section
            aria-label="Collection drop zone"
            className={`section-block resource-panel ${draggedFileCount > 0 ? "drop-zone-active" : ""}`}
            role="region"
            onDragEnter={(event) => {
              const files = event.dataTransfer?.files;
              if (!files) return;
              setDraggedFileCount(droppedPathsFromFileList(files).length);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (event.dataTransfer) {
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDraggedFileCount(0);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (isTauriRuntime()) return;
              const files = event.dataTransfer?.files;
              const paths = files ? droppedPathsFromFileList(files) : [];
              void importPaths(paths, "drag & drop");
            }}
          >
            <div className="section-title-row">
              <h2>Resources</h2>
              <span className="meta-count">{libraryItems.length}</span>
            </div>
            {draggedFileCount > 0 ? (
              <p className="drop-helper">Drop {draggedFileCount} files into {activeCollection?.name ?? "this collection"}.</p>
            ) : null}
            {collections.length === 0 ? (
              <div className="citation-card">
                <p className="eyebrow">Empty Library</p>
                <h3>Start with a collection</h3>
                <p>Create a root collection on the left, then import PDF, DOCX, EPUB, or citation files.</p>
                <p>No collection selected</p>
              </div>
            ) : (
              <div className="resource-tree" role="tree" aria-label="Library resources">
                {treeSearchFilter && treeSearchFilter.allowedItemIds.size === 0 ? (
                  <p className="secondary-copy">No matches.</p>
                ) : (
                  renderTreeNodes(null)
                )}
              </div>
            )}
          </section>

          <details className="management-panel">
            <summary>Manage</summary>
            <div className="management-panel-body">
              <div className="collection-create-row">
                <input
                  aria-label="New collection name"
                  className="search-input"
                  placeholder="Create a new collection..."
                  value={newCollectionName}
                  onChange={(event) => setNewCollectionName(event.target.value)}
                />
                <button className="ghost-button" type="button" onClick={() => void handleCreateCollection()}>
                  Add Collection
                </button>
              </div>
              <div className="collection-create-row">
                <select
                  aria-label="Attachment filter"
                  className="mode-select"
                  value={attachmentFilter}
                  onChange={(event) => setAttachmentFilter(event.target.value as AttachmentFilter)}
                >
                  <option value="all">All Attachments</option>
                  <option value="ready">Readable Files</option>
                  <option value="missing">Missing Files</option>
                  <option value="citation_only">Citation Only</option>
                </select>
                <select
                  aria-label="Sort papers"
                  className="mode-select"
                  value={itemSort}
                  onChange={(event) => setItemSort(event.target.value as ItemSort)}
                >
                  <option value="recent">Recently Added</option>
                  <option value="title">Title A-Z</option>
                  <option value="year_desc">Year (Newest)</option>
                </select>
                <select
                  aria-label="Filter tag"
                  className="mode-select"
                  value={selectedTagId ?? "all"}
                  onChange={(event) =>
                    setSelectedTagId(event.target.value === "all" ? null : Number(event.target.value))
                  }
                >
                  <option value="all">All Tags</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="collection-create-row">
                <input
                  aria-label="New tag name"
                  className="search-input"
                  placeholder="Tag the active paper..."
                  value={newTagName}
                  onChange={(event) => setNewTagName(event.target.value)}
                />
                <button className="ghost-button" disabled={!activePaper} type="button" onClick={() => void handleCreateTag()}>
                  Add Tag
                </button>
              </div>
              {selectedItemIds.length > 0 ? (
                <div className="selection-toolbar">
                  <div className="collection-create-row">
                    <input
                      aria-label="Batch tag papers"
                      className="search-input"
                      placeholder="Tag selected papers..."
                      value={batchTagName}
                      onChange={(event) => setBatchTagName(event.target.value)}
                    />
                    <button className="ghost-button" type="button" onClick={() => void handleBatchTag()}>
                      Tag Selected
                    </button>
                  </div>
                  <div className="collection-create-row">
                    <select
                      aria-label="Batch move papers"
                      className="mode-select"
                      value={batchMoveTargetId}
                      onChange={(event) => setBatchMoveTargetId(event.target.value)}
                    >
                      <option value="current">Current Collection</option>
                      {collections
                        .filter((collection) => collection.id !== selectedCollectionId)
                        .map((collection) => (
                          <option key={collection.id} value={collection.id}>
                            {collection.name}
                          </option>
                        ))}
                    </select>
                    <button className="ghost-button" type="button" onClick={() => void handleBatchMove()}>
                      Move Selected
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>

          <section className="section-block footer-block">
            <div className="section-title-row">
              <h2>Status</h2>
              <span className="meta-count">{lastImportResult ? `${lastImportResult.imported.length}/${lastImportResult.results.length}` : "Idle"}</span>
            </div>
            <p>{statusMessage}</p>
            {selectedTagName ? <p>Filtered by tag: {selectedTagName}</p> : null}
            {importHasIssues && lastImportResult ? (
              <details className="management-panel" open>
                <summary>Show Import Issues</summary>
                <div className="management-panel-body">
                  {lastImportResult.results
                    .filter((result) => result.status !== "imported")
                    .map((result) => (
                      <div key={`${result.path}-${result.status}`} className="export-row">
                        <span>{result.status}</span>
                        <span>{result.message}</span>
                      </div>
                    ))}
                </div>
              </details>
            ) : null}
          </section>
        </aside>
      ) : null}

      <main className={`reader-shell ${workspaceMode === "pdf_focus" ? "reader-shell-focus" : "reader-shell-workspace"}`}>
        <div className={`reader-tabs ${workspaceMode === "pdf_focus" ? "reader-tabs-focus" : ""}`} role="tablist" aria-label="Open papers">
          {openPapers.map((paper) => (
            <div
              key={paper.id}
              className={`reader-tab-shell ${paper.id === activePaper?.id ? "reader-tab-active" : ""}`}
            >
              <button
                aria-selected={paper.id === activePaper?.id}
                className="reader-tab"
                role="tab"
                type="button"
                onClick={() =>
                  workspaceMode === "pdf_focus" && paper.attachment_format === "pdf"
                    ? activateItem(paper, { focusPdf: true })
                    : activateItem(paper)
                }
              >
                {paper.title}
              </button>
              <button
                aria-label={`Close tab ${paper.title}`}
                className="tab-close-button"
                type="button"
                onClick={() => closePaperTab(paper.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>

        {workspaceMode === "pdf_focus" && activePaper?.attachment_format === "pdf" ? (
          <section className="reader-panel reader-panel-focus">
            <div className="reader-toolbar reader-toolbar-focus" role="toolbar" aria-label="PDF focus toolbar">
              <div className="reader-control-group reader-control-group-page">
                <button
                  aria-label="Previous Page"
                  className="ghost-button"
                  disabled={readerPage === 0}
                  type="button"
                  onClick={() => {
                    const nextPage = Math.max(0, readerPage - 1);
                    setReaderPage(nextPage);
                    setReaderPageInput(String(nextPage + 1));
                  }}
                >
                  Prev
                </button>
                <input
                  aria-label="Reader page input"
                  className="reader-page-input"
                  value={readerPageInput}
                  onChange={(event) => setReaderPageInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleReaderPageSubmit();
                  }}
                />
                <span className="reader-control-divider">/ {readerPageCount}</span>
                <button
                  aria-label="Next Page"
                  className="ghost-button"
                  disabled={readerPage >= readerPageCount - 1}
                  type="button"
                  onClick={() => {
                    const nextPage = Math.min(readerPageCount - 1, readerPage + 1);
                    setReaderPage(nextPage);
                    setReaderPageInput(String(nextPage + 1));
                  }}
                >
                  Next
                </button>
              </div>

              <div className="reader-control-group reader-control-group-logs">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={async () => {
                    logEvent("open_logs_dir_click", {});
                    try {
                      await api.revealClientLogDir();
                      logEvent("open_logs_dir_result", { ok: true });
                    } catch (error) {
                      logEvent("open_logs_dir_result", {
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }
                  }}
                >
                  Logs
                </button>
              </div>
            </div>

            {readerView ? (
              <>
                <PdfContinuousReader
                  fitMode="fit_width"
                  getPdfDocumentInfo={getPdfDocumentInfo}
                  getPdfPageBundle={getPdfPageBundle}
                  getPdfPageText={getPdfPageText}
                  ocrPdfPage={ocrPdfPage}
                  annotations={annotations}
                  page={readerPage}
                  searchQuery={readerSearchQuery}
                  activeSearchMatchIndex={readerSearchMatchIndex}
                  view={readerView}
                  zoom={readerZoom}
                  onSearchMatchesChange={({ total, activeIndex }) => {
                    setReaderSearchMatchCount(total);
                    setReportedActiveSearchMatchIndex(activeIndex);
                    logEvent("find_matches_update", { total, activeIndex, reader: "pdf_continuous" });
                  }}
                  onSelectionChange={(selection) => setPdfSelection(selection)}
                  onActivePageChange={(pageIndex0) => {
                    setReaderPage(pageIndex0);
                    setReaderPageInput(String(pageIndex0 + 1));
                  }}
                  onNavigateToPage={(pageIndex0) => {
                    setReaderPage(pageIndex0);
                    setReaderPageInput(String(pageIndex0 + 1));
                  }}
                  onPageCountChange={(pageCount) => {
                    if (!activePaper) return;
                    setPdfPageCounts((current) =>
                      current[activePaper.id] === pageCount ? current : { ...current, [activePaper.id]: pageCount },
                    );
                  }}
                />

                {showPdfFocusHighlightBar ? (
                  <div
                    className="pdf-focus-highlight-bar"
                    ref={pdfFocusHighlightBarRef}
                    role="toolbar"
                    aria-label="PDF highlight colors"
                    style={pdfFocusHighlightBarStyle}
                  >
                    {(["yellow", "red", "green", "blue", "purple"] as const).map((color) => (
                      <button
                        key={color}
                        type="button"
                        className="pdf-focus-highlight-swatch"
                        data-color={color}
                        aria-label={`Highlight ${color}`}
                        onClick={() => void handleCreatePdfFocusHighlight(color)}
                      />
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="reader-focus-loading" role="status">
                Loading PDF...
              </div>
            )}
          </section>
        ) : (
          <section className="reader-panel reader-panel-workspace">
            <div className="reader-meta-row">
              <div>
                <p className="eyebrow">Reader</p>
                <h2>{activePaper?.title ?? "No paper selected"}</h2>
                <p className="secondary-copy">
                  {activePaper ? activePaperMetadata ?? "No metadata" : "No metadata"}
                </p>
                <p className="secondary-copy">
                  {[
                    activeCollection?.name ?? "No collection",
                    activePaper && activePaper.attachment_status !== "ready" ? activePaper.attachment_status : null,
                    activePaper ? attachmentFormatLabel(activePaper.attachment_format) : "Document",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="reader-actions">
                {readyForAi ? (
                  <button
                    aria-expanded={isAiPanelOpen}
                    className="primary-button"
                    type="button"
                    onClick={() => setIsAiPanelOpen(true)}
                  >
                    Open AI Workspace
                  </button>
                ) : null}
                {showHighlightAction ? (
                  <button
                    aria-label="Highlight selection"
                    className="ghost-button"
                    disabled={!pdfSelection}
                    type="button"
                    onClick={() => void handleCreatePdfHighlight()}
                  >
                    Highlight
                  </button>
                ) : null}
                {activePaper ? (
                  <label className="ghost-button">
                    <input
                      aria-label={`Select paper ${activePaper.title}`}
                      checked={selectedItemIds.includes(activePaper.id)}
                      onChange={() =>
                        setSelectedItemIds((current) =>
                          current.includes(activePaper.id)
                            ? current.filter((id) => id !== activePaper.id)
                            : [...current, activePaper.id],
                        )
                      }
                      type="checkbox"
                    />
                    Select
                  </label>
                ) : null}
              </div>
            </div>

            <div className="reader-toolbar">
              {readerView && readerView.content_status !== "ready" ? (
                <span className="meta-count">{readerView.content_notice ?? readerView.content_status}</span>
              ) : null}
              {activePaper && activePaper.attachment_status !== "ready" ? (
                <span className="meta-count">{activePaper.attachment_status}</span>
              ) : null}
            </div>

            {activePaper && readerView ? (
              readerView.reader_kind === "pdf" ? (
                <PdfReader
                  fitMode="fit_width"
                  getPdfDocumentInfo={getPdfDocumentInfo}
                  getPdfPageBundle={getPdfPageBundle}
                  annotations={annotations}
                  page={readerPage}
                  searchQuery={readerSearchQuery}
                  activeSearchMatchIndex={readerSearchMatchIndex}
                  view={readerView}
                  zoom={readerZoom}
                  onSearchMatchesChange={({ total, activeIndex }) => {
                    setReaderSearchMatchCount(total);
                    setReportedActiveSearchMatchIndex(activeIndex);
                    logEvent("find_matches_update", { total, activeIndex, reader: "pdf_single" });
                  }}
                  onSelectionChange={(selection) => setPdfSelection(selection)}
                  onNavigateToPage={(pageIndex0) => {
                    setReaderPage(pageIndex0);
                    setReaderPageInput(String(pageIndex0 + 1));
                  }}
                  onPageCountChange={(pageCount) => {
                    setPdfPageCounts((current) =>
                      current[activePaper.id] === pageCount
                        ? current
                        : { ...current, [activePaper.id]: pageCount },
                    );
                  }}
                />
              ) : (
                <NormalizedReader
                  pageHtml={currentReaderHtml}
                  searchQuery={readerSearchQuery}
                  activeSearchMatchIndex={readerSearchMatchIndex}
                  onSearchMatchesChange={({ total, activeIndex }) => {
                    setReaderSearchMatchCount(total);
                    setReportedActiveSearchMatchIndex(activeIndex);
                    logEvent("find_matches_update", { total, activeIndex, reader: "normalized" });
                  }}
                  zoom={readerZoom}
                />
              )
            ) : (
              <div className="citation-card">
                <p className="eyebrow">Ready for Reading</p>
                <h3>No collection selected</h3>
                <p>{hasCollections ? "Select a document from the resource tree." : "Create your first collection to start building the desktop library."}</p>
              </div>
            )}

            {readerView && readerView.reader_kind !== "pdf" ? (
              <div className="citation-card">
                <p className="eyebrow">Reader Content</p>
                <h3>{readerView.title}</h3>
                <p>{readerView.plain_text}</p>
              </div>
            ) : null}

            {visibleAnnotations.length > 0 && workspaceMode === "workspace" ? (
              <div className="annotation-panel">
                <div className="section-title-row">
                  <h3>Annotations</h3>
                  <span className="meta-count">{visibleAnnotations.length}</span>
                </div>
                <div className="annotation-filter-row">
                  <button
                    aria-pressed={annotationFilter === "all"}
                    className={`ghost-button ${annotationFilter === "all" ? "nav-item-active" : ""}`}
                    type="button"
                    onClick={() => setAnnotationFilter("all")}
                  >
                    All Annotations
                  </button>
                  <button
                    aria-pressed={annotationFilter === "current_page"}
                    className={`ghost-button ${annotationFilter === "current_page" ? "nav-item-active" : ""}`}
                    type="button"
                    onClick={() => setAnnotationFilter("current_page")}
                  >
                    Current Page Annotations
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        )}

        {isFindHudOpen ? (
          <div className="find-hud" role="dialog" aria-label="Find in document">
            <input
              aria-label="Find in document"
              className="find-hud-input"
              placeholder="Find in document..."
              ref={readerSearchInputRef}
              value={readerSearchQuery}
              onChange={(event) => setReaderSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveReaderSearchMatch(event.shiftKey ? -1 : 1, "enter");
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setIsFindHudOpen(false);
                  setReaderSearchQuery("");
                  setReaderSearchMatchIndex(0);
                  setReaderSearchMatchCount(0);
                  setReportedActiveSearchMatchIndex(-1);
                  logEvent("find_close", { source: "escape" });
                }
              }}
            />
            <span className="meta-count">
              {readerSearchMatchCount > 0 && reportedActiveSearchMatchIndex >= 0
                ? `${reportedActiveSearchMatchIndex + 1} / ${readerSearchMatchCount}`
                : "0 / 0"}
            </span>
            <button
              aria-label="Previous match"
              className="ghost-button"
              type="button"
              onClick={() => moveReaderSearchMatch(-1, "button")}
            >
              Prev
            </button>
            <button
              aria-label="Next match"
              className="ghost-button"
              type="button"
              onClick={() => moveReaderSearchMatch(1, "button")}
            >
              Next
            </button>
            <button
              aria-label="Close find"
              className="ghost-button"
              type="button"
              onClick={() => {
                setIsFindHudOpen(false);
                setReaderSearchQuery("");
                setReaderSearchMatchIndex(0);
                setReaderSearchMatchCount(0);
                setReportedActiveSearchMatchIndex(-1);
                logEvent("find_close", { source: "button" });
              }}
            >
              Close
            </button>
          </div>
        ) : null}
      </main>

      {isAiPanelOpen && readyForAi ? (
        <>
          <div
            aria-hidden="true"
            className="drawer-backdrop drawer-backdrop-visible"
            onClick={() => setIsAiPanelOpen(false)}
          />
          <aside className="ai-shell ai-shell-open">
            <div className="panel-header panel-header-row">
              <div>
                <p className="eyebrow">AI Workspace</p>
                <h2>Research Copilot</h2>
              </div>
              <button className="ghost-button" type="button" onClick={() => setIsAiPanelOpen(false)}>
                Close
              </button>
            </div>

            <div className="reader-tabs" role="tablist" aria-label="AI scope">
              <button
                className={`reader-tab ${aiPanelMode === "paper" ? "reader-tab-active" : ""}`}
                role="tab"
                type="button"
                onClick={() => setAiPanelMode("paper")}
              >
                Current Paper
              </button>
              <button
                className={`reader-tab ${aiPanelMode === "collection" ? "reader-tab-active" : ""}`}
                role="tab"
                type="button"
                onClick={() => setAiPanelMode("collection")}
              >
                Current Collection
              </button>
            </div>

            {aiPanelMode === "paper" ? (
              <section className="ai-card-stack">
                <div className="context-card">
                  <p className="eyebrow">Paper Scope</p>
                  <h3>{activePaper?.title ?? "No active paper"}</h3>
                  <p>{readerView?.plain_text ?? "No reader view."}</p>
                </div>
                <div className="action-grid">
                  {itemActions.map((action) => (
                    <button
                      key={action.kind}
                      className="action-card"
                      type="button"
                      onClick={() => void handleItemTask(action.kind)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                <div className="result-card">
                  <h3>Cached Summary</h3>
                  <p>{paperArtifact?.markdown ?? "Run an AI paper task to cache the first artifact."}</p>
                </div>
                <div className="result-card">
                  <h3>Paper Task History</h3>
                  {paperTaskRuns.length > 0 ? (
                    paperTaskRuns.slice(0, 4).map((task) => (
                      <div key={task.id} className="result-card">
                        <div className="export-row">
                          <span>{task.kind}</span>
                          <span className="meta-count">{task.status}</span>
                        </div>
                        <p>{taskPreview(task)}</p>
                      </div>
                    ))
                  ) : (
                    <p>No paper tasks have run yet.</p>
                  )}
                </div>
              </section>
            ) : (
              <section className="ai-card-stack">
                <div className="context-card">
                  <p className="eyebrow">Collection Scope</p>
                  <h3>{activeCollection?.name ?? "No active collection"}</h3>
                  <p>{visibleItems.length} papers included in the current scope.</p>
                </div>
                <div className="action-grid">
                  {collectionActions.map((task) => (
                    <button
                      key={task.kind}
                      className="action-card"
                      type="button"
                      onClick={() => void handleCollectionTask(task.kind)}
                    >
                      {task.label}
                    </button>
                  ))}
                </div>
                <div className="result-card">
                  <h3>Draft Status</h3>
                  {isCollectionDraftStale ? <p>Draft scope is stale.</p> : null}
                  <p>{collectionArtifact?.markdown ?? "No collection draft yet."}</p>
                  {collectionArtifact ? (
                    <button className="ghost-button" type="button" onClick={() => void handleCreateResearchNote()}>
                      Save as Research Note
                    </button>
                  ) : null}
                </div>
                {activeNoteId ? (
                  <div className="result-card">
                    <h3>Research Note</h3>
                    <textarea
                      aria-label="Research note editor"
                      className="note-editor"
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                    />
                    <div className="export-row">
                      <button className="ghost-button" type="button" onClick={() => void handleSaveNoteEdits()}>
                        Save Note Edits
                      </button>
                      <button className="ghost-button" type="button" onClick={() => void handleExportMarkdown()}>
                        Export Markdown
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="result-card">
                  <h3>Saved Notes</h3>
                  {notes.length > 0 ? (
                    notes.map((note) => (
                      <button
                        key={note.id}
                        className={`nav-item ${note.id === activeNoteId ? "nav-item-active" : ""}`}
                        type="button"
                        onClick={() => {
                          setActiveNoteId(note.id);
                          setNoteDraft(note.markdown);
                        }}
                      >
                        {noteHeading(note)}
                      </button>
                    ))
                  ) : (
                    <p>No notes yet.</p>
                  )}
                </div>
                <div className="result-card">
                  <h3>Task History</h3>
                  {collectionTaskRuns.length > 0 ? (
                    collectionTaskRuns.slice(0, 4).map((task) => (
                      <div key={task.id} className="result-card">
                        <div className="export-row">
                          <span>{task.kind}</span>
                          <span className="meta-count">{task.status}</span>
                        </div>
                        <p>{taskPreview(task)}</p>
                      </div>
                    ))
                  ) : (
                    <p>No collection tasks have run yet.</p>
                  )}
                </div>
              </section>
            )}
          </aside>
        </>
      ) : null}
    </div>
  );
}
