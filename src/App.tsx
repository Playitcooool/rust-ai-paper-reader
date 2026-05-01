import type {
  CSSProperties,
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { NormalizedReader } from "./components/readers/NormalizedReader";
import { PdfContinuousReader } from "./components/readers/PdfContinuousReader";
import { PdfReader } from "./components/readers/PdfReader";
import type { PdfHighlightColor, PdfTextSelection } from "./components/readers/pdfSelection";
import { isTauriRuntime } from "./lib/api";
import { getRuntimePolyfillDiagnostics } from "./lib/runtimePolyfills";
import type {
  AIArtifact,
  AISession,
  AISessionReference,
  AISettings,
  AITask,
  AITaskStreamEvent,
  AIProvider,
  Annotation,
  AppApi,
  Collection,
  ImportBatchResult,
  LibraryItem,
  ReaderView,
  ResearchNote,
  Tag,
  UpdateAISettingsInput,
} from "./lib/contracts";

type AiDockSection = "artifacts" | "history" | "notes";
type WorkspaceMode = "workspace" | "pdf_focus";
type ItemSort = "recent" | "title" | "year_desc";
type AttachmentFilter = "all" | "ready" | "missing" | "citation_only";
type ReaderFitMode = "fit_width" | "manual";

const READER_MIN_ZOOM = 70;
const READER_MAX_ZOOM = 180;
const READER_ZOOM_STEP = 10;

const sessionActions = [
  { label: "Summarize", kind: "session.summarize" },
  { label: "Explain Terms", kind: "session.explain_terms" },
  { label: "Compare", kind: "session.compare" },
];

const taskLabel = (kind: string) =>
  ({
    "item.summarize": "Summarize",
    "item.translate": "Translate",
    "item.explain_term": "Explain",
    "item.ask": "Ask",
    "session.summarize": "Summarize",
    "session.explain_terms": "Explain Terms",
    "session.theme_map": "Theme Map",
    "session.compare": "Compare",
    "session.review_draft": "Review Draft",
    "session.ask": "Ask",
    "collection.bulk_summarize": "Bulk Summaries",
    "collection.theme_map": "Theme Map",
    "collection.compare_methods": "Compare Methods",
    "collection.review_draft": "Review Draft",
    "collection.ask": "Ask",
  })[kind] ?? kind;

const isQuickActionKind = (kind: string) =>
  kind !== "item.ask" && kind !== "collection.ask" && kind !== "session.ask";

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

type AiPendingMessage = {
  streamId: string;
  kind: string;
  inputPrompt: string | null;
  markdown: string;
  error: string | null;
  status: "streaming" | "failed";
  taskId?: number;
};

type AiDockState = Record<AiDockSection, boolean>;
type ActivePdfHighlight = {
  annotationId: number;
  rect: { left: number; top: number; right: number; bottom: number };
};
type ResourceContextMenuState =
  | {
      x: number;
      y: number;
      kind: "collection" | "item";
      targetId: number;
    }
  | null;
type DeleteTargetState =
  | {
      kind: "collection" | "item";
      targetId: number;
      label: string;
      parentCollectionId: number | null;
      paperCount?: number;
      nestedCollectionCount?: number;
      deletedCollectionIds?: number[];
      deletedItemIds?: number[];
    }
  | null;
type AiReferencePickerResult =
  | {
      key: string;
      kind: "item";
      targetId: number;
      label: string;
      meta: string | null;
      badges: string[];
    }
  | {
      key: string;
      kind: "collection";
      targetId: number;
      label: string;
      meta: string | null;
      badges: string[];
    };

type GeneralSettingsDraft = {
  resourcesSidebarOpen: boolean;
  defaultItemSort: ItemSort;
  defaultAttachmentFilter: AttachmentFilter;
  defaultReaderFitMode: ReaderFitMode;
  defaultReaderZoom: number;
};

const initialAiDockState = (): AiDockState => ({
  artifacts: false,
  history: false,
  notes: false,
});

const createStreamId = () =>
  globalThis.crypto?.randomUUID?.() ?? `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const emptyAiSettingsDraft = (): UpdateAISettingsInput => ({
  active_provider: "openai",
  openai_model: "",
  openai_base_url: "",
  anthropic_model: "",
  anthropic_base_url: "",
});

const draftFromAiSettings = (settings: AISettings): UpdateAISettingsInput => ({
  active_provider: settings.active_provider,
  openai_model: settings.openai_model,
  openai_base_url: settings.openai_base_url,
  anthropic_model: settings.anthropic_model,
  anthropic_base_url: settings.anthropic_base_url,
});

const markdownComponents = {
  a: (props: ComponentProps<"a">) => <a {...props} rel="noreferrer" target="_blank" />,
  pre: (props: ComponentProps<"pre">) => <pre className="ai-markdown-pre" {...props} />,
  code({
    inline,
    className,
    children,
    ...props
  }: ComponentProps<"code"> & { inline?: boolean }) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

const assistantStatusLabel = (status: AiPendingMessage["status"] | AITask["status"]) =>
  status === "streaming" ? "Streaming" : status === "failed" ? "Failed" : status;

function AiIcon({
  children,
  viewBox = "0 0 20 20",
}: {
  children: ReactNode;
  viewBox?: string;
}) {
  return (
    <svg aria-hidden="true" className="ai-icon" viewBox={viewBox}>
      {children}
    </svg>
  );
}

const ChatHistoryIcon = () => (
  <AiIcon>
    <path
      d="M4 5.5h7.5A2.5 2.5 0 0 1 14 8v2A2.5 2.5 0 0 1 11.5 12.5H8l-3 2v-2H4A2.5 2.5 0 0 1 1.5 10V8A2.5 2.5 0 0 1 4 5.5Z"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
    <circle cx="15.25" cy="6.25" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M15.25 4.75v1.7l1.15.7"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
  </AiIcon>
);

const NewSessionIcon = () => (
  <AiIcon>
    <path
      d="M10 4v12M4 10h12"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </AiIcon>
);

const ArtifactIcon = () => (
  <AiIcon>
    <path
      d="M6 2.5h5l3 3V16A1.5 1.5 0 0 1 12.5 17.5h-6A1.5 1.5 0 0 1 5 16V4A1.5 1.5 0 0 1 6.5 2.5Z"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
    <path
      d="M11 2.5V6h3"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
    <path
      d="M7.5 9.25h4.5M7.5 12h4.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
  </AiIcon>
);

const TaskHistoryIcon = () => (
  <AiIcon>
    <rect x="3" y="3.5" width="14" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
  </AiIcon>
);

const ResearchNotesIcon = () => (
  <AiIcon>
    <path
      d="M5 3.5h8A2 2 0 0 1 15 5.5v11l-4-2-4 2v-11A2 2 0 0 1 9 3.5Z"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.6"
    />
    <path
      d="M8 7.5h5M8 10.25h4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
  </AiIcon>
);

const CloseCopilotIcon = () => (
  <AiIcon>
    <path
      d="m5 5 10 10M15 5 5 15"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </AiIcon>
);

const pickerResultLabel = (result: AiReferencePickerResult, badges: string[]) =>
  [result.label, result.meta, badges.length > 0 ? badges.join(", ") : null].filter(Boolean).join(" — ");

function MarkdownMessage({ markdown }: { markdown: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

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

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 460;
const AI_PANEL_MIN_WIDTH = 320;
const AI_PANEL_MAX_WIDTH = 620;
const DEFAULT_SIDEBAR_WIDTH = 300;
const DEFAULT_AI_PANEL_WIDTH = 360;
const DEFAULT_ITEM_SORT: ItemSort = "recent";
const DEFAULT_ATTACHMENT_FILTER: AttachmentFilter = "all";
const DEFAULT_READER_FIT_MODE: ReaderFitMode = "fit_width";
const DEFAULT_READER_ZOOM = 100;
const SIDEBAR_WIDTH_KEY = "paper-reader.sidebar-width";
const AI_PANEL_WIDTH_KEY = "paper-reader.ai-panel-width";
const SIDEBAR_OPEN_KEY = "paper-reader.sidebar-open";
const ITEM_SORT_KEY = "paper-reader.item-sort";
const ATTACHMENT_FILTER_KEY = "paper-reader.attachment-filter";
const READER_FIT_MODE_KEY = "paper-reader.reader-fit-mode";
const READER_ZOOM_KEY = "paper-reader.reader-zoom";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

const readStoredNumber = (key: string, fallback: number) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readStoredBoolean = (key: string, fallback: boolean) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "true";
};

const readStoredString = <Value extends string>(key: string, fallback: Value, allowed: readonly Value[]) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw && allowed.includes(raw as Value) ? (raw as Value) : fallback;
};

const expandSessionReferenceItemIds = (
  references: AISessionReference[],
  collections: Collection[],
  items: LibraryItem[],
) => {
  const seen = new Set<number>();
  const output: number[] = [];
  const collectionChildren = (parentId: number): number[] =>
    childCollectionsFor(collections, parentId).flatMap((collection) => [collection.id, ...collectionChildren(collection.id)]);

  for (const reference of references.filter((entry) => entry.kind === "item")) {
    if (seen.has(reference.target_id)) continue;
    if (!items.some((item) => item.id === reference.target_id)) continue;
    seen.add(reference.target_id);
    output.push(reference.target_id);
  }

  for (const reference of references.filter((entry) => entry.kind === "collection")) {
    const collectionIds = [reference.target_id, ...collectionChildren(reference.target_id)];
    for (const collectionId of collectionIds) {
      const orderedItemIds = items
        .filter((item) => item.collection_id === collectionId)
        .sort((left, right) => right.id - left.id)
        .map((item) => item.id);
      for (const itemId of orderedItemIds) {
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        output.push(itemId);
      }
    }
  }

  return output;
};

const itemCountForCollection = (libraryItems: LibraryItem[], collectionId: number) =>
  libraryItems.filter((item) => item.collection_id === collectionId).length;

const collectionDeleteSummary = (collections: Collection[], libraryItems: LibraryItem[], collectionId: number) => {
  const descendantIds = Array.from(descendantIdsForCollection(collections, collectionId));
  const deletedCollectionIds = [collectionId, ...descendantIds];
  const deletedCollectionIdSet = new Set(deletedCollectionIds);
  const deletedItemIds = libraryItems
    .filter((item) => deletedCollectionIdSet.has(item.collection_id))
    .map((item) => item.id);

  return {
    deletedCollectionIds,
    deletedItemIds,
    nestedCollectionCount: descendantIds.length,
    paperCount: deletedItemIds.length,
  };
};

const sessionReferenceLabel = (
  reference: AISessionReference,
  libraryItems: LibraryItem[],
  collections: Collection[],
) =>
  reference.kind === "item"
    ? libraryItems.find((item) => item.id === reference.target_id)?.title ?? "Paper"
    : collections.find((collection) => collection.id === reference.target_id)?.name ?? "Collection";

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);

export default function App({ api }: { api: AppApi }) {
  const getApi = useCallback(() => Promise.resolve(api), [api]);
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
  const [aiSessions, setAiSessions] = useState<AISession[]>([]);
  const [activeAiSessionId, setActiveAiSessionId] = useState<number | null>(null);
  const [aiSessionReferences, setAiSessionReferences] = useState<AISessionReference[]>([]);
  const [aiSessionTaskRuns, setAiSessionTaskRuns] = useState<AITask[]>([]);
  const [aiSessionArtifact, setAiSessionArtifact] = useState<AIArtifact | null>(null);
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [aiPending, setAiPending] = useState<AiPendingMessage | null>(null);
  const [aiDockOpen, setAiDockOpen] = useState(initialAiDockState);
  const [isAiSessionHistoryOpen, setIsAiSessionHistoryOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("workspace");
  const [isSidebarVisible, setIsSidebarVisible] = useState(() => readStoredBoolean(SIDEBAR_OPEN_KEY, true));
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH));
  const [aiPanelWidth, setAiPanelWidth] = useState(() => readStoredNumber(AI_PANEL_WIDTH_KEY, DEFAULT_AI_PANEL_WIDTH));
  const [isReferencePickerOpen, setIsReferencePickerOpen] = useState(false);
  const [aiReferenceQuery, setAiReferenceQuery] = useState("");
  const [aiReferenceSearchResults, setAiReferenceSearchResults] = useState<LibraryItem[]>([]);
  const [aiReferenceSearchLoading, setAiReferenceSearchLoading] = useState(false);
  const [aiReferenceSearchError, setAiReferenceSearchError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [itemSort, setItemSort] = useState<ItemSort>(() =>
    readStoredString(ITEM_SORT_KEY, DEFAULT_ITEM_SORT, ["recent", "title", "year_desc"] as const),
  );
  const [attachmentFilter, setAttachmentFilter] = useState<AttachmentFilter>(() =>
    readStoredString(ATTACHMENT_FILTER_KEY, DEFAULT_ATTACHMENT_FILTER, ["all", "ready", "missing", "citation_only"] as const),
  );
  const [lastImportResult, setLastImportResult] = useState<ImportBatchResult | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [draggedFileCount, setDraggedFileCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState("Loading library...");
  const [newTagName, setNewTagName] = useState("");
  const [batchTagName, setBatchTagName] = useState("");
  const [batchMoveTargetId, setBatchMoveTargetId] = useState("current");
  const [readerPage, setReaderPage] = useState(0);
  const [readerPageInput, setReaderPageInput] = useState("1");
  const [readerZoom, setReaderZoom] = useState(() => readStoredNumber(READER_ZOOM_KEY, DEFAULT_READER_ZOOM));
  const [readerFitMode, setReaderFitMode] = useState<ReaderFitMode>(() =>
    readStoredString(READER_FIT_MODE_KEY, DEFAULT_READER_FIT_MODE, ["fit_width", "manual"] as const),
  );
  const [readerSearchQuery, setReaderSearchQuery] = useState("");
  const [isFindHudOpen, setIsFindHudOpen] = useState(false);
  const [readerSearchMatchIndex, setReaderSearchMatchIndex] = useState(0);
  const [readerSearchMatchCount, setReaderSearchMatchCount] = useState(0);
  const [reportedActiveSearchMatchIndex, setReportedActiveSearchMatchIndex] = useState(-1);
  const [pdfPageCounts, setPdfPageCounts] = useState<Record<number, number>>({});
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(null);
  const [activePdfHighlight, setActivePdfHighlight] = useState<ActivePdfHighlight | null>(null);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [creatingCollectionParentId, setCreatingCollectionParentId] = useState<number | "root" | null>(null);
  const [collectionDraftName, setCollectionDraftName] = useState("");
  const [renamingCollectionId, setRenamingCollectionId] = useState<number | null>(null);
  const [resourceContextMenu, setResourceContextMenu] = useState<ResourceContextMenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTargetState>(null);
  const [aiComposerValue, setAiComposerValue] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  const [aiSettingsDraft, setAiSettingsDraft] = useState<UpdateAISettingsInput>(emptyAiSettingsDraft);
  const [generalSettingsDraft, setGeneralSettingsDraft] = useState<GeneralSettingsDraft>({
    resourcesSidebarOpen: true,
    defaultItemSort: DEFAULT_ITEM_SORT,
    defaultAttachmentFilter: DEFAULT_ATTACHMENT_FILTER,
    defaultReaderFitMode: DEFAULT_READER_FIT_MODE,
    defaultReaderZoom: DEFAULT_READER_ZOOM,
  });
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState("");
  const [anthropicApiKeyDraft, setAnthropicApiKeyDraft] = useState("");
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const manageButtonRef = useRef<HTMLButtonElement | null>(null);
  const managePopoverRef = useRef<HTMLDivElement | null>(null);
  const resourceContextMenuRef = useRef<HTMLDivElement | null>(null);
  const highlightActionBarRef = useRef<HTMLDivElement | null>(null);
  const aiReferenceButtonRef = useRef<HTMLButtonElement | null>(null);
  const aiReferencePopoverRef = useRef<HTMLDivElement | null>(null);
  const aiReferenceSearchInputRef = useRef<HTMLInputElement | null>(null);
  const aiReferenceSearchRequestIdRef = useRef(0);
  const closeAiReferencePicker = useCallback(() => {
    setIsReferencePickerOpen(false);
  }, []);
  const toggleAiReferencePicker = useCallback(() => {
    setIsReferencePickerOpen((current) => !current);
  }, []);

  useEffect(() => {
    // Probe polyfills (useful for debugging) but do not write client logs to disk anymore.
    if (!isTauriRuntime()) return;
    void getRuntimePolyfillDiagnostics();
  }, []);

  useEffect(() => {
    if (!isManageOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsManageOpen(false);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const popover = managePopoverRef.current;
      const button = manageButtonRef.current;
      if (popover && popover.contains(target)) return;
      if (button && button.contains(target)) return;
      setIsManageOpen(false);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isManageOpen]);

  useEffect(() => {
    if (!resourceContextMenu) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setResourceContextMenu(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menu = resourceContextMenuRef.current;
      if (menu && menu.contains(target)) return;
      setResourceContextMenu(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [resourceContextMenu]);

  useEffect(() => {
    if (!isReferencePickerOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAiReferencePicker();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const popover = aiReferencePopoverRef.current;
      const button = aiReferenceButtonRef.current;
      if (popover && popover.contains(target)) return;
      if (button && button.contains(target)) return;
      closeAiReferencePicker();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [closeAiReferencePicker, isReferencePickerOpen]);

  useEffect(() => {
    if (!isReferencePickerOpen) return;
    aiReferenceSearchInputRef.current?.focus();
  }, [isReferencePickerOpen]);

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
  const activeAiSession = useMemo(
    () => aiSessions.find((session) => session.id === activeAiSessionId) ?? null,
    [activeAiSessionId, aiSessions],
  );
  const sortedReferenceItems = useMemo(() => sortItems(libraryItems, "title"), [libraryItems]);
  const expandedAiReferenceItemIds = useMemo(
    () => expandSessionReferenceItemIds(aiSessionReferences, collections, libraryItems),
    [aiSessionReferences, collections, libraryItems],
  );
  const sortedReferenceCollections = useMemo(
    () => [...collections].sort((left, right) => left.name.localeCompare(right.name)),
    [collections],
  );
  const aiReferenceItemIds = useMemo(
    () => new Set(aiSessionReferences.filter((reference) => reference.kind === "item").map((reference) => reference.target_id)),
    [aiSessionReferences],
  );
  const aiReferenceCollectionIds = useMemo(
    () =>
      new Set(aiSessionReferences.filter((reference) => reference.kind === "collection").map((reference) => reference.target_id)),
    [aiSessionReferences],
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
  const readerPageCount =
    activePaper?.id && isPdfReader ? pdfPageCounts[activePaper.id] ?? readerView?.page_count ?? 1 : 1;
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
      return;
    }

    let cancelled = false;
    const collectionId = selectedCollectionId;

    async function loadCollectionContext() {
      const runtimeApi = await getApi();
      const loadedTags = await runtimeApi.listTags(collectionId);
      if (cancelled) return;
      setTags(loadedTags);
      setSelectedTagId((current) =>
        current && loadedTags.some((tag) => tag.id === current) ? current : null,
      );
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
      return;
    }

    let cancelled = false;
    const itemId = activePaperId;
    const requestId = readerLoadRequestIdRef.current + 1;
    readerLoadRequestIdRef.current = requestId;

    async function loadReaderContext() {
      const startedAt = performance.now();
      setReaderView(null);
      setAnnotations([]);
      try {
        const runtimeApi = await getApi();
        const view = await runtimeApi.getReaderView(itemId);
        if (cancelled || readerLoadRequestIdRef.current !== requestId) return;
        setReaderView(view);
        setReaderPage(0);
        setReaderPageInput("1");
        setReaderFitMode(readStoredString(READER_FIT_MODE_KEY, DEFAULT_READER_FIT_MODE, ["fit_width", "manual"] as const));
        setReaderZoom(readStoredNumber(READER_ZOOM_KEY, DEFAULT_READER_ZOOM));
        setReaderSearchQuery("");
        setIsFindHudOpen(false);
        setReaderSearchMatchIndex(0);
        setReaderSearchMatchCount(0);
        setReportedActiveSearchMatchIndex(-1);
        setPdfSelection(null);
        void startedAt;

        void (async () => {
          const [annotationsResult] = await Promise.allSettled([
            runtimeApi.listAnnotations(itemId),
          ]);
          if (cancelled || readerLoadRequestIdRef.current !== requestId) return;
          if (annotationsResult.status === "fulfilled") setAnnotations(annotationsResult.value);
        })();
      } catch (error) {
        if (cancelled || readerLoadRequestIdRef.current !== requestId) return;
        void error;
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
    }
  }, [workspaceMode]);

  useEffect(() => {
    setReaderSearchMatchIndex(0);
  }, [activePaperId, readerPage, readerSearchQuery, readerView?.reader_kind]);

  useEffect(() => {
    if (!isFindHudOpen) return;
    readerSearchInputRef.current?.focus();
    readerSearchInputRef.current?.select();
  }, [isFindHudOpen]);

  useEffect(() => {
    if (!isReferencePickerOpen) {
      aiReferenceSearchRequestIdRef.current += 1;
      setAiReferenceQuery("");
      setAiReferenceSearchResults([]);
      setAiReferenceSearchLoading(false);
      setAiReferenceSearchError(null);
      return;
    }

    const query = aiReferenceQuery.trim();
    if (!query) {
      aiReferenceSearchRequestIdRef.current += 1;
      setAiReferenceSearchResults([]);
      setAiReferenceSearchLoading(false);
      setAiReferenceSearchError(null);
      return;
    }

    const requestId = aiReferenceSearchRequestIdRef.current + 1;
    aiReferenceSearchRequestIdRef.current = requestId;
    let cancelled = false;
    setAiReferenceSearchLoading(true);
    setAiReferenceSearchError(null);

    void (async () => {
      try {
        const runtimeApi = await getApi();
        const results = await runtimeApi.searchItems(query);
        if (cancelled || aiReferenceSearchRequestIdRef.current !== requestId) return;
        setAiReferenceSearchResults(results);
        setAiReferenceSearchLoading(false);
      } catch (error) {
        if (cancelled || aiReferenceSearchRequestIdRef.current !== requestId) return;
        setAiReferenceSearchResults([]);
        setAiReferenceSearchLoading(false);
        setAiReferenceSearchError(error instanceof Error ? error.message : "Search failed.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [aiReferenceQuery, getApi, isReferencePickerOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AI_PANEL_WIDTH_KEY, String(aiPanelWidth));
  }, [aiPanelWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(isSidebarVisible));
  }, [isSidebarVisible]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ITEM_SORT_KEY, itemSort);
  }, [itemSort]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ATTACHMENT_FILTER_KEY, attachmentFilter);
  }, [attachmentFilter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(READER_FIT_MODE_KEY, readerFitMode);
  }, [readerFitMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(READER_ZOOM_KEY, String(readerZoom));
  }, [readerZoom]);

  const openFindHud = useCallback(() => {
    if (!textToolsEnabled) return;
    setIsFindHudOpen(true);
  }, [textToolsEnabled]);

  const closeFindHud = useCallback(() => {
    setIsFindHudOpen(false);
    setReaderSearchQuery("");
    setReaderSearchMatchIndex(0);
    setReaderSearchMatchCount(0);
    setReportedActiveSearchMatchIndex(-1);
  }, []);

  const setReaderPageClamped = useCallback(
    (nextPage: number) => {
      const clampedPage = Math.max(0, Math.min(nextPage, Math.max(readerPageCount - 1, 0)));
      setReaderPage(clampedPage);
      setReaderPageInput(String(clampedPage + 1));
    },
    [readerPageCount],
  );

  const goToPreviousReaderPage = useCallback(() => {
    setReaderPageClamped(readerPage - 1);
  }, [readerPage, setReaderPageClamped]);

  const goToNextReaderPage = useCallback(() => {
    setReaderPageClamped(readerPage + 1);
  }, [readerPage, setReaderPageClamped]);

  const clampReaderZoom = useCallback((value: number) => {
    return Math.max(READER_MIN_ZOOM, Math.min(value, READER_MAX_ZOOM));
  }, []);

  const setPdfZoomManual = useCallback(
    (value: number) => {
      setReaderFitMode("manual");
      setReaderZoom(clampReaderZoom(value));
    },
    [clampReaderZoom],
  );

  const stepPdfZoom = useCallback(
    (direction: 1 | -1) => {
      setPdfZoomManual(readerZoom + direction * READER_ZOOM_STEP);
    },
    [readerZoom, setPdfZoomManual],
  );

  const stepNormalizedZoom = useCallback(
    (direction: 1 | -1) => {
      setReaderZoom((current) => clampReaderZoom(current + direction * READER_ZOOM_STEP));
    },
    [clampReaderZoom],
  );

  useEffect(() => {
    if (textToolsEnabled) return;
    closeFindHud();
  }, [closeFindHud, textToolsEnabled]);

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !isTypingTarget(event.target)) {
        event.preventDefault();
        if (workspaceMode === "pdf_focus") {
          setWorkspaceMode("workspace");
          setIsSidebarVisible(true);
        } else {
          setIsSidebarVisible((current) => !current);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && textToolsEnabled) {
        event.preventDefault();
        openFindHud();
        return;
      }
      if (event.key === "Escape" && isFindHudOpen) {
        event.preventDefault();
        closeFindHud();
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
  }, [closeFindHud, isFindHudOpen, openFindHud, textToolsEnabled, workspaceMode]);

  useEffect(() => {
    if (!isFindHudOpen) return;
    const handle = window.setTimeout(() => {
      void readerSearchQuery;
    }, 250);
    return () => window.clearTimeout(handle);
  }, [isFindHudOpen, readerSearchQuery]);

  const moveReaderSearchMatch = (direction: 1 | -1, source: "button" | "enter") => {
    if (readerSearchMatchCount <= 0) return;
    void source;
    void reportedActiveSearchMatchIndex;
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

  const openSettingsDialog = useCallback(async () => {
    const runtimeApi = await getApi();
    const settings = await runtimeApi.getAiSettings();
    setAiSettings(settings);
    setAiSettingsDraft(draftFromAiSettings(settings));
    setGeneralSettingsDraft({
      resourcesSidebarOpen: readStoredBoolean(SIDEBAR_OPEN_KEY, true),
      defaultItemSort: readStoredString(ITEM_SORT_KEY, DEFAULT_ITEM_SORT, ["recent", "title", "year_desc"] as const),
      defaultAttachmentFilter: readStoredString(
        ATTACHMENT_FILTER_KEY,
        DEFAULT_ATTACHMENT_FILTER,
        ["all", "ready", "missing", "citation_only"] as const,
      ),
      defaultReaderFitMode: readStoredString(
        READER_FIT_MODE_KEY,
        DEFAULT_READER_FIT_MODE,
        ["fit_width", "manual"] as const,
      ),
      defaultReaderZoom: readStoredNumber(READER_ZOOM_KEY, DEFAULT_READER_ZOOM),
    });
    setOpenAiApiKeyDraft("");
    setAnthropicApiKeyDraft("");
    setIsSettingsOpen(true);
  }, [getApi]);

  const closeSettingsDialog = useCallback(() => {
    setIsSettingsOpen(false);
    setOpenAiApiKeyDraft("");
    setAnthropicApiKeyDraft("");
  }, []);

  const handleSaveAiSettings = useCallback(async () => {
    const runtimeApi = await getApi();
    const next = await runtimeApi.updateAiSettings({
      ...aiSettingsDraft,
      openai_api_key: openAiApiKeyDraft.trim() ? openAiApiKeyDraft : undefined,
      anthropic_api_key: anthropicApiKeyDraft.trim() ? anthropicApiKeyDraft : undefined,
    });
    setIsSidebarVisible(generalSettingsDraft.resourcesSidebarOpen);
    setItemSort(generalSettingsDraft.defaultItemSort);
    setAttachmentFilter(generalSettingsDraft.defaultAttachmentFilter);
    setReaderFitMode(generalSettingsDraft.defaultReaderFitMode);
    setReaderZoom(clampReaderZoom(generalSettingsDraft.defaultReaderZoom));
    setAiSettings(next);
    setAiSettingsDraft(draftFromAiSettings(next));
    setOpenAiApiKeyDraft("");
    setAnthropicApiKeyDraft("");
    setIsSettingsOpen(false);
    setStatusMessage("Saved settings.");
  }, [aiSettingsDraft, anthropicApiKeyDraft, clampReaderZoom, generalSettingsDraft, getApi, openAiApiKeyDraft]);

  const handleClearSavedKey = useCallback(async (provider: AIProvider) => {
    const runtimeApi = await getApi();
    const next = await runtimeApi.updateAiSettings({
      ...aiSettingsDraft,
      clear_openai_api_key: provider === "openai" ? true : undefined,
      clear_anthropic_api_key: provider === "anthropic" ? true : undefined,
    });
    setAiSettings(next);
    setAiSettingsDraft(draftFromAiSettings(next));
    if (provider === "openai") setOpenAiApiKeyDraft("");
    else setAnthropicApiKeyDraft("");
    setStatusMessage(`${provider === "openai" ? "OpenAI" : "Anthropic"} API key cleared.`);
  }, [aiSettingsDraft, getApi]);

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
    let unlistenSettings: null | (() => void) = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenDocs = await listen("menu:import-documents", () => importDocumentsRef.current());
      unlistenCitations = await listen("menu:import-citations", () => importCitationsRef.current());
      unlistenSettings = await listen("menu:open-settings", () => {
        void openSettingsDialog();
      });
    })();

    return () => {
      unlistenDocs?.();
      unlistenCitations?.();
      unlistenSettings?.();
    };
  }, [openSettingsDialog]);

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

  const refreshAiSessions = useCallback(async () => {
    const runtimeApi = await getApi();
    const sessions = await runtimeApi.listAiSessions();
    setAiSessions(sessions);
    setActiveAiSessionId((current) => current ?? sessions[0]?.id ?? null);
    return sessions;
  }, [getApi]);

  const refreshActiveAiSession = useCallback(
    async (sessionId: number) => {
      const runtimeApi = await getApi();
      const [references, taskRuns, artifact, sessionNotes, sessions] = await Promise.all([
        runtimeApi.listAiSessionReferences(sessionId),
        runtimeApi.listAiSessionTaskRuns(sessionId),
        runtimeApi.getAiSessionArtifact(sessionId),
        runtimeApi.listAiSessionNotes(sessionId),
        runtimeApi.listAiSessions(),
      ]);
      setAiSessionReferences(references);
      setAiSessionTaskRuns(taskRuns);
      setAiSessionArtifact(artifact);
      setNotes(sessionNotes);
      setActiveNoteId(sessionNotes[0]?.id ?? null);
      setNoteDraft(sessionNotes[0]?.markdown ?? "");
      setAiSessions(sessions);
      return { references, taskRuns, artifact, sessionNotes, sessions };
    },
    [getApi],
  );

  const ensureSessionHasCurrentPaper = useCallback(
    async (sessionId: number, references?: AISessionReference[]) => {
      if (!activePaper) return;
      const currentReferences =
        references ??
        (await (async () => {
          const runtimeApi = await getApi();
          return runtimeApi.listAiSessionReferences(sessionId);
        })());
      if (currentReferences.length > 0) return;
      const runtimeApi = await getApi();
      await runtimeApi.addAiSessionReference({
        session_id: sessionId,
        kind: "item",
        target_id: activePaper.id,
      });
    },
    [activePaper, getApi],
  );

  useEffect(() => {
    void refreshAiSessions();
  }, [refreshAiSessions]);

  useEffect(() => {
    if (activeAiSessionId === null) {
      setAiSessionReferences([]);
      setAiSessionTaskRuns([]);
      setAiSessionArtifact(null);
      setNotes([]);
      setActiveNoteId(null);
      setNoteDraft("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const sessionState = await refreshActiveAiSession(activeAiSessionId);
      if (cancelled) return;
      if (sessionState.references.length === 0 && activePaper) {
        await ensureSessionHasCurrentPaper(activeAiSessionId, sessionState.references);
        if (cancelled) return;
        await refreshActiveAiSession(activeAiSessionId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAiSessionId, activePaper, ensureSessionHasCurrentPaper, refreshActiveAiSession]);

  const handleCreateCollection = async (parentId: number | null) => {
    const name = collectionDraftName.trim();
    if (!name) {
      setStatusMessage("Enter a collection name first.");
      return;
    }
    const runtimeApi = await getApi();
    const collection = await runtimeApi.createCollection({ name, parent_id: parentId });
    await refreshCollections(collection.id);
    setCollectionDraftName("");
    setCreatingCollectionParentId(null);
    setStatusMessage(`Created collection ${collection.name}.`);
  };

  const startCreateCollection = useCallback((parentId: number | null) => {
    setCreatingCollectionParentId(parentId === null ? "root" : parentId);
    setRenamingCollectionId(null);
    setCollectionDraftName("");
    setResourceContextMenu(null);
  }, []);

  const startRenameCollection = useCallback((collection: Collection) => {
    setRenamingCollectionId(collection.id);
    setCreatingCollectionParentId(null);
    setCollectionDraftName(collection.name);
    setResourceContextMenu(null);
  }, []);

  const submitCollectionRename = useCallback(async () => {
    if (!renamingCollectionId) return;
    const name = collectionDraftName.trim();
    if (!name) {
      setRenamingCollectionId(null);
      setCollectionDraftName("");
      return;
    }
    const runtimeApi = await getApi();
    await runtimeApi.renameCollection({ collection_id: renamingCollectionId, name });
    await refreshCollections(renamingCollectionId);
    setRenamingCollectionId(null);
    setCollectionDraftName("");
    setStatusMessage(`Renamed collection to ${name}.`);
  }, [collectionDraftName, getApi, refreshCollections, renamingCollectionId]);

  const cancelCollectionInlineEdit = useCallback(() => {
    setCreatingCollectionParentId(null);
    setRenamingCollectionId(null);
    setCollectionDraftName("");
  }, []);

  const openResourceContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      detail: Exclude<ResourceContextMenuState, null>,
    ) => {
      event.preventDefault();
      setResourceContextMenu(detail);
      setIsReferencePickerOpen(false);
    },
    [],
  );

  const closeResourceContextMenu = useCallback(() => {
    setResourceContextMenu(null);
  }, []);

  const handleRequestDeleteCollection = useCallback(
    (collection: Collection) => {
      const summary = collectionDeleteSummary(collections, libraryItems, collection.id);
      setDeleteTarget({
        kind: "collection",
        targetId: collection.id,
        label: collection.name,
        parentCollectionId: collection.parent_id,
        ...summary,
      });
      setResourceContextMenu(null);
    },
    [collections, libraryItems],
  );

  const handleRequestDeleteItem = useCallback((item: LibraryItem) => {
    setDeleteTarget({
      kind: "item",
      targetId: item.id,
      label: item.title,
      parentCollectionId: item.collection_id,
    });
    setResourceContextMenu(null);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const runtimeApi = await getApi();

    try {
      if (deleteTarget.kind === "item") {
        const deletedItemId = deleteTarget.targetId;
        const isActiveDeletedPaper = activePaperId === deletedItemId;
        const remainingOpenPaperIds = openPaperIds.filter((itemId) => itemId !== deletedItemId);

        await runtimeApi.removeItem({ item_id: deletedItemId });
        await loadLibrary();
        if (activeAiSessionId) await refreshActiveAiSession(activeAiSessionId);

        setOpenPaperIds(remainingOpenPaperIds);
        setSelectedItemIds((current) => current.filter((itemId) => itemId !== deletedItemId));
        setActivePaperId((current) => (current === deletedItemId ? remainingOpenPaperIds[remainingOpenPaperIds.length - 1] ?? null : current));

        if (isActiveDeletedPaper) {
          setWorkspaceMode("workspace");
          setIsSidebarVisible(true);
          setReaderView(null);
          setAnnotations([]);
          setPdfSelection(null);
          setActivePdfHighlight(null);
        }

        setStatusMessage(`Deleted ${deleteTarget.label}.`);
      } else {
        const deletedCollectionIds = new Set(deleteTarget.deletedCollectionIds ?? [deleteTarget.targetId]);
        const deletedItemIds = new Set(deleteTarget.deletedItemIds ?? []);
        const remainingOpenPaperIds = openPaperIds.filter((itemId) => !deletedItemIds.has(itemId));
        const deletedActivePaper =
          activePaperId !== null && deletedItemIds.has(activePaperId);
        const deletedSelectedCollection =
          selectedCollectionId !== null && deletedCollectionIds.has(selectedCollectionId);

        await runtimeApi.removeCollection({ collection_id: deleteTarget.targetId });
        await loadLibrary();
        await refreshCollections(deleteTarget.parentCollectionId);
        if (deletedSelectedCollection) {
          setSelectedCollectionId(deleteTarget.parentCollectionId);
        }
        if (activeAiSessionId) await refreshActiveAiSession(activeAiSessionId);
        setOpenPaperIds(remainingOpenPaperIds);
        setSelectedItemIds((current) => current.filter((itemId) => !deletedItemIds.has(itemId)));
        setExpandedCollectionIds((current) => current.filter((collectionId) => !deletedCollectionIds.has(collectionId)));
        setActivePaperId((current) =>
          current !== null && deletedItemIds.has(current)
            ? remainingOpenPaperIds[remainingOpenPaperIds.length - 1] ?? null
            : current,
        );
        setAiSessionReferences((current) =>
          current.filter((reference) =>
            reference.kind === "item"
              ? !deletedItemIds.has(reference.target_id)
              : !deletedCollectionIds.has(reference.target_id),
          ),
        );
        if (deletedActivePaper) {
          setWorkspaceMode("workspace");
          setIsSidebarVisible(true);
          setReaderView(null);
          setAnnotations([]);
          setPdfSelection(null);
          setActivePdfHighlight(null);
        }
        setStatusMessage(`Deleted ${deleteTarget.label}.`);
      }
      setDeleteTarget(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `Failed to delete ${deleteTarget.label}.`);
      setDeleteTarget(null);
    }
  }, [
    activeAiSessionId,
    activePaperId,
    deleteTarget,
    getApi,
    loadLibrary,
    openPaperIds,
    refreshActiveAiSession,
    refreshCollections,
    selectedCollectionId,
  ]);

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

  const toggleAiDockSection = useCallback((section: AiDockSection) => {
    setAiDockOpen((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }, []);

  const handleAiTaskStreamEvent = useCallback((event: AITaskStreamEvent) => {
    if (event.scope !== "session") return;
    setAiPending((current) => {
      const existing = current;
      if (event.phase === "started") {
        return {
          streamId: event.stream_id,
          kind: event.kind,
          inputPrompt: event.input_prompt ?? null,
          markdown: "",
          error: null,
          status: "streaming",
        };
      }
      if (!existing || existing.streamId !== event.stream_id) return current;
      if (event.phase === "delta") {
        return {
          ...existing,
          markdown: event.full_markdown ?? `${existing.markdown}${event.delta_markdown ?? ""}`,
        };
      }
      if (event.phase === "completed") {
        return {
          ...existing,
          markdown: event.full_markdown ?? existing.markdown,
          taskId: event.task_id,
        };
      }
      if (event.phase === "failed") {
        return {
          ...existing,
          error: event.error ?? "AI task failed.",
          status: "failed",
        };
      }
      return current;
    });
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const runtimeApi = await getApi();
      const unlisten = await runtimeApi.listenAiTaskStream(handleAiTaskStreamEvent);
      if (cancelled) {
        unlisten();
        return;
      }
      dispose = unlisten;
    })();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [api, handleAiTaskStreamEvent]);

  const handleSessionTask = async (kind: string, prompt?: string) => {
    if (!activeAiSessionId) return;
    const runtimeApi = await getApi();
    const streamId = createStreamId();
    setAiPending({
      streamId,
      kind,
      inputPrompt: prompt?.trim() || null,
      markdown: "",
      error: null,
      status: "streaming",
    });
    try {
      const task = await runtimeApi.runAiSessionTask({ session_id: activeAiSessionId, kind, prompt, stream_id: streamId });
      const nextTaskRuns = await runtimeApi.listAiSessionTaskRuns(activeAiSessionId);
      const nextArtifact = await runtimeApi.getAiSessionArtifact(activeAiSessionId);
      const nextSessions = await runtimeApi.listAiSessions();
      setAiSessionTaskRuns(nextTaskRuns);
      setAiSessionArtifact(nextArtifact);
      setAiSessions(nextSessions);
      setAiPending((current) => (current && current.streamId === streamId ? null : current));
      setStatusMessage(`Completed ${taskLabel(kind)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed ${taskLabel(kind)}.`;
      setAiPending((current) =>
        current && current.streamId === streamId
          ? {
              ...current,
              error: message,
              status: "failed",
            }
          : current,
      );
      setStatusMessage(message);
    }
  };

  const handleAiSubmit = useCallback(async () => {
    const prompt = aiComposerValue.trim();
    if (!prompt) return;
    await handleSessionTask("session.ask", prompt);
    setAiComposerValue("");
  }, [aiComposerValue]);

  const handleQuickAction = async (kind: string) => {
    await handleSessionTask(kind);
  };

  const handleCreateResearchNote = async () => {
    if (!aiSessionArtifact) return;
    const runtimeApi = await getApi();
    const note = await runtimeApi.createAiSessionNoteFromArtifact(aiSessionArtifact.id);
    const sessionNotes = activeAiSessionId ? await runtimeApi.listAiSessionNotes(activeAiSessionId) : [];
    setNotes(sessionNotes);
    setActiveNoteId(note.id);
    setNoteDraft(note.markdown);
  };

  const handleSaveNoteEdits = async () => {
    if (!activeNoteId || !activeAiSessionId) return;
    const runtimeApi = await getApi();
    await runtimeApi.updateNote({ note_id: activeNoteId, markdown: noteDraft });
    const sessionNotes = await runtimeApi.listAiSessionNotes(activeAiSessionId);
    setNotes(sessionNotes);
  };

  const handleExportMarkdown = async () => {
    const note = notes.find((entry) => entry.id === activeNoteId);
    if (!note) return;
    const runtimeApi = await getApi();
    const markdown = await runtimeApi.exportNoteMarkdown(note.id);
    const exportTarget = await runtimeApi.requestExportPath({
      defaultPath: `${filenameStem(noteHeading(note), "research-note")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!exportTarget) return;
    await runtimeApi.writeExportFile({ ...exportTarget, contents: markdown });
    setStatusMessage(`Saved Markdown to ${exportTarget.path}.`);
  };

  const handleCreateAiSession = useCallback(async () => {
    const runtimeApi = await getApi();
    const session = await runtimeApi.createAiSession();
    setAiSessions((current) => [session, ...current]);
    setActiveAiSessionId(session.id);
    setIsAiSessionHistoryOpen(false);
    if (activePaper) {
      await runtimeApi.addAiSessionReference({
        session_id: session.id,
        kind: "item",
        target_id: activePaper.id,
      });
    }
    await refreshActiveAiSession(session.id);
    setStatusMessage(`Created ${session.title}.`);
  }, [activePaper, getApi, refreshActiveAiSession]);

  const handleAddAiReference = useCallback(
    async (kind: AISessionReference["kind"], targetId: number) => {
      if (!activeAiSessionId) return;
      const runtimeApi = await getApi();
      await runtimeApi.addAiSessionReference({
        session_id: activeAiSessionId,
        kind,
        target_id: targetId,
      });
      await refreshActiveAiSession(activeAiSessionId);
      setAiReferenceQuery("");
      setAiReferenceSearchResults([]);
      setAiReferenceSearchLoading(false);
      setAiReferenceSearchError(null);
      setIsReferencePickerOpen(false);
    },
    [activeAiSessionId, getApi, refreshActiveAiSession],
  );

  const handleRemoveAiReference = useCallback(
    async (referenceId: number) => {
      const runtimeApi = await getApi();
      await runtimeApi.removeAiSessionReference(referenceId);
      if (activeAiSessionId) await refreshActiveAiSession(activeAiSessionId);
    },
    [activeAiSessionId, getApi, refreshActiveAiSession],
  );

  const startPaneResize = useCallback(
    (target: "sidebar" | "ai", event: ReactPointerEvent<HTMLDivElement>) => {
      if (window.innerWidth <= 820) return;
      event.preventDefault();
      const startX = event.clientX;
      const startSidebarWidth = sidebarWidth;
      const startAiPanelWidth = aiPanelWidth;
      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        if (target === "sidebar") {
          setSidebarWidth(clamp(startSidebarWidth + delta, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
        } else {
          setAiPanelWidth(clamp(startAiPanelWidth - delta, AI_PANEL_MIN_WIDTH, AI_PANEL_MAX_WIDTH));
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [aiPanelWidth, sidebarWidth],
  );

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

  const dismissActivePdfHighlight = useCallback(() => {
    setActivePdfHighlight(null);
  }, []);

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

  const handleActivatePdfHighlight = useCallback((highlight: ActivePdfHighlight) => {
    dismissPdfSelection();
    setActivePdfHighlight(highlight);
  }, [dismissPdfSelection]);

  const handleRemoveActivePdfHighlight = useCallback(async () => {
    if (!activePdfHighlight) return;
    const runtimeApi = await getApi();
    await runtimeApi.removeAnnotation({ annotation_id: activePdfHighlight.annotationId });
    setAnnotations((current) => current.filter((annotation) => annotation.id !== activePdfHighlight.annotationId));
    setActivePdfHighlight(null);
    setStatusMessage("Removed highlight.");
  }, [activePdfHighlight, getApi]);

  const handleReaderPageSubmit = () => {
    const parsed = Number(readerPageInput.trim());
    if (!Number.isFinite(parsed)) {
      setReaderPageInput(String(readerPage + 1));
      return;
    }
    setReaderPageClamped(parsed - 1);
  };

  const currentReaderHtml = useMemo(
    () => readerView?.normalized_html ?? "<article><p>No reader view available yet.</p></article>",
    [readerView],
  );

  const aiPanelCanSend = expandedAiReferenceItemIds.length > 0 && aiPending?.status !== "streaming";
  const compareEnabled = expandedAiReferenceItemIds.length >= 2 && aiPending?.status !== "streaming";
  const areQuickActionsDisabled = aiPending?.status === "streaming";
  const filteredReferenceCollections = useMemo(() => {
    const query = aiReferenceQuery.trim().toLowerCase();
    return sortedReferenceCollections.filter((collection) =>
      query.length === 0 ? true : collection.name.toLowerCase().includes(query),
    );
  }, [aiReferenceQuery, sortedReferenceCollections]);
  const aiReferencePickerResults = useMemo<AiReferencePickerResult[]>(() => {
    const query = aiReferenceQuery.trim();
    const output: AiReferencePickerResult[] = [];
    const seen = new Set<string>();
    const pushResult = (entry: AiReferencePickerResult) => {
      if (seen.has(entry.key)) return;
      seen.add(entry.key);
      output.push(entry);
    };

    if (activePaper) {
      pushResult({
        key: `item-${activePaper.id}`,
        kind: "item",
        targetId: activePaper.id,
        label: activePaper.title,
        meta: formatItemMetadata(activePaper),
        badges: ["Current", "Paper"],
      });
    }

    for (const item of query.length > 0 ? aiReferenceSearchResults : sortedReferenceItems) {
      pushResult({
        key: `item-${item.id}`,
        kind: "item",
        targetId: item.id,
        label: item.title,
        meta: formatItemMetadata(item),
        badges: ["Paper"],
      });
    }

    for (const collection of filteredReferenceCollections) {
      pushResult({
        key: `collection-${collection.id}`,
        kind: "collection",
        targetId: collection.id,
        label: collection.name,
        meta: `${itemCountForCollection(libraryItems, collection.id)} papers`,
        badges: ["Collection"],
      });
    }

    return output;
  }, [activePaper, aiReferenceQuery, aiReferenceSearchResults, filteredReferenceCollections, libraryItems, sortedReferenceItems]);


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

  const showActivePdfHighlightBar = Boolean(activePdfHighlight);
  const activePdfHighlightBarStyle = useMemo(() => {
    if (!activePdfHighlight) return {};

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const BAR_WIDTH_PX = 172;
    const BAR_HEIGHT_PX = 44;
    const GAP_PX = 10;
    const PADDING_PX = 12;

    const rect = activePdfHighlight.rect;
    let left = rect.right + GAP_PX;
    let top = rect.top - BAR_HEIGHT_PX - GAP_PX;
    if (top < PADDING_PX) top = rect.bottom + GAP_PX;

    left = clamp(left, PADDING_PX, window.innerWidth - BAR_WIDTH_PX - PADDING_PX);
    top = clamp(top, PADDING_PX, window.innerHeight - BAR_HEIGHT_PX - PADDING_PX);

    return { left: `${left}px`, top: `${top}px` } as const;
  }, [activePdfHighlight]);

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

  useEffect(() => {
    if (!showActivePdfHighlightBar) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissActivePdfHighlight();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const bar = highlightActionBarRef.current;
      if (bar && bar.contains(target)) return;
      const highlight = target instanceof Element
        ? target.closest(".pdf-annotation-highlight[data-annotation-id]")
        : null;
      if (highlight) return;
      dismissActivePdfHighlight();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [dismissActivePdfHighlight, showActivePdfHighlightBar]);

  useEffect(() => {
    setActivePdfHighlight(null);
    setPdfSelection(null);
  }, [activePaper?.id]);

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

  const contextMenuCollection =
    resourceContextMenu?.kind === "collection"
      ? collections.find((collection) => collection.id === resourceContextMenu.targetId) ?? null
      : null;
  const contextMenuItem =
    resourceContextMenu?.kind === "item"
      ? libraryItems.find((item) => item.id === resourceContextMenu.targetId) ?? null
      : null;

  const renderInlineCollectionEditor = (parentId: number | null) => (
    <div className="resource-tree-row resource-tree-row-editing" role="none" key={`inline-editor-${parentId ?? "root"}`}>
      <input
        aria-label={renamingCollectionId ? "Rename collection" : "New collection name"}
        autoFocus
        className="resource-tree-inline-input"
        value={collectionDraftName}
        onBlur={() =>
          renamingCollectionId ? void submitCollectionRename() : void handleCreateCollection(parentId)
        }
        onChange={(event) => setCollectionDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (renamingCollectionId) {
              void submitCollectionRename();
            } else {
              void handleCreateCollection(parentId);
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelCollectionInlineEdit();
          }
        }}
        placeholder={renamingCollectionId ? "Rename collection" : "New collection"}
      />
    </div>
  );

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
        const isRenaming = renamingCollectionId === collection.id;

        return [
          <div key={`collection-${collection.id}`} role="none">
            <div
              className={`resource-tree-row resource-tree-collection ${
                selectedCollectionId === collection.id ? "resource-tree-row-active" : ""
              }`}
              role="treeitem"
              aria-expanded={isExpanded}
              aria-label={collection.name}
              style={{ paddingLeft: `${10 + depth * 18}px` }}
              onContextMenu={(event) =>
                openResourceContextMenu(event, {
                  x: event.clientX,
                  y: event.clientY,
                  kind: "collection",
                  targetId: collection.id,
                })
              }
            >
              <button
                aria-label={isExpanded ? `Collapse ${collection.name}` : `Expand ${collection.name}`}
                className="resource-tree-toggle"
                type="button"
                onClick={() => toggleCollectionExpanded(collection.id)}
              >
                {isExpanded ? "▾" : "▸"}
              </button>
              {isRenaming ? (
                <input
                  aria-label="Rename collection"
                  autoFocus
                  className="resource-tree-inline-input"
                  value={collectionDraftName}
                  onBlur={() => void submitCollectionRename()}
                  onChange={(event) => setCollectionDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitCollectionRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelCollectionInlineEdit();
                    }
                  }}
                />
              ) : (
                <button
                  className="resource-tree-label resource-tree-collection-button"
                  type="button"
                  onClick={() => setSelectedCollectionId(collection.id)}
                >
                  {collection.name}
                </button>
              )}
            </div>
            {isExpanded ? (
              <div className="resource-tree-group" role="group">
                {creatingCollectionParentId === collection.id ? renderInlineCollectionEditor(collection.id) : null}
                {collectionChildren}
                {directItems.map((item) => (
                  <button
                    key={`item-${item.id}`}
                    aria-label={item.title}
                    className={`resource-tree-row resource-tree-item ${
                      activePaperId === item.id ? "resource-tree-row-active" : ""
                    }`}
                    role="treeitem"
                    style={{ paddingLeft: `${28 + depth * 18}px` }}
                    type="button"
                    onClick={() => activateItem(item)}
                    onContextMenu={(event) =>
                      openResourceContextMenu(event, {
                        x: event.clientX,
                        y: event.clientY,
                        kind: "item",
                        targetId: item.id,
                      })
                    }
                    onDoubleClick={() => {
                      if (item.attachment_format === "pdf") {
                        activateItem(item, { focusPdf: true });
                      }
                    }}
                  >
                    <span className="resource-tree-item-title">{item.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>,
        ];
      });

  return (
    <div
      ref={appShellRef}
      className={`app-shell ${
        workspaceMode === "pdf_focus" ? "app-shell-focus" : "app-shell-workspace"
      } ${isAiPanelOpen ? "app-shell-ai-open" : ""}`}
      style={
        {
          "--sidebar-width": `${clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)}px`,
          "--ai-panel-width": `${clamp(aiPanelWidth, AI_PANEL_MIN_WIDTH, AI_PANEL_MAX_WIDTH)}px`,
        } as CSSProperties
      }
    >
      {resourceContextMenu && (contextMenuCollection || contextMenuItem) ? (
        <div
          ref={resourceContextMenuRef}
          aria-label="Resource actions"
          className="floating-menu resource-context-menu"
          role="menu"
          style={{ left: resourceContextMenu.x, top: resourceContextMenu.y }}
        >
          {contextMenuCollection ? (
            <>
              <button className="nav-item" role="menuitem" type="button" onClick={() => startCreateCollection(contextMenuCollection.id)}>
                New Folder
              </button>
              <button className="nav-item" role="menuitem" type="button" onClick={() => startRenameCollection(contextMenuCollection)}>
                Rename
              </button>
              <button
                className="nav-item resource-context-menu-delete"
                role="menuitem"
                type="button"
                onClick={() => handleRequestDeleteCollection(contextMenuCollection)}
              >
                Delete
              </button>
            </>
          ) : null}
          {contextMenuItem ? (
            <>
              <button
                className="nav-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  activateItem(contextMenuItem);
                  closeResourceContextMenu();
                }}
              >
                Open
              </button>
              <button
                className="nav-item resource-context-menu-delete"
                role="menuitem"
                type="button"
                onClick={() => handleRequestDeleteItem(contextMenuItem)}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {isSidebarVisible ? (
        <aside className="sidebar">
          <div className="panel-header panel-header-row">
            <div>
              <p className="eyebrow">Workspace</p>
              <h1>Library</h1>
            </div>
            <button
              aria-label="Manage library"
              className="icon-button"
              type="button"
              ref={manageButtonRef}
              onClick={() => setIsManageOpen((current) => !current)}
            >
              ⚙
            </button>
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
              <div className="section-title-actions">
                <span className="meta-count">{libraryItems.length}</span>
                <button
                  aria-label="New folder"
                  className="icon-button icon-button-small"
                  type="button"
                  onClick={() => startCreateCollection(null)}
                >
                  ＋
                </button>
              </div>
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
                  <>
                    {creatingCollectionParentId === "root" ? renderInlineCollectionEditor(null) : null}
                    {renderTreeNodes(null)}
                  </>
                )}
              </div>
            )}
          </section>

          {isManageOpen ? (
            <div className="manage-popover" ref={managePopoverRef} role="dialog" aria-label="Manage">
              <div className="manage-popover-body">
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
                  <button
                    className="ghost-button"
                    disabled={!activePaper}
                    type="button"
                    onClick={() => void handleCreateTag()}
                  >
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
            </div>
          ) : null}

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
        </aside>
      ) : null}

      {isSidebarVisible && workspaceMode !== "pdf_focus" ? (
        <div
          aria-hidden="true"
          className="pane-resizer"
          onPointerDown={(event) => startPaneResize("sidebar", event)}
        />
      ) : null}

      <main className={`reader-shell ${workspaceMode === "pdf_focus" ? "reader-shell-focus" : "reader-shell-workspace"}`}>
        <div className={`reader-tabs ${workspaceMode === "pdf_focus" ? "reader-tabs-focus" : ""}`} role="tablist" aria-label="Open papers">
          {workspaceMode === "pdf_focus" && activePaper?.attachment_format === "pdf" ? (
            <button
              aria-label="Back to library"
              className="reader-back-button"
              title="Back to library"
              type="button"
              onClick={() => {
                setWorkspaceMode("workspace");
                setIsSidebarVisible(true);
              }}
            >
              &lt;
            </button>
          ) : null}
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
          <button
            aria-label={isAiPanelOpen ? "Close AI panel" : "Open AI panel"}
            aria-pressed={isAiPanelOpen}
            className="icon-button reader-ai-toggle"
            type="button"
            onClick={() =>
              void (async () => {
                if (isAiPanelOpen) {
                  setIsAiPanelOpen(false);
                  return;
                }
                setIsAiPanelOpen(true);
                if (!activeAiSessionId) {
                  const runtimeApi = await getApi();
                  const existing = await runtimeApi.listAiSessions();
                  const session = existing[0] ?? (await runtimeApi.createAiSession());
                  setAiSessions(existing[0] ? existing : [session]);
                  setActiveAiSessionId(session.id);
                }
              })()
            }
          >
            ✦
          </button>
        </div>

        {workspaceMode === "pdf_focus" && activePaper?.attachment_format === "pdf" ? (
          <section className="reader-panel reader-panel-focus">
            <div className="reader-toolbar reader-toolbar-focus" role="toolbar" aria-label="PDF focus toolbar">
              {textToolsEnabled ? (
                <div className="reader-control-group">
                  <button
                    aria-label="Find in document"
                    className="ghost-button"
                    type="button"
                    onClick={openFindHud}
                  >
                    Search
                  </button>
                </div>
              ) : null}

              <div className="reader-control-group reader-control-group-page">
                <button
                  aria-label="Previous Page"
                  className="ghost-button"
                  disabled={readerPage === 0}
                  type="button"
                  onClick={goToPreviousReaderPage}
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
                  onClick={goToNextReaderPage}
                >
                  Next
                </button>
              </div>

              <div className="reader-control-group reader-control-group-zoom">
                <button
                  aria-pressed={readerFitMode === "fit_width"}
                  className="ghost-button"
                  type="button"
                  onClick={() => setReaderFitMode("fit_width")}
                >
                  Fit
                </button>
                <button aria-label="Zoom out" className="ghost-button" type="button" onClick={() => stepPdfZoom(-1)}>
                  -
                </button>
                <span className="reader-zoom-label">{readerFitMode === "fit_width" ? "Fit width" : `${readerZoom}%`}</span>
                <button aria-label="Zoom in" className="ghost-button" type="button" onClick={() => stepPdfZoom(1)}>
                  +
                </button>
              </div>

            </div>

            {readerView ? (
              <>
                <PdfContinuousReader
                  fitMode={readerFitMode}
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
                  }}
                  onSelectionChange={(selection) => {
                    setPdfSelection(selection);
                    if (selection) setActivePdfHighlight(null);
                  }}
                  onHighlightActivate={handleActivatePdfHighlight}
                  onActivePageChange={(pageIndex0) => {
                    setReaderPageClamped(pageIndex0);
                  }}
                  onNavigateToPage={(pageIndex0) => {
                    setReaderPageClamped(pageIndex0);
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
            </div>

            {readerView?.reader_kind !== "pdf" ? (
              <div className="reader-toolbar">
                {textToolsEnabled ? (
                  <div className="reader-control-group">
                    <button
                      aria-label="Find in document"
                      className="ghost-button"
                      type="button"
                      onClick={openFindHud}
                    >
                      Search
                    </button>
                  </div>
                ) : null}
                <div className="reader-control-group">
                  <button
                    aria-label="Zoom out"
                    className="ghost-button"
                    type="button"
                    onClick={() => stepNormalizedZoom(-1)}
                  >
                    -
                  </button>
                  <span className="reader-zoom-label">{readerZoom}%</span>
                  <button
                    aria-label="Zoom in"
                    className="ghost-button"
                    type="button"
                    onClick={() => stepNormalizedZoom(1)}
                  >
                    +
                  </button>
                </div>
                {readerView && readerView.content_status !== "ready" ? (
                  <span className="meta-count">{readerView.content_notice ?? readerView.content_status}</span>
                ) : null}
                {activePaper && activePaper.attachment_status !== "ready" ? (
                  <span className="meta-count">{activePaper.attachment_status}</span>
                ) : null}
              </div>
            ) : null}

            {activePaper && readerView ? (
              readerView.reader_kind === "pdf" ? (
                <PdfReader
                  fitMode={readerFitMode}
                  getPdfDocumentInfo={getPdfDocumentInfo}
                  getPdfPageBundle={getPdfPageBundle}
                  page={0}
                  view={readerView}
                  zoom={readerZoom}
                  onHighlightActivate={handleActivatePdfHighlight}
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
                  closeFindHud();
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
              onClick={closeFindHud}
            >
              Close
            </button>
          </div>
        ) : null}
      </main>

      {showActivePdfHighlightBar ? (
        <div
          className="pdf-highlight-action-bar"
          ref={highlightActionBarRef}
          role="toolbar"
          aria-label="PDF highlight actions"
          style={activePdfHighlightBarStyle}
        >
          <button type="button" className="ghost-button" onClick={() => void handleRemoveActivePdfHighlight()}>
            Remove Highlight
          </button>
        </div>
      ) : null}

      {isAiPanelOpen ? (
        <>
          {workspaceMode !== "pdf_focus" ? (
            <div
              aria-hidden="true"
              className="pane-resizer"
              onPointerDown={(event) => startPaneResize("ai", event)}
            />
          ) : null}
          <aside className="ai-shell" aria-label="AI panel">
            <div className="ai-shell-header">
              <div className="ai-copilot-header">
                <div className="ai-copilot-heading">
                  <span className="ai-copilot-title">Copilot</span>
                  {activeAiSession ? (
                    <span className="meta-count ai-session-title" title={activeAiSession.title}>
                      {activeAiSession.title}
                    </span>
                  ) : null}
                </div>
                <div className="ai-copilot-controls">
                  <button
                    aria-label="Chat History"
                    aria-pressed={isAiSessionHistoryOpen}
                    className="icon-button icon-button-small"
                    type="button"
                    onClick={() => setIsAiSessionHistoryOpen((current) => !current)}
                  >
                    <ChatHistoryIcon />
                  </button>
                  <button
                    aria-label="New Session"
                    className="icon-button icon-button-small"
                    type="button"
                    onClick={() => void handleCreateAiSession()}
                  >
                    <NewSessionIcon />
                  </button>
                  <button
                    aria-label="Artifacts"
                    aria-pressed={aiDockOpen.artifacts}
                    className="icon-button icon-button-small"
                    type="button"
                    onClick={() => toggleAiDockSection("artifacts")}
                  >
                    <ArtifactIcon />
                  </button>
                  <button
                    aria-label="Task History"
                    aria-pressed={aiDockOpen.history}
                    className="icon-button icon-button-small"
                    type="button"
                    onClick={() => toggleAiDockSection("history")}
                  >
                    <TaskHistoryIcon />
                  </button>
                  <button
                    aria-label="Research Notes"
                    aria-pressed={aiDockOpen.notes}
                    className="icon-button icon-button-small"
                    type="button"
                    onClick={() => toggleAiDockSection("notes")}
                  >
                    <ResearchNotesIcon />
                  </button>
                  <button
                    aria-label="Close Copilot"
                    className="icon-button icon-button-small"
                    type="button"
                    onClick={() => setIsAiPanelOpen(false)}
                  >
                    <CloseCopilotIcon />
                  </button>
                </div>
              </div>
              <div className="ai-floating-panels">
                {aiDockOpen.artifacts ? (
                  <div className="management-panel-body ai-dock-panel-body ai-floating-panel" aria-label="Artifacts panel">
                    {aiSessionArtifact ? <MarkdownMessage markdown={aiSessionArtifact.markdown} /> : <p>No artifact yet.</p>}
                    {aiSessionArtifact ? (
                      <button className="ghost-button" type="button" onClick={() => void handleCreateResearchNote()}>
                        Save as Research Note
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {aiDockOpen.history ? (
                  <div className="management-panel-body ai-dock-panel-body ai-floating-panel" aria-label="Task History panel">
                    {aiSessionTaskRuns.length > 0 ? (
                      aiSessionTaskRuns.map((task) => (
                        <div key={`history-${task.id}`} className="export-row">
                          <span>{taskLabel(task.kind)}</span>
                          <span className="meta-count">{task.status}</span>
                        </div>
                      ))
                    ) : (
                      <p>No tasks yet.</p>
                    )}
                  </div>
                ) : null}

                {aiDockOpen.notes ? (
                  <div className="management-panel-body ai-dock-panel-body ai-floating-panel" aria-label="Research Notes panel">
                    {activeNoteId ? (
                      <>
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
                      </>
                    ) : null}
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
                ) : null}
              </div>
            </div>

            <aside
              className={`ai-session-history-panel ${isAiSessionHistoryOpen ? "ai-session-history-panel-open" : ""}`}
              aria-hidden={!isAiSessionHistoryOpen}
            >
              <div className="ai-session-history-panel-header">
                <strong>Chat History</strong>
              </div>
              <div className="ai-session-history-list" role="list" aria-label="Chat History panel">
                {aiSessions.map((session) => (
                  <button
                    key={session.id}
                    className={`nav-item ai-session-history-item ${session.id === activeAiSessionId ? "nav-item-active" : ""}`}
                    title={session.title}
                    type="button"
                    onClick={() => {
                      setActiveAiSessionId(session.id);
                      setIsAiSessionHistoryOpen(false);
                    }}
                  >
                    <span className="ai-session-history-item-title">{session.title}</span>
                    <span className="meta-count">{session.id === activeAiSessionId ? "Active" : "Open"}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="ai-chat-history">
              {aiSessionTaskRuns.map((task) => (
                <article key={task.id} className="ai-thread-entry">
                  <div className="ai-message ai-message-user">
                    <div className="ai-message-meta">
                      <strong>You</strong>
                      {task.input_prompt ? <span className="meta-count">Question</span> : null}
                    </div>
                    <p>{task.input_prompt ?? taskLabel(task.kind)}</p>
                  </div>
                  <div className="ai-message ai-message-assistant">
                    <div className="ai-message-meta">
                      <strong>{taskLabel(task.kind)}</strong>
                      {!isQuickActionKind(task.kind) ? <span className="meta-count">{assistantStatusLabel(task.status)}</span> : null}
                    </div>
                    <MarkdownMessage markdown={task.output_markdown} />
                  </div>
                </article>
              ))}

              {aiPending ? (
                <article className="ai-thread-entry">
                  <div className="ai-message ai-message-user">
                    <div className="ai-message-meta">
                      <strong>You</strong>
                      {aiPending.inputPrompt ? <span className="meta-count">Question</span> : null}
                    </div>
                    <p>{aiPending.inputPrompt ?? taskLabel(aiPending.kind)}</p>
                  </div>
                  <div className="ai-message ai-message-assistant">
                    <div className="ai-message-meta">
                      <strong>{taskLabel(aiPending.kind)}</strong>
                      {!isQuickActionKind(aiPending.kind) ? <span className="meta-count">{assistantStatusLabel(aiPending.status)}</span> : null}
                    </div>
                    {aiPending.error ? <p className="ai-error-text">{aiPending.error}</p> : null}
                    {aiPending.markdown ? <MarkdownMessage markdown={aiPending.markdown} /> : <p>Thinking…</p>}
                  </div>
                </article>
              ) : null}
            </div>

            <div className="ai-bottom-dock">
              <div className="ai-quick-actions" aria-label="AI quick actions">
                {sessionActions.map((action) => (
                  <button
                    key={action.kind}
                    className="ghost-button ai-quick-action"
                    disabled={areQuickActionsDisabled || (action.kind === "session.compare" ? !compareEnabled : !aiPanelCanSend)}
                    type="button"
                    onClick={() => void handleQuickAction(action.kind)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>

              <div className="ai-composer">
                <div className="ai-composer-header">
                  <div className="ai-reference-chip-list" aria-label="Active AI references">
                    {aiSessionReferences.map((reference) => {
                      const referenceLabel = sessionReferenceLabel(reference, libraryItems, collections);
                      return (
                      <span key={reference.id} className="annotation-chip ai-reference-chip" title={referenceLabel}>
                        <span className="ai-reference-chip-label">
                          {referenceLabel}
                        </span>
                        <button
                          aria-label={`Remove ${referenceLabel}`}
                          className="ai-reference-chip-remove"
                          type="button"
                          onClick={() => void handleRemoveAiReference(reference.id)}
                        >
                          ×
                        </button>
                      </span>
                    );
                    })}
                  </div>
                  <div className="ai-reference-picker-shell">
                    <button
                      ref={aiReferenceButtonRef}
                      aria-label="Add AI reference"
                      className="icon-button icon-button-small"
                      type="button"
                      onClick={toggleAiReferencePicker}
                    >
                      <NewSessionIcon />
                    </button>
                    {isReferencePickerOpen ? (
                      <div
                        ref={aiReferencePopoverRef}
                        className="ai-reference-popover"
                        role="dialog"
                        aria-label="Add AI reference"
                      >
                        <label className="ai-reference-search-label" htmlFor="ai-reference-search">
                          Search context
                        </label>
                        <input
                          id="ai-reference-search"
                          ref={aiReferenceSearchInputRef}
                          aria-label="Search context"
                          className="search-input ai-reference-search-input"
                          placeholder="Search papers and collections"
                          type="search"
                          value={aiReferenceQuery}
                          onChange={(event) => setAiReferenceQuery(event.target.value)}
                        />
                        <div className="ai-reference-results" aria-live="polite">
                          {aiReferencePickerResults.map((result) => {
                            const added =
                              result.kind === "item"
                                ? aiReferenceItemIds.has(result.targetId)
                                : aiReferenceCollectionIds.has(result.targetId);
                            const badges = added ? [...result.badges, "Added"] : result.badges;
                            const accessibleLabel = pickerResultLabel(result, badges);
                            return (
                              <button
                                key={result.key}
                                aria-label={accessibleLabel}
                                className="ai-reference-result"
                                disabled={added}
                                title={accessibleLabel}
                                type="button"
                                onClick={() => void handleAddAiReference(result.kind, result.targetId)}
                              >
                                <span className="ai-reference-result-main">
                                  <span className="ai-reference-result-label">{result.label}</span>
                                  {result.meta ? <span className="ai-reference-result-meta">{result.meta}</span> : null}
                                </span>
                                <span className="ai-reference-result-badges">
                                  {badges.map((badge) => (
                                    <span
                                      key={`${result.key}-${badge}`}
                                      className={`meta-count ai-reference-result-badge ${
                                        badge === "Added" ? "ai-reference-result-badge-added" : ""
                                      }`}
                                    >
                                      {badge}
                                    </span>
                                  ))}
                                </span>
                              </button>
                            );
                          })}
                          {aiReferenceSearchLoading ? <p className="ai-reference-results-empty">Searching…</p> : null}
                          {aiReferenceSearchError ? <p className="ai-error-text">{aiReferenceSearchError}</p> : null}
                          {!aiReferenceSearchLoading &&
                          !aiReferenceSearchError &&
                          aiReferencePickerResults.length === 0 ? (
                            <p className="ai-reference-results-empty">
                              {aiReferenceQuery.trim().length === 0
                                ? "No papers or collections available."
                                : "No matching context found."}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
                <textarea
                  aria-label="AI prompt"
                  className="note-editor ai-composer-input"
                  disabled={!aiPanelCanSend}
                  placeholder="Ask about the current references..."
                  rows={4}
                  value={aiComposerValue}
                  onChange={(event) => setAiComposerValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void handleAiSubmit();
                    }
                  }}
                />
                <button
                  aria-label="Send AI prompt"
                  className="primary-button"
                  disabled={!aiPanelCanSend || aiComposerValue.trim().length === 0}
                  type="button"
                  onClick={() => void handleAiSubmit()}
                >
                  Send
                </button>
              </div>
            </div>
          </aside>
        </>
      ) : null}

      {deleteTarget ? (
        <div className="modal-scrim" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-label="Confirm delete">
            <div>
              <p className="eyebrow">Delete</p>
              <h2>{deleteTarget.label}</h2>
            </div>
            <p>
              {deleteTarget.kind === "item"
                ? "This removes the paper from the library and clears any matching AI references."
                : `This removes ${deleteTarget.paperCount ?? 0} paper${deleteTarget.paperCount === 1 ? "" : "s"} and ${deleteTarget.nestedCollectionCount ?? 0} nested collection${deleteTarget.nestedCollectionCount === 1 ? "" : "s"}, then clears matching AI references and related notes.`}
            </p>
          <div className="settings-dialog-actions">
              <button className="ghost-button" type="button" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={() => void handleConfirmDelete()}>
                Delete
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div className="modal-scrim" role="presentation">
          <section className="settings-dialog" role="dialog" aria-label="Settings">
            <div className="panel-header panel-header-row">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>General</h2>
              </div>
              <button className="ghost-button" type="button" onClick={closeSettingsDialog}>
                Cancel
              </button>
            </div>

            <div className="settings-sections">
              <div className="settings-provider-card">
                <p className="eyebrow">General</p>
                <label className="settings-field">
                  <span>Resources sidebar</span>
                  <select
                    aria-label="Resources sidebar default"
                    className="mode-select"
                    value={generalSettingsDraft.resourcesSidebarOpen ? "open" : "closed"}
                    onChange={(event) =>
                      setGeneralSettingsDraft((current) => ({
                        ...current,
                        resourcesSidebarOpen: event.target.value === "open",
                      }))
                    }
                  >
                    <option value="open">Open by default</option>
                    <option value="closed">Closed by default</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>Default paper sort</span>
                  <select
                    aria-label="Default paper sort"
                    className="mode-select"
                    value={generalSettingsDraft.defaultItemSort}
                    onChange={(event) =>
                      setGeneralSettingsDraft((current) => ({
                        ...current,
                        defaultItemSort: event.target.value as ItemSort,
                      }))
                    }
                  >
                    <option value="recent">Recently added</option>
                    <option value="title">Title</option>
                    <option value="year_desc">Year</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>Default attachment filter</span>
                  <select
                    aria-label="Default attachment filter"
                    className="mode-select"
                    value={generalSettingsDraft.defaultAttachmentFilter}
                    onChange={(event) =>
                      setGeneralSettingsDraft((current) => ({
                        ...current,
                        defaultAttachmentFilter: event.target.value as AttachmentFilter,
                      }))
                    }
                  >
                    <option value="all">All attachments</option>
                    <option value="ready">Ready</option>
                    <option value="missing">Missing</option>
                    <option value="citation_only">Citation only</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>PDF default fit mode</span>
                  <select
                    aria-label="PDF default fit mode"
                    className="mode-select"
                    value={generalSettingsDraft.defaultReaderFitMode}
                    onChange={(event) =>
                      setGeneralSettingsDraft((current) => ({
                        ...current,
                        defaultReaderFitMode: event.target.value as ReaderFitMode,
                      }))
                    }
                  >
                    <option value="fit_width">Fit width</option>
                    <option value="manual">Manual zoom</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>PDF default zoom</span>
                  <input
                    aria-label="PDF default zoom"
                    type="number"
                    min={READER_MIN_ZOOM}
                    max={READER_MAX_ZOOM}
                    value={generalSettingsDraft.defaultReaderZoom}
                    onChange={(event) =>
                      setGeneralSettingsDraft((current) => ({
                        ...current,
                        defaultReaderZoom: clampReaderZoom(Number(event.target.value) || DEFAULT_READER_ZOOM),
                      }))
                    }
                  />
                </label>
                <div className="settings-provider-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
                      setAiPanelWidth(DEFAULT_AI_PANEL_WIDTH);
                    }}
                  >
                    Reset layout widths
                  </button>
                </div>
              </div>

              <div className="settings-provider-card">
                <p className="eyebrow">AI Providers</p>
                <div className="settings-provider-tabs" role="tablist" aria-label="Active AI provider">
                  {(["openai", "anthropic"] as const).map((provider) => (
                    <button
                      key={provider}
                      aria-selected={aiSettingsDraft.active_provider === provider}
                      className={`reader-tab ${aiSettingsDraft.active_provider === provider ? "reader-tab-active" : ""}`}
                      role="tab"
                      type="button"
                      onClick={() => setAiSettingsDraft((current) => ({ ...current, active_provider: provider }))}
                    >
                      {provider === "openai" ? "OpenAI" : "Anthropic"}
                    </button>
                  ))}
                </div>

                <div className="settings-provider-grid">
                  <div className="settings-provider-card settings-provider-card-nested">
                    <p className="eyebrow">OpenAI</p>
                    <label className="settings-field">
                      <span>Model</span>
                      <input
                        aria-label="OpenAI model"
                        value={aiSettingsDraft.openai_model}
                        onChange={(event) =>
                          setAiSettingsDraft((current) => ({ ...current, openai_model: event.target.value }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Base URL</span>
                      <input
                        aria-label="OpenAI base URL"
                        placeholder="https://api.openai.com/v1"
                        value={aiSettingsDraft.openai_base_url}
                        onChange={(event) =>
                          setAiSettingsDraft((current) => ({ ...current, openai_base_url: event.target.value }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>API key</span>
                      <input
                        aria-label="OpenAI API key"
                        type="password"
                        value={openAiApiKeyDraft}
                        placeholder={aiSettings?.has_openai_api_key ? "Replace saved key" : "Paste API key"}
                        onChange={(event) => setOpenAiApiKeyDraft(event.target.value)}
                      />
                    </label>
                    <div className="settings-provider-actions">
                      <span className="meta-count">{aiSettings?.has_openai_api_key ? "Saved key" : "No saved key"}</span>
                      <button className="ghost-button" type="button" onClick={() => void handleClearSavedKey("openai")}>
                        Clear saved key
                      </button>
                    </div>
                  </div>

                  <div className="settings-provider-card settings-provider-card-nested">
                    <p className="eyebrow">Anthropic</p>
                    <label className="settings-field">
                      <span>Model</span>
                      <input
                        aria-label="Anthropic model"
                        value={aiSettingsDraft.anthropic_model}
                        onChange={(event) =>
                          setAiSettingsDraft((current) => ({ ...current, anthropic_model: event.target.value }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Base URL</span>
                      <input
                        aria-label="Anthropic base URL"
                        placeholder="https://api.anthropic.com/v1"
                        value={aiSettingsDraft.anthropic_base_url}
                        onChange={(event) =>
                          setAiSettingsDraft((current) => ({ ...current, anthropic_base_url: event.target.value }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>API key</span>
                      <input
                        aria-label="Anthropic API key"
                        type="password"
                        value={anthropicApiKeyDraft}
                        placeholder={aiSettings?.has_anthropic_api_key ? "Replace saved key" : "Paste API key"}
                        onChange={(event) => setAnthropicApiKeyDraft(event.target.value)}
                      />
                    </label>
                    <div className="settings-provider-actions">
                      <span className="meta-count">
                        {aiSettings?.has_anthropic_api_key ? "Saved key" : "No saved key"}
                      </span>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => void handleClearSavedKey("anthropic")}
                      >
                        Clear saved key
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-dialog-actions">
              <button className="ghost-button" type="button" onClick={closeSettingsDialog}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={() => void handleSaveAiSettings()}>
                Save
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
