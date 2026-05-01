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

export type CitationFormat = "apa7" | "bibtex" | "ris";
export type ReaderKind = "pdf" | "normalized";
export type AttachmentFormat = "pdf" | "docx" | "epub" | "unknown";

export type ImportedItem = {
  id: number;
  title: string;
  primary_attachment_id: number;
};

export type ImportPathResult = {
  path: string;
  status: "imported" | "duplicate" | "failed";
  message: string;
  item: ImportedItem | null;
};

export type ImportBatchResult = {
  imported: ImportedItem[];
  duplicates: ImportPathResult[];
  failed: ImportPathResult[];
  results: ImportPathResult[];
};

export type LibraryItem = {
  id: number;
  title: string;
  collection_id: number;
  primary_attachment_id: number;
  attachment_format: AttachmentFormat;
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
  content_status: "ready" | "partial" | "unavailable";
  content_notice: string | null;
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
  session_id: number | null;
  scope_item_ids: number[] | null;
  input_prompt: string | null;
  kind: string;
  status: string;
  output_markdown: string;
};

export type AITaskStreamEvent = {
  stream_id: string;
  scope: "paper" | "collection" | "session";
  kind: string;
  phase: "started" | "delta" | "completed" | "failed";
  task_id?: number;
  input_prompt?: string | null;
  delta_markdown?: string;
  full_markdown?: string;
  error?: string;
};

export type AIArtifact = {
  id: number;
  task_id: number;
  item_id: number | null;
  collection_id: number | null;
  session_id: number | null;
  scope_item_ids: number[] | null;
  kind: string;
  markdown: string;
};

export type AISession = {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
};

export type AISessionReferenceKind = "item" | "collection";

export type AISessionReference = {
  id: number;
  session_id: number;
  kind: AISessionReferenceKind;
  target_id: number;
  sort_index: number;
};

export type AIProvider = "openai" | "anthropic";

export type AISettings = {
  active_provider: AIProvider;
  openai_model: string;
  openai_base_url: string;
  has_openai_api_key: boolean;
  anthropic_model: string;
  anthropic_base_url: string;
  has_anthropic_api_key: boolean;
};

export type UpdateAISettingsInput = {
  active_provider: AIProvider;
  openai_model: string;
  openai_base_url: string;
  openai_api_key?: string;
  clear_openai_api_key?: boolean;
  anthropic_model: string;
  anthropic_base_url: string;
  anthropic_api_key?: string;
  clear_anthropic_api_key?: boolean;
};

export type ResearchNote = {
  id: number;
  collection_id: number | null;
  session_id: number | null;
  title: string;
  markdown: string;
};

export type AIRunSessionTaskInput = {
  session_id: number;
  kind: string;
  prompt?: string;
  stream_id?: string;
};

export type OcrBbox = {
  left: number; // normalized [0..1] relative to OCR raster width
  top: number; // normalized [0..1] relative to OCR raster height
  width: number; // normalized [0..1]
  height: number; // normalized [0..1]
};

export type OcrLine = {
  text: string;
  bbox: OcrBbox;
  confidence: number;
};

export type OcrPageResult = {
  primary_attachment_id: number;
  page_index0: number;
  lang: string;
  config_version: string;
  lines: OcrLine[];
};

export type OcrPdfPageInput = {
  primary_attachment_id: number;
  page_index0: number;
  png_bytes: Uint8Array;
  lang?: string;
  config_version: string;
  source_resolution?: number;
};

export type PdfTextSpan = {
  text: string;
  // PDF points (origin bottom-left). Converted to CSS pixels in the frontend.
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type PdfPageBundle = {
  png_bytes: Uint8Array;
  width_px: number;
  height_px: number;
  page_width_pt: number;
  page_height_pt: number;
  spans: PdfTextSpan[];
};

export type PdfPageInfo = {
  width_pt: number;
  height_pt: number;
};

export type PdfDocumentInfo = {
  page_count: number;
  pages: PdfPageInfo[];
};

export type PdfEngineGetPageBundleInput = {
  primary_attachment_id: number;
  page_index0: number;
  target_width_px: number;
};

export type PdfEngineGetDocumentInfoInput = {
  primary_attachment_id: number;
};

export type PdfEngineGetPageTextInput = {
  primary_attachment_id: number;
  page_index0: number;
};

export type PdfPageText = {
  page_index0: number;
  spans: PdfTextSpan[];
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
  }) => Promise<ImportBatchResult>;
  importCitations: (input: { collection_id: number; paths: string[] }) => Promise<ImportBatchResult>;
  refreshAttachmentStatuses: () => Promise<void>;
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
  readPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  listAnnotations: (itemId: number) => Promise<Annotation[]>;
  createAnnotation: (input: {
    item_id: number;
    anchor: string;
    kind: string;
    body: string;
  }) => Promise<Annotation>;
  removeAnnotation: (input: { annotation_id: number }) => Promise<void>;
  getAiSettings: () => Promise<AISettings>;
  updateAiSettings: (input: UpdateAISettingsInput) => Promise<AISettings>;
  listAiSessions: () => Promise<AISession[]>;
  createAiSession: () => Promise<AISession>;
  listAiSessionReferences: (sessionId: number) => Promise<AISessionReference[]>;
  addAiSessionReference: (input: {
    session_id: number;
    kind: AISessionReferenceKind;
    target_id: number;
  }) => Promise<AISessionReference>;
  removeAiSessionReference: (referenceId: number) => Promise<void>;
  runAiSessionTask: (input: AIRunSessionTaskInput) => Promise<AITask>;
  listAiSessionTaskRuns: (sessionId: number) => Promise<AITask[]>;
  getAiSessionArtifact: (sessionId: number) => Promise<AIArtifact | null>;
  listAiSessionNotes: (sessionId: number) => Promise<ResearchNote[]>;
  createAiSessionNoteFromArtifact: (artifactId: number) => Promise<ResearchNote>;
  runItemTask: (input: {
    item_id: number;
    kind: string;
    prompt?: string;
    stream_id?: string;
  }) => Promise<AITask>;
  runCollectionTask: (input: {
    collection_id: number;
    kind: string;
    scope_item_ids: number[];
    prompt?: string;
    stream_id?: string;
  }) => Promise<AITask>;
  listTaskRuns: (input: { item_id?: number; collection_id?: number }) => Promise<AITask[]>;
  listenAiTaskStream: (handler: (event: AITaskStreamEvent) => void) => Promise<() => void>;
  getArtifact: (input: {
    item_id?: number;
    collection_id?: number;
  }) => Promise<AIArtifact | null>;
  listNotes: (collectionId?: number) => Promise<ResearchNote[]>;
  createNoteFromArtifact: (input: { artifact_id: number }) => Promise<ResearchNote>;
  updateNote: (input: { note_id: number; markdown: string }) => Promise<void>;
  exportNoteMarkdown: (noteId: number) => Promise<string>;
  exportCitation: (itemId: number, format?: CitationFormat) => Promise<string>;
  requestExportPath: (input: {
    defaultPath: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ path: string; authorization_token: string } | null>;
  writeExportFile: (input: { path: string; authorization_token: string; contents: string }) => Promise<void>;
  ocrPdfPage: (input: OcrPdfPageInput) => Promise<OcrPageResult>;
  pdfEngineGetDocumentInfo: (input: PdfEngineGetDocumentInfoInput) => Promise<PdfDocumentInfo>;
  pdfEngineGetPageBundle: (input: PdfEngineGetPageBundleInput) => Promise<PdfPageBundle>;
  pdfEngineGetPageText: (input: PdfEngineGetPageTextInput) => Promise<PdfPageText>;
};
