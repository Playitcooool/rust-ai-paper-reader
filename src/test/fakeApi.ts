import type {
  AIArtifact,
  AIRunSessionTaskInput,
  AIProvider,
  AISession,
  AISessionReference,
  AISessionReferenceKind,
  AISettings,
  AITaskStreamEvent,
  Annotation,
  AttachmentFormat,
  AppApi,
  AITask,
  CitationFormat,
  Collection,
  ImportBatchResult,
  LibraryItem,
  OcrPageResult,
  OcrPdfPageInput,
  PdfDocumentInfo,
  PdfEngineGetDocumentInfoInput,
  PdfEngineGetPageBundleInput,
  PdfEngineGetPageTextInput,
  PdfPageBundle,
  PdfPageText,
  ReaderView,
  ResearchNote,
  Tag,
  UpdateAISettingsInput,
} from "../lib/contracts";

type MockItemDetails = LibraryItem & {
  plainText: string;
  normalizedHtml: string;
  attachmentFormat?: AttachmentFormat;
  primaryAttachmentPath?: string | null;
  pageCount?: number | null;
  contentStatus?: ReaderView["content_status"];
  contentNotice?: string | null;
};

type MockState = {
  collections: Collection[];
  items: MockItemDetails[];
  tags: Tag[];
  itemTags: Array<{ item_id: number; tag_id: number }>;
  annotations: Annotation[];
  tasks: AITask[];
  artifacts: AIArtifact[];
  notes: ResearchNote[];
  sessions: AISession[];
  sessionReferences: AISessionReference[];
  aiSettings: AISettings & {
    openai_api_key: string;
    anthropic_api_key: string;
  };
  nextId: number;
  importFileResults?: ImportBatchResult | null;
  importCitationResults?: ImportBatchResult | null;
  nextAiStreamFailure?: string | null;
  sessionTaskDelayMs?: number;
};

const exportWrites: Array<{ path: string; authorization_token: string; contents: string }> = [];

const richItemSummary = (title: string, collectionLabel: string, firstLine: string) =>
  `# Summary: ${title}\n\nCollection: ${collectionLabel}\n\n## Key Points\n- ${firstLine}\n- Compute and data should stay balanced.\n\n> The paper argues for predictable scaling trends.\n\n| Axis | Signal |\n| --- | --- |\n| Model | Larger models improve smoothly |\n| Data | More tokens reduce loss |\n\n\`\`\`text\nloss ~= f(model, data, compute)\n\`\`\`\n`;

const initialState = (): MockState => ({
  collections: [
    { id: 1, name: "Machine Learning", parent_id: null },
    { id: 2, name: "Systems", parent_id: null },
  ],
  items: [
    {
      id: 1,
      title: "Transformer Scaling Laws",
      collection_id: 1,
      primary_attachment_id: 101,
      attachment_format: "pdf",
      attachment_status: "ready",
      authors: "Kaplan et al.",
      publication_year: 2020,
      source: "OpenAI",
      doi: "10.1000/scaling-laws",
      tags: [],
      plainText:
        "Overview. Scaling behavior emerges when model size, data volume, and compute are balanced. Methods. This paper discusses predictable loss curves and practical planning heuristics.",
      normalizedHtml:
        "<article><h1>Transformer Scaling Laws</h1><p>Scaling behavior emerges when model size, data volume, and compute are balanced.</p><h2>Methods</h2><p>This paper discusses predictable loss curves and practical planning heuristics.</p></article>",
      attachmentFormat: "pdf",
      primaryAttachmentPath: "/mock/transformer-scaling-laws.pdf",
      pageCount: 2,
    },
    {
      id: 2,
      title: "Graph Neural Survey",
      collection_id: 1,
      primary_attachment_id: 102,
      attachment_format: "docx",
      attachment_status: "ready",
      authors: "Wu et al.",
      publication_year: 2021,
      source: "IEEE TPAMI",
      doi: "10.1000/gnn-survey",
      tags: [],
      plainText:
        "Graph representation learning unifies message passing, pooling, and graph-level reasoning into a broad survey of architectures and benchmarks.",
      normalizedHtml:
        "<article><h1>Graph Neural Survey</h1><p>Graph representation learning unifies message passing, pooling, and graph-level reasoning into a broad survey of architectures and benchmarks.</p></article>",
      attachmentFormat: "docx",
      primaryAttachmentPath: "/mock/graph-neural-survey.docx",
      pageCount: 1,
    },
    {
      id: 3,
      title: "Distributed Consensus Notes",
      collection_id: 2,
      primary_attachment_id: 103,
      attachment_format: "epub",
      attachment_status: "missing",
      authors: "Ongaro & Ousterhout",
      publication_year: 2014,
      source: "USENIX",
      doi: "10.1000/raft",
      tags: [],
      plainText:
        "Consensus protocols coordinate replicas under partial failure. This note contrasts Paxos, Raft, and production trade-offs around operator ergonomics.",
      normalizedHtml:
        "<article><h1>Distributed Consensus Notes</h1><p>Consensus protocols coordinate replicas under partial failure.</p><p>This note contrasts Paxos, Raft, and production trade-offs around operator ergonomics.</p></article>",
      attachmentFormat: "epub",
      primaryAttachmentPath: "/mock/distributed-consensus-notes.epub",
      pageCount: 2,
    },
  ],
  tags: [
    { id: 10, name: "Scaling", item_count: 1 },
    { id: 11, name: "Survey", item_count: 1 },
    { id: 12, name: "Distributed", item_count: 1 },
  ],
  itemTags: [
    { item_id: 1, tag_id: 10 },
    { item_id: 2, tag_id: 11 },
    { item_id: 3, tag_id: 12 },
  ],
  annotations: [
    {
      id: 500,
      item_id: 1,
      anchor: "section-1",
      kind: "highlight",
      body: "This scaling rule is the key takeaway.",
    },
  ],
  tasks: [
    {
      id: 700,
      item_id: 1,
      collection_id: 1,
      session_id: null,
      scope_item_ids: null,
      input_prompt: null,
      kind: "item.summarize",
      status: "succeeded",
      output_markdown: richItemSummary(
        "Transformer Scaling Laws",
        "Machine Learning",
        "Scaling behavior emerges when model size, data volume, and compute are balanced",
      ),
    },
  ],
  artifacts: [
    {
      id: 800,
      task_id: 700,
      item_id: 1,
      collection_id: 1,
      session_id: null,
      scope_item_ids: null,
      kind: "item.summarize",
      markdown: richItemSummary(
        "Transformer Scaling Laws",
        "Machine Learning",
        "Scaling behavior emerges when model size, data volume, and compute are balanced",
      ),
    },
  ],
  notes: [
    {
      id: 900,
      collection_id: 1,
      session_id: null,
      title: "Machine Learning Review",
      markdown:
        "# Machine Learning Review\n\n## Evidence Map\n- Transformer Scaling Laws\n- Graph Neural Survey",
    },
  ],
  sessions: [
    {
      id: 910,
      title: "Transformer Scaling Laws",
      created_at: "2026-04-30 09:00:00",
      updated_at: "2026-04-30 09:00:00",
    },
  ],
  sessionReferences: [
    { id: 911, session_id: 910, kind: "item", target_id: 1, sort_index: 0 },
  ],
  aiSettings: {
    active_provider: "openai",
    openai_model: "gpt-4.1-mini",
    openai_base_url: "",
    has_openai_api_key: true,
    openai_api_key: "openai-secret",
    anthropic_model: "claude-3-5-sonnet-latest",
    anthropic_base_url: "",
    has_anthropic_api_key: false,
    anthropic_api_key: "",
  },
  nextId: 1000,
  importFileResults: null,
  importCitationResults: null,
  nextAiStreamFailure: null,
  sessionTaskDelayMs: 120,
});

const aiStreamListeners = new Set<(event: AITaskStreamEvent) => void>();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const emitAiTaskStream = (event: AITaskStreamEvent) => {
  for (const listener of aiStreamListeners) {
    listener(event);
  }
};

const chunkMarkdown = (markdown: string) => {
  const normalized = markdown.trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).flatMap((paragraph) => {
    if (paragraph.length <= 140) return [paragraph];
    const pieces: string[] = [];
    for (let start = 0; start < paragraph.length; start += 140) {
      pieces.push(paragraph.slice(start, start + 140));
    }
    return pieces;
  });
  return paragraphs.map((part, index) => (index < paragraphs.length - 1 ? `${part}\n\n` : part));
};

const runStream = async (
  chunks: string[],
  emit: (chunk: string) => void,
) => {
  for (const chunk of chunks) {
    emit(chunk);
    await delay(0);
  }
};

let state = initialState();

const collectionName = (collectionId: number) =>
  state.collections.find((collection) => collection.id === collectionId)?.name ?? "Unknown";

const noteTitle = (collectionId: number) => `${collectionName(collectionId)} Review`;

const touchSession = (sessionId: number, title?: string) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) return;
  if (title) session.title = title;
  session.updated_at = "2026-04-30 09:30:00";
};

const normalizeSessionReferenceSortIndexes = (sessionId: number) => {
  state.sessionReferences
    .filter((reference) => reference.session_id === sessionId)
    .sort((left, right) => left.sort_index - right.sort_index)
    .forEach((reference, index) => {
      reference.sort_index = index;
    });
};

const removeSessionReferencesMatching = (kind: AISessionReferenceKind, targetId: number) => {
  const affectedSessionIds = Array.from(
    new Set(
      state.sessionReferences
        .filter((reference) => reference.kind === kind && reference.target_id === targetId)
        .map((reference) => reference.session_id),
    ),
  );
  if (affectedSessionIds.length === 0) return;
  state.sessionReferences = state.sessionReferences.filter(
    (reference) => !(reference.kind === kind && reference.target_id === targetId),
  );
  for (const sessionId of affectedSessionIds) {
    normalizeSessionReferenceSortIndexes(sessionId);
    touchSession(sessionId);
  }
};

const removeSessionReferencesMatchingAny = (kind: AISessionReferenceKind, targetIds: number[]) => {
  const targetIdSet = new Set(targetIds);
  const affectedSessionIds = Array.from(
    new Set(
      state.sessionReferences
        .filter((reference) => reference.kind === kind && targetIdSet.has(reference.target_id))
        .map((reference) => reference.session_id),
    ),
  );
  if (affectedSessionIds.length === 0) return;
  state.sessionReferences = state.sessionReferences.filter(
    (reference) => !(reference.kind === kind && targetIdSet.has(reference.target_id)),
  );
  for (const sessionId of affectedSessionIds) {
    normalizeSessionReferenceSortIndexes(sessionId);
    touchSession(sessionId);
  }
};

const childCollectionIds = (collectionId: number): number[] => {
  const orderedChildren = state.collections
    .filter((collection) => collection.parent_id === collectionId)
    .sort((left, right) => left.name.localeCompare(right.name));
  return orderedChildren.flatMap((collection) => [collection.id, ...childCollectionIds(collection.id)]);
};

const expandSessionReferenceItemIds = (references: AISessionReference[]) => {
  const seen = new Set<number>();
  const itemIds: number[] = [];

  for (const reference of references.filter((entry) => entry.kind === "item")) {
    const item = state.items.find((entry) => entry.id === reference.target_id);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    itemIds.push(item.id);
  }

  for (const reference of references.filter((entry) => entry.kind === "collection")) {
    const collectionIds = [reference.target_id, ...childCollectionIds(reference.target_id)];
    for (const collectionId of collectionIds) {
      const collectionItemIds = state.items
        .filter((item) => item.collection_id === collectionId)
        .sort((left, right) => right.id - left.id)
        .map((item) => item.id);
      for (const itemId of collectionItemIds) {
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        itemIds.push(itemId);
      }
    }
  }

  return itemIds;
};

const importSeedPaths = [
  "/imports/fresh-import-paper.pdf",
  "/imports/method-bench.epub",
];

const citationSeedPaths = [
  "/imports/attention-is-all-you-need.bib",
  "/imports/retrieval-augmented-generation.ris",
];

const titleFromPath = (path: string) =>
  path
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "")
    .split(/[-_]/)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ") ?? "Imported Paper";

const normalizedHtmlFromTitle = (title: string) =>
  `<article><h1>${title}</h1><p>Imported (managed copy).</p><p>This mock document is ready for reading, annotation, and AI analysis.</p></article>`;

const metadataFromTitle = (title: string) => {
  const normalized = title.toLowerCase();
  if (normalized === "transformer scaling laws") {
    return {
      authors: "Kaplan et al.",
      publication_year: 2020,
      source: "OpenAI",
      doi: "10.1000/scaling-laws",
    };
  }
  if (normalized === "graph neural survey") {
    return {
      authors: "Wu et al.",
      publication_year: 2021,
      source: "IEEE TPAMI",
      doi: "10.1000/gnn-survey",
    };
  }
  if (normalized === "distributed consensus notes") {
    return {
      authors: "Ongaro & Ousterhout",
      publication_year: 2014,
      source: "USENIX",
      doi: "10.1000/raft",
    };
  }
  return {
    authors: "Imported Author",
    publication_year: 2026,
    source: "Paper Reader Library",
    doi: null,
  };
};

const tagsForItem = (itemId: number) =>
  state.itemTags
    .filter((entry) => entry.item_id === itemId)
    .map((entry) => state.tags.find((tag) => tag.id === entry.tag_id)?.name)
    .filter((name): name is string => Boolean(name));

const buildTagView = (collectionId?: number) =>
  state.tags
    .map((tag) => {
      const itemIds = state.itemTags
        .filter((entry) => entry.tag_id === tag.id)
        .map((entry) => entry.item_id);
      const itemCount = itemIds.filter((itemId) => {
        if (collectionId === undefined) return true;
        return state.items.find((item) => item.id === itemId)?.collection_id === collectionId;
      }).length;
      return {
        id: tag.id,
        name: tag.name,
        item_count: itemCount,
      } satisfies Tag;
    })
    .filter((tag) => tag.item_count > 0 || collectionId === undefined)
    .sort((left, right) => left.name.localeCompare(right.name));

const buildLibraryItem = (item: MockItemDetails): LibraryItem => ({
  id: item.id,
  title: item.title,
  collection_id: item.collection_id,
  primary_attachment_id: item.primary_attachment_id,
  attachment_format: item.attachmentFormat ?? item.attachment_format ?? "unknown",
  attachment_status: item.attachment_status,
  authors: item.authors,
  publication_year: item.publication_year,
  source: item.source,
  doi: item.doi,
  tags: tagsForItem(item.id),
});

const extractHeading = (markdown: string) =>
  markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"))
    ?.replace(/^#+\s*/, "")
    .trim();

const noteTitleFromArtifact = (collectionId: number, markdown: string) =>
  extractHeading(markdown) || `${collectionName(collectionId)} Note`;

const publicAiSettings = (): AISettings => ({
  active_provider: state.aiSettings.active_provider,
  openai_model: state.aiSettings.openai_model,
  openai_base_url: state.aiSettings.openai_base_url,
  has_openai_api_key: Boolean(state.aiSettings.openai_api_key),
  anthropic_model: state.aiSettings.anthropic_model,
  anthropic_base_url: state.aiSettings.anthropic_base_url,
  has_anthropic_api_key: Boolean(state.aiSettings.anthropic_api_key),
});

const collectionTaskOutput = (collectionId: number, kind: string, scopeItemIds: number[]) => {
  const items = scopeItemIds
    .map((itemId) => state.items.find((item) => item.id === itemId && item.collection_id === collectionId))
    .filter((item): item is MockItemDetails => Boolean(item));
  const evidenceMap = items
    .map((item) => `- **${item.title}**: ${item.plainText.split(".").shift()?.trim() ?? item.title}`)
    .join("\n");

  switch (kind) {
    case "collection.bulk_summarize":
      return `# Bulk Summary: ${collectionName(collectionId)}\n\n## Paper Capsules\n${evidenceMap}\n\n> Working set spans ${items.length} visible papers.\n\n| Lens | Takeaway |\n| --- | --- |\n| Breadth | Cross-paper synthesis |\n| Depth | Quick evidence capsules |`;
    case "collection.theme_map":
      return `# Theme Map: ${collectionName(collectionId)}\n\n## Themes\n${evidenceMap}\n\n## Theme Clusters\nTheme clusters across ${items.length} visible papers.`;
    case "collection.compare_methods":
      return `# Method Comparison: ${collectionName(collectionId)}\n\n## Comparison Matrix\n${evidenceMap}\n\n## Method Notes\nMethod comparison across ${items.length} visible papers.`;
    case "collection.ask":
      return `# Collection Q&A: ${collectionName(collectionId)}\n\n## Answer\n${items[0]?.plainText.split(".").shift()?.trim() ?? "No readable evidence was available."}\n\n## Scope\n${items.length} papers in the current collection view.`;
    case "collection.review_draft":
    default:
      return `# Review Draft: ${collectionName(collectionId)}\n\n## Evidence Map\n${evidenceMap}\n\n## Narrative\nThis draft groups the imported papers into a concise literature review scaffold ready for editing.`;
  }
};

const itemTaskOutput = (item: MockItemDetails, kind: string, prompt?: string) => {
  const firstLine = item.plainText.split(".").shift()?.trim() ?? item.title;

  switch (kind) {
    case "item.summarize":
      return richItemSummary(item.title, collectionName(item.collection_id), firstLine);
    case "item.translate":
      return `# Translation: ${item.title}\n\n## Translated Passage\n${firstLine}\n\n## Notes\nTranslated from the active reader selection.`;
    case "item.explain_term":
      return `# Terminology Notes: ${item.title}\n\n## Key Terms\n- Scaling law: ${firstLine}\n\n## Reading Tip\nUse this note to clarify repeated technical vocabulary.`;
    case "item.ask":
      return `# Reading Q&A: ${item.title}\n\n## Question\n${prompt?.trim() || "No question provided."}\n\n## Answer\n${firstLine}\n\n## Evidence\nCollection: ${collectionName(item.collection_id)}`;
    default:
      return `# Summary: ${item.title}\n\nCollection: ${collectionName(item.collection_id)}\n\n${firstLine}`;
  }
};

const sessionTaskOutput = (input: AIRunSessionTaskInput, references: AISessionReference[]) => {
  const scopeItemIds = expandSessionReferenceItemIds(references);
  const items = scopeItemIds
    .map((itemId) => state.items.find((item) => item.id === itemId))
    .filter((item): item is MockItemDetails => Boolean(item));
  const singleDirectItem =
    items.length === 1 &&
    references.some((entry) => entry.kind === "item") &&
    !references.some((entry) => entry.kind === "collection");
  const firstItem = items[0];
  const firstLine = firstItem?.plainText.split(".").shift()?.trim() ?? "No readable evidence was available.";
  const evidenceMap = items
    .map((item) => `- **${item.title}**: ${item.plainText.split(".").shift()?.trim() ?? item.title}`)
    .join("\n");

  switch (input.kind) {
    case "session.summarize":
      return singleDirectItem && firstItem
        ? richItemSummary(firstItem.title, collectionName(firstItem.collection_id), firstLine)
        : `# Summary Set\n\n## Paper Capsules\n${evidenceMap}\n\n## Synthesis\nThe session spans ${items.length} papers.`;
    case "session.explain_terms":
      return singleDirectItem && firstItem
        ? `# Terminology Notes: ${firstItem.title}\n\n## Key Terms\n- Scaling law: ${firstLine}\n\n## Reading Tip\nUse this note to clarify repeated technical vocabulary.`
        : `# Terminology Notes\n\n## Terms\n- Scaling law: ${firstLine}\n\n## Cross-Paper Usage\nTerms recur across ${items.length} papers.`;
    case "session.theme_map":
      return `# Theme Map\n\n## Themes\n${evidenceMap}\n\n## Theme Clusters\nTheme clusters across ${items.length} referenced papers.`;
    case "session.compare":
      return `# Comparison\n\n## Comparison Matrix\n${evidenceMap}\n\n## Method Notes\nComparison across ${items.length} unique papers.`;
    case "session.review_draft":
      return `# Review Draft\n\n## Evidence Map\n${evidenceMap}\n\n## Narrative\nThis draft groups the session evidence into a concise review scaffold.`;
    case "session.ask":
    default:
      return singleDirectItem && firstItem
        ? `# Reading Q&A: ${firstItem.title}\n\n## Question\n${input.prompt?.trim() || "No question provided."}\n\n## Answer\n${firstLine}\n\n## Evidence\nCollection: ${collectionName(firstItem.collection_id)}`
        : `# Reading Q&A\n\n## Question\n${input.prompt?.trim() || "No question provided."}\n\n## Answer\n${firstLine}\n\n## Scope\n${items.length} papers in the session.`;
  }
};

export function resetFakeApi() {
  state = initialState();
  exportWrites.length = 0;
  aiStreamListeners.clear();
}

export function replaceFakeApiState(nextState: Partial<MockState>) {
  state = {
    ...initialState(),
    ...nextState,
  };
  exportWrites.length = 0;
}

export function failNextFakeAiStream(message = "Mock AI stream failed.") {
  state.nextAiStreamFailure = message;
}

export const fakeApi: AppApi = {
  async listCollections() {
    return [...state.collections];
  },

  async createCollection(input) {
    const collection = {
      id: state.nextId++,
      name: input.name,
      parent_id: input.parent_id ?? null,
    };
    state.collections.push(collection);
    return collection;
  },

  async moveCollection(input) {
    if (input.parent_id === input.collection_id) {
      throw new Error("A collection cannot be moved into itself.");
    }

    const descendants = new Set<number>();
    const stack = [input.collection_id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      for (const collection of state.collections) {
        if (collection.parent_id === current && !descendants.has(collection.id)) {
          descendants.add(collection.id);
          stack.push(collection.id);
        }
      }
    }

    if (input.parent_id != null && descendants.has(input.parent_id)) {
      throw new Error("A collection cannot be moved into one of its descendants.");
    }

    const collection = state.collections.find((entry) => entry.id === input.collection_id);
    if (!collection) {
      throw new Error(`Unknown collection ${input.collection_id}`);
    }
    collection.parent_id = input.parent_id ?? null;
  },

  async renameCollection(input) {
    const collection = state.collections.find((entry) => entry.id === input.collection_id);
    if (!collection) {
      throw new Error(`Unknown collection ${input.collection_id}`);
    }
    collection.name = input.name;
  },

  async removeCollection(input) {
    const collection = state.collections.find((entry) => entry.id === input.collection_id);
    if (!collection) {
      throw new Error(`Unknown collection ${input.collection_id}`);
    }
    const deletedCollectionIds = [input.collection_id, ...childCollectionIds(input.collection_id)];
    const deletedCollectionIdSet = new Set(deletedCollectionIds);
    const deletedItemIds = state.items
      .filter((item) => deletedCollectionIdSet.has(item.collection_id))
      .map((item) => item.id);
    const deletedItemIdSet = new Set(deletedItemIds);
    const deletedTaskIds = state.tasks
      .filter(
        (task) =>
          (task.item_id !== null && deletedItemIdSet.has(task.item_id)) ||
          (task.collection_id !== null && deletedCollectionIdSet.has(task.collection_id)),
      )
      .map((task) => task.id);
    const deletedTaskIdSet = new Set(deletedTaskIds);

    state.collections = state.collections.filter((entry) => !deletedCollectionIdSet.has(entry.id));
    state.items = state.items.filter((entry) => !deletedItemIdSet.has(entry.id));
    state.itemTags = state.itemTags.filter((entry) => !deletedItemIdSet.has(entry.item_id));
    state.annotations = state.annotations.filter((entry) => !deletedItemIdSet.has(entry.item_id));
    removeSessionReferencesMatchingAny("collection", deletedCollectionIds);
    removeSessionReferencesMatchingAny("item", deletedItemIds);
    state.notes = state.notes.filter((note) => note.collection_id === null || !deletedCollectionIdSet.has(note.collection_id));
    state.tasks = state.tasks.filter((task) => !deletedTaskIdSet.has(task.id));
    state.artifacts = state.artifacts.filter(
      (artifact) =>
        !deletedTaskIdSet.has(artifact.task_id) &&
        (artifact.item_id === null || !deletedItemIdSet.has(artifact.item_id)) &&
        (artifact.collection_id === null || !deletedCollectionIdSet.has(artifact.collection_id)),
    );
  },

  async listTags(collectionId) {
    return buildTagView(collectionId);
  },

  async createTag(input) {
    const existing = state.tags.find((tag) => tag.name.toLowerCase() === input.name.toLowerCase());
    if (existing) {
      return {
        ...existing,
        item_count: buildTagView().find((tag) => tag.id === existing.id)?.item_count ?? 0,
      };
    }

    const tag = {
      id: state.nextId++,
      name: input.name,
      item_count: 0,
    } satisfies Tag;
    state.tags.push(tag);
    return tag;
  },

  async assignTag(input) {
    const alreadyAssigned = state.itemTags.some(
      (entry) => entry.item_id === input.item_id && entry.tag_id === input.tag_id,
    );
    if (!alreadyAssigned) {
      state.itemTags.push({ item_id: input.item_id, tag_id: input.tag_id });
    }
  },

  async pickImportPaths() {
    return [...importSeedPaths];
  },

  async pickCitationPaths() {
    return [...citationSeedPaths];
  },

  async requestExportPath(input) {
    return {
      path: `/exports/${input.defaultPath}`,
      authorization_token: "fake-export-token",
    };
  },

  async pickRelinkPath() {
    return "/relinked/distributed-consensus-notes.epub";
  },

  async refreshAttachmentStatuses() {
    state.items = state.items.map((item) => {
      if (
        item.attachment_status === "missing" &&
        item.primaryAttachmentPath &&
        item.primaryAttachmentPath.startsWith("/relinked/")
      ) {
        return { ...item, attachment_status: "ready" };
      }
      return item;
    });
  },

  async importFiles(input) {
    if (state.importFileResults) {
      for (const importedItem of state.importFileResults.imported) {
        const path =
          state.importFileResults.results.find((result) => result.item?.id === importedItem.id)?.path ??
          `${importedItem.title}.pdf`;
        const title = importedItem.title;
        const metadata = metadataFromTitle(title);
        state.items = state.items.filter((item) => item.id !== importedItem.id);
        state.items.unshift({
          id: importedItem.id,
          title,
          collection_id: input.collection_id,
          primary_attachment_id: importedItem.primary_attachment_id,
          attachment_format: path.toLowerCase().endsWith(".docx")
            ? "docx"
            : path.toLowerCase().endsWith(".epub")
              ? "epub"
              : "pdf",
          attachment_status: "ready",
          authors: metadata.authors,
          publication_year: metadata.publication_year,
          source: metadata.source,
          doi: metadata.doi,
          tags: [],
          plainText: `${title} was imported into ${collectionName(input.collection_id)} and normalized for AI-assisted reading.`,
          normalizedHtml: normalizedHtmlFromTitle(title),
          attachmentFormat: path.toLowerCase().endsWith(".docx")
            ? "docx"
            : path.toLowerCase().endsWith(".epub")
              ? "epub"
              : "pdf",
          primaryAttachmentPath: path,
          pageCount: 1,
          contentStatus: "ready",
          contentNotice: null,
        });
      }
      return state.importFileResults;
    }

    const imported = input.paths.map((path) => {
      const title = titleFromPath(path);
      const metadata = metadataFromTitle(title);
      const itemId = state.nextId++;
      const attachmentId = state.nextId++;
      state.items.unshift({
        id: itemId,
        title,
        collection_id: input.collection_id,
        primary_attachment_id: attachmentId,
        attachment_format: path.toLowerCase().endsWith(".docx")
          ? "docx"
          : path.toLowerCase().endsWith(".epub")
            ? "epub"
            : "pdf",
        attachment_status: "ready",
        authors: metadata.authors,
        publication_year: metadata.publication_year,
        source: metadata.source,
        doi: metadata.doi,
        tags: [],
        plainText: `${title} was imported into ${collectionName(input.collection_id)} and normalized for AI-assisted reading.`,
        normalizedHtml: normalizedHtmlFromTitle(title),
        attachmentFormat: path.toLowerCase().endsWith(".docx")
          ? "docx"
          : path.toLowerCase().endsWith(".epub")
            ? "epub"
            : "pdf",
        primaryAttachmentPath: path,
      });
      return {
        id: itemId,
        title,
        primary_attachment_id: attachmentId,
      };
    });
    const results: ImportBatchResult["results"] = imported.map((item, index) => ({
      path: input.paths[index] ?? "",
      status: "imported" as const,
      message: "Imported successfully.",
      item,
    }));
    return {
      imported,
      duplicates: [],
      failed: [],
      results,
    } satisfies ImportBatchResult;
  },

  async importCitations(input) {
    if (state.importCitationResults) {
      for (const importedItem of state.importCitationResults.imported) {
        const path =
          state.importCitationResults.results.find((result) => result.item?.id === importedItem.id)?.path ??
          `${importedItem.title}.bib`;
        const title = importedItem.title;
        const metadata = metadataFromTitle(title);
        state.items = state.items.filter((item) => item.id !== importedItem.id);
        state.items.unshift({
          id: importedItem.id,
          title,
          collection_id: input.collection_id,
          primary_attachment_id: importedItem.primary_attachment_id,
          attachment_format: "unknown",
          attachment_status: "citation_only",
          authors: metadata.authors,
          publication_year: metadata.publication_year,
          source: metadata.source,
          doi: metadata.doi,
          tags: [],
          plainText: `${title} was imported from a citation record and is ready for metadata-first triage.`,
          normalizedHtml: `<article><h1>${title}</h1><p>Citation-only import.</p><p>Add a source file later or use this entry for bibliography management.</p></article>`,
          attachmentFormat: "unknown",
          primaryAttachmentPath: path,
          pageCount: 1,
          contentStatus: "ready",
          contentNotice: null,
        });
      }
      return state.importCitationResults;
    }

    const imported = input.paths.map((path) => {
      const title = titleFromPath(path);
      const metadata = metadataFromTitle(title);
      const itemId = state.nextId++;
      const attachmentId = state.nextId++;
      state.items.unshift({
        id: itemId,
        title,
        collection_id: input.collection_id,
        primary_attachment_id: attachmentId,
        attachment_format: "unknown",
        attachment_status: "citation_only",
        authors: metadata.authors,
        publication_year: metadata.publication_year,
        source: metadata.source,
        doi: metadata.doi,
        tags: [],
        plainText: `${title} was imported from a citation record and is ready for metadata-first triage.`,
        normalizedHtml: `<article><h1>${title}</h1><p>Citation-only import.</p><p>Add a source file later or use this entry for bibliography management.</p></article>`,
        attachmentFormat: "unknown",
        primaryAttachmentPath: null,
      });
      return {
        id: itemId,
        title,
        primary_attachment_id: attachmentId,
      };
    });
    const results: ImportBatchResult["results"] = imported.map((item, index) => ({
      path: input.paths[index] ?? "",
      status: "imported" as const,
      message: "Citation imported successfully.",
      item,
    }));
    return {
      imported,
      duplicates: [],
      failed: [],
      results,
    } satisfies ImportBatchResult;
  },

  async relinkAttachment(input) {
    const item = state.items.find((entry) => entry.primary_attachment_id === input.attachment_id);
    if (!item) {
      throw new Error(`Unknown attachment ${input.attachment_id}`);
    }
    item.attachment_status = "ready";
    item.primaryAttachmentPath = input.replacement_path;
    item.attachmentFormat = input.replacement_path.toLowerCase().endsWith(".epub")
      ? "epub"
      : input.replacement_path.toLowerCase().endsWith(".docx")
        ? "docx"
        : input.replacement_path.toLowerCase().endsWith(".pdf")
          ? "pdf"
          : "unknown";
    item.attachment_format = item.attachmentFormat;
  },

  async updateItemMetadata(input) {
    const item = state.items.find((entry) => entry.id === input.item_id);
    if (!item) {
      throw new Error(`Unknown item ${input.item_id}`);
    }
    item.title = input.title;
    item.authors = input.authors;
    item.publication_year = input.publication_year;
    item.source = input.source;
    item.doi = input.doi;
  },

  async removeItem(input) {
    const item = state.items.find((entry) => entry.id === input.item_id);
    if (!item) {
      throw new Error(`Unknown item ${input.item_id}`);
    }

    state.items = state.items.filter((entry) => entry.id !== input.item_id);
    removeSessionReferencesMatching("item", input.item_id);
    state.itemTags = state.itemTags.filter((entry) => entry.item_id !== input.item_id);
    state.annotations = state.annotations.filter((entry) => entry.item_id !== input.item_id);

    const removedTaskIds = state.tasks
      .filter((task) => task.item_id === input.item_id)
      .map((task) => task.id);
    state.tasks = state.tasks.filter((task) => task.item_id !== input.item_id);
    state.artifacts = state.artifacts.filter(
      (artifact) =>
        artifact.item_id !== input.item_id && !removedTaskIds.includes(artifact.task_id),
    );
  },

  async moveItem(input) {
    const item = state.items.find((entry) => entry.id === input.item_id);
    if (!item) {
      throw new Error(`Unknown item ${input.item_id}`);
    }
    item.collection_id = input.collection_id;
    state.tasks = state.tasks.map((task) =>
      task.item_id === input.item_id ? { ...task, collection_id: input.collection_id } : task,
    );
    state.artifacts = state.artifacts.map((artifact) =>
      artifact.item_id === input.item_id
        ? { ...artifact, collection_id: input.collection_id }
        : artifact,
    );
  },

  async listItems(collectionId) {
    return state.items
      .filter((item) => (collectionId === undefined ? true : item.collection_id === collectionId))
      .map(buildLibraryItem);
  },

  async searchItems(query) {
    const lowered = query.trim().toLowerCase();
    return state.items
      .filter((item) => {
        if (item.title.toLowerCase().includes(lowered)) return true;
        if (item.authors.toLowerCase().includes(lowered)) return true;
        if (item.source.toLowerCase().includes(lowered)) return true;
        if (String(item.publication_year ?? "").includes(lowered)) return true;
        if ((item.doi ?? "").toLowerCase().includes(lowered)) return true;
        return tagsForItem(item.id).some((tag) => tag.toLowerCase().includes(lowered));
      })
      .map(buildLibraryItem);
  },

  async getReaderView(itemId) {
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error(`No reader view for item ${itemId}`);
    }
    const attachmentFormat = item.attachmentFormat ?? "unknown";
    return {
      item_id: item.id,
      title: item.title,
      reader_kind: attachmentFormat === "pdf" ? "pdf" : "normalized",
      attachment_format: attachmentFormat,
      primary_attachment_id: item.primary_attachment_id,
      primary_attachment_path: item.primaryAttachmentPath ?? null,
      page_count: item.pageCount ?? null,
      content_status: item.contentStatus ?? "ready",
      content_notice: item.contentNotice ?? null,
      normalized_html: item.normalizedHtml,
      plain_text: item.plainText,
    } satisfies ReaderView;
  },

  async readPrimaryAttachmentBytes(primaryAttachmentId) {
    const item = state.items.find((entry) => entry.primary_attachment_id === primaryAttachmentId);
    if (!item) {
      throw new Error("Primary attachment was not found.");
    }
    const attachmentFormat = item.attachmentFormat ?? item.attachment_format ?? "unknown";
    if (!item.primaryAttachmentPath) {
      throw new Error("Primary attachment file is missing.");
    }
    if (attachmentFormat !== "pdf") {
      throw new Error("Primary attachment is not a PDF.");
    }
    if (item.attachment_status === "missing") {
      throw new Error("Primary attachment file is missing.");
    }
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  },

  async listAnnotations(itemId) {
    return state.annotations.filter((annotation) => annotation.item_id === itemId);
  },

  async createAnnotation(input) {
    const annotation = {
      id: state.nextId++,
      item_id: input.item_id,
      anchor: input.anchor,
      kind: input.kind,
      body: input.body,
    };
    state.annotations.push(annotation);
    return annotation;
  },

  async removeAnnotation(input) {
    state.annotations = state.annotations.filter((annotation) => annotation.id !== input.annotation_id);
  },

  async getAiSettings() {
    return publicAiSettings();
  },

  async updateAiSettings(input: UpdateAISettingsInput) {
    state.aiSettings.active_provider = input.active_provider as AIProvider;
    state.aiSettings.openai_model = input.openai_model;
    state.aiSettings.openai_base_url = input.openai_base_url;
    state.aiSettings.anthropic_model = input.anthropic_model;
    state.aiSettings.anthropic_base_url = input.anthropic_base_url;
    if (input.clear_openai_api_key) state.aiSettings.openai_api_key = "";
    else if (input.openai_api_key && input.openai_api_key.trim()) state.aiSettings.openai_api_key = input.openai_api_key;
    if (input.clear_anthropic_api_key) state.aiSettings.anthropic_api_key = "";
    else if (input.anthropic_api_key && input.anthropic_api_key.trim()) {
      state.aiSettings.anthropic_api_key = input.anthropic_api_key;
    }
    state.aiSettings.has_openai_api_key = Boolean(state.aiSettings.openai_api_key);
    state.aiSettings.has_anthropic_api_key = Boolean(state.aiSettings.anthropic_api_key);
    return publicAiSettings();
  },

  async listAiSessions() {
    return [...state.sessions].sort((left, right) => right.id - left.id);
  },

  async createAiSession() {
    const session = {
      id: state.nextId++,
      title: "New Chat",
      created_at: "2026-04-30 09:30:00",
      updated_at: "2026-04-30 09:30:00",
    } satisfies AISession;
    state.sessions.unshift(session);
    return session;
  },

  async deleteAiSession(sessionId) {
    state.artifacts = state.artifacts.filter((artifact) => artifact.session_id !== sessionId);
    state.tasks = state.tasks.filter((task) => task.session_id !== sessionId);
    state.notes = state.notes.filter((note) => note.session_id !== sessionId);
    state.sessionReferences = state.sessionReferences.filter((reference) => reference.session_id !== sessionId);
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  },

  async listAiSessionReferences(sessionId) {
    return state.sessionReferences
      .filter((reference) => reference.session_id === sessionId)
      .sort((left, right) => left.sort_index - right.sort_index);
  },

  async addAiSessionReference(input) {
    const existing = state.sessionReferences.find(
      (reference) =>
        reference.session_id === input.session_id &&
        reference.kind === input.kind &&
        reference.target_id === input.target_id,
    );
    if (existing) return existing;
    const sort_index = state.sessionReferences.filter((reference) => reference.session_id === input.session_id).length;
    const reference = {
      id: state.nextId++,
      session_id: input.session_id,
      kind: input.kind,
      target_id: input.target_id,
      sort_index,
    } satisfies AISessionReference;
    state.sessionReferences.push(reference);
    touchSession(input.session_id);
    return reference;
  },

  async removeAiSessionReference(referenceId) {
    const reference = state.sessionReferences.find((entry) => entry.id === referenceId);
    if (!reference) return;
    state.sessionReferences = state.sessionReferences.filter((entry) => entry.id !== referenceId);
    normalizeSessionReferenceSortIndexes(reference.session_id);
    touchSession(reference.session_id);
  },

  async listenAiTaskStream(handler) {
    aiStreamListeners.add(handler);
    return () => {
      aiStreamListeners.delete(handler);
    };
  },

  async runAiSessionTask(input) {
    const references = state.sessionReferences
      .filter((reference) => reference.session_id === input.session_id)
      .sort((left, right) => left.sort_index - right.sort_index);
    const scope_item_ids = expandSessionReferenceItemIds(references);
    if (scope_item_ids.length === 0) {
      throw new Error("session has no readable items");
    }
    if (input.kind === "session.compare" && scope_item_ids.length < 2) {
      throw new Error("compare requires at least 2 unique papers");
    }
    const output = sessionTaskOutput(input, references);
    if (input.stream_id) {
      emitAiTaskStream({
        stream_id: input.stream_id,
        scope: "session",
        session_id: input.session_id,
        scope_item_ids: [...scope_item_ids],
        kind: input.kind,
        phase: "started",
        input_prompt: input.prompt?.trim() || null,
      });
    }
    if (input.stream_id) {
      const error = state.nextAiStreamFailure;
      state.nextAiStreamFailure = null;
      void (async () => {
        await delay(state.sessionTaskDelayMs ?? 20);
        if (error) {
          emitAiTaskStream({
            stream_id: input.stream_id!,
            scope: "session",
            session_id: input.session_id,
            scope_item_ids: [...scope_item_ids],
            kind: input.kind,
            phase: "failed",
            input_prompt: input.prompt?.trim() || null,
            error,
          });
          return;
        }
        await runStream(chunkMarkdown(output), (chunk) => {
          emitAiTaskStream({
            stream_id: input.stream_id!,
            scope: "session",
            session_id: input.session_id,
            scope_item_ids: [...scope_item_ids],
            kind: input.kind,
            phase: "delta",
            input_prompt: input.prompt?.trim() || null,
            delta_markdown: chunk,
          });
        });
        const primaryItem = state.items.find((item) => item.id === scope_item_ids[0]);
        const session = state.sessions.find((entry) => entry.id === input.session_id);
        const nextTitle =
          session?.title === "New Chat"
            ? (input.prompt?.trim() || (input.kind === "session.summarize" ? "Summarize" : input.kind.replace("session.", "")))
            : undefined;
        touchSession(input.session_id, nextTitle);
        const task = {
          id: state.nextId++,
          item_id: null,
          collection_id: primaryItem?.collection_id ?? null,
          session_id: input.session_id,
          scope_item_ids: [...scope_item_ids],
          input_prompt: input.prompt?.trim() || null,
          kind: input.kind,
          status: "succeeded",
          output_markdown: output,
        };
        state.tasks.unshift(task);
        state.artifacts.unshift({
          id: state.nextId++,
          task_id: task.id,
          item_id: null,
          collection_id: primaryItem?.collection_id ?? null,
          session_id: input.session_id,
          scope_item_ids: [...scope_item_ids],
          kind: input.kind,
          markdown: output,
        });
        emitAiTaskStream({
          stream_id: input.stream_id!,
          scope: "session",
          session_id: input.session_id,
          collection_id: primaryItem?.collection_id,
          scope_item_ids: [...scope_item_ids],
          kind: input.kind,
          phase: "completed",
          task_id: task.id,
          input_prompt: input.prompt?.trim() || null,
          full_markdown: output,
        });
      })();
      return;
    }
    const primaryItem = state.items.find((item) => item.id === scope_item_ids[0]);
    const session = state.sessions.find((entry) => entry.id === input.session_id);
    const nextTitle =
      session?.title === "New Chat" ? (input.prompt?.trim() || (input.kind === "session.summarize" ? "Summarize" : input.kind.replace("session.", ""))) : undefined;
    touchSession(input.session_id, nextTitle);
    state.tasks.unshift({
      id: state.nextId++,
      item_id: null,
      collection_id: primaryItem?.collection_id ?? null,
      session_id: input.session_id,
      scope_item_ids: [...scope_item_ids],
      input_prompt: input.prompt?.trim() || null,
      kind: input.kind,
      status: "succeeded",
      output_markdown: output,
    });
    return;
  },

  async runItemTask(input) {
    const item = state.items.find((entry) => entry.id === input.item_id);
    if (!item) {
      throw new Error(`Unknown item ${input.item_id}`);
    }
    const output = itemTaskOutput(item, input.kind, input.prompt);
    if (input.stream_id) {
      emitAiTaskStream({
        stream_id: input.stream_id,
        scope: "paper",
        item_id: input.item_id,
        collection_id: item.collection_id,
        kind: input.kind,
        phase: "started",
        input_prompt: input.prompt?.trim() || null,
      });
      void (async () => {
        await delay(0);
        if (state.nextAiStreamFailure) {
          const error = state.nextAiStreamFailure;
          state.nextAiStreamFailure = null;
          emitAiTaskStream({
            stream_id: input.stream_id!,
            scope: "paper",
            item_id: input.item_id,
            collection_id: item.collection_id,
            kind: input.kind,
            phase: "failed",
            input_prompt: input.prompt?.trim() || null,
            error,
          });
          return;
        }
        await runStream(chunkMarkdown(output), (chunk) => {
          emitAiTaskStream({
            stream_id: input.stream_id!,
            scope: "paper",
            item_id: input.item_id,
            collection_id: item.collection_id,
            kind: input.kind,
            phase: "delta",
            input_prompt: input.prompt?.trim() || null,
            delta_markdown: chunk,
          });
        });
        const task = {
          id: state.nextId++,
          item_id: item.id,
          collection_id: item.collection_id,
          session_id: null,
          scope_item_ids: null,
          input_prompt: input.prompt?.trim() || null,
          kind: input.kind,
          status: "succeeded",
          output_markdown: output,
        };
        state.tasks.unshift(task);
        state.artifacts.unshift({
          id: state.nextId++,
          task_id: task.id,
          item_id: item.id,
          collection_id: item.collection_id,
          session_id: null,
          scope_item_ids: null,
          kind: input.kind,
          markdown: output,
        });
        emitAiTaskStream({
          stream_id: input.stream_id!,
          scope: "paper",
          item_id: input.item_id,
          collection_id: item.collection_id,
          kind: input.kind,
          phase: "completed",
          task_id: task.id,
          input_prompt: input.prompt?.trim() || null,
          full_markdown: output,
        });
      })();
      return;
    }
    const task = {
      id: state.nextId++,
      item_id: item.id,
      collection_id: item.collection_id,
      session_id: null,
      scope_item_ids: null,
      input_prompt: input.prompt?.trim() || null,
      kind: input.kind,
      status: "succeeded",
      output_markdown: output,
    };
    state.tasks.unshift(task);
    state.artifacts.unshift({
      id: state.nextId++,
      task_id: task.id,
      item_id: item.id,
      collection_id: item.collection_id,
      session_id: null,
      scope_item_ids: null,
      kind: input.kind,
      markdown: output,
    });
    return;
  },

  async runCollectionTask(input) {
    if (input.scope_item_ids.length === 0) {
      throw new Error("collection has no readable items");
    }
    const scopeItems = input.scope_item_ids.map((itemId) =>
      state.items.find((entry) => entry.id === itemId && entry.collection_id === input.collection_id),
    );
    if (scopeItems.some((item) => !item)) {
      throw new Error("scope contains items outside the target collection");
    }
    const output = collectionTaskOutput(input.collection_id, input.kind, input.scope_item_ids);
    if (input.stream_id) {
      emitAiTaskStream({
        stream_id: input.stream_id,
        scope: "collection",
        collection_id: input.collection_id,
        scope_item_ids: [...input.scope_item_ids],
        kind: input.kind,
        phase: "started",
        input_prompt: input.prompt?.trim() || null,
      });
      void (async () => {
        await delay(0);
        if (state.nextAiStreamFailure) {
          const error = state.nextAiStreamFailure;
          state.nextAiStreamFailure = null;
          emitAiTaskStream({
            stream_id: input.stream_id!,
            scope: "collection",
            collection_id: input.collection_id,
            scope_item_ids: [...input.scope_item_ids],
            kind: input.kind,
            phase: "failed",
            input_prompt: input.prompt?.trim() || null,
            error,
          });
          return;
        }
        await runStream(chunkMarkdown(output), (chunk) => {
          emitAiTaskStream({
            stream_id: input.stream_id!,
            scope: "collection",
            collection_id: input.collection_id,
            scope_item_ids: [...input.scope_item_ids],
            kind: input.kind,
            phase: "delta",
            input_prompt: input.prompt?.trim() || null,
            delta_markdown: chunk,
          });
        });
        const task = {
          id: state.nextId++,
          item_id: null,
          collection_id: input.collection_id,
          session_id: null,
          scope_item_ids: [...input.scope_item_ids],
          input_prompt: input.prompt?.trim() || null,
          kind: input.kind,
          status: "succeeded",
          output_markdown: output,
        };
        state.tasks.unshift(task);
        state.artifacts.unshift({
          id: state.nextId++,
          task_id: task.id,
          item_id: null,
          collection_id: input.collection_id,
          session_id: null,
          scope_item_ids: [...input.scope_item_ids],
          kind: input.kind,
          markdown: output,
        });
        emitAiTaskStream({
          stream_id: input.stream_id!,
          scope: "collection",
          collection_id: input.collection_id,
          scope_item_ids: [...input.scope_item_ids],
          kind: input.kind,
          phase: "completed",
          task_id: task.id,
          input_prompt: input.prompt?.trim() || null,
          full_markdown: output,
        });
      })();
      return;
    }
    const task = {
      id: state.nextId++,
      item_id: null,
      collection_id: input.collection_id,
      session_id: null,
      scope_item_ids: [...input.scope_item_ids],
      input_prompt: input.prompt?.trim() || null,
      kind: input.kind,
      status: "succeeded",
      output_markdown: output,
    };
    state.tasks.unshift(task);
    state.artifacts.unshift({
      id: state.nextId++,
      task_id: task.id,
      item_id: null,
      collection_id: input.collection_id,
      session_id: null,
      scope_item_ids: [...input.scope_item_ids],
      kind: input.kind,
      markdown: output,
    });
    return;
  },

  async listTaskRuns(input) {
    return state.tasks.filter((task) => {
      if (input.item_id !== undefined) {
        return task.item_id === input.item_id;
      }
      if (input.collection_id !== undefined) {
        return task.collection_id === input.collection_id && task.item_id === null && task.session_id === null;
      }
      return true;
    });
  },

  async listAiSessionTaskRuns(sessionId) {
    return state.tasks.filter((task) => task.session_id === sessionId);
  },

  async getArtifact(input) {
    return (
      state.artifacts.find((artifact) => {
        if (input.item_id !== undefined) {
          return artifact.item_id === input.item_id;
        }
        if (input.collection_id !== undefined) {
          return artifact.collection_id === input.collection_id && artifact.item_id === null && artifact.session_id === null;
        }
        return false;
      }) ?? null
    );
  },

  async getAiSessionArtifact(sessionId) {
    return state.artifacts.find((artifact) => artifact.session_id === sessionId) ?? null;
  },

  async listNotes(collectionId) {
    return state.notes.filter((note) =>
      collectionId === undefined ? true : note.collection_id === collectionId,
    );
  },

  async listAiSessionNotes(sessionId) {
    return state.notes.filter((note) => note.session_id === sessionId);
  },

  async createNoteFromArtifact(input) {
    const artifact = state.artifacts.find((entry) => entry.id === input.artifact_id);
    if (!artifact || artifact.collection_id === null) {
      throw new Error(`Unknown artifact ${input.artifact_id}`);
    }
    const note = {
      id: state.nextId++,
      collection_id: artifact.collection_id,
      session_id: artifact.session_id,
      title: noteTitleFromArtifact(artifact.collection_id, artifact.markdown),
      markdown: artifact.markdown,
    };
    state.notes.unshift(note);
    return note;
  },

  async createAiSessionNoteFromArtifact(artifactId) {
    return fakeApi.createNoteFromArtifact({ artifact_id: artifactId });
  },

  async updateNote(input) {
    const note = state.notes.find((entry) => entry.id === input.note_id);
    if (!note) {
      throw new Error(`Unknown note ${input.note_id}`);
    }
    note.markdown = input.markdown;
  },

  async exportNoteMarkdown(noteId) {
    const note = state.notes.find((entry) => entry.id === noteId);
    if (!note) {
      throw new Error(`Unknown note ${noteId}`);
    }
    return note.markdown;
  },

  async exportCitation(itemId, format: CitationFormat = "apa7") {
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error(`Unknown item ${itemId}`);
    }
    if (format === "bibtex") {
      return `@article{paper-reader-${item.id},\n  title = {${item.title}},\n  author = {${item.authors}},\n  journal = {${item.source}},\n  doi = {${item.doi ?? ""}},\n  year = {${item.publication_year ?? 2026}}\n}`;
    }
    if (format === "ris") {
      return `TY  - JOUR\nTI  - ${item.title}\nAU  - ${item.authors}\nJO  - ${item.source}\nPY  - ${item.publication_year ?? 2026}\nDO  - ${item.doi ?? ""}\nER  -`;
    }
    return `APA 7 · ${item.authors}. (${item.publication_year ?? item.id}). ${item.title}. ${item.source}.`;
  },

  async writeExportFile(input) {
    exportWrites.push(input);
  },

  async ocrPdfPage(input: OcrPdfPageInput): Promise<OcrPageResult> {
    return {
      primary_attachment_id: input.primary_attachment_id,
      page_index0: input.page_index0,
      lang: input.lang ?? "eng+chi_sim",
      config_version: input.config_version,
      lines: [],
    };
  },

  async pdfEngineGetDocumentInfo(_input: PdfEngineGetDocumentInfoInput): Promise<PdfDocumentInfo> {
    return {
      page_count: 2,
      pages: [
        { width_pt: 612, height_pt: 792 },
        { width_pt: 612, height_pt: 792 },
      ],
    };
  },

  async pdfEngineGetPageBundle(_input: PdfEngineGetPageBundleInput): Promise<PdfPageBundle> {
    return {
      png_bytes: new Uint8Array([137, 80, 78, 71]),
      width_px: 100,
      height_px: 120,
      page_width_pt: 612,
      page_height_pt: 792,
      spans: [
        { text: "Hello", x0: 10, y0: 10, x1: 50, y1: 20 },
        { text: "world", x0: 55, y0: 10, x1: 95, y1: 20 },
      ],
    };
  },

  async pdfEngineGetPageText(input: PdfEngineGetPageTextInput): Promise<PdfPageText> {
    return {
      page_index0: input.page_index0,
      spans: [
        { text: "Hello", x0: 10, y0: 10, x1: 50, y1: 20 },
        { text: "world", x0: 55, y0: 10, x1: 95, y1: 20 },
      ],
    };
  },
};
