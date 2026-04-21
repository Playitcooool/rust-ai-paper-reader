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
fn generates_task_specific_collection_outputs() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let collection = service
        .create_collection("Reading Group", None)
        .expect("collection created");
    let pdf = root.path().join("group-paper.pdf");
    let docx = root.path().join("survey-notes.docx");
    std::fs::write(
        &pdf,
        b"Scaling laws show predictable returns as compute, data, and parameters grow in sync.",
    )
    .unwrap();
    std::fs::write(
        &docx,
        b"Graph neural networks compare message passing, pooling, and graph-level supervision.",
    )
    .unwrap();

    service
        .import_files(collection.id, &[pdf, docx], ImportMode::ManagedCopy)
        .expect("import succeeds");

    let theme_map = service
        .run_collection_task(collection.id, "collection.theme_map")
        .expect("theme map succeeds");
    assert_eq!(theme_map.kind, "collection.theme_map");
    assert!(theme_map.output_markdown.contains("# Theme Map: Reading Group"));
    assert!(theme_map.output_markdown.contains("## Themes"));

    let compare_methods = service
        .run_collection_task(collection.id, "collection.compare_methods")
        .expect("comparison succeeds");
    assert_eq!(compare_methods.kind, "collection.compare_methods");
    assert!(
        compare_methods
            .output_markdown
            .contains("# Method Comparison: Reading Group")
    );
    assert!(compare_methods.output_markdown.contains("## Comparison Matrix"));
}

#[test]
fn generates_task_specific_item_outputs() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let collection = service
        .create_collection("Machine Learning", None)
        .expect("collection created");
    let pdf = root.path().join("paper.pdf");
    std::fs::write(
        &pdf,
        b"Scaling laws show predictable returns as compute, data, and parameters grow in sync.",
    )
    .unwrap();

    let imported = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .expect("import succeeds");
    let item_id = imported[0].id;

    let translation = service
        .run_item_task(item_id, "item.translate")
        .expect("translation succeeds");
    assert_eq!(translation.kind, "item.translate");
    assert!(translation.output_markdown.contains("# Translation: paper"));
    assert!(translation.output_markdown.contains("## Translated Passage"));

    let explanation = service
        .run_item_task(item_id, "item.explain_term")
        .expect("term explanation succeeds");
    assert_eq!(explanation.kind, "item.explain_term");
    assert!(explanation.output_markdown.contains("# Terminology Notes: paper"));
    assert!(explanation.output_markdown.contains("## Key Terms"));
}

#[test]
fn removes_items_and_cleans_managed_files_and_indexes() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let collection = service
        .create_collection("Machine Learning", None)
        .expect("collection created");
    let pdf = root.path().join("paper.pdf");
    std::fs::write(
        &pdf,
        b"Scaling laws show predictable returns as compute, data, and parameters grow in sync.",
    )
    .unwrap();

    let imported = service
        .import_files(collection.id, &[pdf], ImportMode::ManagedCopy)
        .expect("import succeeds");
    let item_id = imported[0].id;
    service
        .create_annotation(
            item_id,
            "section-1".into(),
            "highlight".into(),
            "Important paragraph".into(),
        )
        .expect("annotation created");
    service
        .run_item_task(item_id, "item.summarize")
        .expect("summary succeeds");

    let managed_files = root.path().join("library-files");
    assert_eq!(std::fs::read_dir(&managed_files).unwrap().count(), 1);

    service.remove_item(item_id).expect("item removed");

    assert!(service.list_items(Some(collection.id)).unwrap().is_empty());
    assert!(service.search_items("scaling").unwrap().is_empty());
    assert!(service.list_annotations(item_id).unwrap().is_empty());
    assert!(service.list_task_runs(Some(item_id), None).unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&managed_files).unwrap().count(), 0);
}

#[test]
fn moves_items_between_collections_and_preserves_item_history() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");
    let inbox = service
        .create_collection("Inbox", None)
        .expect("collection created");
    let reading = service
        .create_collection("Reading", None)
        .expect("collection created");
    let pdf = root.path().join("paper.pdf");
    std::fs::write(
        &pdf,
        b"Scaling laws show predictable returns as compute, data, and parameters grow in sync.",
    )
    .unwrap();

    let imported = service
        .import_files(inbox.id, &[pdf], ImportMode::ManagedCopy)
        .expect("import succeeds");
    let item_id = imported[0].id;
    service
        .run_item_task(item_id, "item.summarize")
        .expect("summary succeeds");

    service.move_item(item_id, reading.id).expect("item moved");

    let inbox_items = service.list_items(Some(inbox.id)).expect("inbox items listed");
    let reading_items = service
        .list_items(Some(reading.id))
        .expect("reading items listed");
    assert!(inbox_items.is_empty());
    assert_eq!(reading_items.len(), 1);
    assert_eq!(reading_items[0].collection_id, reading.id);

    let item_tasks = service.list_task_runs(Some(item_id), None).expect("tasks listed");
    assert_eq!(item_tasks[0].collection_id, Some(reading.id));

    let item_artifact = service
        .get_latest_artifact(Some(item_id), None)
        .expect("artifact lookup succeeds")
        .expect("artifact exists");
    assert_eq!(item_artifact.collection_id, Some(reading.id));
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

#[test]
fn searches_items_by_metadata_fields() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");

    let collection = service
        .create_collection("Machine Learning", None)
        .expect("collection created");
    let paper = root.path().join("transformer-scaling-laws.pdf");
    std::fs::write(&paper, b"scaling laws").unwrap();

    service
        .import_files(collection.id, &[paper], ImportMode::ManagedCopy)
        .expect("import succeeds");

    let by_author = service.search_items("Kaplan").expect("author search works");
    assert_eq!(by_author.len(), 1);
    assert_eq!(by_author[0].title, "transformer-scaling-laws");

    let by_year = service.search_items("2020").expect("year search works");
    assert_eq!(by_year.len(), 1);
}

#[test]
fn updates_item_metadata_and_search_uses_the_new_values() {
    let root = tempdir().unwrap();
    let service = LibraryService::new(root.path()).expect("service initializes");

    let collection = service
        .create_collection("Machine Learning", None)
        .expect("collection created");
    let paper = root.path().join("transformer-scaling-laws.pdf");
    std::fs::write(&paper, b"scaling laws").unwrap();

    let imported = service
        .import_files(collection.id, &[paper], ImportMode::ManagedCopy)
        .expect("import succeeds");
    let item_id = imported[0].id;

    service
        .update_item_metadata(
            item_id,
            "Edited Scaling Laws".into(),
            "OpenAI Research".into(),
            Some(2024),
            "NeurIPS".into(),
            Some("10.1000/edited-scaling".into()),
        )
        .expect("metadata update succeeds");

    let updated = service.list_items(Some(collection.id)).expect("items listed");
    assert_eq!(updated[0].title, "Edited Scaling Laws");
    assert_eq!(updated[0].authors, "OpenAI Research");
    assert_eq!(updated[0].publication_year, Some(2024));
    assert_eq!(updated[0].source, "NeurIPS");
    assert_eq!(updated[0].doi.as_deref(), Some("10.1000/edited-scaling"));

    let by_title = service
        .search_items("edited scaling")
        .expect("title search works");
    assert_eq!(by_title.len(), 1);
    assert_eq!(by_title[0].id, item_id);

    let by_author = service
        .search_items("openai research")
        .expect("author search works");
    assert_eq!(by_author.len(), 1);
    assert_eq!(by_author[0].id, item_id);
}
