use std::{
    collections::{HashMap, VecDeque},
    ffi::CString,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use app_core::service::{
    Annotation, Collection, ImportBatchResult, ImportMode, LibraryItem, LibraryService, ReaderView,
    ResearchNote, Tag,
};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, State,
};
use tokio::sync::Semaphore;

use pdf_oxide::{
    document::PdfDocument as OxidePdfDocument,
    rendering::{render_page, ImageFormat, RenderOptions},
};
use tesseract_ocr_static::{
    Config as TesseractConfig, Image as TessImage, PageSegmentationMode, TextRecognizer,
};

struct AppState {
    library_root: PathBuf,
    pdf_cache: Arc<Mutex<PdfEngineCache>>,
}

static OCR_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
static PDF_RENDER_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

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
    prompt: Option<String>,
}

#[derive(Deserialize)]
struct RunCollectionTaskInput {
    collection_id: i64,
    kind: String,
    scope_item_ids: Vec<i64>,
    prompt: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfTextSpan {
    text: String,
    // PDF points, origin at bottom-left. We keep this stable and convert in the frontend.
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfPageBundle {
    png_bytes: Vec<u8>,
    width_px: u32,
    height_px: u32,
    page_width_pt: f32,
    page_height_pt: f32,
    spans: Vec<PdfTextSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfPageInfo {
    width_pt: f32,
    height_pt: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfDocumentInfo {
    page_count: usize,
    pages: Vec<PdfPageInfo>,
}

#[derive(Deserialize)]
struct PdfEngineGetPageBundleInput {
    primary_attachment_id: i64,
    page_index0: i64,
    target_width_px: u32,
}

#[derive(Deserialize)]
struct PdfEngineGetDocumentInfoInput {
    primary_attachment_id: i64,
}

#[derive(Deserialize)]
struct PdfEngineGetPageTextInput {
    primary_attachment_id: i64,
    page_index0: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfPageText {
    page_index0: i64,
    spans: Vec<PdfTextSpan>,
}

#[derive(Default)]
struct PdfEngineCache {
    document_info_by_attachment: HashMap<i64, PdfDocumentInfo>,
    text_spans_by_page: HashMap<(i64, i64), Vec<PdfTextSpan>>,
    text_spans_order: VecDeque<(i64, i64)>,
    bundle_by_key: HashMap<(i64, i64, u32), PdfPageBundle>,
    bundle_order: VecDeque<(i64, i64, u32)>,
    bundle_total_bytes: usize,
}

const PDF_TEXT_PAGE_CACHE_LIMIT: usize = 64;
const PDF_BUNDLE_CACHE_ENTRY_LIMIT: usize = 24;
const PDF_BUNDLE_CACHE_BYTES_LIMIT: usize = 96 * 1024 * 1024;

fn service(state: &AppState) -> Result<LibraryService, String> {
    LibraryService::new(&state.library_root).map_err(|error| error.to_string())
}

fn service_for_root(library_root: &PathBuf) -> Result<LibraryService, String> {
    LibraryService::new(library_root).map_err(|error| error.to_string())
}

fn remember_text_spans(cache: &mut PdfEngineCache, key: (i64, i64), spans: Vec<PdfTextSpan>) {
    cache.text_spans_by_page.insert(key, spans);
    cache.text_spans_order.retain(|existing| existing != &key);
    cache.text_spans_order.push_back(key);
    while cache.text_spans_order.len() > PDF_TEXT_PAGE_CACHE_LIMIT {
        if let Some(oldest) = cache.text_spans_order.pop_front() {
            cache.text_spans_by_page.remove(&oldest);
        }
    }
}

fn bundle_weight(bundle: &PdfPageBundle) -> usize {
    let span_text_bytes = bundle
        .spans
        .iter()
        .map(|span| span.text.len() + std::mem::size_of::<PdfTextSpan>())
        .sum::<usize>();
    bundle.png_bytes.len() + span_text_bytes
}

fn remember_page_bundle(cache: &mut PdfEngineCache, key: (i64, i64, u32), bundle: PdfPageBundle) {
    if let Some(previous) = cache.bundle_by_key.remove(&key) {
        cache.bundle_total_bytes = cache
            .bundle_total_bytes
            .saturating_sub(bundle_weight(&previous));
        cache.bundle_order.retain(|existing| existing != &key);
    }
    cache.bundle_total_bytes = cache
        .bundle_total_bytes
        .saturating_add(bundle_weight(&bundle));
    cache.bundle_by_key.insert(key, bundle);
    cache.bundle_order.push_back(key);

    while cache.bundle_order.len() > PDF_BUNDLE_CACHE_ENTRY_LIMIT
        || cache.bundle_total_bytes > PDF_BUNDLE_CACHE_BYTES_LIMIT
    {
        let Some(oldest) = cache.bundle_order.pop_front() else {
            break;
        };
        if let Some(removed) = cache.bundle_by_key.remove(&oldest) {
            cache.bundle_total_bytes = cache
                .bundle_total_bytes
                .saturating_sub(bundle_weight(&removed));
        }
    }
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

fn parse_tesseract_tsv_to_lines(
    tsv_str: &str,
    image_width: u32,
    image_height: u32,
) -> Vec<OcrLine> {
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

        let Some(level_str) = get("level") else {
            continue;
        };
        let Ok(level) = level_str.parse::<i32>() else {
            continue;
        };
        // Only aggregate word-level rows.
        if level != 5 {
            continue;
        }

        let block: i32 = get("block_num")
            .and_then(|value| value.parse().ok())
            .unwrap_or(-1);
        let para: i32 = get("par_num")
            .and_then(|value| value.parse().ok())
            .unwrap_or(-1);
        let line: i32 = get("line_num")
            .and_then(|value| value.parse().ok())
            .unwrap_or(-1);
        let key = LineKey { block, para, line };

        let left: u32 = get("left")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let top: u32 = get("top").and_then(|value| value.parse().ok()).unwrap_or(0);
        let w: u32 = get("width")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let h: u32 = get("height")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let right = left.saturating_add(w);
        let bottom = top.saturating_add(h);

        let conf: f32 = get("conf")
            .and_then(|value| value.parse().ok())
            .unwrap_or(-1.0);
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

#[tauri::command]
async fn ocr_pdf_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OcrPdfPageInput,
) -> Result<OcrPageResult, String> {
    let lang = input
        .lang
        .clone()
        .unwrap_or_else(|| "eng+chi_sim".to_string());
    let cache_path = cache_path_for_ocr(&state, &input, &lang);
    if let Some(cached) = read_cached_ocr(&cache_path) {
        return Ok(cached);
    }

    // Avoid kicking off many OCR jobs at once when in continuous scroll.
    let semaphore = OCR_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone();
    let _permit = semaphore
        .acquire_owned()
        .await
        .map_err(|_| "OCR queue closed")?;

    // Decode PNG -> RGBA
    let decoded = image::load_from_memory_with_format(&input.png_bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = decoded.dimensions();
    let tess_image =
        TessImage::from_rgba(width, height, decoded.as_raw()).map_err(|_| "invalid OCR image")?;

    // Configure tesseract.
    let tessdata_dir = resolve_tessdata_dir(&app);
    let data_dir = CString::new(tessdata_dir.to_string_lossy().as_ref().to_string())
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

fn width_bucket(width_px: u32) -> u32 {
    let bucket = 64;
    ((width_px + bucket - 1) / bucket) * bucket
}

fn spans_from_document(
    doc: &OxidePdfDocument,
    page_index: usize,
) -> Result<Vec<PdfTextSpan>, String> {
    let spans_raw = doc
        .extract_spans(page_index)
        .map_err(|error| error.to_string())?;
    let mut spans: Vec<PdfTextSpan> = Vec::with_capacity(spans_raw.len());
    for span in spans_raw {
        let text = span.text;
        if text.trim().is_empty() {
            continue;
        }
        let x0 = span.bbox.x;
        let y0 = span.bbox.y;
        let x1 = x0 + span.bbox.width;
        let y1 = y0 + span.bbox.height;
        spans.push(PdfTextSpan {
            text,
            x0,
            y0,
            x1,
            y1,
        });
    }
    Ok(spans)
}

fn document_info_from_document(doc: &OxidePdfDocument) -> Result<PdfDocumentInfo, String> {
    let page_count = doc.page_count().map_err(|error| error.to_string())?;
    let mut pages = Vec::with_capacity(page_count.min(1));
    for page_index in 0..page_count.min(1) {
        let page_info = doc
            .get_page_info(page_index)
            .map_err(|error| error.to_string())?;
        pages.push(PdfPageInfo {
            width_pt: page_info.media_box.width,
            height_pt: page_info.media_box.height,
        });
    }
    Ok(PdfDocumentInfo { page_count, pages })
}

#[tauri::command]
async fn pdf_engine_get_document_info(
    state: State<'_, AppState>,
    input: PdfEngineGetDocumentInfoInput,
) -> Result<PdfDocumentInfo, String> {
    if let Some(cached) = state
        .pdf_cache
        .lock()
        .map_err(|_| "pdf cache poisoned".to_string())?
        .document_info_by_attachment
        .get(&input.primary_attachment_id)
        .cloned()
    {
        return Ok(cached);
    }

    let library_root = state.library_root.clone();
    let pdf_cache = state.pdf_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = service_for_root(&library_root)?
            .read_primary_attachment_bytes(input.primary_attachment_id)
            .map_err(|error| error.to_string())?;
        let doc = OxidePdfDocument::from_bytes(bytes).map_err(|error| error.to_string())?;
        let info = document_info_from_document(&doc)?;
        pdf_cache
            .lock()
            .map_err(|_| "pdf cache poisoned".to_string())?
            .document_info_by_attachment
            .insert(input.primary_attachment_id, info.clone());
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn pdf_engine_get_page_text(
    state: State<'_, AppState>,
    input: PdfEngineGetPageTextInput,
) -> Result<PdfPageText, String> {
    if input.page_index0 < 0 {
        return Err("invalid page index".to_string());
    }
    if let Some(cached) = state
        .pdf_cache
        .lock()
        .map_err(|_| "pdf cache poisoned".to_string())?
        .text_spans_by_page
        .get(&(input.primary_attachment_id, input.page_index0))
        .cloned()
    {
        return Ok(PdfPageText {
            page_index0: input.page_index0,
            spans: cached,
        });
    }

    let library_root = state.library_root.clone();
    let pdf_cache = state.pdf_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = service_for_root(&library_root)?
            .read_primary_attachment_bytes(input.primary_attachment_id)
            .map_err(|error| error.to_string())?;
        let doc = OxidePdfDocument::from_bytes(bytes).map_err(|error| error.to_string())?;
        let page_index: usize =
            usize::try_from(input.page_index0).map_err(|_| "invalid page index")?;
        let spans = spans_from_document(&doc, page_index)?;
        let mut cache = pdf_cache
            .lock()
            .map_err(|_| "pdf cache poisoned".to_string())?;
        remember_text_spans(
            &mut cache,
            (input.primary_attachment_id, input.page_index0),
            spans.clone(),
        );
        Ok(PdfPageText {
            page_index0: input.page_index0,
            spans,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn pdf_engine_get_page_bundle(
    state: State<'_, AppState>,
    input: PdfEngineGetPageBundleInput,
) -> Result<PdfPageBundle, String> {
    if input.page_index0 < 0 {
        return Err("invalid page index".to_string());
    }
    let target_width_px = input.target_width_px.max(1).min(8192);
    let bucketed_width = width_bucket(target_width_px);
    if let Some(cached) = state
        .pdf_cache
        .lock()
        .map_err(|_| "pdf cache poisoned".to_string())?
        .bundle_by_key
        .get(&(
            input.primary_attachment_id,
            input.page_index0,
            bucketed_width,
        ))
        .cloned()
    {
        return Ok(cached);
    }

    let semaphore = PDF_RENDER_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone();
    let permit = semaphore
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    let library_root = state.library_root.clone();
    let pdf_cache = state.pdf_cache.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let bytes = service_for_root(&library_root)?
            .read_primary_attachment_bytes(input.primary_attachment_id)
            .map_err(|error| error.to_string())?;

        let mut doc = OxidePdfDocument::from_bytes(bytes).map_err(|error| error.to_string())?;
        let page_index: usize =
            usize::try_from(input.page_index0).map_err(|_| "invalid page index")?;

        let page_info = doc
            .get_page_info(page_index)
            .map_err(|error| error.to_string())?;

        let page_width_pt = page_info.media_box.width;
        let page_height_pt = page_info.media_box.height;
        if !(page_width_pt.is_finite()
            && page_height_pt.is_finite()
            && page_width_pt > 0.0
            && page_height_pt > 0.0)
        {
            return Err("invalid page size".to_string());
        }

        let dpi = ((bucketed_width as f32) * 72.0 / page_width_pt)
            .clamp(36.0, 600.0)
            .round() as u32;
        let opts = RenderOptions {
            dpi,
            format: ImageFormat::Png,
            ..Default::default()
        };
        let rendered =
            render_page(&mut doc, page_index, &opts).map_err(|error| error.to_string())?;

        let spans = if let Some(cached) = pdf_cache
            .lock()
            .map_err(|_| "pdf cache poisoned".to_string())?
            .text_spans_by_page
            .get(&(input.primary_attachment_id, input.page_index0))
            .cloned()
        {
            cached
        } else {
            spans_from_document(&doc, page_index)?
        };

        let bundle = PdfPageBundle {
            png_bytes: rendered.data,
            width_px: rendered.width,
            height_px: rendered.height,
            page_width_pt,
            page_height_pt,
            spans: spans.clone(),
        };

        let mut cache = pdf_cache
            .lock()
            .map_err(|_| "pdf cache poisoned".to_string())?;
        remember_text_spans(
            &mut cache,
            (input.primary_attachment_id, input.page_index0),
            spans,
        );
        remember_page_bundle(
            &mut cache,
            (
                input.primary_attachment_id,
                input.page_index0,
                bucketed_width,
            ),
            bundle.clone(),
        );
        Ok(bundle)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn pdf_cache_enforces_text_and_bundle_limits() {
        let mut cache = PdfEngineCache::default();
        for page_index0 in 0..(PDF_TEXT_PAGE_CACHE_LIMIT as i64 + 3) {
            remember_text_spans(
                &mut cache,
                (7, page_index0),
                vec![PdfTextSpan {
                    text: format!("page-{page_index0}"),
                    x0: 0.0,
                    y0: 0.0,
                    x1: 1.0,
                    y1: 1.0,
                }],
            );
        }
        assert_eq!(cache.text_spans_by_page.len(), PDF_TEXT_PAGE_CACHE_LIMIT);
        assert!(!cache.text_spans_by_page.contains_key(&(7, 0)));

        for page_index0 in 0..(PDF_BUNDLE_CACHE_ENTRY_LIMIT as i64 + 3) {
            remember_page_bundle(
                &mut cache,
                (7, page_index0, 640),
                PdfPageBundle {
                    png_bytes: vec![0; 1024],
                    width_px: 640,
                    height_px: 800,
                    page_width_pt: 600.0,
                    page_height_pt: 750.0,
                    spans: vec![],
                },
            );
        }
        assert!(cache.bundle_by_key.len() <= PDF_BUNDLE_CACHE_ENTRY_LIMIT);
        assert!(!cache.bundle_by_key.contains_key(&(7, 0, 640)));
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
fn move_collection(state: State<'_, AppState>, input: MoveCollectionInput) -> Result<(), String> {
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
    let paths = input
        .paths
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    service(&state)?
        .import_files(input.collection_id, &paths, ImportMode::ManagedCopy)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_citations(
    state: State<'_, AppState>,
    input: ImportCitationsInput,
) -> Result<ImportBatchResult, String> {
    let paths = input
        .paths
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
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
    let view = svc
        .get_reader_view(item_id)
        .map_err(|error| error.to_string())?;
    let library_root = state.library_root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(service) = LibraryService::new(&library_root) {
            let _ = service.repair_item_content_if_needed(item_id);
        }
    });
    Ok(view)
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
            .run_item_task(input.item_id, &input.kind, input.prompt.as_deref())
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
        | "collection.compare_methods"
        | "collection.ask" => service(&state)?
            .run_collection_task(
                input.collection_id,
                &input.kind,
                &input.scope_item_ids,
                input.prompt.as_deref(),
            )
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
            app.manage(AppState {
                library_root,
                pdf_cache: Arc::new(Mutex::new(PdfEngineCache::default())),
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
            pdf_engine_get_document_info,
            pdf_engine_get_page_bundle,
            pdf_engine_get_page_text,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run paper-reader desktop app");
}
