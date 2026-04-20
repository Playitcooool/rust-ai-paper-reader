import type { AppApi } from "./contracts";
import { mockApi } from "./mockApi";

const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function createTauriApi(): Promise<AppApi> {
  const { invoke } = await import("@tauri-apps/api/core");

  return {
    listCollections: () => invoke("list_collections"),
    createCollection: (input) => invoke("create_collection", { input }),
    listItems: (collectionId) => invoke("list_items", { collectionId }),
    searchItems: (query) => invoke("search_items", { input: { query } }),
    getReaderView: (itemId) => invoke("get_reader_view", { itemId }),
    listAnnotations: (itemId) => invoke("list_annotations", { itemId }),
    createAnnotation: (input) => invoke("create_annotation", { input }),
    runItemTask: (input) => invoke("run_item_task", { input }),
    runCollectionTask: (input) => invoke("run_collection_task", { input }),
    getArtifact: (input) =>
      invoke("get_artifact", {
        itemId: input.item_id,
        collectionId: input.collection_id,
      }),
    listNotes: (collectionId) => invoke("list_notes", { collectionId }),
    createNoteFromArtifact: (collectionId) =>
      invoke("create_note_from_artifact", { collectionId }),
    exportNoteMarkdown: (noteId) => invoke("export_note_markdown", { noteId }),
    exportCitation: (itemId) => invoke("export_citation", { itemId }),
  };
}

let apiPromise: Promise<AppApi> | null = null;

export function getApi(): Promise<AppApi> {
  if (!apiPromise) {
    apiPromise = isTauriRuntime() ? createTauriApi() : Promise.resolve(mockApi);
  }
  return apiPromise;
}

