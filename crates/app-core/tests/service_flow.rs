use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use app_core::service::{
    AiCompletionRequest, AiTransport, AIProvider, AISessionReferenceKind, ImportMode, LibraryService,
    UpdateAISettingsInput,
};
use flate2::{write::ZlibEncoder, Compression};
use rusqlite::Connection;
use tempfile::tempdir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn fixture_path(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn service_with_transport(root: &Path, transport: Arc<dyn AiTransport>) -> LibraryService {
    LibraryService::new_with_transport(root, transport).unwrap()
}

fn write_pdf_fixture(path: &Path) {
    write_compressed_pdf_fixture(
        path,
        Some("Scaling Laws Field Guide"),
        Some("Reader Team"),
        Some(2024),
        &[
            Some("Scaling laws improve planning for training runs."),
            Some("Compute and data must grow together for stable returns."),
        ],
    );
}

fn write_partial_pdf_fixture(path: &Path) {
    write_compressed_pdf_fixture(
        path,
        Some("Partial Text Layer"),
        Some("Reader Team"),
        Some(2025),
        &[Some("Only the first page has a reliable text layer."), None],
    );
}

fn write_unavailable_pdf_fixture(path: &Path) {
    write_compressed_pdf_fixture(
        path,
        Some("Scanned Paper"),
        Some("Reader Team"),
        Some(2025),
        &[None, None],
    );
}

fn write_pdf_fixture_without_metadata(path: &Path, pages: &[Option<&str>]) {
    write_compressed_pdf_fixture(path, None, None, None, pages);
}

fn write_broken_pdf_fixture(path: &Path) {
    // Intentionally not a valid PDF. Import should still succeed and mark content as unavailable.
    fs::write(path, b"%PDF-1.4\n% broken\n").unwrap();
}

fn compress_pdf_stream(stream: &str) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(stream.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

fn write_compressed_pdf_fixture(
    path: &Path,
    title: Option<&str>,
    author: Option<&str>,
    year: Option<i64>,
    pages: &[Option<&str>],
) {
    let mut objects: Vec<Vec<u8>> = Vec::new();
    objects.push(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_vec());

    let page_ids: Vec<usize> = (0..pages.len()).map(|index| 3 + index).collect();
    let contents_start = 3 + pages.len();
    let font_id = contents_start + pages.len();
    let info_id = font_id + 1;

    let kids = page_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!(
        "2 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {} >>\nendobj\n",
        pages.len()
    ).into_bytes());

    for (index, _) in pages.iter().enumerate() {
        let page_id = page_ids[index];
        let contents_id = contents_start + index;
        objects.push(format!(
            "{page_id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {contents_id} 0 R >>\nendobj\n"
        ).into_bytes());
    }

    for (index, text) in pages.iter().enumerate() {
        let contents_id = contents_start + index;
        let stream = match text {
            Some(text) => format!(
                "BT\n/F1 12 Tf\n72 720 Td\n({}) Tj\nET\n",
                text.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)")
            ),
            None => "q\nQ\n".to_string(),
        };
        let compressed = compress_pdf_stream(&stream);
        let mut object = format!(
            "{contents_id} 0 obj\n<< /Length {} /Filter /FlateDecode >>\nstream\n",
            compressed.len()
        )
        .into_bytes();
        object.extend_from_slice(&compressed);
        object.extend_from_slice(b"\nendstream\nendobj\n");
        objects.push(object);
    }

    objects.push(
        format!(
            "{font_id} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
        )
        .into_bytes(),
    );

    let mut info_parts = Vec::new();
    if let Some(title) = title {
        info_parts.push(format!("/Title ({title})"));
    }
    if let Some(author) = author {
        info_parts.push(format!("/Author ({author})"));
    }
    if let Some(year) = year {
        info_parts.push(format!("/CreationDate (D:{year}0101000000Z)"));
    }
    objects.push(format!(
        "{info_id} 0 obj\n<< {} >>\nendobj\n",
        info_parts.join(" ")
    ).into_bytes());

    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for object in &objects {
        offsets.push(pdf.len());
        pdf.extend_from_slice(object);
    }
    let xref_offset = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(format!(
        "trailer\n<< /Size {} /Root 1 0 R /Info {info_id} 0 R >>\nstartxref\n{xref_offset}\n%%EOF",
        objects.len() + 1
    ).as_bytes());

    fs::write(path, pdf).unwrap();
}

fn write_docx_fixture(path: &Path) {
    let file = fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    zip.start_file("[Content_Types].xml", options).unwrap();
    zip.write_all(br#"<?xml version='1.0' encoding='UTF-8'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'></Types>"#).unwrap();
    zip.start_file("docProps/core.xml", options).unwrap();
    zip.write_all(br#"<?xml version='1.0' encoding='UTF-8'?><cp:coreProperties xmlns:cp='http://schemas.openxmlformats.org/package/2006/metadata/core-properties' xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Graph Notes</dc:title><dc:creator>Docx Author</dc:creator></cp:coreProperties>"#).unwrap();
    zip.start_file("word/document.xml", options).unwrap();
    zip.write_all(br#"<?xml version='1.0' encoding='UTF-8'?><w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body><w:p><w:r><w:t>Graph neural networks unify message passing.</w:t></w:r></w:p><w:p><w:r><w:t>Benchmarks compare pooling, supervision, and transfer.</w:t></w:r></w:p></w:body></w:document>"#).unwrap();
    zip.finish().unwrap();
}

fn write_epub_fixture(path: &Path) {
    let file = fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", stored).unwrap();
    zip.write_all(br#"<?xml version='1.0'?><container version='1.0' xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='OEBPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles></container>"#).unwrap();
    zip.start_file("OEBPS/content.opf", stored).unwrap();
    zip.write_all(br#"<?xml version='1.0'?><package xmlns='http://www.idpf.org/2007/opf' version='3.0'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Distributed Systems Reader</dc:title><dc:creator>Epub Author</dc:creator></metadata><manifest><item id='c1' href='chapter1.xhtml' media-type='application/xhtml+xml'/><item id='c2' href='chapter2.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='c1'/><itemref idref='c2'/></spine></package>"#).unwrap();
    zip.start_file("OEBPS/chapter1.xhtml", stored).unwrap();
    zip.write_all(br#"<?xml version='1.0'?><html xmlns='http://www.w3.org/1999/xhtml'><body><h1>Chapter 1</h1><p>Consensus protocols coordinate replicas.</p></body></html>"#).unwrap();
    zip.start_file("OEBPS/chapter2.xhtml", stored).unwrap();
    zip.write_all(br#"<?xml version='1.0'?><html xmlns='http://www.w3.org/1999/xhtml'><body><h2>Chapter 2</h2><p>Operator ergonomics matter during failures.</p></body></html>"#).unwrap();
    zip.finish().unwrap();
}

#[derive(Default)]
struct StubTransport {
    requests: Mutex<Vec<AiCompletionRequest>>,
}

impl AiTransport for StubTransport {
    fn stream_completion(
        &self,
        request: AiCompletionRequest,
        on_delta: &mut dyn FnMut(&str) -> anyhow::Result<()>,
    ) -> anyhow::Result<String> {
        let provider = request.provider;
        let prompt = request.prompt.clone();
        self.requests.lock().unwrap().push(request);
        let output = match provider {
            AIProvider::OpenAI => format!(
                "# Summary: OpenAI Path\n\n## Key Points\n- Routed through OpenAI\n\n## Echo\n{}",
                prompt
            ),
            AIProvider::Anthropic => {
                format!(
                    "# Theme Map: Anthropic Path\n\n## Themes\n- Routed through Anthropic\n\n## Echo\n{}",
                    prompt
                )
            }
        };
        for chunk in output.split_inclusive('\n') {
            on_delta(chunk)?;
        }
        Ok(output)
    }
}

#[test]
fn starts_with_an_empty_library() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();

    assert!(service.list_collections().unwrap().is_empty());
    assert!(service.list_items(None).unwrap().is_empty());
}

#[test]
fn imports_pdf_with_metadata_text_page_count_and_search_index() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Machine Learning", None).unwrap();
    let pdf = fixture_path(root.path(), "scaling-laws.pdf");
    write_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();

    assert_eq!(result.imported.len(), 1);
    assert!(result.duplicates.is_empty());
    assert!(result.failed.is_empty());
    assert_eq!(result.results[0].status, "imported");

    let item_id = result.imported[0].id;
    let item = service.list_items(Some(collection.id)).unwrap().remove(0);
    assert_eq!(item.title, "Scaling Laws Field Guide");
    assert_eq!(item.authors, "Reader Team");
    assert_eq!(item.publication_year, Some(2024));

    let reader = service.get_reader_view(item_id).unwrap();
    assert_eq!(reader.reader_kind, "pdf");
    assert_eq!(reader.page_count, Some(2));
    assert_eq!(reader.content_status, "ready");
    assert!(reader.plain_text.contains("Scaling laws improve planning"));

    let search = service.search_items("stable returns").unwrap();
    assert_eq!(search.len(), 1);
}

#[test]
fn imports_pdf_without_reliable_text_as_unavailable_and_skips_search_index() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Scans", None).unwrap();
    let pdf = fixture_path(root.path(), "scanned-paper.pdf");
    write_unavailable_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();

    let reader = service.get_reader_view(result.imported[0].id).unwrap();
    assert_eq!(reader.reader_kind, "pdf");
    assert_eq!(reader.content_status, "unavailable");
    assert!(reader.plain_text.is_empty());
    assert!(reader
        .content_notice
        .unwrap_or_default()
        .contains("reliable text layer"));

    let search = service.search_items("scanned").unwrap();
    assert!(search.is_empty());
}

#[test]
fn imports_pdf_with_partial_text_as_partial_and_indexes_reliable_excerpt() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Partials", None).unwrap();
    let pdf = fixture_path(root.path(), "partial-text-layer.pdf");
    write_partial_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();

    let reader = service.get_reader_view(result.imported[0].id).unwrap();
    assert_eq!(reader.content_status, "partial");
    assert!(reader.plain_text.contains("Only the first page has a reliable text layer."));
    assert!(reader.content_notice.unwrap_or_default().contains("partial"));

    let search = service.search_items("reliable text layer").unwrap();
    assert_eq!(search.len(), 1);
}

#[test]
fn imports_pdf_with_chinese_filename_and_missing_metadata_falls_back_to_filename() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "中文论文.pdf");
    write_pdf_fixture_without_metadata(&pdf, &[Some("中文内容可被提取。")]);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();

    assert!(result.failed.is_empty());
    assert_eq!(result.imported.len(), 1);
    let item = service.list_items(Some(collection.id)).unwrap().remove(0);
    assert_eq!(item.title, "中文论文");
}

#[test]
fn imports_pdf_even_when_pdf_parsing_fails_and_marks_content_unavailable() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "broken.pdf");
    write_broken_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();

    assert_eq!(result.imported.len(), 1);
    assert!(result.failed.is_empty());
    let reader = service.get_reader_view(result.imported[0].id).unwrap();
    assert_eq!(reader.reader_kind, "pdf");
    assert_eq!(reader.content_status, "unavailable");
    assert!(reader.plain_text.is_empty());
}

#[test]
fn repairs_old_pdf_extraction_version_on_demand_and_rebuilds_search_index() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "repair-me.pdf");
    write_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();
    let item_id = result.imported[0].id;

    // Simulate an older extractor run.
    {
        let conn = Connection::open(root.path().join("library.db")).unwrap();
        conn.execute(
            "UPDATE extracted_content SET plain_text = '', normalized_html = '', content_status = 'unavailable', extractor_version = 0 WHERE item_id = ?1",
            [item_id],
        )
        .unwrap();
        conn.execute("DELETE FROM search_index WHERE item_id = ?1", [item_id])
            .unwrap();
    }

    let repaired = service.repair_item_content_if_needed(item_id).unwrap();
    assert!(repaired);

    let reader = service.get_reader_view(item_id).unwrap();
    assert_eq!(reader.content_status, "ready");
    assert!(reader.plain_text.contains("Scaling laws improve planning"));

    let search = service.search_items("stable returns").unwrap();
    assert_eq!(search.len(), 1);
}

#[test]
fn repairs_outdated_pdf_content_in_bulk() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf1 = fixture_path(root.path(), "bulk-1.pdf");
    let pdf2 = fixture_path(root.path(), "bulk-2.pdf");
    write_pdf_fixture(&pdf1);
    write_partial_pdf_fixture(&pdf2);

    let result = service
        .import_files(collection.id, &[pdf1, pdf2], ImportMode::ManagedCopy)
        .unwrap();
    assert_eq!(result.imported.len(), 2);

    {
        let conn = Connection::open(root.path().join("library.db")).unwrap();
        conn.execute("UPDATE extracted_content SET extractor_version = 0, plain_text = '', normalized_html = '', content_status = 'unavailable' WHERE item_id = ?1", [result.imported[0].id]).unwrap();
        conn.execute("UPDATE extracted_content SET extractor_version = 0, plain_text = '', normalized_html = '', content_status = 'unavailable' WHERE item_id = ?1", [result.imported[1].id]).unwrap();
        conn.execute("DELETE FROM search_index", []).unwrap();
    }

    let repaired = service.repair_library_content_if_needed().unwrap();
    assert_eq!(repaired, 2);
    assert_eq!(service.search_items("stable returns").unwrap().len(), 1);
}

#[test]
fn imports_docx_and_epub_as_real_text_readers() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Reading", None).unwrap();
    let docx = fixture_path(root.path(), "graph-notes.docx");
    let epub = fixture_path(root.path(), "systems.epub");
    write_docx_fixture(&docx);
    write_epub_fixture(&epub);

    let result = service
        .import_files(collection.id, &[docx, epub], ImportMode::ManagedCopy)
        .unwrap();

    assert_eq!(result.imported.len(), 2);
    let items = service.list_items(Some(collection.id)).unwrap();
    assert_eq!(items.len(), 2);

    let docx_item = items.iter().find(|item| item.attachment_format == "docx").unwrap();
    let docx_reader = service.get_reader_view(docx_item.id).unwrap();
    assert_eq!(docx_reader.reader_kind, "normalized");
    assert_eq!(docx_reader.content_status, "ready");
    assert!(docx_reader.plain_text.contains("Graph neural networks"));
    assert!(docx_reader.normalized_html.contains("<p>Graph neural networks unify message passing."));

    let epub_item = items.iter().find(|item| item.attachment_format == "epub").unwrap();
    let epub_reader = service.get_reader_view(epub_item.id).unwrap();
    assert_eq!(epub_reader.reader_kind, "normalized");
    assert!(epub_reader.plain_text.contains("Consensus protocols coordinate replicas."));
    assert!(epub_reader.normalized_html.contains("Chapter 1"));
    assert!(epub_reader.normalized_html.contains("Operator ergonomics matter during failures."));
}

#[test]
fn duplicate_imports_report_duplicate_without_creating_new_items() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "duplicate.pdf");
    write_pdf_fixture(&pdf);

    let first = service
        .import_files(collection.id, std::slice::from_ref(&pdf), ImportMode::ManagedCopy)
        .unwrap();
    let second = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();

    assert_eq!(first.imported.len(), 1);
    assert!(second.imported.is_empty());
    assert_eq!(second.duplicates.len(), 1);
    assert_eq!(second.results[0].status, "duplicate");
    assert_eq!(service.list_items(Some(collection.id)).unwrap().len(), 1);
}

#[test]
fn linked_files_can_be_marked_missing_and_relinked() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Systems", None).unwrap();
    let original = fixture_path(root.path(), "systems.epub");
    write_epub_fixture(&original);

    let result = service
        .import_files(collection.id, std::slice::from_ref(&original), ImportMode::LinkedFile)
        .unwrap();
    let attachment_id = result.imported[0].primary_attachment_id;

    fs::remove_file(&original).unwrap();
    service.refresh_attachment_statuses().unwrap();
    assert_eq!(service.list_items(Some(collection.id)).unwrap()[0].attachment_status, "missing");

    let replacement = fixture_path(root.path(), "replacement.epub");
    write_epub_fixture(&replacement);
    service.relink_attachment(attachment_id, replacement).unwrap();

    let item = service.list_items(Some(collection.id)).unwrap().remove(0);
    assert_eq!(item.attachment_status, "ready");
}

#[test]
fn reads_primary_pdf_attachment_bytes_for_managed_and_linked_files() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("PDFs", None).unwrap();
    let managed = fixture_path(root.path(), "managed-read.pdf");
    let linked = fixture_path(root.path(), "linked-read.pdf");
    write_pdf_fixture(&managed);
    write_partial_pdf_fixture(&linked);

    let managed_result = service
        .import_files(collection.id, &[managed], ImportMode::ManagedCopy)
        .unwrap();
    let linked_result = service
        .import_files(collection.id, std::slice::from_ref(&linked), ImportMode::LinkedFile)
        .unwrap();

    let managed_bytes = service
        .read_primary_attachment_bytes(managed_result.imported[0].primary_attachment_id)
        .unwrap();
    let linked_bytes = service
        .read_primary_attachment_bytes(linked_result.imported[0].primary_attachment_id)
        .unwrap();

    assert!(!managed_bytes.is_empty());
    assert!(!linked_bytes.is_empty());
    assert_eq!(&managed_bytes[..4], b"%PDF");
    assert_eq!(&linked_bytes[..4], b"%PDF");
}

#[test]
fn read_primary_attachment_bytes_rejects_missing_non_pdf_and_unknown_attachments() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Failures", None).unwrap();

    let missing_pdf = fixture_path(root.path(), "missing.pdf");
    write_pdf_fixture(&missing_pdf);
    let missing_result = service
        .import_files(collection.id, std::slice::from_ref(&missing_pdf), ImportMode::LinkedFile)
        .unwrap();
    fs::remove_file(&missing_pdf).unwrap();

    let docx = fixture_path(root.path(), "not-pdf.docx");
    write_docx_fixture(&docx);
    let docx_result = service
        .import_files(collection.id, &[docx], ImportMode::ManagedCopy)
        .unwrap();

    let missing_error = service
        .read_primary_attachment_bytes(missing_result.imported[0].primary_attachment_id)
        .unwrap_err()
        .to_string();
    let non_pdf_error = service
        .read_primary_attachment_bytes(docx_result.imported[0].primary_attachment_id)
        .unwrap_err()
        .to_string();
    let unknown_error = service
        .read_primary_attachment_bytes(9_999_999)
        .unwrap_err()
        .to_string();

    assert!(missing_error.contains("file is missing"));
    assert!(non_pdf_error.contains("not a PDF"));
    assert!(unknown_error.contains("not found"));
}

#[test]
fn removing_items_deletes_managed_copy_but_preserves_linked_source() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Cleanup", None).unwrap();
    let managed = fixture_path(root.path(), "managed.pdf");
    let linked = fixture_path(root.path(), "linked.epub");
    write_pdf_fixture(&managed);
    write_epub_fixture(&linked);

    let managed_result = service
        .import_files(collection.id, &[managed], ImportMode::ManagedCopy)
        .unwrap();
    let linked_result = service
        .import_files(collection.id, std::slice::from_ref(&linked), ImportMode::LinkedFile)
        .unwrap();

    let managed_reader = service.get_reader_view(managed_result.imported[0].id).unwrap();
    assert!(Path::new(managed_reader.primary_attachment_path.as_deref().unwrap()).exists());

    service.remove_item(managed_result.imported[0].id).unwrap();
    assert!(!Path::new(managed_reader.primary_attachment_path.as_deref().unwrap()).exists());

    service.remove_item(linked_result.imported[0].id).unwrap();
    assert!(linked.exists());
}

#[test]
fn removing_item_clears_matching_ai_session_references() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "session-ref-item.pdf");
    write_pdf_fixture(&pdf);

    let item_id = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap()
        .imported[0]
        .id;
    let session = service.create_ai_session().unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Item, item_id)
        .unwrap();

    service.remove_item(item_id).unwrap();

    assert!(service.list_ai_session_references(session.id).unwrap().is_empty());
}

#[test]
fn removing_collection_clears_matching_ai_session_references() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Empty", None).unwrap();
    let session = service.create_ai_session().unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Collection, collection.id)
        .unwrap();

    service.remove_collection(collection.id).unwrap();

    assert!(service.list_ai_session_references(session.id).unwrap().is_empty());
}

#[test]
fn removing_collection_recursively_clears_descendant_items_and_related_records() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));
    let parent = service.create_collection("Machine Learning", None).unwrap();
    let child = service.create_collection("Scaling Papers", Some(parent.id)).unwrap();
    let sibling = service.create_collection("Systems", None).unwrap();
    let parent_pdf = fixture_path(root.path(), "parent.pdf");
    let child_pdf = fixture_path(root.path(), "child.pdf");
    let sibling_epub = fixture_path(root.path(), "sibling.epub");
    write_pdf_fixture(&parent_pdf);
    write_partial_pdf_fixture(&child_pdf);
    write_epub_fixture(&sibling_epub);

    let parent_item_id = service
        .import_files(parent.id, &[parent_pdf], ImportMode::ManagedCopy)
        .unwrap()
        .imported[0]
        .id;
    let child_item_id = service
        .import_files(child.id, &[child_pdf], ImportMode::ManagedCopy)
        .unwrap()
        .imported[0]
        .id;
    let sibling_item_id = service
        .import_files(sibling.id, &[sibling_epub], ImportMode::ManagedCopy)
        .unwrap()
        .imported[0]
        .id;

    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let session = service.create_ai_session().unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Collection, parent.id)
        .unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Item, child_item_id)
        .unwrap();
    let collection_task = service
        .run_collection_task(child.id, "collection.theme_map", &[child_item_id], None)
        .unwrap();
    let note = service
        .create_note_from_artifact(
            service
                .get_latest_artifact(None, Some(child.id))
                .unwrap()
                .expect("collection artifact")
                .id,
        )
        .unwrap();

    service.remove_collection(parent.id).unwrap();

    let collections = service.list_collections().unwrap();
    assert_eq!(collections.len(), 1);
    assert_eq!(collections[0].id, sibling.id);

    let items = service.list_items(None).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, sibling_item_id);
    assert!(items.iter().all(|item| item.id != parent_item_id && item.id != child_item_id));

    assert!(service.list_ai_session_references(session.id).unwrap().is_empty());
    assert!(service.list_task_runs(None, Some(child.id)).unwrap().is_empty());
    assert!(service.get_latest_artifact(None, Some(child.id)).unwrap().is_none());
    assert!(service.list_notes(Some(child.id)).unwrap().is_empty());
    assert!(service
        .list_notes(None)
        .unwrap()
        .iter()
        .all(|entry| entry.id != note.id));
    assert_eq!(collection_task.collection_id, Some(child.id));
}

#[test]
fn removing_item_prunes_cascaded_records_and_session_scope_item_ids() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf_a = fixture_path(root.path(), "scope-a.pdf");
    let pdf_b = fixture_path(root.path(), "scope-b.pdf");
    write_pdf_fixture(&pdf_a);
    write_partial_pdf_fixture(&pdf_b);

    let result = service
        .import_files(collection.id, &[pdf_a, pdf_b], ImportMode::ManagedCopy)
        .unwrap();
    let item_a = result.imported[0].id;
    let item_b = result.imported[1].id;

    let tag = service.create_tag("reading-list").unwrap();
    service.assign_tag(item_a, tag.id).unwrap();
    service
        .create_annotation(
            item_a,
            "page=1".to_string(),
            "highlight".to_string(),
            "Keep this paragraph.".to_string(),
        )
        .unwrap();
    let session = service.create_ai_session().unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Item, item_a)
        .unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Item, item_b)
        .unwrap();

    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let task = service
        .run_ai_session_task(session.id, "session.compare", None)
        .unwrap();
    assert_eq!(task.scope_item_ids, Some(vec![item_a, item_b]));

    service.remove_item(item_a).unwrap();

    let conn = Connection::open(root.path().join("library.db")).unwrap();
    let attachments: i64 = conn
        .query_row("SELECT COUNT(*) FROM attachments WHERE item_id = ?1", [item_a], |row| row.get(0))
        .unwrap();
    let extracted_content: i64 = conn
        .query_row("SELECT COUNT(*) FROM extracted_content WHERE item_id = ?1", [item_a], |row| row.get(0))
        .unwrap();
    let annotations: i64 = conn
        .query_row("SELECT COUNT(*) FROM annotations WHERE item_id = ?1", [item_a], |row| row.get(0))
        .unwrap();
    let item_tags: i64 = conn
        .query_row("SELECT COUNT(*) FROM item_tags WHERE item_id = ?1", [item_a], |row| row.get(0))
        .unwrap();
    assert_eq!(attachments, 0);
    assert_eq!(extracted_content, 0);
    assert_eq!(annotations, 0);
    assert_eq!(item_tags, 0);

    let session_tasks = service.list_ai_session_task_runs(session.id).unwrap();
    assert_eq!(session_tasks.len(), 1);
    assert_eq!(session_tasks[0].scope_item_ids, Some(vec![item_b]));
    let artifact = service.get_ai_session_artifact(session.id).unwrap().expect("session artifact");
    assert_eq!(artifact.scope_item_ids, Some(vec![item_b]));
}

#[test]
fn removing_collection_prunes_session_scope_item_ids_for_descendant_items() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));
    let parent = service.create_collection("Parent", None).unwrap();
    let child = service.create_collection("Child", Some(parent.id)).unwrap();
    let keep = service.create_collection("Keep", None).unwrap();
    let child_pdf = fixture_path(root.path(), "child-session.pdf");
    let keep_pdf = fixture_path(root.path(), "keep-session.pdf");
    write_pdf_fixture(&child_pdf);
    write_partial_pdf_fixture(&keep_pdf);

    let child_item_id = service
        .import_files(child.id, &[child_pdf], ImportMode::ManagedCopy)
        .unwrap()
        .imported[0]
        .id;
    let keep_item_id = service
        .import_files(keep.id, &[keep_pdf], ImportMode::ManagedCopy)
        .unwrap()
        .imported[0]
        .id;
    let session = service.create_ai_session().unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Item, child_item_id)
        .unwrap();
    service
        .add_ai_session_reference(session.id, AISessionReferenceKind::Item, keep_item_id)
        .unwrap();

    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();
    service
        .run_ai_session_task(session.id, "session.compare", None)
        .unwrap();

    service.remove_collection(parent.id).unwrap();

    let session_tasks = service.list_ai_session_task_runs(session.id).unwrap();
    assert!(session_tasks.iter().all(|task| {
        task.scope_item_ids
            .as_ref()
            .is_none_or(|scope_item_ids| scope_item_ids == &vec![keep_item_id])
    }));
    let artifact = service.get_ai_session_artifact(session.id).unwrap();
    assert!(artifact.as_ref().is_none_or(|entry| entry.scope_item_ids == Some(vec![keep_item_id])));
}

#[test]
fn item_ask_persists_input_prompt() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "ask-item.pdf");
    write_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();
    let item_id = result.imported[0].id;
    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let task = service
        .run_item_task(item_id, "item.ask", Some("What is the core claim?"))
        .unwrap();

    assert_eq!(task.input_prompt.as_deref(), Some("What is the core claim?"));
    assert!(task.output_markdown.contains("What is the core claim?"));

    let listed = service.list_task_runs(Some(item_id), None).unwrap();
    assert_eq!(listed[0].input_prompt.as_deref(), Some("What is the core claim?"));
}

#[test]
fn collection_ask_persists_input_prompt_and_scope() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));
    let collection = service.create_collection("Review", None).unwrap();
    let pdf_a = fixture_path(root.path(), "collection-ask-a.pdf");
    let pdf_b = fixture_path(root.path(), "collection-ask-b.pdf");
    write_pdf_fixture(&pdf_a);
    write_partial_pdf_fixture(&pdf_b);

    let result = service
        .import_files(collection.id, &[pdf_a, pdf_b], ImportMode::ManagedCopy)
        .unwrap();
    let scope_item_ids = result.imported.iter().map(|item| item.id).collect::<Vec<_>>();
    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let task = service
        .run_collection_task(
            collection.id,
            "collection.ask",
            &scope_item_ids,
            Some("How do these papers compare?"),
        )
        .unwrap();

    assert_eq!(task.input_prompt.as_deref(), Some("How do these papers compare?"));
    assert_eq!(task.scope_item_ids.as_deref(), Some(scope_item_ids.as_slice()));

    let listed = service.list_task_runs(None, Some(collection.id)).unwrap();
    assert_eq!(listed[0].input_prompt.as_deref(), Some("How do these papers compare?"));
    assert_eq!(listed[0].scope_item_ids.as_deref(), Some(scope_item_ids.as_slice()));
}

#[test]
fn legacy_ai_tasks_keep_null_input_prompt() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "summary-item.pdf");
    write_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();
    let item_id = result.imported[0].id;
    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let task = service.run_item_task(item_id, "item.summarize", None).unwrap();
    assert_eq!(task.input_prompt, None);

    let listed = service.list_task_runs(Some(item_id), None).unwrap();
    assert_eq!(listed[0].input_prompt, None);
}

#[test]
fn ai_settings_persist_without_returning_raw_keys() {
    let root = tempdir().unwrap();
    let service = service_with_transport(root.path(), Arc::new(StubTransport::default()));

    let settings = service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "claude-3-5-sonnet-latest".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: Some("anthropic-secret".into()),
            clear_anthropic_api_key: None,
        })
        .unwrap();

    assert_eq!(settings.active_provider, AIProvider::OpenAI);
    assert!(settings.has_openai_api_key);
    assert!(settings.has_anthropic_api_key);
    assert_eq!(settings.openai_base_url, "");

    let loaded = service.get_ai_settings().unwrap();
    assert!(loaded.has_openai_api_key);
    assert!(loaded.has_anthropic_api_key);
    assert_eq!(loaded.openai_model, "gpt-4.1-mini");

    let conn = Connection::open(root.path().join("library.db")).unwrap();
    let stored_keys: (String, String) = conn
        .query_row(
            "SELECT openai_api_key, anthropic_api_key FROM ai_settings WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored_keys.0, "openai-secret");
    assert_eq!(stored_keys.1, "anthropic-secret");
}

#[test]
fn missing_active_provider_configuration_fails_without_persisting_tasks() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).unwrap();
    let collection = service.create_collection("Inbox", None).unwrap();
    let pdf = fixture_path(root.path(), "missing-config.pdf");
    write_pdf_fixture(&pdf);

    let result = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .unwrap();
    let item_id = result.imported[0].id;

    let error = service.run_item_task(item_id, "item.summarize", None).unwrap_err();
    assert!(error.to_string().contains("OpenAI is missing"));
    assert!(service.list_task_runs(Some(item_id), None).unwrap().is_empty());
    assert!(service.get_latest_artifact(Some(item_id), None).unwrap().is_none());
}

#[test]
fn provider_backed_item_and_collection_tasks_route_and_persist() {
    let root = tempdir().unwrap();
    let transport = Arc::new(StubTransport::default());
    let service = service_with_transport(root.path(), transport.clone());
    let collection = service.create_collection("Machine Learning", None).unwrap();
    let pdf_a = fixture_path(root.path(), "provider-a.pdf");
    let pdf_b = fixture_path(root.path(), "provider-b.pdf");
    write_pdf_fixture(&pdf_a);
    write_pdf_fixture(&pdf_b);

    let result = service
        .import_files(collection.id, &[pdf_a, pdf_b], ImportMode::ManagedCopy)
        .unwrap();
    let item_id = result.imported[0].id;
    let scope_item_ids = result.imported.iter().map(|item| item.id).collect::<Vec<_>>();

    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::OpenAI,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: Some("openai-secret".into()),
            clear_openai_api_key: None,
            anthropic_model: "".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: None,
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let item_task = service.run_item_task(item_id, "item.summarize", None).unwrap();
    assert!(item_task.output_markdown.contains("OpenAI Path"));

    service
        .update_ai_settings(UpdateAISettingsInput {
            active_provider: AIProvider::Anthropic,
            openai_model: "gpt-4.1-mini".into(),
            openai_base_url: "".into(),
            openai_api_key: None,
            clear_openai_api_key: None,
            anthropic_model: "claude-3-5-sonnet-latest".into(),
            anthropic_base_url: "".into(),
            anthropic_api_key: Some("anthropic-secret".into()),
            clear_anthropic_api_key: None,
        })
        .unwrap();

    let collection_task = service
        .run_collection_task(collection.id, "collection.theme_map", &scope_item_ids, None)
        .unwrap();
    assert!(collection_task.output_markdown.contains("Anthropic Path"));

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].provider, AIProvider::OpenAI);
    assert_eq!(requests[1].provider, AIProvider::Anthropic);

    let artifact = service
        .get_latest_artifact(None, Some(collection.id))
        .unwrap()
        .expect("artifact");
    assert!(artifact.markdown.contains("Anthropic Path"));
}
