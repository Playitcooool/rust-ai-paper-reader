import { useEffect, useMemo, useState } from "react";

import { getApi } from "./lib/api";
import type {
  AIArtifact,
  Annotation,
  Collection,
  ImportMode,
  LibraryItem,
  ReaderView,
  ResearchNote,
  Tag,
} from "./lib/contracts";

type AiPanelMode = "paper" | "collection";
type ReaderSection = "Overview" | "Methods" | "Results" | "Notes";

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

export default function App() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [importMode, setImportMode] = useState<ImportMode>("managed_copy");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newTagName, setNewTagName] = useState("");
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
  const [collectionArtifact, setCollectionArtifact] = useState<AIArtifact | null>(null);
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [draggedFileCount, setDraggedFileCount] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [latestCitation, setLatestCitation] = useState("");
  const [pendingCollectionStatus, setPendingCollectionStatus] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Loading library...");

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
          : "Create a collection to begin building your library.",
      );
    }

    void loadCollections();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedCollectionId === null) return;
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
  }, [search, selectedCollectionId, selectedTagId, tags]);

  useEffect(() => {
    if (selectedCollectionId === null) return;
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
    if (activePaperId === null) {
      setReaderView(null);
      setAnnotations([]);
      setPaperArtifact(null);
      setActiveReaderSection("Overview");
      setActiveAnchor(null);
      return;
    }
    const itemId = activePaperId;
    let cancelled = false;

    async function loadReaderContext() {
      const api = await getApi();
      const [view, itemAnnotations, artifact] = await Promise.all([
        api.getReaderView(itemId),
        api.listAnnotations(itemId),
        api.getArtifact({ item_id: itemId }),
      ]);
      if (cancelled) return;

      setReaderView(view);
      setActiveReaderSection("Overview");
      setActiveAnchor(null);
      setAnnotations(itemAnnotations);
      setPaperArtifact(artifact);
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
    if (selectedCollectionId === null) return;
    const collectionId = selectedCollectionId;
    let cancelled = false;

    async function loadCollectionOutputs() {
      const api = await getApi();
      const [artifact, collectionNotes] = await Promise.all([
        api.getArtifact({ collection_id: collectionId }),
        api.listNotes(collectionId),
      ]);
      if (cancelled) return;
      setCollectionArtifact(artifact);
      setNotes(collectionNotes);
      setActiveNoteId(collectionNotes[0]?.id ?? null);
      setNoteDraft(collectionNotes[0]?.markdown ?? "");
    }

    void loadCollectionOutputs();

    return () => {
      cancelled = true;
    };
  }, [selectedCollectionId]);

  const openPapers = useMemo(
    () =>
      openPaperIds
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is LibraryItem => Boolean(item)),
    [items, openPaperIds],
  );

  const activePaper = items.find((item) => item.id === activePaperId) ?? openPapers[0] ?? null;
  const activeCollection =
    collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const selectedTagName = tags.find((tag) => tag.id === selectedTagId)?.name ?? null;

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
    if (selectedCollectionId === null || !activeCollection || isImporting) return;

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

  async function handleItemTask(kind: string) {
    if (!activePaper) return;
    const api = await getApi();
    await api.runItemTask({ item_id: activePaper.id, kind });
    const artifact = await api.getArtifact({ item_id: activePaper.id });
    setPaperArtifact(artifact);
    setStatusMessage(`Completed ${kind} for ${activePaper.title}.`);
  }

  async function handleCollectionTask(kind: string) {
    if (!activeCollection) return;
    const api = await getApi();
    await api.runCollectionTask({ collection_id: activeCollection.id, kind });
    const [artifact, collectionNotes] = await Promise.all([
      api.getArtifact({ collection_id: activeCollection.id }),
      api.listNotes(activeCollection.id),
    ]);
    setCollectionArtifact(artifact);
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

  async function handleExportMarkdown() {
    const note = notes[0];
    if (!note) return;
    const api = await getApi();
    const markdown = await api.exportNoteMarkdown(note.id);
    setStatusMessage(`Exported Markdown (${markdown.length} chars).`);
  }

  async function handleExportCitation() {
    if (!activePaper) return;
    const api = await getApi();
    const citation = await api.exportCitation(activePaper.id);
    setLatestCitation(citation);
    setStatusMessage(`Copied citation for ${activePaper.title}.`);
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

  async function handleCreateCollection() {
    const name = newCollectionName.trim();
    if (!name) {
      setStatusMessage("Enter a collection name first.");
      return;
    }

    const api = await getApi();
    const collection = await api.createCollection({ name });
    setCollections((current) => [...current, collection]);
    setPendingCollectionStatus(`Created collection ${collection.name}.`);
    setSelectedCollectionId(collection.id);
    setNewCollectionName("");
    setStatusMessage(`Created collection ${collection.name}.`);
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
          </div>
          <div className="nav-list">
            {collections.map((collection) => {
              const itemCount = items.filter((item) => item.collection_id === collection.id).length;
              return (
              <button
                key={collection.id}
                className={`nav-item ${
                  collection.id === selectedCollectionId ? "nav-item-active" : ""
                }`}
                type="button"
                onClick={() => setSelectedCollectionId(collection.id)}
              >
                <span>{collection.name}</span>
                <span className="meta-count">{itemCount}</span>
              </button>
              );
            })}
          </div>
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
            <button className="ghost-button" type="button" onClick={() => void handleCreateTag()}>
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
              <span className="meta-count">{items.length}</span>
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
            <span className="meta-count">{items.length} items</span>
          </div>
          {draggedFileCount > 0 ? (
            <p className="drop-helper">Drop {draggedFileCount} files into {activeCollection?.name ?? "this collection"}.</p>
          ) : null}
          <div className="paper-list">
            {items.map((paper) => (
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
                {paper.tags.length > 0 ? (
                  <span className="paper-tag-row">{paper.tags.join(" · ")}</span>
                ) : null}
                <small>{formatHint(paper.title)}</small>
              </button>
            ))}
          </div>
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
              <p className="secondary-copy">
                {activeCollection?.name ?? "No collection"} · {activePaper?.attachment_status ?? "idle"} · {activePaper ? formatHint(activePaper.title) : "Document"}
              </p>
            </div>
            <div className="reader-actions">
              <button className="ghost-button" type="button" onClick={handleCreateAnnotation}>
                Highlight
              </button>
              <button className="ghost-button" type="button" onClick={handleExportCitation}>
                Copy Citation
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
                  <span className="meta-count">{notes[0].title}</span>
                </div>
              ) : null}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
