import { useEffect, useMemo, useState } from "react";

import { getApi } from "./lib/api";
import type {
  AIArtifact,
  AITask,
  Annotation,
  CitationFormat,
  Collection,
  ImportMode,
  LibraryItem,
  ReaderView,
  ResearchNote,
  Tag,
} from "./lib/contracts";

type AiPanelMode = "paper" | "collection";
type ReaderSection = "Overview" | "Methods" | "Results" | "Notes";
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

const readerSections: ReaderSection[] = ["Overview", "Methods", "Results", "Notes"];

const excerptFromView = (view: ReaderView | null) =>
  view?.plain_text.split(". ").slice(0, 2).join(". ") ?? "Open a paper to see its extracted text.";

const taskPreview = (task: AITask) =>
  (() => {
    const lines = task.output_markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
    return lines[lines.length - 1]?.replace(/^- /, "") ?? "No preview available.";
  })();

const noteHeading = (note: ResearchNote) =>
  note.markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"))
    ?.replace(/^#+\s*/, "") ?? note.title;

const formatHint = (title: string) => {
  if (title.toLowerCase().endsWith("notes")) return "EPUB";
  if (title.toLowerCase().includes("survey")) return "DOCX";
  return "PDF";
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

const applyTagFilter = (items: LibraryItem[], tags: Tag[], selectedTagId: number | null) => {
  if (selectedTagId === null) return items;
  const selectedTagName = tags.find((tag) => tag.id === selectedTagId)?.name;
  if (!selectedTagName) return items;
  return items.filter((item) => item.tags.includes(selectedTagName));
};

const filterItemsByAttachment = (items: LibraryItem[], attachmentFilter: AttachmentFilter) => {
  if (attachmentFilter === "all") return items;
  return items.filter((item) => item.attachment_status === attachmentFilter);
};

const sortItems = (items: LibraryItem[], itemSort: ItemSort) => {
  const nextItems = [...items];
  nextItems.sort((left, right) => {
    if (itemSort === "title") {
      return left.title.localeCompare(right.title);
    }
    if (itemSort === "year_desc") {
      return (right.publication_year ?? 0) - (left.publication_year ?? 0);
    }
    return right.id - left.id;
  });
  return nextItems;
};

const formatItemMetadata = (item: LibraryItem | null) => {
  if (!item) return "No metadata";
  const year = item.publication_year ? String(item.publication_year) : "Unknown year";
  return `${item.authors} · ${year} · ${item.source}`;
};

const readerStateCopy = (activePaper: LibraryItem | null, itemCount: number) => {
  if (!activePaper) {
    return {
      title: itemCount === 0 ? "No papers in this collection yet" : "Choose a paper to start reading",
      body:
        itemCount === 0
          ? "Import PDF, DOCX, EPUB, or citation files to start this workspace."
          : "Select a paper from the collection to load its reader context and AI workspace.",
    };
  }

  if (activePaper.attachment_status === "missing") {
    return {
      title: "Source file missing",
      body: "Relink this attachment to restore reading and AI actions.",
    };
  }

  if (activePaper.attachment_status === "citation_only") {
    return {
      title: "Metadata-only entry",
      body: "Import a PDF, DOCX, or EPUB later to enable full reading and AI extraction.",
      secondary: "Citation metadata is available for export and organization right now.",
    };
  }

  return null;
};

const canRunReaderActions = (activePaper: LibraryItem | null) =>
  Boolean(activePaper) &&
  activePaper?.attachment_status !== "missing" &&
  activePaper?.attachment_status !== "citation_only";

type CollectionTreeEntry = {
  collection: Collection;
  depth: number;
  pathLabel: string;
};

const orderedCollections = (collections: Collection[]): CollectionTreeEntry[] => {
  const childrenByParent = new Map<number | null, Collection[]>();

  for (const collection of collections) {
    const siblings = childrenByParent.get(collection.parent_id) ?? [];
    siblings.push(collection);
    childrenByParent.set(collection.parent_id, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }

  const walk = (
    parentId: number | null,
    depth: number,
    parentPath: string | null,
  ): CollectionTreeEntry[] =>
    (childrenByParent.get(parentId) ?? []).flatMap((collection) => {
      const pathLabel = parentPath ? `${parentPath} / ${collection.name}` : collection.name;
      return [
        { collection, depth, pathLabel },
        ...walk(collection.id, depth + 1, pathLabel),
      ];
    });

  return walk(null, 0, null);
};

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

export default function App() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [importMode, setImportMode] = useState<ImportMode>("managed_copy");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [moveCollectionParentValue, setMoveCollectionParentValue] = useState("root");
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [openPaperIds, setOpenPaperIds] = useState<number[]>([]);
  const [activePaperId, setActivePaperId] = useState<number | null>(null);
  const [aiPanelMode, setAiPanelMode] = useState<AiPanelMode>("paper");
  const [search, setSearch] = useState("");
  const [readerView, setReaderView] = useState<ReaderView | null>(null);
  const [activeReaderSection, setActiveReaderSection] = useState<ReaderSection>("Overview");
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [paperArtifact, setPaperArtifact] = useState<AIArtifact | null>(null);
  const [paperTaskRuns, setPaperTaskRuns] = useState<AITask[]>([]);
  const [collectionArtifact, setCollectionArtifact] = useState<AIArtifact | null>(null);
  const [collectionTaskRuns, setCollectionTaskRuns] = useState<AITask[]>([]);
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [draggedFileCount, setDraggedFileCount] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [latestCitation, setLatestCitation] = useState("");
  const [isEditingMetadata, setIsEditingMetadata] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState({
    title: "",
    authors: "",
    publication_year: "",
    source: "",
    doi: "",
  });
  const [pendingCollectionStatus, setPendingCollectionStatus] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Loading library...");
  const [itemSort, setItemSort] = useState<ItemSort>("recent");
  const [attachmentFilter, setAttachmentFilter] = useState<AttachmentFilter>("all");
  const hasCollections = collections.length > 0;

  useEffect(() => {
    let cancelled = false;

    async function loadCollections() {
      const api = await getApi();
      const loadedCollections = await api.listCollections();
      if (cancelled) return;

      setCollections(loadedCollections);
      const firstCollectionId = loadedCollections[0]?.id ?? null;
      setSelectedCollectionId((current) => current ?? firstCollectionId);
      setStatusMessage(
        loadedCollections.length > 0
          ? `Loaded ${loadedCollections.length} collections.`
          : "Create your first collection to start building the desktop library.",
      );
    }

    void loadCollections();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedCollectionId === null) {
      setItems([]);
      setOpenPaperIds([]);
      setActivePaperId(null);
      if (!pendingCollectionStatus) {
        setStatusMessage(
          hasCollections
            ? "Select a collection to view its library."
            : "Create your first collection to start building the desktop library.",
        );
      }
      return;
    }
    const collectionId = selectedCollectionId;
    let cancelled = false;

    async function loadItems() {
      const api = await getApi();
      const loadedItems =
        search.trim().length > 0
          ? await api.searchItems(search.trim())
          : await api.listItems(collectionId);
      if (cancelled) return;

      const filteredItems =
        search.trim().length > 0
          ? loadedItems.filter((item) => item.collection_id === collectionId)
          : loadedItems;
      const tagFilteredItems = applyTagFilter(filteredItems, tags, selectedTagId);
      setItems(tagFilteredItems);
      const nextActiveId = tagFilteredItems[0]?.id ?? null;
      setActivePaperId((current) =>
        current && tagFilteredItems.some((item) => item.id === current) ? current : nextActiveId,
      );
      setOpenPaperIds((current) => {
        const aliveIds = current.filter((id) => tagFilteredItems.some((item) => item.id === id));
        if (nextActiveId && !aliveIds.includes(nextActiveId)) {
          return [...aliveIds, nextActiveId];
        }
        return aliveIds;
      });
      if (pendingCollectionStatus) {
        setStatusMessage(pendingCollectionStatus);
      } else {
        if (tagFilteredItems.length > 0) {
          setStatusMessage(`${tagFilteredItems.length} papers ready in the current collection.`);
        }
      }
    }

    void loadItems();

    return () => {
      cancelled = true;
    };
  }, [hasCollections, pendingCollectionStatus, search, selectedCollectionId, selectedTagId, tags]);

  useEffect(() => {
    if (selectedCollectionId === null) {
      setTags([]);
      setSelectedTagId(null);
      return;
    }
    const collectionId = selectedCollectionId;
    let cancelled = false;

    async function loadTags() {
      const api = await getApi();
      const loadedTags = await api.listTags(collectionId);
      if (cancelled) return;
      setTags(loadedTags);
      setSelectedTagId((current) =>
        current && loadedTags.some((tag) => tag.id === current) ? current : null,
      );
    }

    void loadTags();

    return () => {
      cancelled = true;
    };
  }, [selectedCollectionId]);

  useEffect(() => {
    if (selectedCollectionId === null) {
      setMoveCollectionParentValue("root");
      return;
    }
    const currentCollection = collections.find((collection) => collection.id === selectedCollectionId);
    setMoveCollectionParentValue(
      currentCollection?.parent_id !== null && currentCollection?.parent_id !== undefined
        ? String(currentCollection.parent_id)
        : "root",
    );
  }, [collections, selectedCollectionId]);

  useEffect(() => {
    if (activePaperId === null) {
      setReaderView(null);
      setAnnotations([]);
      setPaperArtifact(null);
      setPaperTaskRuns([]);
      setActiveReaderSection("Overview");
      setActiveAnchor(null);
      return;
    }
    const itemId = activePaperId;
    let cancelled = false;

    async function loadReaderContext() {
      const api = await getApi();
      const [view, itemAnnotations, artifact, taskRuns] = await Promise.all([
        api.getReaderView(itemId),
        api.listAnnotations(itemId),
        api.getArtifact({ item_id: itemId }),
        api.listTaskRuns({ item_id: itemId }),
      ]);
      if (cancelled) return;

      setReaderView(view);
      setActiveReaderSection("Overview");
      setActiveAnchor(null);
      setAnnotations(itemAnnotations);
      setPaperArtifact(artifact);
      setPaperTaskRuns(taskRuns);
      setOpenPaperIds((current) =>
        current.includes(itemId) ? current : [...current, itemId],
      );
    }

    void loadReaderContext();

    return () => {
      cancelled = true;
    };
  }, [activePaperId]);

  useEffect(() => {
    if (selectedCollectionId === null) {
      setCollectionArtifact(null);
      setCollectionTaskRuns([]);
      setNotes([]);
      setActiveNoteId(null);
      setNoteDraft("");
      return;
    }
    const collectionId = selectedCollectionId;
    let cancelled = false;

    async function loadCollectionOutputs() {
      const api = await getApi();
      const [artifact, collectionNotes, taskRuns] = await Promise.all([
        api.getArtifact({ collection_id: collectionId }),
        api.listNotes(collectionId),
        api.listTaskRuns({ collection_id: collectionId }),
      ]);
      if (cancelled) return;
      setCollectionArtifact(artifact);
      setCollectionTaskRuns(taskRuns);
      setNotes(collectionNotes);
      setActiveNoteId(collectionNotes[0]?.id ?? null);
      setNoteDraft(collectionNotes[0]?.markdown ?? "");
    }

    void loadCollectionOutputs();

    return () => {
      cancelled = true;
    };
  }, [selectedCollectionId]);

  const visibleItems = useMemo(
    () => sortItems(filterItemsByAttachment(items, attachmentFilter), itemSort),
    [attachmentFilter, itemSort, items],
  );

  useEffect(() => {
    setActivePaperId((current) =>
      current && visibleItems.some((item) => item.id === current) ? current : visibleItems[0]?.id ?? null,
    );
    setOpenPaperIds((current) => {
      const aliveIds = current.filter((id) => visibleItems.some((item) => item.id === id));
      const nextActiveId = visibleItems[0]?.id;
      if (nextActiveId && !aliveIds.includes(nextActiveId)) {
        return [...aliveIds, nextActiveId];
      }
      return aliveIds;
    });
  }, [visibleItems]);

  const openPapers = useMemo(
    () =>
      openPaperIds
        .map((id) => visibleItems.find((item) => item.id === id))
        .filter((item): item is LibraryItem => Boolean(item)),
    [openPaperIds, visibleItems],
  );

  const activePaper = visibleItems.find((item) => item.id === activePaperId) ?? openPapers[0] ?? null;
  const activeCollection =
    collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const selectedTagName = tags.find((tag) => tag.id === selectedTagId)?.name ?? null;
  const readerState = readerStateCopy(activePaper, visibleItems.length);
  const paperActionsEnabled = canRunReaderActions(activePaper);
  useEffect(() => {
    setIsEditingMetadata(false);
    setLatestCitation("");
    setMetadataDraft({
      title: activePaper?.title ?? "",
      authors: activePaper?.authors ?? "",
      publication_year: activePaper?.publication_year ? String(activePaper.publication_year) : "",
      source: activePaper?.source ?? "",
      doi: activePaper?.doi ?? "",
    });
  }, [
    activePaper?.id,
    activePaper?.title,
    activePaper?.authors,
    activePaper?.publication_year,
    activePaper?.source,
    activePaper?.doi,
  ]);
  const collectionEntries = useMemo(() => orderedCollections(collections), [collections]);
  const moveDestinationOptions = useMemo(() => {
    if (selectedCollectionId === null) return collectionEntries;
    const blockedIds = descendantIdsForCollection(collections, selectedCollectionId);
    blockedIds.add(selectedCollectionId);
    return collectionEntries.filter((entry) => !blockedIds.has(entry.collection.id));
  }, [collectionEntries, collections, selectedCollectionId]);

  async function refreshCollections(nextSelectedId?: number | null) {
    const api = await getApi();
    const loadedCollections = await api.listCollections();
    setCollections(loadedCollections);
    if (nextSelectedId !== undefined) {
      setSelectedCollectionId(nextSelectedId);
      return;
    }
    setSelectedCollectionId((current) =>
      current && loadedCollections.some((collection) => collection.id === current)
        ? current
        : loadedCollections[0]?.id ?? null,
    );
  }

  function closePaperTab(itemId: number) {
    setOpenPaperIds((current) => {
      const remaining = current.filter((id) => id !== itemId);
      setActivePaperId((currentActive) => {
        if (currentActive !== itemId) {
          return currentActive;
        }
        return remaining.length > 0 ? remaining[remaining.length - 1] : null;
      });
      return remaining;
    });
  }

  async function refreshItemsForCollection(collectionId: number, nextActiveId?: number) {
    const api = await getApi();
    const loadedItems =
      search.trim().length > 0
        ? await api.searchItems(search.trim())
        : await api.listItems(collectionId);
    const filteredItems =
      search.trim().length > 0
        ? loadedItems.filter((item) => item.collection_id === collectionId)
        : loadedItems;
    const nextTags = await api.listTags(collectionId);
    setTags(nextTags);
    const tagFilteredItems = applyTagFilter(filteredItems, nextTags, selectedTagId);

    setItems(tagFilteredItems);
    const fallbackActiveId = tagFilteredItems[0]?.id ?? null;
    const resolvedActiveId =
      nextActiveId && tagFilteredItems.some((item) => item.id === nextActiveId)
        ? nextActiveId
        : fallbackActiveId;
    setActivePaperId(resolvedActiveId);
    setOpenPaperIds((current) => {
      const aliveIds = current.filter((id) => tagFilteredItems.some((item) => item.id === id));
      if (resolvedActiveId && !aliveIds.includes(resolvedActiveId)) {
        return [...aliveIds, resolvedActiveId];
      }
      return aliveIds;
    });
  }

  async function importPaths(paths: string[], sourceLabel: string) {
    if (selectedCollectionId === null || !activeCollection || isImporting) return;
    const acceptedPaths = paths.filter(isSupportedPath);
    if (acceptedPaths.length === 0) {
      setStatusMessage("Only PDF, DOCX, and EPUB files can be imported.");
      return;
    }

    const api = await getApi();
    setIsImporting(true);
    try {
      const importedItems = await api.importFiles({
        collection_id: selectedCollectionId,
        paths: acceptedPaths,
        mode: importMode,
      });
      const importMessage = `Imported ${importedItems.length} files into ${activeCollection.name} from ${sourceLabel}.`;
      setPendingCollectionStatus(importMessage);
      await refreshItemsForCollection(selectedCollectionId, importedItems[0]?.id);
      setStatusMessage(importMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed.";
      setStatusMessage(message);
    } finally {
      setIsImporting(false);
      setDraggedFileCount(0);
    }
  }

  async function handleImport() {
    if (selectedCollectionId === null || !activeCollection || isImporting) {
      if (!hasCollections) {
        setStatusMessage("Create a collection before importing files.");
      }
      return;
    }

    const api = await getApi();
    setStatusMessage(`Selecting files for ${activeCollection.name}...`);

    try {
      const paths = await api.pickImportPaths();
      if (paths.length === 0) {
        setStatusMessage("Import cancelled.");
        return;
      }
      await importPaths(paths, "picker");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed.";
      setStatusMessage(message);
    }
  }

  async function handleImportCitations() {
    if (selectedCollectionId === null || !activeCollection || isImporting) {
      if (!hasCollections) {
        setStatusMessage("Create a collection before importing citation files.");
      }
      return;
    }

    const api = await getApi();
    setStatusMessage(`Selecting citation files for ${activeCollection.name}...`);

    try {
      const paths = await api.pickCitationPaths();
      if (paths.length === 0) {
        setStatusMessage("Citation import cancelled.");
        return;
      }
      const importedItems = await api.importCitations({
        collection_id: selectedCollectionId,
        paths,
      });
      const message = `Imported ${importedItems.length} citation records into ${activeCollection.name}.`;
      setPendingCollectionStatus(message);
      await refreshItemsForCollection(selectedCollectionId, importedItems[0]?.id);
      setStatusMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Citation import failed.";
      setStatusMessage(message);
    }
  }

  async function handleItemTask(kind: string) {
    if (!activePaper) return;
    const api = await getApi();
    await api.runItemTask({ item_id: activePaper.id, kind });
    const [artifact, taskRuns] = await Promise.all([
      api.getArtifact({ item_id: activePaper.id }),
      api.listTaskRuns({ item_id: activePaper.id }),
    ]);
    setPaperArtifact(artifact);
    setPaperTaskRuns(taskRuns);
    setStatusMessage(`Completed ${kind} for ${activePaper.title}.`);
  }

  async function handleCollectionTask(kind: string) {
    if (!activeCollection) return;
    const api = await getApi();
    await api.runCollectionTask({ collection_id: activeCollection.id, kind });
    const [artifact, collectionNotes, taskRuns] = await Promise.all([
      api.getArtifact({ collection_id: activeCollection.id }),
      api.listNotes(activeCollection.id),
      api.listTaskRuns({ collection_id: activeCollection.id }),
    ]);
    setCollectionArtifact(artifact);
    setCollectionTaskRuns(taskRuns);
    setNotes(collectionNotes);
    setStatusMessage(`Completed ${kind} for ${activeCollection.name}.`);
  }

  async function handleCreateAnnotation() {
    if (!activePaper) return;
    const api = await getApi();
    const annotation = await api.createAnnotation({
      item_id: activePaper.id,
      anchor: `anchor-${annotations.length + 1}`,
      kind: "note",
      body: "Flag this passage for the review draft.",
    });
    setAnnotations((current) => [...current, annotation]);
    setStatusMessage(`Added note to ${activePaper.title}.`);
  }

  async function handleSaveMetadata() {
    if (!activePaper || selectedCollectionId === null) return;
    const api = await getApi();
    const nextTitle = metadataDraft.title.trim();
    const nextAuthors = metadataDraft.authors.trim();
    const nextSource = metadataDraft.source.trim();
    const nextDoi = metadataDraft.doi.trim();
    if (!nextTitle || !nextAuthors || !nextSource) {
      setStatusMessage("Title, authors, and source are required.");
      return;
    }

    await api.updateItemMetadata({
      item_id: activePaper.id,
      title: nextTitle,
      authors: nextAuthors,
      publication_year: metadataDraft.publication_year.trim()
        ? Number(metadataDraft.publication_year.trim())
        : null,
      source: nextSource,
      doi: nextDoi ? nextDoi : null,
    });

    await refreshItemsForCollection(selectedCollectionId, activePaper.id);
    const [view, artifact] = await Promise.all([
      api.getReaderView(activePaper.id),
      api.getArtifact({ item_id: activePaper.id }),
    ]);
    setReaderView(view);
    setPaperArtifact(artifact);
    setIsEditingMetadata(false);
    setStatusMessage(`Saved metadata for ${nextTitle}.`);
  }

  async function handleRemoveItem() {
    if (!activePaper || selectedCollectionId === null) return;

    const api = await getApi();
    await api.removeItem({ item_id: activePaper.id });
    setPendingCollectionStatus(`Removed ${activePaper.title} from the library.`);
    setLatestCitation("");
    await refreshItemsForCollection(selectedCollectionId);
    setStatusMessage(`Removed ${activePaper.title} from the library.`);
  }

  async function handleExportMarkdown() {
    const note = notes.find((entry) => entry.id === activeNoteId);
    if (!note) return;
    const api = await getApi();
    const markdown = await api.exportNoteMarkdown(note.id);
    setStatusMessage(`Exported Markdown for # ${noteHeading(note)} (${markdown.length} chars).`);
  }

  async function handleExportCitation(format: CitationFormat = "apa7") {
    if (!activePaper) return;
    const api = await getApi();
    const citation = await api.exportCitation(activePaper.id, format);
    setLatestCitation(citation);
    const label = format === "apa7" ? "citation" : format.toUpperCase();
    setStatusMessage(`Exported ${label} for ${activePaper.title}.`);
  }

  async function handleCreateResearchNote() {
    if (!activeCollection) return;
    const api = await getApi();
    const note = await api.createNoteFromArtifact(activeCollection.id);
    const collectionNotes = await api.listNotes(activeCollection.id);
    setNotes(collectionNotes);
    setActiveNoteId(note.id);
    setNoteDraft(note.markdown);
    setStatusMessage(`Created research note for ${activeCollection.name}.`);
  }

  function handleSelectNote(noteId: number) {
    const note = notes.find((entry) => entry.id === noteId);
    if (!note) return;
    setActiveNoteId(note.id);
    setNoteDraft(note.markdown);
    setStatusMessage(`Opened research note ${noteHeading(note)}.`);
  }

  async function handleRelinkAttachment() {
    if (!activePaper) return;
    const api = await getApi();
    const replacement = await api.pickRelinkPath();
    if (!replacement) {
      setStatusMessage("Relink cancelled.");
      return;
    }
    const message = `Relinked source for ${activePaper.title}.`;
    await api.relinkAttachment({
      attachment_id: activePaper.primary_attachment_id,
      replacement_path: replacement,
    });
    setPendingCollectionStatus(message);
    await refreshItemsForCollection(activePaper.collection_id, activePaper.id);
    setStatusMessage(message);
  }

  async function handleCreateCollection(parentId: number | null = null) {
    const name = newCollectionName.trim();
    if (!name) {
      setStatusMessage("Enter a collection name first.");
      return;
    }

    const api = await getApi();
    const collection = await api.createCollection({ name, parent_id: parentId });
    const message =
      parentId === null
        ? `Created collection ${collection.name}.`
        : `Created nested collection ${collection.name} under ${activeCollection?.name ?? "the selected collection"}.`;
    setPendingCollectionStatus(message);
    await refreshCollections(collection.id);
    setNewCollectionName("");
    setStatusMessage(message);
  }

  async function handleMoveCollection() {
    if (!activeCollection) {
      setStatusMessage("Select a collection before moving it.");
      return;
    }

    const parentId = moveCollectionParentValue === "root" ? null : Number(moveCollectionParentValue);
    const destinationName =
      parentId === null
        ? "the root"
        : collections.find((collection) => collection.id === parentId)?.name ?? "the selected parent";

    try {
      const api = await getApi();
      await api.moveCollection({ collection_id: activeCollection.id, parent_id: parentId });
      const message =
        parentId === null
          ? `Moved ${activeCollection.name} to the root.`
          : `Moved ${activeCollection.name} into ${destinationName}.`;
      setPendingCollectionStatus(message);
      await refreshCollections(activeCollection.id);
      setStatusMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Move collection failed.";
      setStatusMessage(message);
    }
  }

  async function handleCreateTag() {
    const name = newTagName.trim();
    if (!name) {
      setStatusMessage("Enter a tag name first.");
      return;
    }
    if (!activePaper) {
      setStatusMessage("Open a paper before tagging it.");
      return;
    }

    const api = await getApi();
    const tag = await api.createTag({ name });
    await api.assignTag({ item_id: activePaper.id, tag_id: tag.id });
    const tagMessage = `Tagged ${activePaper.title} with ${tag.name}.`;
    setPendingCollectionStatus(tagMessage);
    await refreshItemsForCollection(activePaper.collection_id, activePaper.id);
    setNewTagName("");
    setStatusMessage(tagMessage);
  }

  async function handleSaveNoteEdits() {
    if (!activeCollection || activeNoteId === null) return;
    const api = await getApi();
    await api.updateNote({ note_id: activeNoteId, markdown: noteDraft });
    const collectionNotes = await api.listNotes(activeCollection.id);
    setNotes(collectionNotes);
    setStatusMessage(`Saved note edits for ${activeCollection.name}.`);
  }

  function handleReaderSectionChange(section: ReaderSection) {
    setActiveReaderSection(section);
    setActiveAnchor(null);
    if (activePaper) {
      setStatusMessage(`Focused reader outline on ${section} in ${activePaper.title}.`);
    }
  }

  function handleAnnotationJump(annotation: Annotation) {
    setActiveReaderSection("Notes");
    setActiveAnchor(annotation.anchor);
    if (activePaper) {
      setStatusMessage(`Jumped to annotation ${annotation.anchor} in ${activePaper.title}.`);
    }
  }

  function handleSourceJump(anchor: string) {
    const annotation = annotations.find((entry) => entry.anchor === anchor);
    if (annotation) {
      handleAnnotationJump(annotation);
      return;
    }

    setActiveReaderSection("Notes");
    setActiveAnchor(anchor);
    if (activePaper) {
      setStatusMessage(`Jumped to annotation ${anchor} in ${activePaper.title}.`);
    }
  }

  useEffect(() => {
    if (selectedCollectionId === null) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;

    async function attachNativeDropListener() {
      if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (cancelled) return;

        if (event.payload.type === "enter") {
          setDraggedFileCount(event.payload.paths.filter(isSupportedPath).length);
        } else if (event.payload.type === "over") {
          setDraggedFileCount((current) => (current === 0 ? 1 : current));
        } else if (event.payload.type === "drop") {
          void importPaths(event.payload.paths, "drag & drop");
        } else if (event.payload.type === "leave") {
          setDraggedFileCount(0);
        }
      });
      teardown = () => {
        void unlisten();
      };
    }

    void attachNativeDropListener();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [importMode, selectedCollectionId, activeCollection, isImporting, search]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel-header">
          <p className="eyebrow">Workspace</p>
          <h1>Collections</h1>
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
          <button
            className="ghost-button"
            disabled={!activeCollection || isImporting}
            type="button"
            onClick={() => void handleImportCitations()}
          >
            Import Citations
          </button>
        </div>

        <section className="section-block">
          <div className="section-title-row">
            <h2>Collections</h2>
            <span className="status-pill">Synced</span>
          </div>
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
              disabled={!activeCollection}
              type="button"
              onClick={() => void handleCreateCollection(selectedCollectionId)}
            >
              Add Nested Collection
            </button>
          </div>
          <div className="collection-create-row">
            <select
              aria-label="Move collection destination"
              className="mode-select"
              disabled={!activeCollection}
              value={moveCollectionParentValue}
              onChange={(event) => setMoveCollectionParentValue(event.target.value)}
            >
              <option value="root">Move to Root</option>
              {moveDestinationOptions.map((entry) => (
                <option key={entry.collection.id} value={entry.collection.id}>
                  {entry.pathLabel}
                </option>
              ))}
            </select>
            <button
              className="ghost-button"
              disabled={!activeCollection}
              type="button"
              onClick={() => void handleMoveCollection()}
            >
              Move Collection
            </button>
          </div>
          {collectionEntries.length === 0 ? (
            <div className="citation-card">
              <p className="eyebrow">Empty Library</p>
              <h3>Start with a collection</h3>
              <p>Create a root collection on the left, then import PDF, DOCX, EPUB, or citation files.</p>
            </div>
          ) : (
            <div className="nav-list">
              {collectionEntries.map(({ collection, depth, pathLabel }) => {
                const itemCount = items.filter((item) => item.collection_id === collection.id).length;
                return (
                <button
                  key={collection.id}
                  aria-label={`Open collection ${pathLabel}`}
                  className={`nav-item ${
                    collection.id === selectedCollectionId ? "nav-item-active" : ""
                  }`}
                  style={{ paddingLeft: `${16 + depth * 18}px` }}
                  type="button"
                  onClick={() => setSelectedCollectionId(collection.id)}
                >
                  <span>{collection.name}</span>
                  <span className="meta-count">{itemCount}</span>
                </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="section-block">
          <div className="section-title-row">
            <h2>Tags</h2>
            <span className="meta-count">{tags.length}</span>
          </div>
          <div className="collection-create-row">
            <input
              aria-label="New tag name"
              className="search-input"
              placeholder="Tag the current paper..."
              value={newTagName}
              onChange={(event) => setNewTagName(event.target.value)}
            />
            <button
              className="ghost-button"
              disabled={!activePaper}
              type="button"
              onClick={() => void handleCreateTag()}
            >
              Add Tag to Current Paper
            </button>
          </div>
          <div className="tag-list">
            <button
              aria-pressed={selectedTagId === null}
              className={`nav-item ${selectedTagId === null ? "nav-item-active" : ""}`}
              type="button"
              onClick={() => setSelectedTagId(null)}
            >
              <span>All Tags</span>
              <span className="meta-count">{visibleItems.length}</span>
            </button>
            {tags.map((tag) => (
              <button
                key={tag.id}
                aria-label={`Filter tag ${tag.name}`}
                aria-pressed={selectedTagId === tag.id}
                className={`nav-item ${selectedTagId === tag.id ? "nav-item-active" : ""}`}
                type="button"
                onClick={() => setSelectedTagId(tag.id)}
              >
                <span>{tag.name}</span>
                <span className="meta-count">{tag.item_count}</span>
              </button>
            ))}
          </div>
        </section>

        <section
          aria-label="Collection drop zone"
          className={`section-block ${draggedFileCount > 0 ? "drop-zone-active" : ""}`}
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
            <h2>Current Collection</h2>
            <span className="meta-count">{visibleItems.length} items</span>
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
          </div>
          {draggedFileCount > 0 ? (
            <p className="drop-helper">Drop {draggedFileCount} files into {activeCollection?.name ?? "this collection"}.</p>
          ) : null}
          {!activeCollection ? (
            <div className="citation-card">
              <p className="eyebrow">Library Queue</p>
              <h3>No collection selected</h3>
              <p>Create or select a collection before importing and organizing papers.</p>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="citation-card">
              <p className="eyebrow">Ready for Import</p>
              <h3>No papers match the current view</h3>
              <p>
                {items.length === 0
                  ? `Use Import, drag and drop files, or add citation records to populate ${activeCollection.name}.`
                  : "Adjust the current attachment filter, tag, or search query to show matching papers."}
              </p>
            </div>
          ) : (
            <div className="paper-list">
              {visibleItems.map((paper) => (
                <button
                  key={paper.id}
                  className={`paper-card ${paper.id === activePaper?.id ? "paper-card-active" : ""}`}
                  type="button"
                  onClick={() => {
                    setActivePaperId(paper.id);
                    setOpenPaperIds((current) =>
                      current.includes(paper.id) ? current : [...current, paper.id],
                    );
                  }}
                >
                  <strong>{paper.title}</strong>
                  <span>Collection #{paper.collection_id} · {paper.attachment_status}</span>
                  <span>{formatItemMetadata(paper)}</span>
                  {paper.tags.length > 0 ? (
                    <span className="paper-tag-row">{paper.tags.join(" · ")}</span>
                  ) : null}
                  <small>{formatHint(paper.title)}</small>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="section-block footer-block">
          <h2>Import Status</h2>
          <p>{statusMessage}</p>
        </section>
      </aside>

      <main className="reader-shell">
        <div className="reader-tabs" role="tablist" aria-label="Open papers">
          {openPapers.map((paper) => (
            <div
              key={paper.id}
              className={`reader-tab-shell ${
                paper.id === activePaper?.id ? "reader-tab-active" : ""
              }`}
            >
              <button
                aria-selected={paper.id === activePaper?.id}
                className="reader-tab"
                role="tab"
                type="button"
                onClick={() => setActivePaperId(paper.id)}
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

        <section className="reader-panel">
          <div className="reader-meta-row">
            <div>
              <p className="eyebrow">Reader</p>
              <h2>{activePaper?.title ?? "No paper selected"}</h2>
              <p className="secondary-copy">{activePaper ? formatItemMetadata(activePaper) : "No metadata"}</p>
              <p className="secondary-copy">
                {activeCollection?.name ?? "No collection"} · {activePaper?.attachment_status ?? "idle"} · {activePaper ? formatHint(activePaper.title) : "Document"}
              </p>
            </div>
            <div className="reader-actions">
              <button
                className="ghost-button"
                type="button"
                disabled={!activePaper}
                onClick={() => setIsEditingMetadata((current) => !current)}
              >
                {isEditingMetadata ? "Cancel Metadata" : "Edit Metadata"}
              </button>
              {activePaper?.attachment_status === "missing" ? (
                <button className="ghost-button" type="button" onClick={() => void handleRelinkAttachment()}>
                  Relink Source
                </button>
              ) : null}
              <button className="ghost-button" type="button" disabled={!paperActionsEnabled} onClick={handleCreateAnnotation}>
                Highlight
              </button>
              <button className="ghost-button" type="button" disabled={!activePaper} onClick={() => void handleRemoveItem()}>
                Remove from Library
              </button>
              <button className="ghost-button" type="button" disabled={!activePaper} onClick={() => void handleExportCitation()}>
                Copy Citation
              </button>
              <button className="ghost-button" type="button" disabled={!activePaper} onClick={() => void handleExportCitation("bibtex")}>
                Export BibTeX
              </button>
              <button className="ghost-button" type="button" disabled={!activePaper} onClick={() => void handleExportCitation("ris")}>
                Export RIS
              </button>
            </div>
          </div>

          <div className="reader-surface">
            <div className="reader-outline">
              <p className="eyebrow">Outline</p>
              {readerSections.map((section) => (
                <button
                  key={section}
                  aria-pressed={activeReaderSection === section}
                  className={`outline-link ${
                    activeReaderSection === section ? "outline-link-active" : ""
                  }`}
                  type="button"
                  onClick={() => handleReaderSectionChange(section)}
                >
                  {section}
                </button>
              ))}
            </div>
            <article className="reader-document">
              <div className="reader-location-bar">
                <span className="status-pill">{activeReaderSection}</span>
                <span className="meta-count">Page {readerSections.indexOf(activeReaderSection) + 1}</span>
                {activeAnchor ? <span className="meta-count">Active anchor: {activeAnchor}</span> : null}
              </div>
              {latestCitation ? (
                <div className="citation-card">
                  <p className="eyebrow">Latest Citation</p>
                  <p>{latestCitation}</p>
                </div>
              ) : null}
              {activePaper ? (
                <div className="citation-card">
                  <p className="eyebrow">Document Metadata</p>
                  {isEditingMetadata ? (
                    <div className="note-editor-stack">
                      <input
                        aria-label="Metadata title"
                        className="search-input"
                        value={metadataDraft.title}
                        onChange={(event) =>
                          setMetadataDraft((current) => ({ ...current, title: event.target.value }))
                        }
                      />
                      <input
                        aria-label="Metadata authors"
                        className="search-input"
                        value={metadataDraft.authors}
                        onChange={(event) =>
                          setMetadataDraft((current) => ({ ...current, authors: event.target.value }))
                        }
                      />
                      <input
                        aria-label="Metadata year"
                        className="search-input"
                        value={metadataDraft.publication_year}
                        onChange={(event) =>
                          setMetadataDraft((current) => ({
                            ...current,
                            publication_year: event.target.value,
                          }))
                        }
                      />
                      <input
                        aria-label="Metadata source"
                        className="search-input"
                        value={metadataDraft.source}
                        onChange={(event) =>
                          setMetadataDraft((current) => ({ ...current, source: event.target.value }))
                        }
                      />
                      <input
                        aria-label="Metadata DOI"
                        className="search-input"
                        value={metadataDraft.doi}
                        onChange={(event) =>
                          setMetadataDraft((current) => ({ ...current, doi: event.target.value }))
                        }
                      />
                      <button className="ghost-button" type="button" onClick={() => void handleSaveMetadata()}>
                        Save Metadata
                      </button>
                    </div>
                  ) : null}
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
                    <span>DOI</span>
                    <span>{activePaper.doi ?? "Not available"}</span>
                  </div>
                  <div className="export-row">
                    <span>Attachment</span>
                    <span>{activePaper.attachment_status} · {formatHint(activePaper.title)}</span>
                  </div>
                  <div className="export-row">
                    <span>Tags</span>
                    <span>{activePaper.tags.length > 0 ? activePaper.tags.join(" · ") : "No tags"}</span>
                  </div>
                </div>
              ) : null}
              {readerState ? (
                <div className="citation-card">
                  <p className="eyebrow">Workspace State</p>
                  <h3>{readerState.title}</h3>
                  <p>{readerState.body}</p>
                  {"secondary" in readerState && readerState.secondary ? <p>{readerState.secondary}</p> : null}
                </div>
              ) : null}
              <p className="document-lead">{excerptFromView(readerView)}</p>
              {annotations.map((annotation) => (
                <button
                  key={annotation.id}
                  aria-label={`Jump to annotation ${annotation.anchor}`}
                  className={`annotation-chip ${
                    activeAnchor === annotation.anchor ? "annotation-chip-active" : ""
                  }`}
                  type="button"
                  onClick={() => handleAnnotationJump(annotation)}
                >
                  {annotation.anchor}: {annotation.body}
                </button>
              ))}
              <div
                className="reader-html"
                dangerouslySetInnerHTML={{
                  __html:
                    readerView?.normalized_html ??
                    "<article><p>No reader view available yet.</p></article>",
                }}
              />
            </article>
          </div>
        </section>
      </main>

      <aside className="ai-shell">
        <div className="panel-header">
          <p className="eyebrow">AI Workspace</p>
          <h2>Research Copilot</h2>
        </div>

        <div className="ai-tabs" role="tablist" aria-label="AI context tabs">
          <button
            aria-selected={aiPanelMode === "paper"}
            className={`ai-tab ${aiPanelMode === "paper" ? "ai-tab-active" : ""}`}
            role="tab"
            type="button"
            onClick={() => setAiPanelMode("paper")}
          >
            Current Paper
          </button>
          <button
            aria-selected={aiPanelMode === "collection"}
            className={`ai-tab ${aiPanelMode === "collection" ? "ai-tab-active" : ""}`}
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
              <p className="eyebrow">Focused Context</p>
              <h3>{activePaper?.title ?? "No active paper"}</h3>
              <p>{excerptFromView(readerView)}</p>
              {!paperActionsEnabled ? (
                <p>
                  {activePaper
                    ? "This item needs a readable source file before paper-level AI tasks can run."
                    : "Open a readable paper to enable paper-level AI tasks."}
                </p>
              ) : null}
              {activePaper?.tags.length ? (
                <div className="tag-chip-row">
                  {activePaper.tags.map((tag) => (
                    <span key={tag} className="status-pill">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="action-grid">
              {itemActions.map((action) => (
                <button
                  key={action.kind}
                  className="action-card"
                  disabled={!paperActionsEnabled}
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
              {annotations[0] ? (
                <div className="export-row">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => handleSourceJump(annotations[0].anchor)}
                  >
                    Source: {annotations[0].anchor}
                  </button>
                  <span className="meta-count">Jump to evidence</span>
                </div>
              ) : null}
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
                    <div className="export-row">
                      <button
                        aria-label={`Run Again ${task.kind}`}
                        className="ghost-button"
                        disabled={!paperActionsEnabled}
                        type="button"
                        onClick={() => void handleItemTask(task.kind)}
                      >
                        Run Again
                      </button>
                      <span className="meta-count">{task.id === paperTaskRuns[0]?.id ? "Latest" : "History"}</span>
                    </div>
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
              <p>
                Aggregate the papers in this collection into structured comparisons, theme maps,
                and an editable review note.
              </p>
              {selectedTagName ? <p>Filtered by tag: {selectedTagName}</p> : null}
              {attachmentFilter !== "all" ? <p>Filtered by attachment: {attachmentFilter}</p> : null}
            </div>
            <div className="context-card">
              <p className="eyebrow">Review Scope</p>
              <h3>{visibleItems.length} papers included</h3>
              <p>
                {selectedTagName
                  ? `Current draft scope is filtered to tag ${selectedTagName}.`
                  : attachmentFilter !== "all"
                    ? `Current draft scope is filtered to ${attachmentFilter} items.`
                    : "Current draft scope includes every visible paper in this collection."}
              </p>
              {visibleItems.length > 0 ? (
                <div className="tag-chip-row">
                  {visibleItems.map((item) => (
                    <span key={item.id} className="status-pill">
                      {item.title}
                    </span>
                  ))}
                </div>
              ) : (
                <p>No papers are currently included in this review scope.</p>
              )}
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
              {collectionArtifact ? (
                <div className="export-row">
                  <span className="eyebrow">Latest Run</span>
                  <span className="meta-count">
                    {collectionArtifact.kind} · {activeCollection?.name ?? "No collection"}
                  </span>
                </div>
              ) : null}
              <p>{collectionArtifact?.markdown ?? "No collection draft yet."}</p>
              {collectionArtifact ? (
                <div className="export-row">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => void handleCreateResearchNote()}
                  >
                    Save as Research Note
                  </button>
                  <span className="meta-count">Snapshot current draft</span>
                </div>
              ) : null}
              {activeNoteId ? (
                <div className="note-editor-stack">
                  {notes.length > 0 ? (
                    <div className="result-card">
                      <h3>Research Notes</h3>
                      {notes.map((note) => (
                        <button
                          key={note.id}
                          aria-label={`Open research note ${noteHeading(note)}`}
                          className={`nav-item ${note.id === activeNoteId ? "nav-item-active" : ""}`}
                          type="button"
                          onClick={() => handleSelectNote(note.id)}
                        >
                          <span>{noteHeading(note)}</span>
                          <span className="meta-count">{note.id === activeNoteId ? "Active" : "Saved"}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <label className="eyebrow" htmlFor="research-note-editor">
                    Research Note
                  </label>
                  <textarea
                    id="research-note-editor"
                    aria-label="Research note editor"
                    className="note-editor"
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                  />
                  <div className="export-row">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void handleSaveNoteEdits()}
                    >
                      Save Note Edits
                    </button>
                    <span className="meta-count">
                      {notes.find((note) => note.id === activeNoteId)?.title ?? "Research Note"}
                    </span>
                  </div>
                </div>
              ) : null}
              {notes[0] ? (
                <div className="export-row">
                  <button className="ghost-button" type="button" onClick={handleExportMarkdown}>
                    Export Markdown
                  </button>
                  <span className="meta-count">
                    {(notes.find((note) => note.id === activeNoteId) ?? notes[0]).title}
                  </span>
                </div>
              ) : null}
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
                    <div className="export-row">
                      <button
                        aria-label={`Run Again ${task.kind}`}
                        className="ghost-button"
                        type="button"
                        onClick={() => void handleCollectionTask(task.kind)}
                      >
                        Run Again
                      </button>
                      <span className="meta-count">{task.id === collectionTaskRuns[0]?.id ? "Latest" : "History"}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p>No collection tasks have run yet.</p>
              )}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
