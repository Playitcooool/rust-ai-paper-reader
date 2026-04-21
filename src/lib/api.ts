import type { AppApi } from "./contracts";
import { mockApi } from "./mockApi";

const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function createTauriApi(): Promise<AppApi> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { open } = await import("@tauri-apps/plugin-dialog");

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
    relinkAttachment: (input) => invoke("relink_attachment", { input }),
    updateItemMetadata: (input) => invoke("update_item_metadata", { input }),
    removeItem: (input) => invoke("remove_item", { input }),
    moveItem: (input) => invoke("move_item", { input }),
    listItems: (collectionId) => invoke("list_items", { collectionId }),
    searchItems: (query) => invoke("search_items", { input: { query } }),
    getReaderView: (itemId) => invoke("get_reader_view", { itemId }),
    listAnnotations: (itemId) => invoke("list_annotations", { itemId }),
    createAnnotation: (input) => invoke("create_annotation", { input }),
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
    createNoteFromArtifact: (collectionId) =>
      invoke("create_note_from_artifact", { collectionId }),
    updateNote: (input) => invoke("update_note", { input }),
    exportNoteMarkdown: (noteId) => invoke("export_note_markdown", { noteId }),
    exportCitation: (itemId, format) => invoke("export_citation", { itemId, format }),
  };
}

let apiPromise: Promise<AppApi> | null = null;

export function getApi(): Promise<AppApi> {
  if (!apiPromise) {
    apiPromise = isTauriRuntime() ? createTauriApi() : Promise.resolve(mockApi);
  }
  return apiPromise;
}
