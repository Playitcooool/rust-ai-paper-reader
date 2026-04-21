use std::{fs, path::PathBuf};

use app_core::service::{
    Annotation, Collection, ImportMode, LibraryItem, LibraryService, ReaderView, ResearchNote, Tag,
};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

struct AppState {
    library_root: PathBuf,
}

#[derive(Deserialize)]
struct CreateCollectionInput {
    name: String,
    parent_id: Option<i64>,
}

#[derive(Deserialize)]
struct MoveCollectionInput {
    collection_id: i64,
    parent_id: Option<i64>,
}

#[derive(Deserialize)]
struct CreateTagInput {
    name: String,
}

#[derive(Deserialize)]
struct AssignTagInput {
    item_id: i64,
    tag_id: i64,
}

#[derive(Deserialize)]
struct ImportFilesInput {
    collection_id: i64,
    paths: Vec<String>,
    mode: String,
}

#[derive(Deserialize)]
struct ImportCitationsInput {
    collection_id: i64,
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct SearchItemsInput {
    query: String,
}

#[derive(Deserialize)]
struct CreateAnnotationInput {
    item_id: i64,
    anchor: String,
    kind: String,
    body: String,
}

#[derive(Deserialize)]
struct RelinkAttachmentInput {
    attachment_id: i64,
    replacement_path: String,
}

#[derive(Deserialize)]
struct UpdateItemMetadataInput {
    item_id: i64,
    title: String,
    authors: String,
    publication_year: Option<i64>,
    source: String,
    doi: Option<String>,
}

#[derive(Deserialize)]
struct RemoveItemInput {
    item_id: i64,
}

#[derive(Deserialize)]
struct MoveItemInput {
    item_id: i64,
    collection_id: i64,
}

#[derive(Deserialize)]
struct RunItemTaskInput {
    item_id: i64,
    kind: String,
}

#[derive(Deserialize)]
struct RunCollectionTaskInput {
    collection_id: i64,
    kind: String,
}

#[derive(Deserialize)]
struct UpdateNoteInput {
    note_id: i64,
    markdown: String,
}

fn service(state: &AppState) -> Result<LibraryService, String> {
    LibraryService::new(&state.library_root).map_err(|error| error.to_string())
}

fn root_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("paper-reader-dev"))
}

#[tauri::command]
fn list_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    service(&state)?
        .list_collections()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_collection(
    state: State<'_, AppState>,
    input: CreateCollectionInput,
) -> Result<Collection, String> {
    service(&state)?
        .create_collection(&input.name, input.parent_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_collection(
    state: State<'_, AppState>,
    input: MoveCollectionInput,
) -> Result<(), String> {
    service(&state)?
        .move_collection(input.collection_id, input.parent_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_tags(state: State<'_, AppState>, collection_id: Option<i64>) -> Result<Vec<Tag>, String> {
    service(&state)?
        .list_tags(collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_tag(state: State<'_, AppState>, input: CreateTagInput) -> Result<Tag, String> {
    service(&state)?
        .create_tag(&input.name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn assign_tag(state: State<'_, AppState>, input: AssignTagInput) -> Result<(), String> {
    service(&state)?
        .assign_tag(input.item_id, input.tag_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_items(
    state: State<'_, AppState>,
    collection_id: Option<i64>,
) -> Result<Vec<LibraryItem>, String> {
    service(&state)?
        .list_items(collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn search_items(
    state: State<'_, AppState>,
    input: SearchItemsInput,
) -> Result<Vec<LibraryItem>, String> {
    service(&state)?
        .search_items(&input.query)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_files(
    state: State<'_, AppState>,
    input: ImportFilesInput,
) -> Result<Vec<app_core::service::ImportedItem>, String> {
    let mode = match input.mode.as_str() {
        "managed_copy" => ImportMode::ManagedCopy,
        "linked_file" => ImportMode::LinkedFile,
        _ => return Err("unsupported import mode".into()),
    };
    let paths = input.paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    service(&state)?
        .import_files(input.collection_id, &paths, mode)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_citations(
    state: State<'_, AppState>,
    input: ImportCitationsInput,
) -> Result<Vec<app_core::service::ImportedItem>, String> {
    let paths = input.paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    service(&state)?
        .import_citations(input.collection_id, &paths)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn relink_attachment(
    state: State<'_, AppState>,
    input: RelinkAttachmentInput,
) -> Result<(), String> {
    service(&state)?
        .relink_attachment(input.attachment_id, PathBuf::from(input.replacement_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_item_metadata(
    state: State<'_, AppState>,
    input: UpdateItemMetadataInput,
) -> Result<(), String> {
    service(&state)?
        .update_item_metadata(
            input.item_id,
            input.title,
            input.authors,
            input.publication_year,
            input.source,
            input.doi,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_item(state: State<'_, AppState>, input: RemoveItemInput) -> Result<(), String> {
    service(&state)?
        .remove_item(input.item_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_item(state: State<'_, AppState>, input: MoveItemInput) -> Result<(), String> {
    service(&state)?
        .move_item(input.item_id, input.collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_reader_view(state: State<'_, AppState>, item_id: i64) -> Result<ReaderView, String> {
    service(&state)?
        .get_reader_view(item_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_annotation(
    state: State<'_, AppState>,
    input: CreateAnnotationInput,
) -> Result<Annotation, String> {
    service(&state)?
        .create_annotation(input.item_id, input.anchor, input.kind, input.body)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_annotations(state: State<'_, AppState>, item_id: i64) -> Result<Vec<Annotation>, String> {
    service(&state)?
        .list_annotations(item_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn run_item_task(
    state: State<'_, AppState>,
    input: RunItemTaskInput,
) -> Result<app_core::service::AITask, String> {
    match input.kind.as_str() {
        "item.summarize" | "item.translate" | "item.explain_term" | "item.ask" => service(&state)?
            .run_item_task(input.item_id, &input.kind)
            .map_err(|error| error.to_string()),
        _ => Err("unsupported item task".into()),
    }
}

#[tauri::command]
fn run_collection_task(
    state: State<'_, AppState>,
    input: RunCollectionTaskInput,
) -> Result<app_core::service::AITask, String> {
    match input.kind.as_str() {
        "collection.review_draft"
        | "collection.bulk_summarize"
        | "collection.theme_map"
        | "collection.compare_methods" => service(&state)?
            .run_collection_task(input.collection_id, &input.kind)
            .map_err(|error| error.to_string()),
        _ => Err("unsupported collection task".into()),
    }
}

#[tauri::command]
fn list_task_runs(
    state: State<'_, AppState>,
    item_id: Option<i64>,
    collection_id: Option<i64>,
) -> Result<Vec<app_core::service::AITask>, String> {
    service(&state)?
        .list_task_runs(item_id, collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_artifact(
    state: State<'_, AppState>,
    item_id: Option<i64>,
    collection_id: Option<i64>,
) -> Result<Option<app_core::service::AIArtifact>, String> {
    service(&state)?
        .get_latest_artifact(item_id, collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_notes(
    state: State<'_, AppState>,
    collection_id: Option<i64>,
) -> Result<Vec<ResearchNote>, String> {
    service(&state)?
        .list_notes(collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_note_from_artifact(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<ResearchNote, String> {
    service(&state)?
        .create_note_from_latest_collection_artifact(collection_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_note(state: State<'_, AppState>, input: UpdateNoteInput) -> Result<(), String> {
    service(&state)?
        .update_note(input.note_id, input.markdown)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_note_markdown(state: State<'_, AppState>, note_id: i64) -> Result<String, String> {
    service(&state)?
        .export_note_markdown(note_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_citation(
    state: State<'_, AppState>,
    item_id: i64,
    format: Option<String>,
) -> Result<String, String> {
    service(&state)?
        .export_citation(item_id, format.as_deref().unwrap_or("apa7"))
        .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let library_root = root_dir(app.handle());
            fs::create_dir_all(&library_root)?;
            app.manage(AppState { library_root });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_collections,
            create_collection,
            move_collection,
            list_tags,
            create_tag,
            assign_tag,
            list_items,
            search_items,
            import_files,
            import_citations,
            relink_attachment,
            update_item_metadata,
            remove_item,
            move_item,
            get_reader_view,
            create_annotation,
            list_annotations,
            run_item_task,
            run_collection_task,
            list_task_runs,
            get_artifact,
            list_notes,
            create_note_from_artifact,
            update_note,
            export_note_markdown,
            export_citation
        ])
        .run(tauri::generate_context!())
        .expect("failed to run paper-reader desktop app");
}
