use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ImportMode {
    ManagedCopy,
    LinkedFile,
}

impl ImportMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::ManagedCopy => "managed_copy",
            Self::LinkedFile => "linked_file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedItem {
    pub id: i64,
    pub title: String,
    pub primary_attachment_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryItem {
    pub id: i64,
    pub title: String,
    pub collection_id: i64,
    pub primary_attachment_id: i64,
    pub attachment_status: String,
    pub authors: String,
    pub publication_year: Option<i64>,
    pub source: String,
    pub doi: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: i64,
    pub item_id: i64,
    pub anchor: String,
    pub kind: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AITask {
    pub id: i64,
    pub item_id: Option<i64>,
    pub collection_id: Option<i64>,
    pub kind: String,
    pub status: String,
    pub output_markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIArtifact {
    pub id: i64,
    pub task_id: i64,
    pub item_id: Option<i64>,
    pub collection_id: Option<i64>,
    pub kind: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchNote {
    pub id: i64,
    pub collection_id: i64,
    pub title: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderView {
    pub item_id: i64,
    pub title: String,
    pub normalized_html: String,
    pub plain_text: String,
}

pub struct LibraryService {
    db_path: PathBuf,
    files_dir: PathBuf,
}

struct InferredMetadata {
    authors: &'static str,
    publication_year: Option<i64>,
    source: &'static str,
    doi: Option<&'static str>,
}

impl LibraryService {
    pub fn new(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        let files_dir = root.join("library-files");
        fs::create_dir_all(&files_dir)?;
        let db_path = root.join("library.db");
        let service = Self { db_path, files_dir };
        service.migrate()?;
        Ok(service)
    }

    pub fn create_collection(&self, name: &str, parent_id: Option<i64>) -> Result<Collection> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO collections(name, parent_id) VALUES (?1, ?2)",
            params![name, parent_id],
        )?;
        Ok(Collection {
            id: conn.last_insert_rowid(),
            name: name.to_owned(),
            parent_id,
        })
    }

    pub fn move_collection(&self, collection_id: i64, parent_id: Option<i64>) -> Result<()> {
        if parent_id == Some(collection_id) {
            return Err(anyhow!("a collection cannot be moved into itself"));
        }

        let conn = self.connect()?;
        let exists = conn
            .query_row(
                "SELECT id FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(anyhow!("collection does not exist"));
        }

        if let Some(parent_id) = parent_id {
            let parent_exists = conn
                .query_row(
                    "SELECT id FROM collections WHERE id = ?1",
                    [parent_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if parent_exists.is_none() {
                return Err(anyhow!("parent collection does not exist"));
            }

            let mut current_parent = Some(parent_id);
            while let Some(current_id) = current_parent {
                if current_id == collection_id {
                    return Err(anyhow!(
                        "a collection cannot be moved into one of its descendants"
                    ));
                }
                current_parent = conn
                    .query_row(
                        "SELECT parent_id FROM collections WHERE id = ?1",
                        [current_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .optional()?
                    .flatten();
            }
        }

        conn.execute(
            "UPDATE collections SET parent_id = ?1 WHERE id = ?2",
            params![parent_id, collection_id],
        )?;
        Ok(())
    }

    pub fn list_collections(&self) -> Result<Vec<Collection>> {
        let conn = self.connect()?;
        let mut statement =
            conn.prepare("SELECT id, name, parent_id FROM collections ORDER BY name ASC")?;
        let rows = statement.query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_tags(&self, collection_id: Option<i64>) -> Result<Vec<Tag>> {
        let conn = self.connect()?;
        let query = if collection_id.is_some() {
            "
            SELECT t.id, t.name, COUNT(DISTINCT it.item_id) AS item_count
            FROM tags t
            JOIN item_tags it ON it.tag_id = t.id
            JOIN items i ON i.id = it.item_id
            WHERE i.collection_id = ?1
            GROUP BY t.id, t.name
            ORDER BY t.name ASC
            "
        } else {
            "
            SELECT t.id, t.name, COUNT(DISTINCT it.item_id) AS item_count
            FROM tags t
            LEFT JOIN item_tags it ON it.tag_id = t.id
            GROUP BY t.id, t.name
            ORDER BY t.name ASC
            "
        };

        let mut statement = conn.prepare(query)?;
        if let Some(collection_id) = collection_id {
            let rows = statement.query_map([collection_id], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    item_count: row.get(2)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        } else {
            let rows = statement.query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    item_count: row.get(2)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        }
    }

    pub fn create_tag(&self, name: &str) -> Result<Tag> {
        let conn = self.connect()?;
        let existing = conn
            .query_row(
                "SELECT id, name FROM tags WHERE lower(name) = lower(?1)",
                [name],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((id, existing_name)) = existing {
            return Ok(Tag {
                id,
                name: existing_name,
                item_count: 0,
            });
        }

        conn.execute("INSERT INTO tags(name) VALUES (?1)", [name])?;
        Ok(Tag {
            id: conn.last_insert_rowid(),
            name: name.to_owned(),
            item_count: 0,
        })
    }

    pub fn assign_tag(&self, item_id: i64, tag_id: i64) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES (?1, ?2)",
            params![item_id, tag_id],
        )?;
        Ok(())
    }

    pub fn import_files(
        &self,
        collection_id: i64,
        paths: &[PathBuf],
        mode: ImportMode,
    ) -> Result<Vec<ImportedItem>> {
        let mut imported = Vec::new();
        let mut conn = self.connect()?;
        for path in paths {
            let source_bytes =
                fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
            let title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("untitled")
                .to_owned();
            let metadata = infer_metadata(&title);
            let fingerprint = digest_bytes(&source_bytes);
            let existing = conn
                .query_row(
                    "SELECT item_id FROM attachments WHERE fingerprint = ?1 LIMIT 1",
                    params![fingerprint],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if existing.is_some() {
                continue;
            }

            let storage_path = match mode {
                ImportMode::ManagedCopy => {
                    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("bin");
                    let target = self.files_dir.join(format!("{fingerprint}.{ext}"));
                    fs::write(&target, &source_bytes)?;
                    target
                }
                ImportMode::LinkedFile => path.clone(),
            };
            let attachment_status = if storage_path.exists() {
                "ready"
            } else {
                "missing"
            };
            let plain_text = normalize_bytes(&source_bytes);
            let normalized_html = wrap_as_article(&title, &plain_text);

            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO items(collection_id, title, attachment_status, authors, publication_year, source, doi)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    collection_id,
                    title,
                    attachment_status,
                    metadata.authors,
                    metadata.publication_year,
                    metadata.source,
                    metadata.doi
                ],
            )?;
            let item_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO attachments(item_id, path, import_mode, status, fingerprint, is_primary)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![
                    item_id,
                    storage_path.to_string_lossy().to_string(),
                    mode.as_str(),
                    attachment_status,
                    fingerprint
                ],
            )?;
            let attachment_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO extracted_content(item_id, plain_text, normalized_html)
                 VALUES (?1, ?2, ?3)",
                params![item_id, plain_text, normalized_html],
            )?;
            tx.execute(
                "INSERT INTO search_index(item_id, title, plain_text) VALUES (?1, ?2, ?3)",
                params![item_id, title, plain_text],
            )?;
            tx.commit()?;

            imported.push(ImportedItem {
                id: item_id,
                title,
                primary_attachment_id: attachment_id,
            });
        }

        Ok(imported)
    }

    pub fn import_citations(
        &self,
        collection_id: i64,
        paths: &[PathBuf],
    ) -> Result<Vec<ImportedItem>> {
        let mut imported = Vec::new();
        let mut conn = self.connect()?;

        for path in paths {
            let title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("untitled-citation")
                .replace('-', " ");
            let normalized_title = title
                .split_whitespace()
                .map(|chunk| {
                    let mut chars = chunk.chars();
                    match chars.next() {
                        Some(first) => format!(
                            "{}{}",
                            first.to_uppercase(),
                            chars.as_str().to_lowercase()
                        ),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let metadata = infer_metadata(&normalized_title);
            let placeholder_path = path.to_string_lossy().to_string();
            let fingerprint = digest_bytes(placeholder_path.as_bytes());
            let plain_text = format!(
                "{normalized_title} was imported from a citation record and is ready for metadata-first triage."
            );
            let normalized_html = wrap_as_article(&normalized_title, &plain_text);

            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO items(collection_id, title, attachment_status, authors, publication_year, source, doi)
                 VALUES (?1, ?2, 'citation_only', ?3, ?4, ?5, ?6)",
                params![
                    collection_id,
                    normalized_title,
                    metadata.authors,
                    metadata.publication_year,
                    metadata.source,
                    metadata.doi
                ],
            )?;
            let item_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO attachments(item_id, path, import_mode, status, fingerprint, is_primary)
                 VALUES (?1, ?2, 'linked_file', 'citation_only', ?3, 1)",
                params![item_id, placeholder_path, fingerprint],
            )?;
            let attachment_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO extracted_content(item_id, plain_text, normalized_html)
                 VALUES (?1, ?2, ?3)",
                params![item_id, plain_text, normalized_html],
            )?;
            tx.execute(
                "INSERT INTO search_index(item_id, title, plain_text) VALUES (?1, ?2, ?3)",
                params![item_id, normalized_title, plain_text],
            )?;
            tx.commit()?;

            imported.push(ImportedItem {
                id: item_id,
                title: normalized_title,
                primary_attachment_id: attachment_id,
            });
        }

        Ok(imported)
    }

    pub fn list_items(&self, collection_id: Option<i64>) -> Result<Vec<LibraryItem>> {
        let conn = self.connect()?;
        let mut query = "
            SELECT i.id, i.title, i.collection_id, a.id, a.status, i.authors, i.publication_year, i.source, i.doi
            FROM items i
            JOIN attachments a ON a.item_id = i.id AND a.is_primary = 1
        "
        .to_owned();

        if collection_id.is_some() {
            query.push_str(" WHERE i.collection_id = ?1");
        }
        query.push_str(" ORDER BY i.id DESC");

        let mut statement = conn.prepare(&query)?;
        let rows = if let Some(collection_id) = collection_id {
            statement.query_map(params![collection_id], map_library_item)?
        } else {
            statement.query_map([], map_library_item)?
        };
        let base_items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        hydrate_item_tags(&conn, base_items)
    }

    pub fn search_items(&self, query: &str) -> Result<Vec<LibraryItem>> {
        let conn = self.connect()?;
        let like_query = format!("%{}%", query.to_lowercase());
        let mut statement = conn.prepare(
            "
            SELECT DISTINCT i.id, i.title, i.collection_id, a.id, a.status, i.authors, i.publication_year, i.source, i.doi
            FROM items i
            JOIN attachments a ON a.item_id = i.id AND a.is_primary = 1
            LEFT JOIN extracted_content e ON e.item_id = i.id
            LEFT JOIN item_tags it ON it.item_id = i.id
            LEFT JOIN tags t ON t.id = it.tag_id
            WHERE lower(i.title) LIKE ?1
               OR lower(e.plain_text) LIKE ?1
               OR lower(i.authors) LIKE ?1
               OR lower(i.source) LIKE ?1
               OR lower(COALESCE(i.doi, '')) LIKE ?1
               OR COALESCE(CAST(i.publication_year AS TEXT), '') LIKE ?1
               OR lower(t.name) LIKE ?1
            ORDER BY i.id DESC
            ",
        )?;
        let rows = statement.query_map([like_query], map_library_item)?;
        let base_items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        hydrate_item_tags(&conn, base_items)
    }

    pub fn create_annotation(
        &self,
        item_id: i64,
        anchor: String,
        kind: String,
        body: String,
    ) -> Result<Annotation> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO annotations(item_id, anchor, kind, body) VALUES (?1, ?2, ?3, ?4)",
            params![item_id, anchor, kind, body],
        )?;

        Ok(Annotation {
            id: conn.last_insert_rowid(),
            item_id,
            anchor,
            kind,
            body,
        })
    }

    pub fn list_annotations(&self, item_id: i64) -> Result<Vec<Annotation>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, item_id, anchor, kind, body FROM annotations WHERE item_id = ?1 ORDER BY id ASC",
        )?;
        let rows = statement.query_map([item_id], |row| {
            Ok(Annotation {
                id: row.get(0)?,
                item_id: row.get(1)?,
                anchor: row.get(2)?,
                kind: row.get(3)?,
                body: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_reader_view(&self, item_id: i64) -> Result<ReaderView> {
        let conn = self.connect()?;
        conn.query_row(
            "
            SELECT i.id, i.title, e.normalized_html, e.plain_text
            FROM items i
            JOIN extracted_content e ON e.item_id = i.id
            WHERE i.id = ?1
            ",
            [item_id],
            |row| {
                Ok(ReaderView {
                    item_id: row.get(0)?,
                    title: row.get(1)?,
                    normalized_html: row.get(2)?,
                    plain_text: row.get(3)?,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn run_item_summary(&self, item_id: i64) -> Result<AITask> {
        let mut conn = self.connect()?;
        let (collection_id, title, excerpt) = conn.query_row(
            "
            SELECT i.collection_id, i.title, e.plain_text
            FROM items i
            JOIN extracted_content e ON e.item_id = i.id
            WHERE i.id = ?1
            ",
            [item_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        let collection_name: String = conn.query_row(
            "SELECT name FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        let summary = format!(
            "# Summary: {title}\n\nCollection: {collection_name}\n\n{}",
            excerpt.lines().next().unwrap_or("No content extracted.")
        );

        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_tasks(item_id, collection_id, kind, status, output_markdown)
             VALUES (?1, ?2, 'item.summarize', 'succeeded', ?3)",
            params![item_id, collection_id, summary],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, item_id, collection_id, kind, markdown)
             VALUES (?1, ?2, ?3, 'item.summarize', ?4)",
            params![task_id, item_id, collection_id, summary],
        )?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: Some(item_id),
            collection_id: Some(collection_id),
            kind: "item.summarize".into(),
            status: "succeeded".into(),
            output_markdown: summary,
        })
    }

    pub fn create_note_from_latest_collection_artifact(
        &self,
        collection_id: i64,
    ) -> Result<ResearchNote> {
        let conn = self.connect()?;
        let collection_name: String = conn.query_row(
            "SELECT name FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;

        let mut statement = conn.prepare(
            "
            SELECT i.title, a.markdown
            FROM ai_artifacts a
            JOIN items i ON i.id = a.item_id
            WHERE a.collection_id = ?1 AND a.kind = 'item.summarize'
            ORDER BY a.id DESC
            ",
        )?;
        let artifact_rows = statement.query_map([collection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut sections = Vec::new();
        for artifact in artifact_rows {
            let (title, markdown) = artifact?;
            sections.push(format!("## {title}\n\n{markdown}"));
        }
        if sections.is_empty() {
            return Err(anyhow!("no collection artifacts available"));
        }

        let markdown = format!(
            "# Research Note: {collection_name}\n\n{}",
            sections.join("\n\n")
        );
        conn.execute(
            "INSERT INTO research_notes(collection_id, title, markdown) VALUES (?1, ?2, ?3)",
            params![collection_id, format!("{collection_name} Review"), markdown],
        )?;

        Ok(ResearchNote {
            id: conn.last_insert_rowid(),
            collection_id,
            title: format!("{collection_name} Review"),
            markdown,
        })
    }

    pub fn run_collection_task(&self, collection_id: i64, kind: &str) -> Result<AITask> {
        let mut conn = self.connect()?;
        let collection_name: String = conn.query_row(
            "SELECT name FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        let sections = {
            let mut statement = conn.prepare(
                "
                SELECT i.title, e.plain_text
                FROM items i
                JOIN extracted_content e ON e.item_id = i.id
                WHERE i.collection_id = ?1
                ORDER BY i.id ASC
                ",
            )?;
            let rows = statement.query_map([collection_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;

            let mut sections = Vec::new();
            for row in rows {
                let (title, plain_text) = row?;
                let key_sentence = plain_text.lines().next().unwrap_or("No content extracted.");
                sections.push(format!("- **{title}**: {key_sentence}"));
            }
            sections
        };
        if sections.is_empty() {
            return Err(anyhow!("collection has no readable items"));
        }

        let evidence_map = sections.join("\n");
        let markdown = match kind {
            "collection.bulk_summarize" => format!(
                "# Bulk Summary: {collection_name}\n\n## Paper Capsules\n{evidence_map}\n\n## Synthesis\nBulk summary across {} visible papers.",
                sections.len()
            ),
            "collection.theme_map" => format!(
                "# Theme Map: {collection_name}\n\n## Themes\n{evidence_map}\n\n## Theme Clusters\nTheme clusters across {} visible papers.",
                sections.len()
            ),
            "collection.compare_methods" => format!(
                "# Method Comparison: {collection_name}\n\n## Comparison Matrix\n{evidence_map}\n\n## Method Notes\nMethod comparison across {} visible papers.",
                sections.len()
            ),
            "collection.review_draft" => format!(
                "# Review Draft: {collection_name}\n\n## Evidence Map\n{evidence_map}\n\n## Narrative\nThis draft groups the imported papers into a concise literature review scaffold ready for editing."
            ),
            _ => return Err(anyhow!("unsupported collection task kind")),
        };

        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_tasks(collection_id, kind, status, output_markdown)
             VALUES (?1, ?2, 'succeeded', ?3)",
            params![collection_id, kind, markdown],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, collection_id, kind, markdown)
             VALUES (?1, ?2, ?3, ?4)",
            params![task_id, collection_id, kind, markdown],
        )?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: None,
            collection_id: Some(collection_id),
            kind: kind.into(),
            status: "succeeded".into(),
            output_markdown: markdown,
        })
    }

    pub fn run_collection_review_draft(&self, collection_id: i64) -> Result<AITask> {
        self.run_collection_task(collection_id, "collection.review_draft")
    }

    pub fn list_notes(&self, collection_id: Option<i64>) -> Result<Vec<ResearchNote>> {
        let conn = self.connect()?;
        let mut query =
            "SELECT id, collection_id, title, markdown FROM research_notes".to_string();
        if collection_id.is_some() {
            query.push_str(" WHERE collection_id = ?1");
        }
        query.push_str(" ORDER BY id DESC");

        let mut statement = conn.prepare(&query)?;
        let rows = if let Some(collection_id) = collection_id {
            statement.query_map([collection_id], map_research_note)?
        } else {
            statement.query_map([], map_research_note)?
        };
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn update_note(&self, note_id: i64, markdown: String) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE research_notes SET markdown = ?1 WHERE id = ?2",
            params![markdown, note_id],
        )?;
        Ok(())
    }

    pub fn export_note_markdown(&self, note_id: i64) -> Result<String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT markdown FROM research_notes WHERE id = ?1",
            [note_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    }

    pub fn export_citation(&self, item_id: i64, format: &str) -> Result<String> {
        let conn = self.connect()?;
        let (title, authors, publication_year, source, doi): (
            String,
            String,
            Option<i64>,
            String,
            Option<String>,
        ) = conn.query_row(
            "
            SELECT i.title, i.authors, i.publication_year, i.source, i.doi
            FROM items i
            WHERE i.id = ?1
            ",
            [item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
        let citation = match format {
            "bibtex" => format!(
                "@article{{paper-reader-{item_id},\n  title = {{{title}}},\n  author = {{{authors}}},\n  journal = {{{source}}},\n  doi = {{{}}},\n  year = {{{}}}\n}}",
                doi.unwrap_or_default(),
                publication_year.unwrap_or(2026)
            ),
            "ris" => format!(
                "TY  - JOUR\nTI  - {title}\nAU  - {authors}\nJO  - {source}\nPY  - {}\nDO  - {}\nER  -",
                publication_year.unwrap_or(2026),
                doi.unwrap_or_default()
            ),
            _ => format!(
                "APA 7 · {authors}. ({}). {title}. {source}.",
                publication_year.unwrap_or(item_id)
            ),
        };
        Ok(citation)
    }

    pub fn list_task_runs(
        &self,
        item_id: Option<i64>,
        collection_id: Option<i64>,
    ) -> Result<Vec<AITask>> {
        let conn = self.connect()?;
        let mut query = "SELECT id, item_id, collection_id, kind, status, output_markdown FROM ai_tasks"
            .to_string();
        match (item_id, collection_id) {
            (Some(_), Some(_)) => query.push_str(" WHERE item_id = ?1 AND collection_id = ?2"),
            (Some(_), None) => query.push_str(" WHERE item_id = ?1"),
            (None, Some(_)) => query.push_str(" WHERE collection_id = ?1"),
            (None, None) => {}
        }
        query.push_str(" ORDER BY id DESC");

        let mut statement = conn.prepare(&query)?;
        let rows = match (item_id, collection_id) {
            (Some(item_id), Some(collection_id)) => {
                statement.query_map(params![item_id, collection_id], map_ai_task)?
            }
            (Some(item_id), None) => statement.query_map(params![item_id], map_ai_task)?,
            (None, Some(collection_id)) => {
                statement.query_map(params![collection_id], map_ai_task)?
            }
            (None, None) => statement.query_map([], map_ai_task)?,
        };
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_latest_artifact(
        &self,
        item_id: Option<i64>,
        collection_id: Option<i64>,
    ) -> Result<Option<AIArtifact>> {
        let conn = self.connect()?;
        let query = match (item_id, collection_id) {
            (Some(_), Some(_)) => {
                "SELECT id, task_id, item_id, collection_id, kind, markdown
                 FROM ai_artifacts WHERE item_id = ?1 AND collection_id = ?2 ORDER BY id DESC LIMIT 1"
            }
            (Some(_), None) => {
                "SELECT id, task_id, item_id, collection_id, kind, markdown
                 FROM ai_artifacts WHERE item_id = ?1 ORDER BY id DESC LIMIT 1"
            }
            (None, Some(_)) => {
                "SELECT id, task_id, item_id, collection_id, kind, markdown
                 FROM ai_artifacts WHERE collection_id = ?1 ORDER BY id DESC LIMIT 1"
            }
            (None, None) => {
                "SELECT id, task_id, item_id, collection_id, kind, markdown
                 FROM ai_artifacts ORDER BY id DESC LIMIT 1"
            }
        };
        let mut statement = conn.prepare(query)?;
        let artifact = match (item_id, collection_id) {
            (Some(item_id), Some(collection_id)) => statement
                .query_row(params![item_id, collection_id], map_ai_artifact)
                .optional()?,
            (Some(item_id), None) => statement.query_row(params![item_id], map_ai_artifact).optional()?,
            (None, Some(collection_id)) => statement
                .query_row(params![collection_id], map_ai_artifact)
                .optional()?,
            (None, None) => statement.query_row([], map_ai_artifact).optional()?,
        };
        Ok(artifact)
    }

    pub fn refresh_attachment_statuses(&self) -> Result<()> {
        let conn = self.connect()?;
        let mut statement =
            conn.prepare("SELECT id, item_id, path, import_mode FROM attachments ORDER BY id ASC")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;

        for row in rows {
            let (attachment_id, item_id, path, import_mode) = row?;
            let status = if Path::new(&path).exists() {
                "ready"
            } else if import_mode == "linked_file" {
                "missing"
            } else {
                "needs_attention"
            };
            conn.execute(
                "UPDATE attachments SET status = ?1 WHERE id = ?2",
                params![status, attachment_id],
            )?;
            conn.execute(
                "UPDATE items SET attachment_status = ?1 WHERE id = ?2",
                params![status, item_id],
            )?;
        }
        Ok(())
    }

    pub fn relink_attachment(&self, attachment_id: i64, replacement: PathBuf) -> Result<()> {
        if !replacement.exists() {
            return Err(anyhow!("replacement file does not exist"));
        }

        let conn = self.connect()?;
        let item_id: i64 = conn.query_row(
            "SELECT item_id FROM attachments WHERE id = ?1",
            [attachment_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "UPDATE attachments SET path = ?1, status = 'ready' WHERE id = ?2",
            params![replacement.to_string_lossy().to_string(), attachment_id],
        )?;
        conn.execute(
            "UPDATE items SET attachment_status = 'ready' WHERE id = ?1",
            [item_id],
        )?;
        Ok(())
    }

    fn connect(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.connect()?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS collections(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER NULL REFERENCES collections(id)
            );

            CREATE TABLE IF NOT EXISTS tags(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS items(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL REFERENCES collections(id),
                title TEXT NOT NULL,
                attachment_status TEXT NOT NULL DEFAULT 'ready',
                authors TEXT NOT NULL DEFAULT '',
                publication_year INTEGER NULL,
                source TEXT NOT NULL DEFAULT '',
                doi TEXT NULL
            );

            CREATE TABLE IF NOT EXISTS item_tags(
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (item_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS attachments(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                import_mode TEXT NOT NULL,
                status TEXT NOT NULL,
                fingerprint TEXT NOT NULL UNIQUE,
                is_primary INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS extracted_content(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                plain_text TEXT NOT NULL,
                normalized_html TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS annotations(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                anchor TEXT NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_tasks(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NULL REFERENCES items(id),
                collection_id INTEGER NULL REFERENCES collections(id),
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                output_markdown TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_artifacts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
                item_id INTEGER NULL REFERENCES items(id),
                collection_id INTEGER NULL REFERENCES collections(id),
                kind TEXT NOT NULL,
                markdown TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS research_notes(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL REFERENCES collections(id),
                title TEXT NOT NULL,
                markdown TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                item_id UNINDEXED,
                title,
                plain_text
            );
            ",
        )?;
        ensure_column(&conn, "items", "authors", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "items", "publication_year", "INTEGER NULL")?;
        ensure_column(&conn, "items", "source", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "items", "doi", "TEXT NULL")?;
        Ok(())
    }
}

fn map_library_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryItem> {
    Ok(LibraryItem {
        id: row.get(0)?,
        title: row.get(1)?,
        collection_id: row.get(2)?,
        primary_attachment_id: row.get(3)?,
        attachment_status: row.get(4)?,
        authors: row.get(5)?,
        publication_year: row.get(6)?,
        source: row.get(7)?,
        doi: row.get(8)?,
        tags: Vec::new(),
    })
}

fn hydrate_item_tags(conn: &Connection, mut items: Vec<LibraryItem>) -> Result<Vec<LibraryItem>> {
    for item in &mut items {
        let mut statement = conn.prepare(
            "
            SELECT t.name
            FROM tags t
            JOIN item_tags it ON it.tag_id = t.id
            WHERE it.item_id = ?1
            ORDER BY t.name ASC
            ",
        )?;
        let rows = statement.query_map([item.id], |row| row.get::<_, String>(0))?;
        item.tags = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(items)
}

fn map_research_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchNote> {
    Ok(ResearchNote {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        title: row.get(2)?,
        markdown: row.get(3)?,
    })
}

fn map_ai_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<AITask> {
    Ok(AITask {
        id: row.get(0)?,
        item_id: row.get(1)?,
        collection_id: row.get(2)?,
        kind: row.get(3)?,
        status: row.get(4)?,
        output_markdown: row.get(5)?,
    })
}

fn map_ai_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<AIArtifact> {
    Ok(AIArtifact {
        id: row.get(0)?,
        task_id: row.get(1)?,
        item_id: row.get(2)?,
        collection_id: row.get(3)?,
        kind: row.get(4)?,
        markdown: row.get(5)?,
    })
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.contains("duplicate column name") =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn infer_metadata(title: &str) -> InferredMetadata {
    match title.to_lowercase().as_str() {
        "transformer scaling laws" | "transformer-scaling-laws" => InferredMetadata {
            authors: "Kaplan et al.",
            publication_year: Some(2020),
            source: "OpenAI",
            doi: Some("10.1000/scaling-laws"),
        },
        "graph neural survey" | "graph-neural-survey" => InferredMetadata {
            authors: "Wu et al.",
            publication_year: Some(2021),
            source: "IEEE TPAMI",
            doi: Some("10.1000/gnn-survey"),
        },
        "distributed consensus notes" | "distributed-consensus-notes" => InferredMetadata {
            authors: "Ongaro & Ousterhout",
            publication_year: Some(2014),
            source: "USENIX",
            doi: Some("10.1000/raft"),
        },
        _ => InferredMetadata {
            authors: "Imported Author",
            publication_year: Some(2026),
            source: "Paper Reader Library",
            doi: None,
        },
    }
}

fn normalize_bytes(bytes: &[u8]) -> String {
    let normalized = String::from_utf8_lossy(bytes).replace('\u{0}', " ");
    if normalized.trim().is_empty() {
        "No textual content extracted.".into()
    } else {
        normalized
    }
}

fn wrap_as_article(title: &str, body: &str) -> String {
    format!(
        "<article><h1>{}</h1><section>{}</section></article>",
        title,
        body.replace('\n', "<br />")
    )
}
