export type Collection = {
  id: number;
  name: string;
  parent_id: number | null;
};

export type Tag = {
  id: number;
  name: string;
  item_count: number;
};

export type ImportMode = "managed_copy" | "linked_file";
export type CitationFormat = "apa7" | "bibtex" | "ris";
export type ReaderKind = "pdf" | "normalized";
export type AttachmentFormat = "pdf" | "docx" | "epub" | "unknown";

export type ImportedItem = {
  id: number;
  title: string;
  primary_attachment_id: number;
};

export type LibraryItem = {
  id: number;
  title: string;
  collection_id: number;
  primary_attachment_id: number;
  attachment_status: string;
  authors: string;
  publication_year: number | null;
  source: string;
  doi: string | null;
  tags: string[];
};

export type ReaderView = {
  item_id: number;
  title: string;
  reader_kind: ReaderKind;
  attachment_format: AttachmentFormat;
  primary_attachment_id: number | null;
  primary_attachment_path: string | null;
  page_count: number | null;
  normalized_html: string;
  plain_text: string;
};

export type Annotation = {
  id: number;
  item_id: number;
  anchor: string;
  kind: string;
  body: string;
};

export type AnnotationFilter = "all" | "current_page" | "search_matches";

export type AITask = {
  id: number;
  item_id: number | null;
  collection_id: number | null;
  kind: string;
  status: string;
  output_markdown: string;
};

export type AIArtifact = {
  id: number;
  task_id: number;
  item_id: number | null;
  collection_id: number | null;
  kind: string;
  markdown: string;
};

export type ResearchNote = {
  id: number;
  collection_id: number;
  title: string;
  markdown: string;
};

export type AppApi = {
  listCollections: () => Promise<Collection[]>;
  createCollection: (input: { name: string; parent_id?: number | null }) => Promise<Collection>;
  moveCollection: (input: { collection_id: number; parent_id?: number | null }) => Promise<void>;
  renameCollection: (input: { collection_id: number; name: string }) => Promise<void>;
  removeCollection: (input: { collection_id: number }) => Promise<void>;
  listTags: (collectionId?: number) => Promise<Tag[]>;
  createTag: (input: { name: string }) => Promise<Tag>;
  assignTag: (input: { item_id: number; tag_id: number }) => Promise<void>;
  pickImportPaths: () => Promise<string[]>;
  pickCitationPaths: () => Promise<string[]>;
  pickRelinkPath: () => Promise<string | null>;
  importFiles: (input: {
    collection_id: number;
    paths: string[];
    mode: ImportMode;
  }) => Promise<ImportedItem[]>;
  importCitations: (input: { collection_id: number; paths: string[] }) => Promise<ImportedItem[]>;
  relinkAttachment: (input: { attachment_id: number; replacement_path: string }) => Promise<void>;
  updateItemMetadata: (input: {
    item_id: number;
    title: string;
    authors: string;
    publication_year: number | null;
    source: string;
    doi: string | null;
  }) => Promise<void>;
  removeItem: (input: { item_id: number }) => Promise<void>;
  moveItem: (input: { item_id: number; collection_id: number }) => Promise<void>;
  listItems: (collectionId?: number) => Promise<LibraryItem[]>;
  searchItems: (query: string) => Promise<LibraryItem[]>;
  getReaderView: (itemId: number) => Promise<ReaderView>;
  listAnnotations: (itemId: number) => Promise<Annotation[]>;
  createAnnotation: (input: {
    item_id: number;
    anchor: string;
    kind: string;
    body: string;
  }) => Promise<Annotation>;
  removeAnnotation: (input: { annotation_id: number }) => Promise<void>;
  runItemTask: (input: { item_id: number; kind: string }) => Promise<AITask>;
  runCollectionTask: (input: { collection_id: number; kind: string }) => Promise<AITask>;
  listTaskRuns: (input: { item_id?: number; collection_id?: number }) => Promise<AITask[]>;
  getArtifact: (input: {
    item_id?: number;
    collection_id?: number;
  }) => Promise<AIArtifact | null>;
  listNotes: (collectionId?: number) => Promise<ResearchNote[]>;
  createNoteFromArtifact: (collectionId: number) => Promise<ResearchNote>;
  updateNote: (input: { note_id: number; markdown: string }) => Promise<void>;
  exportNoteMarkdown: (noteId: number) => Promise<string>;
  exportCitation: (itemId: number, format?: CitationFormat) => Promise<string>;
};
