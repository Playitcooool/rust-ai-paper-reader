import type {
  AIArtifact,
  Annotation,
  AppApi,
  AITask,
  CitationFormat,
  Collection,
  ImportMode,
  LibraryItem,
  ReaderView,
  ResearchNote,
  Tag,
} from "./contracts";

type MockItemDetails = LibraryItem & {
  plainText: string;
  normalizedHtml: string;
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
  nextId: number;
};

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
      attachment_status: "ready",
      authors: "Kaplan et al.",
      publication_year: 2020,
      source: "OpenAI",
      doi: "10.1000/scaling-laws",
      tags: [],
      plainText:
        "Scaling behavior emerges when model size, data volume, and compute are balanced. This paper discusses predictable loss curves and practical planning heuristics.",
      normalizedHtml:
        "<article><h1>Transformer Scaling Laws</h1><p>Scaling behavior emerges when model size, data volume, and compute are balanced.</p><p>This paper discusses predictable loss curves and practical planning heuristics.</p></article>",
    },
    {
      id: 2,
      title: "Graph Neural Survey",
      collection_id: 1,
      primary_attachment_id: 102,
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
    },
    {
      id: 3,
      title: "Distributed Consensus Notes",
      collection_id: 2,
      primary_attachment_id: 103,
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
      kind: "item.summarize",
      status: "succeeded",
      output_markdown:
        "# Summary: Transformer Scaling Laws\n\nCollection: Machine Learning\n\nScaling behavior emerges when model size, data volume, and compute are balanced.",
    },
  ],
  artifacts: [
    {
      id: 800,
      task_id: 700,
      item_id: 1,
      collection_id: 1,
      kind: "item.summarize",
      markdown:
        "# Summary: Transformer Scaling Laws\n\nCollection: Machine Learning\n\nScaling behavior emerges when model size, data volume, and compute are balanced.",
    },
  ],
  notes: [
    {
      id: 900,
      collection_id: 1,
      title: "Machine Learning Review",
      markdown:
        "# Machine Learning Review\n\n## Evidence Map\n- Transformer Scaling Laws\n- Graph Neural Survey",
    },
  ],
  nextId: 1000,
});

let state = initialState();

const collectionName = (collectionId: number) =>
  state.collections.find((collection) => collection.id === collectionId)?.name ?? "Unknown";

const noteTitle = (collectionId: number) => `${collectionName(collectionId)} Review`;

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

const normalizedHtmlFromTitle = (title: string, mode: ImportMode) =>
  `<article><h1>${title}</h1><p>Imported in ${mode} mode.</p><p>This mock document is ready for reading, annotation, and AI analysis.</p></article>`;

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
  attachment_status: item.attachment_status,
  authors: item.authors,
  publication_year: item.publication_year,
  source: item.source,
  doi: item.doi,
  tags: tagsForItem(item.id),
});

const collectionTaskOutput = (collectionId: number, kind: string) => {
  const items = state.items.filter((item) => item.collection_id === collectionId);
  const evidenceMap = items
    .map((item) => `- **${item.title}**: ${item.plainText.split(".").shift()?.trim() ?? item.title}`)
    .join("\n");

  switch (kind) {
    case "collection.bulk_summarize":
      return `# Bulk Summary: ${collectionName(collectionId)}\n\n## Paper Capsules\n${evidenceMap}\n\n## Synthesis\nBulk summary across ${items.length} visible papers.`;
    case "collection.theme_map":
      return `# Theme Map: ${collectionName(collectionId)}\n\n## Themes\n${evidenceMap}\n\n## Theme Clusters\nTheme clusters across ${items.length} visible papers.`;
    case "collection.compare_methods":
      return `# Method Comparison: ${collectionName(collectionId)}\n\n## Comparison Matrix\n${evidenceMap}\n\n## Method Notes\nMethod comparison across ${items.length} visible papers.`;
    case "collection.review_draft":
    default:
      return `# Review Draft: ${collectionName(collectionId)}\n\n## Evidence Map\n${evidenceMap}\n\n## Narrative\nThis draft groups the imported papers into a concise literature review scaffold ready for editing.`;
  }
};

const itemTaskOutput = (item: MockItemDetails, kind: string) => {
  const firstLine = item.plainText.split(".").shift()?.trim() ?? item.title;

  switch (kind) {
    case "item.summarize":
      return `# Summary: ${item.title}\n\nCollection: ${collectionName(item.collection_id)}\n\n${firstLine}`;
    case "item.translate":
      return `# Translation: ${item.title}\n\n## Translated Passage\n${firstLine}\n\n## Notes\nTranslated from the active reader selection.`;
    case "item.explain_term":
      return `# Terminology Notes: ${item.title}\n\n## Key Terms\n- Scaling law: ${firstLine}\n\n## Reading Tip\nUse this note to clarify repeated technical vocabulary.`;
    case "item.ask":
      return `# Reading Q&A: ${item.title}\n\n## Answer\n${firstLine}\n\n## Evidence\nCollection: ${collectionName(item.collection_id)}`;
    default:
      return `# Summary: ${item.title}\n\nCollection: ${collectionName(item.collection_id)}\n\n${firstLine}`;
  }
};

export function resetMockApi() {
  state = initialState();
}

export const mockApi: AppApi = {
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

  async pickRelinkPath() {
    return "/relinked/distributed-consensus-notes.epub";
  },

  async importFiles(input) {
    return input.paths.map((path) => {
      const title = titleFromPath(path);
      const metadata = metadataFromTitle(title);
      const itemId = state.nextId++;
      const attachmentId = state.nextId++;
      state.items.unshift({
        id: itemId,
        title,
        collection_id: input.collection_id,
        primary_attachment_id: attachmentId,
        attachment_status: "ready",
        authors: metadata.authors,
        publication_year: metadata.publication_year,
        source: metadata.source,
        doi: metadata.doi,
        tags: [],
        plainText: `${title} was imported into ${collectionName(input.collection_id)} and normalized for AI-assisted reading.`,
        normalizedHtml: normalizedHtmlFromTitle(title, input.mode),
      });
      return {
        id: itemId,
        title,
        primary_attachment_id: attachmentId,
      };
    });
  },

  async importCitations(input) {
    return input.paths.map((path) => {
      const title = titleFromPath(path);
      const metadata = metadataFromTitle(title);
      const itemId = state.nextId++;
      const attachmentId = state.nextId++;
      state.items.unshift({
        id: itemId,
        title,
        collection_id: input.collection_id,
        primary_attachment_id: attachmentId,
        attachment_status: "citation_only",
        authors: metadata.authors,
        publication_year: metadata.publication_year,
        source: metadata.source,
        doi: metadata.doi,
        tags: [],
        plainText: `${title} was imported from a citation record and is ready for metadata-first triage.`,
        normalizedHtml: `<article><h1>${title}</h1><p>Citation-only import.</p><p>Add a source file later or use this entry for bibliography management.</p></article>`,
      });
      return {
        id: itemId,
        title,
        primary_attachment_id: attachmentId,
      };
    });
  },

  async relinkAttachment(input) {
    const item = state.items.find((entry) => entry.primary_attachment_id === input.attachment_id);
    if (!item) {
      throw new Error(`Unknown attachment ${input.attachment_id}`);
    }
    item.attachment_status = "ready";
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
    return {
      item_id: item.id,
      title: item.title,
      normalized_html: item.normalizedHtml,
      plain_text: item.plainText,
    } satisfies ReaderView;
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

  async runItemTask(input) {
    const item = state.items.find((entry) => entry.id === input.item_id);
    if (!item) {
      throw new Error(`Unknown item ${input.item_id}`);
    }
    const output = itemTaskOutput(item, input.kind);
    const task = {
      id: state.nextId++,
      item_id: item.id,
      collection_id: item.collection_id,
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
      kind: input.kind,
      markdown: output,
    });
    return task;
  },

  async runCollectionTask(input) {
    const output = collectionTaskOutput(input.collection_id, input.kind);
    const task = {
      id: state.nextId++,
      item_id: null,
      collection_id: input.collection_id,
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
      kind: input.kind,
      markdown: output,
    });
    state.notes.unshift({
      id: state.nextId++,
      collection_id: input.collection_id,
      title: noteTitle(input.collection_id),
      markdown: output,
    });
    return task;
  },

  async listTaskRuns(input) {
    return state.tasks.filter((task) => {
      if (input.item_id !== undefined) {
        return task.item_id === input.item_id;
      }
      if (input.collection_id !== undefined) {
        return task.collection_id === input.collection_id;
      }
      return true;
    });
  },

  async getArtifact(input) {
    return (
      state.artifacts.find((artifact) => {
        if (input.item_id !== undefined) {
          return artifact.item_id === input.item_id;
        }
        if (input.collection_id !== undefined) {
          return artifact.collection_id === input.collection_id;
        }
        return false;
      }) ?? null
    );
  },

  async listNotes(collectionId) {
    return state.notes.filter((note) =>
      collectionId === undefined ? true : note.collection_id === collectionId,
    );
  },

  async createNoteFromArtifact(collectionId) {
    const artifact =
      state.artifacts.find((entry) => entry.collection_id === collectionId) ??
      ({
        markdown: `# ${noteTitle(collectionId)}\n\nNo artifact yet.`,
      } as AIArtifact);
    const note = {
      id: state.nextId++,
      collection_id: collectionId,
      title: noteTitle(collectionId),
      markdown: artifact.markdown,
    };
    state.notes.unshift(note);
    return note;
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
};
