import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NormalizedReader } from "./components/readers/NormalizedReader";
import { PdfReader } from "./components/readers/PdfReader";
import type {
  AIArtifact,
  AITask,
  Annotation,
  AnnotationFilter,
  AppApi,
  Collection,
  ImportBatchResult,
  ImportMode,
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

const formatItemMetadata = (item: LibraryItem) =>
  [item.authors, item.publication_year, item.source].filter(Boolean).join(" · ");

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
  const [importMode, setImportMode] = useState<ImportMode>("managed_copy");
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
  const [pdfPageCounts, setPdfPageCounts] = useState<Record<number, number>>({});
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>("all");

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
  const isPdfReader = readerView?.reader_kind === "pdf";
  const textCapabilitiesEnabled = Boolean(
    activePaper &&
      activePaper.attachment_status !== "missing" &&
      activePaper.attachment_status !== "citation_only" &&
      readerView?.content_status === "ready",
  );
  const readyForAi = Boolean(activePaper && textCapabilitiesEnabled);
  const readerPageCount =
    activePaper?.id && isPdfReader ? pdfPageCounts[activePaper.id] ?? readerView?.page_count ?? 1 : 1;
  const visibleAnnotations = useMemo(() => {
    if (annotationFilter === "current_page") {
      return annotations.filter((annotation) => annotation.anchor === `page-${readerPage + 1}`);
    }
    return annotations;
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
      setReaderView(null);
      setAnnotations([]);
      setPaperArtifact(null);
      setPaperTaskRuns([]);
      return;
    }

    let cancelled = false;
    const itemId = activePaperId;

    async function loadReaderContext() {
      const runtimeApi = await getApi();
      const [view, itemAnnotations, artifact, taskRuns] = await Promise.all([
        runtimeApi.getReaderView(itemId),
        runtimeApi.listAnnotations(itemId),
        runtimeApi.getArtifact({ item_id: itemId }),
        runtimeApi.listTaskRuns({ item_id: itemId }),
      ]);
      if (cancelled) return;
      setReaderView(view);
      setAnnotations(itemAnnotations);
      setPaperArtifact(artifact);
      setPaperTaskRuns(taskRuns);
      setReaderPage(0);
      setReaderPageInput("1");
      setReaderSearchQuery("");
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
    if (workspaceMode === "pdf_focus" && readerView?.attachment_format !== "pdf") {
      setWorkspaceMode("workspace");
      setIsSidebarVisible(true);
    }
  }, [activePaper, readerView, workspaceMode]);

  useEffect(() => {
    if (workspaceMode === "pdf_focus") {
      setIsSidebarVisible(false);
      setIsAiPanelOpen(false);
    }
  }, [workspaceMode]);

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (workspaceMode !== "pdf_focus") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && textCapabilitiesEnabled) {
        event.preventDefault();
        readerSearchInputRef.current?.focus();
        readerSearchInputRef.current?.select();
        return;
      }
      if (event.key === "Escape" && !isTypingTarget(event.target)) {
        setWorkspaceMode("workspace");
        setIsSidebarVisible(true);
      }
    }

    window.addEventListener("keydown", handleWindowKeydown);
    return () => window.removeEventListener("keydown", handleWindowKeydown);
  }, [textCapabilitiesEnabled, workspaceMode]);

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

  const loadPrimaryAttachmentBytes = useCallback(
    async (primaryAttachmentId: number) => {
      const runtimeApi = await getApi();
      return runtimeApi.readPrimaryAttachmentBytes(primaryAttachmentId);
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
        mode: importMode,
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
    if (!activePaper || !textCapabilitiesEnabled) return;
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
  const showPdfNotice =
    readerView?.attachment_format === "pdf" && readerView.content_status !== "ready";
  const showTextTools = Boolean(readerView?.attachment_format === "pdf" ? textCapabilitiesEnabled : true);
  const isCollectionDraftStale = Boolean(
    collectionArtifact &&
      collectionArtifact.collection_id === activeCollection?.id &&
      !scopeMatches(collectionArtifact.scope_item_ids, visibleScopeItemIds),
  );

  const renderTreeNodes = (parentId: number | null, depth = 0): JSX.Element[] =>
    childCollectionsFor(collections, parentId).flatMap((collection) => {
      const isExpanded = expandedCollectionIds.includes(collection.id);
      const collectionChildren = renderTreeNodes(collection.id, depth + 1);
      const directItems = sortItems(
        libraryItems.filter((item) => item.collection_id === collection.id),
        "title",
      );

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
            <span className="meta-count">{itemCountForCollection(libraryItems, collection.id)}</span>
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
                  onClick={() => activateItem(item)}
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
            <select
              aria-label="Import mode"
              className="mode-select"
              value={importMode}
              onChange={(event) => setImportMode(event.target.value as ImportMode)}
            >
              <option value="managed_copy">Managed Copy</option>
              <option value="linked_file">Linked File</option>
            </select>
            <button className="primary-button" type="button" onClick={() => void handleImport()}>
              {isImporting ? "Importing..." : "Import"}
            </button>
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
                {renderTreeNodes(null)}
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
                <button
                  className="ghost-button"
                  disabled={!activeCollection || isImporting}
                  type="button"
                  onClick={() => void handleImportCitations()}
                >
                  Import Citations
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
                onClick={() => activateItem(paper)}
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

        {workspaceMode === "pdf_focus" && activePaper && readerView ? (
          <section className="reader-panel reader-panel-focus">
            <div className="reader-meta-row reader-meta-row-focus">
              <div className="reader-focus-heading">
                <h2>{activePaper.title}</h2>
                <p className="secondary-copy reader-focus-subtitle">
                  {activeCollection?.name ?? "No collection"} · {attachmentFormatLabel(activePaper.attachment_format)}
                </p>
              </div>
              <div className="reader-actions reader-actions-focus">
                <button aria-label="Back to workspace" className="ghost-button focus-action-button" type="button" onClick={() => {
                  setWorkspaceMode("workspace");
                  setIsSidebarVisible(true);
                }}>
                  Back
                </button>
                <button className="ghost-button focus-action-button" type="button" onClick={() => {
                  setWorkspaceMode("workspace");
                  setIsSidebarVisible(true);
                }}>
                  Show sidebar
                </button>
              </div>
            </div>

            <div className="reader-toolbar">
              <div className="reader-toolbar-status">
                <span className="status-pill">{readerView.content_status}</span>
                <span className="meta-count">
                  Page {readerPage + 1} of {readerPageCount}
                </span>
                <span className="meta-count">Zoom {readerZoom}%</span>
              </div>
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
              <div className="reader-control-group reader-control-group-zoom">
                <button
                  aria-label="Zoom Out"
                  className="ghost-button"
                  type="button"
                  onClick={() => setReaderZoom((current) => Math.max(70, current - 10))}
                >
                  -
                </button>
                <span className="reader-control-divider">{readerZoom}%</span>
                <button
                  aria-label="Zoom In"
                  className="ghost-button"
                  type="button"
                  onClick={() => setReaderZoom((current) => Math.min(180, current + 10))}
                >
                  +
                </button>
              </div>
              <div className="reader-control-group reader-control-group-search">
                <input
                  aria-label="Find in document"
                  className="reader-search-input"
                  disabled={!textCapabilitiesEnabled}
                  placeholder="Find in document..."
                  ref={readerSearchInputRef}
                  value={readerSearchQuery}
                  onChange={(event) => setReaderSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setReaderSearchQuery("");
                    }
                  }}
                />
              </div>
            </div>

            {showPdfNotice ? (
              <div className="citation-card">
                <p className="eyebrow">Text Capabilities</p>
                <p>{readerView.content_notice ?? "This PDF can be read by page, but no reliable text layer is available."}</p>
              </div>
            ) : null}

            <PdfReader
              loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
              page={readerPage}
              view={readerView}
              zoom={readerZoom}
              onPageCountChange={(pageCount) => {
                if (!activePaper) return;
                setPdfPageCounts((current) =>
                  current[activePaper.id] === pageCount
                    ? current
                    : { ...current, [activePaper.id]: pageCount },
                );
              }}
            />
          </section>
        ) : (
          <section className="reader-panel reader-panel-workspace">
            <div className="reader-meta-row">
              <div>
                <p className="eyebrow">Reader</p>
                <h2>{activePaper?.title ?? "No paper selected"}</h2>
                <p className="secondary-copy">{activePaper ? formatItemMetadata(activePaper) : "No metadata"}</p>
                <p className="secondary-copy">
                  {activeCollection?.name ?? "No collection"} · {activePaper?.attachment_status ?? "idle"} · {activePaper ? attachmentFormatLabel(activePaper.attachment_format) : "Document"}
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
                {showTextTools ? (
                  <button className="ghost-button" type="button">
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

            {showPdfNotice ? (
              <div className="citation-card">
                <p className="eyebrow">Text Capabilities</p>
                <p>{readerView?.content_notice ?? "This PDF can be read by page, but no reliable text layer is available."}</p>
              </div>
            ) : null}

            <div className="reader-toolbar">
              <input
                aria-label="Find in document"
                className="reader-search-input"
                disabled={!textCapabilitiesEnabled}
                placeholder="Find in document..."
                ref={readerSearchInputRef}
                value={readerSearchQuery}
                onChange={(event) => setReaderSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setReaderSearchQuery("");
                  }
                }}
              />
              <span className="meta-count">
                {textCapabilitiesEnabled ? "ready" : readerView?.content_status ?? "idle"}
              </span>
            </div>

            {activePaper && readerView ? (
              readerView.reader_kind === "pdf" ? (
                <PdfReader
                  loadPrimaryAttachmentBytes={loadPrimaryAttachmentBytes}
                  page={readerPage}
                  view={readerView}
                  zoom={readerZoom}
                  onPageCountChange={(pageCount) => {
                    setPdfPageCounts((current) =>
                      current[activePaper.id] === pageCount
                        ? current
                        : { ...current, [activePaper.id]: pageCount },
                    );
                  }}
                />
              ) : (
                <NormalizedReader pageHtml={currentReaderHtml} zoom={readerZoom} />
              )
            ) : (
              <div className="citation-card">
                <p className="eyebrow">Ready for Reading</p>
                <h3>No collection selected</h3>
                <p>{hasCollections ? "Select a document from the resource tree." : "Create your first collection to start building the desktop library."}</p>
              </div>
            )}

            {activePaper ? (
              <div className="citation-card">
                <p className="eyebrow">Document Metadata</p>
                <div className="export-row">
                  <span>Authors</span>
                  <span>{activePaper.authors}</span>
                </div>
                <div className="export-row">
                  <span>Year</span>
                  <span>{activePaper.publication_year ?? "Unknown"}</span>
                </div>
                <div className="export-row">
                  <span>Source</span>
                  <span>{activePaper.source}</span>
                </div>
                <div className="export-row">
                  <span>Tags</span>
                  <span>{activePaper.tags.length > 0 ? activePaper.tags.join(" · ") : "No tags"}</span>
                </div>
              </div>
            ) : null}

            {readerView && !showPdfNotice && readerView.reader_kind !== "pdf" ? (
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
