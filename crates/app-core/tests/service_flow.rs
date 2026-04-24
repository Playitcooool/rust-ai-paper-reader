use std::{fs, io::Write, path::{Path, PathBuf}};

use app_core::service::{ImportMode, LibraryService};
use flate2::{write::ZlibEncoder, Compression};
use tempfile::tempdir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn fixture_path(root: &Path, name: &str) -> PathBuf {
    root.join(name)
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
        .import_files(collection.id, &[pdf.clone()], ImportMode::ManagedCopy)
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
        .import_files(collection.id, &[original.clone()], ImportMode::LinkedFile)
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
        .import_files(collection.id, &[linked.clone()], ImportMode::LinkedFile)
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
        .import_files(collection.id, &[missing_pdf.clone()], ImportMode::LinkedFile)
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
        .import_files(collection.id, &[linked.clone()], ImportMode::LinkedFile)
        .unwrap();

    let managed_reader = service.get_reader_view(managed_result.imported[0].id).unwrap();
    assert!(Path::new(managed_reader.primary_attachment_path.as_deref().unwrap()).exists());

    service.remove_item(managed_result.imported[0].id).unwrap();
    assert!(!Path::new(managed_reader.primary_attachment_path.as_deref().unwrap()).exists());

    service.remove_item(linked_result.imported[0].id).unwrap();
    assert!(linked.exists());
}
