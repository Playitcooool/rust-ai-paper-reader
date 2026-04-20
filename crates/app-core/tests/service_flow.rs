use std::path::PathBuf;

use app_core::service::{ImportMode, LibraryService};
use tempfile::tempdir;

fn fixture_path(root: &std::path::Path, name: &str) -> PathBuf {
    root.join(name)
}

#[test]
fn imports_files_creates_items_and_supports_search_annotations_and_notes() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");

    let collection = service
        .create_collection("Machine Learning", None)
        .expect("collection created");

    std::fs::write(fixture_path(root.path(), "paper.pdf"), b"%PDF-1.4 test content").unwrap();
    std::fs::write(
        fixture_path(root.path(), "notes.docx"),
        b"word document content about transformers",
    )
    .unwrap();

    let imported = service
        .import_files(
            collection.id,
            &[
                fixture_path(root.path(), "paper.pdf"),
                fixture_path(root.path(), "notes.docx"),
            ],
            ImportMode::ManagedCopy,
        )
        .expect("files imported");

    assert_eq!(imported.len(), 2);

    let listed = service.list_items(Some(collection.id)).expect("items listed");
    assert_eq!(listed.len(), 2);

    let transformers_tag = service.create_tag("Transformers").expect("tag created");
    service
        .assign_tag(listed[0].id, transformers_tag.id)
        .expect("tag assigned");

    let search = service.search_items("transformers").expect("search works");
    assert_eq!(search.len(), 1);
    assert!(search.iter().any(|item| item.title == "notes"));
    assert!(
        search
            .iter()
            .any(|item| item.tags.iter().any(|tag| tag == "Transformers"))
    );

    let annotation = service
        .create_annotation(
            search[0].id,
            "section-1".into(),
            "highlight".into(),
            "Important paragraph".into(),
        )
        .expect("annotation created");

    assert_eq!(annotation.anchor, "section-1");

    let task = service
        .run_item_summary(search[0].id)
        .expect("summary task created");
    assert_eq!(task.status, "succeeded");

    let note = service
        .create_note_from_latest_collection_artifact(collection.id)
        .expect("note created");
    assert!(note.markdown.contains("Machine Learning"));
}

#[test]
fn linked_files_can_be_relinked_after_missing_attachment_is_detected() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let collection = service
        .create_collection("Systems", None)
        .expect("collection created");

    let original = root.path().join("systems.epub");
    std::fs::write(&original, b"distributed systems").unwrap();

    let imported = service
        .import_files(collection.id, &[original.clone()], ImportMode::LinkedFile)
        .expect("linked import succeeds");
    let attachment_id = imported[0].primary_attachment_id;

    std::fs::remove_file(&original).unwrap();
    service
        .refresh_attachment_statuses()
        .expect("status refresh works");

    let missing = service.list_items(Some(collection.id)).expect("items listed");
    assert_eq!(missing[0].attachment_status, "missing");

    let replacement = root.path().join("replacement.epub");
    std::fs::write(&replacement, b"distributed systems second copy").unwrap();

    service
        .relink_attachment(attachment_id, replacement)
        .expect("relink succeeds");

    let relinked = service.list_items(Some(collection.id)).expect("items listed");
    assert_eq!(relinked[0].attachment_status, "ready");
}

#[test]
fn generates_collection_review_reader_views_and_markdown_exports() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let collection = service
        .create_collection("Reading Group", None)
        .expect("collection created");
    let pdf = root.path().join("group-paper.pdf");
    std::fs::write(
        &pdf,
        b"evidence-backed summaries let readers jump from review draft to source",
    )
    .unwrap();

    let imported = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .expect("import succeeds");
    let item_id = imported[0].id;

    let reader_view = service.get_reader_view(item_id).expect("reader view exists");
    assert!(reader_view.normalized_html.contains("group-paper"));

    service.run_item_summary(item_id).expect("summary task");
    let review = service
        .run_collection_review_draft(collection.id)
        .expect("collection review");
    assert_eq!(review.kind, "collection.review_draft");

    let note = service
        .create_note_from_latest_collection_artifact(collection.id)
        .expect("note created");
    let exported = service
        .export_note_markdown(note.id)
        .expect("markdown exported");
    assert!(exported.contains("Reading Group"));

    let citation = service
        .export_citation(item_id, "apa7")
        .expect("citation exported");
    assert!(citation.contains("APA 7"));
}

#[test]
fn lists_tags_scoped_to_the_current_collection() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let ml = service
        .create_collection("Machine Learning", None)
        .expect("collection created");
    let systems = service
        .create_collection("Systems", None)
        .expect("collection created");
    let ml_pdf = root.path().join("ml-paper.pdf");
    let systems_pdf = root.path().join("systems-paper.pdf");
    std::fs::write(&ml_pdf, b"model scaling").unwrap();
    std::fs::write(&systems_pdf, b"distributed consensus").unwrap();

    let ml_item = service
        .import_files(ml.id, &[ml_pdf], ImportMode::ManagedCopy)
        .expect("import succeeds")[0]
        .clone();
    let systems_item = service
        .import_files(systems.id, &[systems_pdf], ImportMode::ManagedCopy)
        .expect("import succeeds")[0]
        .clone();

    let shared = service.create_tag("Core").expect("tag created");
    let systems_only = service.create_tag("Distributed").expect("tag created");
    service.assign_tag(ml_item.id, shared.id).expect("tag assigned");
    service
        .assign_tag(systems_item.id, shared.id)
        .expect("tag assigned");
    service
        .assign_tag(systems_item.id, systems_only.id)
        .expect("tag assigned");

    let ml_tags = service.list_tags(Some(ml.id)).expect("tags listed");
    assert_eq!(ml_tags.len(), 1);
    assert_eq!(ml_tags[0].name, "Core");
    assert_eq!(ml_tags[0].item_count, 1);
}

#[test]
fn imports_citation_records_and_exports_structured_formats() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let collection = service
        .create_collection("Bibliography", None)
        .expect("collection created");
    let bib = root.path().join("attention-is-all-you-need.bib");
    let ris = root.path().join("retrieval-augmented-generation.ris");

    std::fs::write(&bib, b"@article{attention}").unwrap();
    std::fs::write(&ris, b"TY  - JOUR").unwrap();

    let imported = service
        .import_citations(collection.id, &[bib, ris])
        .expect("citations imported");
    assert_eq!(imported.len(), 2);

    let items = service.list_items(Some(collection.id)).expect("items listed");
    assert_eq!(items[0].attachment_status, "citation_only");

    let bibtex = service
        .export_citation(imported[0].id, "bibtex")
        .expect("bibtex exported");
    assert!(bibtex.contains("@article"));

    let ris = service
        .export_citation(imported[0].id, "ris")
        .expect("ris exported");
    assert!(ris.contains("TY  - JOUR"));
}

#[test]
fn moves_collections_without_allowing_cycles() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");

    let ml = service
        .create_collection("Machine Learning", None)
        .expect("collection created");
    let systems = service
        .create_collection("Systems", None)
        .expect("collection created");
    let theory = service
        .create_collection("Theory", Some(ml.id))
        .expect("nested collection created");

    service
        .move_collection(systems.id, Some(ml.id))
        .expect("move succeeds");

    let collections = service.list_collections().expect("collections listed");
    let moved = collections
        .iter()
        .find(|collection| collection.id == systems.id)
        .expect("systems exists");
    assert_eq!(moved.parent_id, Some(ml.id));

    let cycle_error = service
        .move_collection(ml.id, Some(theory.id))
        .expect_err("cycle should fail");
    assert!(cycle_error.to_string().contains("descendant"));
}
