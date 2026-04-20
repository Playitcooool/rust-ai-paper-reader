import type {
  AIArtifact,
  Annotation,
  AppApi,
  AITask,
  Collection,
  LibraryItem,
  ReaderView,
  ResearchNote,
} from "./contracts";

type MockItemDetails = LibraryItem & {
  plainText: string;
  normalizedHtml: string;
};

type MockState = {
  collections: Collection[];
  items: MockItemDetails[];
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
      attachment_status: "ready",
      plainText:
        "Consensus protocols coordinate replicas under partial failure. This note contrasts Paxos, Raft, and production trade-offs around operator ergonomics.",
      normalizedHtml:
        "<article><h1>Distributed Consensus Notes</h1><p>Consensus protocols coordinate replicas under partial failure.</p><p>This note contrasts Paxos, Raft, and production trade-offs around operator ergonomics.</p></article>",
    },
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

  async listItems(collectionId) {
    return state.items.filter((item) =>
      collectionId === undefined ? true : item.collection_id === collectionId,
    );
  },

  async searchItems(query) {
    const lowered = query.trim().toLowerCase();
    return state.items.filter((item) => item.title.toLowerCase().includes(lowered));
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
    const output = `# ${input.kind}\n\n${item.title}\n\n${item.plainText}`;
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
    const items = state.items.filter((item) => item.collection_id === input.collection_id);
    const output = `# ${collectionName(input.collection_id)} Review Draft\n\n${items
      .map((item) => `- ${item.title}`)
      .join("\n")}`;
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

  async exportNoteMarkdown(noteId) {
    const note = state.notes.find((entry) => entry.id === noteId);
    if (!note) {
      throw new Error(`Unknown note ${noteId}`);
    }
    return note.markdown;
  },

  async exportCitation(itemId) {
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error(`Unknown item ${itemId}`);
    }
    return `APA 7 · ${collectionName(item.collection_id)}. (${item.id}). ${item.title}. Paper Reader Library.`;
  },
};

