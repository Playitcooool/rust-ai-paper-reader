use std::{fs, io::Write, path::{Path, PathBuf}};

use app_core::service::{ImportMode, LibraryService};
use tempfile::tempdir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn fixture_path(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn write_pdf_fixture(path: &Path) {
    let pdf = br#"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>
endobj
5 0 obj
<< /Length 72 >>
stream
BT
/F1 12 Tf
72 720 Td
(Scaling laws improve planning for training runs.) Tj
ET
endstream
endobj
6 0 obj
<< /Length 71 >>
stream
BT
/F1 12 Tf
72 720 Td
(Compute and data must grow together for stable returns.) Tj
ET
endstream
endobj
7 0 obj
<< /Title (Scaling Laws Field Guide) /Author (Reader Team) /CreationDate (D:20240101000000Z) >>
endobj
trailer
<< /Root 1 0 R /Info 7 0 R >>
%%EOF"#;
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
