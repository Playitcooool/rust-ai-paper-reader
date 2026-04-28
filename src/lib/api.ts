import type { AppApi } from "./contracts";

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function createTauriApi(): Promise<AppApi> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { open, save } = await import("@tauri-apps/plugin-dialog");
  const toUint8Array = (value: unknown): Uint8Array => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value);
    if (
      value &&
      typeof value === "object" &&
      "data" in value &&
      Array.isArray((value as { data: unknown }).data)
    ) {
      return Uint8Array.from((value as { data: number[] }).data);
    }
    throw new Error("Unexpected attachment byte response.");
  };

  const toPdfPageBundle = (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Unexpected PDF page bundle response.");
    const obj = value as Record<string, unknown>;
    return {
      png_bytes: toUint8Array(obj.png_bytes),
      width_px: Number(obj.width_px),
      height_px: Number(obj.height_px),
      page_width_pt: Number(obj.page_width_pt),
      page_height_pt: Number(obj.page_height_pt),
      spans: Array.isArray(obj.spans)
        ? (obj.spans as unknown[]).map((span) => {
            const s = span && typeof span === "object" ? (span as Record<string, unknown>) : {};
            return {
              text: typeof s.text === "string" ? s.text : "",
              x0: Number(s.x0),
              y0: Number(s.y0),
              x1: Number(s.x1),
              y1: Number(s.y1),
            };
          })
        : [],
    };
  };

  return {
    listCollections: () => invoke("list_collections"),
    createCollection: (input) => invoke("create_collection", { input }),
    moveCollection: (input) => invoke("move_collection", { input }),
    renameCollection: (input) => invoke("rename_collection", { input }),
    removeCollection: (input) => invoke("remove_collection", { input }),
    listTags: (collectionId) => invoke("list_tags", { collectionId }),
    createTag: (input) => invoke("create_tag", { input }),
    assignTag: (input) => invoke("assign_tag", { input }),
    pickCitationPaths: async () => {
      const selection = await open({
        multiple: true,
        filters: [
          {
            name: "Citations",
            extensions: ["bib", "ris"],
          },
        ],
      });
      if (!selection) return [];
      return Array.isArray(selection) ? selection : [selection];
    },
    pickRelinkPath: async () => {
      const selection = await open({
        multiple: false,
      });
      if (!selection || Array.isArray(selection)) return null;
      return selection;
    },
    pickImportPaths: async () => {
      const selection = await open({
        multiple: true,
        filters: [
          {
            name: "Documents",
            extensions: ["pdf", "docx", "epub"],
          },
        ],
      });
      if (!selection) return [];
      return Array.isArray(selection) ? selection : [selection];
    },
    importFiles: (input) => invoke("import_files", { input }),
    importCitations: (input) => invoke("import_citations", { input }),
    refreshAttachmentStatuses: () => invoke("refresh_attachment_statuses"),
    relinkAttachment: (input) => invoke("relink_attachment", { input }),
    updateItemMetadata: (input) => invoke("update_item_metadata", { input }),
    removeItem: (input) => invoke("remove_item", { input }),
    moveItem: (input) => invoke("move_item", { input }),
    listItems: (collectionId) => invoke("list_items", { collectionId }),
    searchItems: (query) => invoke("search_items", { input: { query } }),
    getReaderView: (itemId) => invoke("get_reader_view", { itemId }),
    readPrimaryAttachmentBytes: async (primaryAttachmentId) =>
      toUint8Array(
        await invoke("read_primary_attachment_bytes", {
          primaryAttachmentId,
        }),
      ),
    listAnnotations: (itemId) => invoke("list_annotations", { itemId }),
    createAnnotation: (input) => invoke("create_annotation", { input }),
    removeAnnotation: (input) => invoke("remove_annotation", { input }),
    runItemTask: (input) => invoke("run_item_task", { input }),
    runCollectionTask: (input) => invoke("run_collection_task", { input }),
    listTaskRuns: (input) =>
      invoke("list_task_runs", {
        itemId: input.item_id,
        collectionId: input.collection_id,
      }),
    getArtifact: (input) =>
      invoke("get_artifact", {
        itemId: input.item_id,
        collectionId: input.collection_id,
      }),
    listNotes: (collectionId) => invoke("list_notes", { collectionId }),
    createNoteFromArtifact: (input) =>
      invoke("create_note_from_artifact", { artifactId: input.artifact_id }),
    updateNote: (input) => invoke("update_note", { input }),
    exportNoteMarkdown: (noteId) => invoke("export_note_markdown", { noteId }),
    exportCitation: (itemId, format) => invoke("export_citation", { itemId, format }),
    pickSavePath: async (input) => {
      const selection = await save({
        defaultPath: input.defaultPath,
        filters: input.filters,
      });
      if (!selection || Array.isArray(selection)) return null;
      return selection;
    },
    writeExportFile: (input) => invoke("write_export_file", { input }),
    ocrPdfPage: (input) => invoke("ocr_pdf_page", { input }),
    pdfEngineGetPageBundle: async (input) =>
      toPdfPageBundle(
        await invoke("pdf_engine_get_page_bundle", {
          input,
        }),
      ),
    getClientLogDir: () => invoke("get_client_log_dir"),
    revealClientLogDir: () => invoke("reveal_client_log_dir"),
    appendClientEventLog: (input) => invoke("append_client_event_log", { input }),
  };
}
