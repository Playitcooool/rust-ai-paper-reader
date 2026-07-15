export type Collection = {
  id: number;
  name: string;
  parent_id: number | null;
  item_count: number;
};

export type Tag = {
  id: number;
  name: string;
  item_count: number;
};

export type CitationFormat = "apa7" | "bibtex" | "ris";
export type ReaderKind = "pdf" | "normalized";
export type AttachmentFormat = "pdf" | "docx" | "epub" | "md" | "unknown";

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
  display_metadata: string | null;
};

export type LibraryQueryInput = {
  collection_id: number | null;
  search: string;
  selected_tag_id: number | null;
  attachment_filter: "all" | "ready" | "missing" | "citation_only";
  item_sort: "recent" | "title" | "year_desc";
};

export type LibraryTreeSearchFilterInput = {
  collection_id: number | null;
  search: string;
};

export type LibraryTreeSearchFilter = {
  item_ids: number[];
  collection_ids: number[];
};

export type CollectionDeleteSummary = {
  deleted_collection_ids: number[];
  deleted_item_ids: number[];
  nested_collection_count: number;
  paper_count: number;
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

export type EvidenceChunk = {
  id: number;
  item_id: number;
  item_title: string;
  chunk_index: number;
  page_number: number | null;
  page_start: number | null;
  page_end: number | null;
  section_title: string | null;
  heading_path_json: string | null;
  content_kind: string;
  metadata_json: string | null;
  retrieval_weight: number;
  score: number | null;
  anchor_json: string;
  text: string;
  source_kind: string;
  extractor_version: number;
};

export type EvidenceCitationTarget = {
  evidence_id: number;
  item_id: number;
  item_title: string;
  page_number: number | null;
  page_start: number | null;
  page_end: number | null;
  text_prefix: string;
  section_title: string | null;
  content_kind: string;
  source_kind: string;
};

export type PdfHighlightColor = "yellow" | "red" | "green" | "blue" | "purple";

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
  session_id?: number;
  item_id?: number;
  collection_id?: number;
  scope_item_ids?: number[];
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

export type AISessionScope = {
  session_id: number;
  item_ids: number[];
  has_collection_reference: boolean;
  primary_collection_id: number | null;
};

export type AIProvider = "openai" | "anthropic";
export type TranslationProvider = "openai" | "anthropic" | "deepl";

export type AISettings = {
  active_provider: AIProvider;
  openai_model: string;
  openai_base_url: string;
  has_openai_api_key: boolean;
  provider_env_openai: string;
  anthropic_model: string;
  anthropic_base_url: string;
  has_anthropic_api_key: boolean;
  provider_env_anthropic: string;
  translation_provider: TranslationProvider;
  translation_openai_model: string;
  translation_anthropic_model: string;
  translation_target_lang: string;
  deepl_base_url: string;
  has_deepl_api_key: boolean;
};

export type AIEnvSettings = {
  text: string;
};

export type ConnectorSettings = {
  connector_url: string;
  port: number;
  token: string;
  status: "running" | "error";
  error?: string;
};

export type UpdateAISettingsInput = {
  active_provider: AIProvider;
  openai_model: string;
  openai_base_url: string;
  openai_api_key?: string;
  clear_openai_api_key?: boolean;
  provider_env_openai?: string;
  anthropic_model: string;
  anthropic_base_url: string;
  anthropic_api_key?: string;
  clear_anthropic_api_key?: boolean;
  provider_env_anthropic?: string;
  translation_provider: TranslationProvider;
  translation_openai_model: string;
  translation_anthropic_model: string;
  translation_target_lang: string;
  deepl_base_url: string;
  deepl_api_key?: string;
  clear_deepl_api_key?: boolean;
};

export type TranslateSelectionInput = {
  text: string;
  target_lang?: string;
};

export type TranslateSelectionResult = {
  translated_text: string;
};

export type ResearchNote = {
  id: number;
  collection_id: number | null;
  session_id: number | null;
  title: string;
  markdown: string;
  display_title: string;
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

export type PdfOutlineItem = {
  id: string;
  title: string;
  page_index0: number;
  children: PdfOutlineItem[];
};

export type PdfPageLink = {
  id: string;
  page_index0: number;
  // PDF points (origin bottom-left). Converted to CSS pixels in the frontend.
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  target_page_index0: number;
};

export type PdfInitialPageBundle = {
  document_info: PdfDocumentInfo;
  bundle: PdfPageBundle;
};

export type PdfEngineGetPageBundleInput = {
  primary_attachment_id: number;
  page_index0: number;
  target_width_px: number;
};

export type PdfEngineGetPageBundlesBatchInput = {
  primary_attachment_id: number;
  page_indexes0: number[];
  target_width_px: number;
};

export type PdfEngineGetDocumentInfoInput = {
  primary_attachment_id: number;
};

export type PdfEngineGetOutlineInput = {
  primary_attachment_id: number;
};

export type PdfEngineGetLinksInput = {
  primary_attachment_id: number;
};

export type PdfEngineGetPageTextInput = {
  primary_attachment_id: number;
  page_index0: number;
};

export type PdfEngineGetPageTextsBatchInput = {
  primary_attachment_id: number;
  page_indexes0: number[];
};

export type PdfPageText = {
  page_index0: number;
  spans: PdfTextSpan[];
};

export type PdfSearchMatch = {
  page_index0: number;
  span_index: number;
  start: number;
  end: number;
};

export type PdfSearchResult = {
  total: number;
  matches: PdfSearchMatch[];
};

export type PdfEngineSearchInput = {
  primary_attachment_id: number;
  query: string;
  max_matches?: number;
};

export type LibraryChangedEvent = {
  source: "connector" | string;
  collection_id?: number | null;
  imported_count?: number;
  duplicate_count?: number;
  failed_count?: number;
  imported_item_ids?: number[];
  duplicate_item_ids?: number[];
};

export type AppApi = {
  listCollections: () => Promise<Collection[]>;
  createCollection: (input: { name: string; parent_id?: number | null }) => Promise<Collection>;
  moveCollection: (input: { collection_id: number; parent_id?: number | null }) => Promise<void>;
  renameCollection: (input: { collection_id: number; name: string }) => Promise<void>;
  removeCollection: (input: { collection_id: number }) => Promise<void>;
  collectionDeleteSummary: (input: { collection_id: number }) => Promise<CollectionDeleteSummary>;
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
  queryLibraryItems: (input: LibraryQueryInput) => Promise<LibraryItem[]>;
  libraryTreeSearchFilter: (input: LibraryTreeSearchFilterInput) => Promise<LibraryTreeSearchFilter>;
  searchItems: (query: string) => Promise<LibraryItem[]>;
  getReaderView: (itemId: number) => Promise<ReaderView>;
  updateMarkdownItem: (input: { item_id: number; markdown: string }) => Promise<ReaderView>;
  readPrimaryAttachmentBytes: (primaryAttachmentId: number) => Promise<Uint8Array>;
  listAnnotations: (itemId: number) => Promise<Annotation[]>;
  createAnnotation: (input: {
    item_id: number;
    anchor: string;
    kind: string;
    body: string;
  }) => Promise<Annotation>;
  updateAnnotation: (input: {
    annotation_id: number;
    anchor: string;
    body?: string;
  }) => Promise<Annotation>;
  colorPdfTextAnchor: (input: { anchor: string; color: PdfHighlightColor }) => Promise<string>;
  normalizePdfTextBoxAnchor: (input: { anchor: string }) => Promise<string>;
  normalizePdfInkAnchor: (input: { anchor: string }) => Promise<string>;
  removeAnnotation: (input: { annotation_id: number }) => Promise<void>;
  getAiSettings: () => Promise<AISettings>;
  getSystemAiEnv: () => Promise<AIEnvSettings>;
  updateAiSettings: (input: UpdateAISettingsInput) => Promise<AISettings>;
  getConnectorSettings: () => Promise<ConnectorSettings>;
  regenerateConnectorToken: () => Promise<ConnectorSettings>;
  translateSelection: (input: TranslateSelectionInput) => Promise<TranslateSelectionResult>;
  listAiSessions: () => Promise<AISession[]>;
  findItemOnlyAiSession: (itemId: number) => Promise<AISession | null>;
  createAiSession: () => Promise<AISession>;
  deleteAiSession: (sessionId: number) => Promise<void>;
  listAiSessionReferences: (sessionId: number) => Promise<AISessionReference[]>;
  getAiSessionScope: (sessionId: number) => Promise<AISessionScope>;
  addAiSessionReference: (input: {
    session_id: number;
    kind: AISessionReferenceKind;
    target_id: number;
  }) => Promise<AISessionReference>;
  removeAiSessionReference: (referenceId: number) => Promise<void>;
  runAiSessionTask: (input: AIRunSessionTaskInput) => Promise<void>;
  listAiSessionTaskRuns: (sessionId: number) => Promise<AITask[]>;
  queryEvidenceChunks: (input: {
    item_ids: number[];
    query?: string;
    limit?: number;
    scope?: "page" | "section" | "paper" | "collection";
    content_kinds?: string[];
    group_by_item?: boolean;
    rerank?: "none" | "local";
  }) => Promise<EvidenceChunk[]>;
  getEvidenceChunk: (evidenceId: number) => Promise<EvidenceChunk | null>;
  locateEvidenceChunk: (evidenceId: number) => Promise<EvidenceCitationTarget | null>;
  getAiSessionArtifact: (sessionId: number) => Promise<AIArtifact | null>;
  listAiSessionNotes: (sessionId: number) => Promise<ResearchNote[]>;
  createAiSessionNoteFromArtifact: (artifactId: number) => Promise<ResearchNote>;
  createResearchNote: (input: { collection_id?: number | null; session_id?: number | null; title: string; markdown: string }) => Promise<ResearchNote>;
  runItemTask: (input: {
    item_id: number;
    kind: string;
    prompt?: string;
    stream_id?: string;
  }) => Promise<void>;
  runCollectionTask: (input: {
    collection_id: number;
    kind: string;
    scope_item_ids: number[];
    prompt?: string;
    stream_id?: string;
  }) => Promise<void>;
  listTaskRuns: (input: { item_id?: number; collection_id?: number }) => Promise<AITask[]>;
  listenAiTaskStream: (handler: (event: AITaskStreamEvent) => void) => Promise<() => void>;
  listenLibraryChanged: (handler: (event: LibraryChangedEvent) => void) => Promise<() => void>;
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
  pdfEngineGetOutline: (input: PdfEngineGetOutlineInput) => Promise<PdfOutlineItem[]>;
  pdfEngineGetLinks: (input: PdfEngineGetLinksInput) => Promise<PdfPageLink[]>;
  pdfEngineGetInitialPageBundle: (input: PdfEngineGetPageBundleInput) => Promise<PdfInitialPageBundle>;
  pdfEngineGetPageBundle: (input: PdfEngineGetPageBundleInput) => Promise<PdfPageBundle>;
  pdfEngineGetPageBundlesBatch: (input: PdfEngineGetPageBundlesBatchInput) => Promise<PdfPageBundle[]>;
  pdfEngineGetPageText: (input: PdfEngineGetPageTextInput) => Promise<PdfPageText>;
  pdfEngineGetPageTextsBatch: (input: PdfEngineGetPageTextsBatchInput) => Promise<PdfPageText[]>;
  pdfEngineSearch: (input: PdfEngineSearchInput) => Promise<PdfSearchResult>;
};
