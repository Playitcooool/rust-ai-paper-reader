use std::{fs, path::{Path, PathBuf}};

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

fn seed_library_if_empty(library_root: &Path) -> Result<(), String> {
    let service = LibraryService::new(library_root).map_err(|error| error.to_string())?;
    if !service
        .list_collections()
        .map_err(|error| error.to_string())?
        .is_empty()
    {
        return Ok(());
    }

    let ml = service
        .create_collection("Machine Learning", None)
        .map_err(|error| error.to_string())?;
    let systems = service
        .create_collection("Systems", None)
        .map_err(|error| error.to_string())?;

    let seed_dir = library_root.join("seed-inputs");
    fs::create_dir_all(&seed_dir).map_err(|error| error.to_string())?;

    let ml_pdf = seed_dir.join("transformer-scaling-laws.pdf");
    let ml_docx = seed_dir.join("graph-neural-survey.docx");
    let systems_epub = seed_dir.join("distributed-consensus-notes.epub");

    fs::write(
        &ml_pdf,
        b"Scaling behavior emerges when model size, data volume, and compute are balanced. This seed PDF powers the default reader workspace.",
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        &ml_docx,
        b"Graph representation learning unifies message passing, pooling, and graph-level reasoning into a broad survey of architectures and benchmarks.",
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        &systems_epub,
        b"Consensus protocols coordinate replicas under partial failure. This seed EPUB contrasts Paxos, Raft, and operational ergonomics.",
    )
    .map_err(|error| error.to_string())?;

    let ml_items = service
        .import_files(ml.id, &[ml_pdf, ml_docx], ImportMode::ManagedCopy)
        .map_err(|error| error.to_string())?;
    let systems_items = service
        .import_files(systems.id, &[systems_epub], ImportMode::ManagedCopy)
        .map_err(|error| error.to_string())?;

    let scaling = service.create_tag("Scaling").map_err(|error| error.to_string())?;
    let survey = service.create_tag("Survey").map_err(|error| error.to_string())?;
    let distributed = service
        .create_tag("Distributed")
        .map_err(|error| error.to_string())?;
    service
        .assign_tag(ml_items[0].id, scaling.id)
        .map_err(|error| error.to_string())?;
    service
        .assign_tag(ml_items[1].id, survey.id)
        .map_err(|error| error.to_string())?;
    service
        .assign_tag(systems_items[0].id, distributed.id)
        .map_err(|error| error.to_string())?;

    Ok(())
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
            seed_library_if_empty(&library_root)?;
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
