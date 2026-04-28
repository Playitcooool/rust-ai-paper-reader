use std::{
    ffi::CString,
    fs,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use app_core::service::{
    Annotation, Collection, ImportBatchResult, ImportMode, LibraryItem, LibraryService, ReaderView,
    ResearchNote, Tag,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{menu::{MenuBuilder, SubmenuBuilder}, AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;

use tesseract_ocr_static::{Config as TesseractConfig, Image as TessImage, PageSegmentationMode, TextRecognizer};

struct AppState {
    library_root: PathBuf,
}

static OCR_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Deserialize)]
struct ClientLogEvent {
    ts_ms: i64,
    kind: String,
    data: JsonValue,
}

#[derive(Deserialize)]
struct AppendClientEventLogInput {
    session_id: String,
    events: Vec<ClientLogEvent>,
}

#[derive(Serialize)]
struct ClientLogLine<'a> {
    session_id: &'a str,
    ts_ms: i64,
    kind: &'a str,
    data: &'a JsonValue,
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
struct RenameCollectionInput {
    collection_id: i64,
    name: String,
}

#[derive(Deserialize)]
struct RemoveCollectionInput {
    collection_id: i64,
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
struct RemoveAnnotationInput {
    annotation_id: i64,
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
    scope_item_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct UpdateNoteInput {
    note_id: i64,
    markdown: String,
}

#[derive(Deserialize)]
struct WriteExportFileInput {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
struct OcrPdfPageInput {
    primary_attachment_id: i64,
    page_index0: i64,
    png_bytes: Vec<u8>,
    lang: Option<String>,
    config_version: String,
    source_resolution: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OcrBbox {
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OcrLine {
    text: String,
    bbox: OcrBbox,
    confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OcrPageResult {
    primary_attachment_id: i64,
    page_index0: i64,
    lang: String,
    config_version: String,
    lines: Vec<OcrLine>,
}

fn service(state: &AppState) -> Result<LibraryService, String> {
    LibraryService::new(&state.library_root).map_err(|error| error.to_string())
}

fn root_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("paper-reader-dev"))
}

fn resolve_tessdata_dir(app: &AppHandle) -> PathBuf {
    // Packaged builds: tauri bundles resources under the app resource dir.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("resources").join("tessdata");
        if packaged.exists() {
            return packaged;
        }
    }

    // Dev fallback: `CARGO_MANIFEST_DIR` points at `src-tauri/`.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("tessdata")
}

fn normalize_ocr_text(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn cache_path_for_ocr(state: &AppState, input: &OcrPdfPageInput, lang: &str) -> PathBuf {
    // Stable cache key for anchor stability across sessions.
    state
        .library_root
        .join("ocr_cache")
        .join(&input.config_version)
        .join(lang)
        .join(input.primary_attachment_id.to_string())
        .join(format!("{}.json", input.page_index0))
}

fn parse_tesseract_tsv_to_lines(tsv_str: &str, image_width: u32, image_height: u32) -> Vec<OcrLine> {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct LineKey {
        block: i32,
        para: i32,
        line: i32,
    }

    #[derive(Debug)]
    struct LineAgg {
        left: u32,
        top: u32,
        right: u32,
        bottom: u32,
        words: Vec<String>,
        confidences: Vec<f32>,
    }

    let mut lines: Vec<LineAgg> = Vec::new();
    let mut current_key: Option<LineKey> = None;
    let mut current: Option<LineAgg> = None;

    let mut header_map: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut saw_header = false;

    for (idx, row) in tsv_str.lines().enumerate() {
        if idx == 0 {
            // Header: map column names to indices so we don't rely on column ordering.
            // Expected Tesseract TSV columns include:
            // level page_num block_num par_num line_num word_num left top width height conf text
            for (col_index, name) in row.split('\t').enumerate() {
                header_map.insert(name.trim(), col_index);
            }
            saw_header = true;
            continue;
        }
        if row.trim().is_empty() {
            continue;
        }
        if !saw_header {
            continue;
        }

        let cols = row.split('\t').collect::<Vec<_>>();
        let get = |name: &str| -> Option<&str> {
            let idx = *header_map.get(name)?;
            cols.get(idx).copied()
        };

        let Some(level_str) = get("level") else { continue };
        let Ok(level) = level_str.parse::<i32>() else { continue };
        // Only aggregate word-level rows.
        if level != 5 {
            continue;
        }

        let block: i32 = get("block_num").and_then(|value| value.parse().ok()).unwrap_or(-1);
        let para: i32 = get("par_num").and_then(|value| value.parse().ok()).unwrap_or(-1);
        let line: i32 = get("line_num").and_then(|value| value.parse().ok()).unwrap_or(-1);
        let key = LineKey { block, para, line };

        let left: u32 = get("left").and_then(|value| value.parse().ok()).unwrap_or(0);
        let top: u32 = get("top").and_then(|value| value.parse().ok()).unwrap_or(0);
        let w: u32 = get("width").and_then(|value| value.parse().ok()).unwrap_or(0);
        let h: u32 = get("height").and_then(|value| value.parse().ok()).unwrap_or(0);
        let right = left.saturating_add(w);
        let bottom = top.saturating_add(h);

        let conf: f32 = get("conf").and_then(|value| value.parse().ok()).unwrap_or(-1.0);
        let word = get("text").unwrap_or("");
        if conf < 0.0 {
            continue;
        }
        let normalized_word = normalize_ocr_text(word);
        if normalized_word.is_empty() {
            continue;
        }

        if current_key != Some(key) {
            if let Some(agg) = current.take() {
                lines.push(agg);
            }
            current_key = Some(key);
            current = Some(LineAgg {
                left,
                top,
                right,
                bottom,
                words: Vec::new(),
                confidences: Vec::new(),
            });
        }

        let agg = current.as_mut().expect("current agg");
        agg.left = agg.left.min(left);
        agg.top = agg.top.min(top);
        agg.right = agg.right.max(right);
        agg.bottom = agg.bottom.max(bottom);
        agg.words.push(normalized_word);
        agg.confidences.push(conf);
    }

    if let Some(agg) = current.take() {
        lines.push(agg);
    }

    let width_f = image_width.max(1) as f32;
    let height_f = image_height.max(1) as f32;
    let mut out_lines: Vec<OcrLine> = Vec::new();
    for agg in lines {
        let text = agg.words.join(" ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let confidence = if agg.confidences.is_empty() {
            0.0
        } else {
            agg.confidences.iter().copied().sum::<f32>() / (agg.confidences.len() as f32)
        };
        out_lines.push(OcrLine {
            text,
            bbox: OcrBbox {
                left: (agg.left as f32) / width_f,
                top: (agg.top as f32) / height_f,
                width: ((agg.right.saturating_sub(agg.left)) as f32) / width_f,
                height: ((agg.bottom.saturating_sub(agg.top)) as f32) / height_f,
            },
            confidence,
        });
    }

    out_lines
}

fn read_cached_ocr(path: &PathBuf) -> Option<OcrPageResult> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<OcrPageResult>(&bytes).ok()
}

fn write_cached_ocr_atomic(path: &PathBuf, result: &OcrPageResult) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(result).map_err(|error| error.to_string())?;
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn client_logs_dir(state: &AppState) -> PathBuf {
    state.library_root.join("client_logs")
}

fn client_log_file_path(state: &AppState) -> PathBuf {
    client_logs_dir(state).join("ui-events.jsonl")
}

fn ensure_client_logs_dir(state: &AppState) -> Result<PathBuf, String> {
    let dir = client_logs_dir(state);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

#[cfg(not(test))]
fn reveal_dir_in_file_manager(dir: &PathBuf) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(dir)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // Prefer absolute path if PATH is restricted in the packaged runtime.
        let xdg = if PathBuf::from("/usr/bin/xdg-open").exists() {
            "/usr/bin/xdg-open"
        } else {
            "xdg-open"
        };
        Command::new(xdg)
            .arg(dir)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(test)]
fn reveal_dir_in_file_manager(_dir: &PathBuf) -> Result<(), String> {
    // Avoid spawning OS processes in unit tests/CI.
    Ok(())
}

fn rotate_client_log_if_needed(path: &PathBuf) -> Result<(), String> {
    const MAX_BYTES: u64 = 5 * 1024 * 1024;
    const MAX_BACKUPS: usize = 3;

    let size = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(_) => return Ok(()),
    };
    if size <= MAX_BYTES {
        return Ok(());
    }

    let dir = path.parent().ok_or_else(|| "invalid log path".to_string())?;
    let base_name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| "invalid log filename".to_string())?
        .to_string();

    // Remove the oldest backup first.
    let oldest = dir.join(format!("{base_name}.{MAX_BACKUPS}"));
    let _ = fs::remove_file(&oldest);

    // Shift backups: .2 -> .3, .1 -> .2
    for idx in (1..MAX_BACKUPS).rev() {
        let from = dir.join(format!("{base_name}.{idx}"));
        let to = dir.join(format!("{base_name}.{}", idx + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }

    // Move current file to .1
    let first = dir.join(format!("{base_name}.1"));
    let _ = fs::rename(path, &first);
    Ok(())
}

fn append_client_log_lines(
    state: &AppState,
    session_id: &str,
    events: &[ClientLogEvent],
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }

    let dir = client_logs_dir(state);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let path = client_log_file_path(state);
    rotate_client_log_if_needed(&path)?;

    // Serialize to a single buffer to reduce interleaving risk.
    let mut buf: Vec<u8> = Vec::with_capacity(events.len() * 256);
    for event in events {
        let line = ClientLogLine {
            session_id,
            ts_ms: event.ts_ms,
            kind: event.kind.as_str(),
            data: &event.data,
        };
        serde_json::to_writer(&mut buf, &line).map_err(|error| error.to_string())?;
        buf.push(b'\n');
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&buf).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn ocr_pdf_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OcrPdfPageInput,
) -> Result<OcrPageResult, String> {
    let lang = input.lang.clone().unwrap_or_else(|| "eng+chi_sim".to_string());
    let cache_path = cache_path_for_ocr(&state, &input, &lang);
    if let Some(cached) = read_cached_ocr(&cache_path) {
        return Ok(cached);
    }

    // Avoid kicking off many OCR jobs at once when in continuous scroll.
    let semaphore = OCR_SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(2))).clone();
    let _permit = semaphore.acquire_owned().await.map_err(|_| "OCR queue closed")?;

    // Decode PNG -> RGBA
    let decoded = image::load_from_memory_with_format(&input.png_bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = decoded.dimensions();
    let tess_image =
        TessImage::from_rgba(width, height, decoded.as_raw()).map_err(|_| "invalid OCR image")?;

    // Configure tesseract.
    let tessdata_dir = resolve_tessdata_dir(&app);
    let data_dir = CString::new(
        tessdata_dir
            .to_string_lossy()
            .as_ref()
            .to_string(),
    )
    .map_err(|_| "invalid tessdata path")?;
    let languages = CString::new(lang.as_str()).map_err(|_| "invalid OCR language")?;
    let mut recognizer = TextRecognizer::with_config(TesseractConfig {
        data_dir: Some(data_dir.as_c_str()),
        languages: languages.as_c_str(),
        ..Default::default()
    })
    .map_err(|_| "tesseract init failed (missing tessdata?)")?;
    recognizer.set_page_segmentation_mode(PageSegmentationMode::SingleBlock);
    recognizer.set_source_resolution(input.source_resolution.unwrap_or(300));

    let results = recognizer
        .recognize_text(&tess_image)
        .map_err(|_| "tesseract recognition failed")?;

    // Use TSV output for stable per-line grouping with bounding boxes and confidences.
    let tsv = results.get_tsv_text(0);
    let tsv_str = std::str::from_utf8(tsv.as_c_str().to_bytes()).unwrap_or("");
    let out_lines = parse_tesseract_tsv_to_lines(tsv_str, width, height);

    let result = OcrPageResult {
        primary_attachment_id: input.primary_attachment_id,
        page_index0: input.page_index0,
        lang,
        config_version: input.config_version,
        lines: out_lines,
    };

    // Best-effort cache write; OCR results are still returned even if disk write fails.
    let _ = write_cached_ocr_atomic(&cache_path, &result);
    Ok(result)
}

#[tauri::command]
fn get_client_log_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = ensure_client_logs_dir(&state)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_client_log_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = ensure_client_logs_dir(&state)?;
    reveal_dir_in_file_manager(&dir)?;
    Ok(())
}

#[tauri::command]
fn append_client_event_log(
    state: State<'_, AppState>,
    input: AppendClientEventLogInput,
) -> Result<(), String> {
    append_client_log_lines(&state, &input.session_id, &input.events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tempfile::tempdir;

    #[test]
    fn parses_tesseract_tsv_word_rows_with_header_mapping() {
        let tsv = [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "4\t1\t1\t1\t1\t0\t100\t200\t100\t10\t-1\t",
            "5\t1\t1\t1\t1\t1\t100\t200\t50\t10\t90\tHello",
            "5\t1\t1\t1\t1\t2\t160\t200\t40\t10\t80\tworld",
        ]
        .join("\n");

        let lines = parse_tesseract_tsv_to_lines(&tsv, 1000, 2000);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world");
        assert!((lines[0].bbox.left - 0.1).abs() < 1e-6);
        assert!((lines[0].bbox.top - 0.1).abs() < 1e-6);
        assert!((lines[0].bbox.width - 0.1).abs() < 1e-6);
        assert!((lines[0].bbox.height - 0.005).abs() < 1e-6);
        assert!((lines[0].confidence - 85.0).abs() < 1e-6);
    }

    #[test]
    fn appends_client_log_as_jsonl_one_line_per_event() {
        let dir = tempdir().expect("tempdir");
        let state = AppState {
            library_root: dir.path().to_path_buf(),
        };

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let events = vec![
            ClientLogEvent {
                ts_ms: now_ms,
                kind: "test_event_1".to_string(),
                data: serde_json::json!({"a": 1}),
            },
            ClientLogEvent {
                ts_ms: now_ms + 1,
                kind: "test_event_2".to_string(),
                data: serde_json::json!({"b": true}),
            },
        ];

        append_client_log_lines(&state, "session-abc", &events).expect("append");

        let path = client_log_file_path(&state);
        let content = fs::read_to_string(&path).expect("read");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        for (idx, line) in lines.iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(line).expect("json");
            assert_eq!(parsed["session_id"], "session-abc");
            assert_eq!(parsed["kind"], events[idx].kind);
        }
    }

    #[test]
    fn rotates_client_log_when_exceeding_limit() {
        let dir = tempdir().expect("tempdir");
        let state = AppState {
            library_root: dir.path().to_path_buf(),
        };
        let logs_dir = client_logs_dir(&state);
        fs::create_dir_all(&logs_dir).unwrap();

        // Create an oversized log file to force rotation.
        let path = client_log_file_path(&state);
        fs::write(&path, vec![b'x'; (5 * 1024 * 1024) as usize + 10]).unwrap();

        let events = vec![ClientLogEvent {
            ts_ms: 1,
            kind: "after_rotate".to_string(),
            data: serde_json::json!({}),
        }];
        append_client_log_lines(&state, "s", &events).expect("append");

        assert!(path.exists());
        let backup1 = logs_dir.join("ui-events.jsonl.1");
        assert!(backup1.exists());
    }

    #[test]
    fn reveal_client_log_dir_creates_directory() {
        let dir = tempdir().expect("tempdir");
        let state = AppState {
            library_root: dir.path().to_path_buf(),
        };

        let logs_dir = client_logs_dir(&state);
        assert!(!logs_dir.exists());

        let created = ensure_client_logs_dir(&state).expect("ensure_client_logs_dir");
        assert_eq!(created, logs_dir);
        assert!(logs_dir.exists());
    }
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
fn rename_collection(
    state: State<'_, AppState>,
    input: RenameCollectionInput,
) -> Result<(), String> {
    service(&state)?
        .rename_collection(input.collection_id, &input.name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_collection(
    state: State<'_, AppState>,
    input: RemoveCollectionInput,
) -> Result<(), String> {
    service(&state)?
        .remove_collection(input.collection_id)
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
) -> Result<ImportBatchResult, String> {
    let paths = input.paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    service(&state)?
        .import_files(input.collection_id, &paths, ImportMode::ManagedCopy)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_citations(
    state: State<'_, AppState>,
    input: ImportCitationsInput,
) -> Result<ImportBatchResult, String> {
    let paths = input.paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    service(&state)?
        .import_citations(input.collection_id, &paths)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn refresh_attachment_statuses(state: State<'_, AppState>) -> Result<(), String> {
    service(&state)?
        .refresh_attachment_statuses()
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
    let svc = service(&state)?;
    // Lazy self-heal: opening a PDF upgrades legacy extracted content + search index if needed.
    let _ = svc.repair_item_content_if_needed(item_id);
    svc.get_reader_view(item_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_primary_attachment_bytes(
    state: State<'_, AppState>,
    primary_attachment_id: i64,
) -> Result<tauri::ipc::Response, String> {
    let bytes = service(&state)?
        .read_primary_attachment_bytes(primary_attachment_id)
        .map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
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
fn remove_annotation(
    state: State<'_, AppState>,
    input: RemoveAnnotationInput,
) -> Result<(), String> {
    service(&state)?
        .remove_annotation(input.annotation_id)
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
            .run_collection_task(input.collection_id, &input.kind, &input.scope_item_ids)
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
    artifact_id: i64,
) -> Result<ResearchNote, String> {
    service(&state)?
        .create_note_from_artifact(artifact_id)
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

#[tauri::command]
fn write_export_file(input: WriteExportFileInput) -> Result<(), String> {
    let path = PathBuf::from(input.path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, input.contents).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let library_root = root_dir(app.handle());
            fs::create_dir_all(&library_root)?;
            // Startup backfill (non-blocking): upgrade legacy PDF extraction results in the background.
            let background_root = library_root.clone();
            app.manage(AppState { library_root });
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok(service) = LibraryService::new(&background_root) {
                    let _ = service.repair_library_content_if_needed();
                }
            });

            // Native menu: all imports flow through the same Managed Copy import path on the frontend.
            let file_menu = SubmenuBuilder::new(app, "File")
                .text("import_documents", "Import Documents")
                .text("import_citations", "Import Citations")
                .separator()
                .quit()
                .build()?;
            let menu = MenuBuilder::new(app).item(&file_menu).build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app_handle, event| match event.id().0.as_str() {
                "import_documents" => {
                    let _ = app_handle.emit("menu:import-documents", ());
                }
                "import_citations" => {
                    let _ = app_handle.emit("menu:import-citations", ());
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_collections,
            create_collection,
            move_collection,
            rename_collection,
            remove_collection,
            list_tags,
            create_tag,
            assign_tag,
            list_items,
            search_items,
            import_files,
            import_citations,
            refresh_attachment_statuses,
            relink_attachment,
            update_item_metadata,
            remove_item,
            move_item,
            get_reader_view,
            read_primary_attachment_bytes,
            create_annotation,
            list_annotations,
            remove_annotation,
            run_item_task,
            run_collection_task,
            list_task_runs,
            get_artifact,
            list_notes,
            create_note_from_artifact,
            update_note,
            export_note_markdown,
            export_citation,
            write_export_file,
            ocr_pdf_page,
            get_client_log_dir,
            reveal_client_log_dir,
            append_client_event_log
        ])
        .run(tauri::generate_context!())
        .expect("failed to run paper-reader desktop app");
}
