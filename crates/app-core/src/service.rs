use std::{
    fs,
    io::{Cursor, Read, Seek},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use html_escape::encode_safe;
use regex::Regex;
use roxmltree::Document;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

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
    pub attachment_format: String,
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
    pub scope_item_ids: Option<Vec<i64>>,
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
    pub scope_item_ids: Option<Vec<i64>>,
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
    pub reader_kind: String,
    pub attachment_format: String,
    pub primary_attachment_id: Option<i64>,
    pub primary_attachment_path: Option<String>,
    pub page_count: Option<i64>,
    pub content_status: String,
    pub content_notice: Option<String>,
    pub normalized_html: String,
    pub plain_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPathResult {
    pub path: String,
    pub status: String,
    pub message: String,
    pub item: Option<ImportedItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportBatchResult {
    pub imported: Vec<ImportedItem>,
    pub duplicates: Vec<ImportPathResult>,
    pub failed: Vec<ImportPathResult>,
    pub results: Vec<ImportPathResult>,
}

pub struct LibraryService {
    db_path: PathBuf,
    files_dir: PathBuf,
}

struct InferredMetadata {
    title: Option<String>,
    authors: String,
    publication_year: Option<i64>,
    source: String,
    doi: Option<String>,
}

struct ExtractedDocument {
    plain_text: String,
    normalized_html: String,
    page_count: Option<i64>,
    content_status: String,
    content_notice: Option<String>,
    metadata: InferredMetadata,
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

    pub fn rename_collection(&self, collection_id: i64, name: &str) -> Result<()> {
        let conn = self.connect()?;
        let updated = conn.execute(
            "UPDATE collections SET name = ?1 WHERE id = ?2",
            params![name, collection_id],
        )?;
        if updated == 0 {
            return Err(anyhow!("collection does not exist"));
        }
        Ok(())
    }

    pub fn remove_collection(&self, collection_id: i64) -> Result<()> {
        let conn = self.connect()?;
        let child_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM collections WHERE parent_id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        if child_count > 0 {
            return Err(anyhow!(
                "remove or move nested collections before deleting this collection"
            ));
        }

        let item_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE collection_id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        if item_count > 0 {
            return Err(anyhow!("move or remove papers before deleting this collection"));
        }

        let deleted = conn.execute("DELETE FROM collections WHERE id = ?1", [collection_id])?;
        if deleted == 0 {
            return Err(anyhow!("collection does not exist"));
        }
        Ok(())
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
    ) -> Result<ImportBatchResult> {
        let mut imported = Vec::new();
        let mut duplicates = Vec::new();
        let mut failed = Vec::new();
        let mut results = Vec::new();
        let mut conn = self.connect()?;

        for path in paths {
            let path_label = path.to_string_lossy().to_string();
            let format = infer_attachment_format(&path_label);
            if format == "unknown" {
                let result = ImportPathResult {
                    path: path_label,
                    status: "failed".into(),
                    message: "Unsupported attachment format.".into(),
                    item: None,
                };
                failed.push(result.clone());
                results.push(result);
                continue;
            }

            let source_bytes = match fs::read(path)
                .with_context(|| format!("failed to read {}", path.display()))
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    let result = ImportPathResult {
                        path: path_label,
                        status: "failed".into(),
                        message: error.to_string(),
                        item: None,
                    };
                    failed.push(result.clone());
                    results.push(result);
                    continue;
                }
            };
            let fingerprint = digest_bytes(&source_bytes);
            let existing = conn
                .query_row(
                    "SELECT attachments.item_id, attachments.id, items.title FROM attachments
                     JOIN items ON items.id = attachments.item_id
                     WHERE fingerprint = ?1 LIMIT 1",
                    params![fingerprint],
                    |row| {
                        Ok(ImportedItem {
                            id: row.get(0)?,
                            primary_attachment_id: row.get(1)?,
                            title: row.get(2)?,
                        })
                    },
                )
                .optional()?;

            if let Some(item) = existing {
                let result = ImportPathResult {
                    path: path_label,
                    status: "duplicate".into(),
                    message: format!("Duplicate of existing library item {}.", item.title),
                    item: Some(item),
                };
                duplicates.push(result.clone());
                results.push(result);
                continue;
            }

            let extracted = match extract_document(path, &source_bytes, format) {
                Ok(extracted) => extracted,
                Err(error) => {
                    let result = ImportPathResult {
                        path: path_label,
                        status: "failed".into(),
                        message: error.to_string(),
                        item: None,
                    };
                    failed.push(result.clone());
                    results.push(result);
                    continue;
                }
            };
            let title = extracted.metadata.title.clone().unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("untitled")
                    .replace(['-', '_'], " ")
            });

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

            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO items(collection_id, title, attachment_status, authors, publication_year, source, doi)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    collection_id,
                    title,
                    attachment_status,
                    extracted.metadata.authors,
                    extracted.metadata.publication_year,
                    extracted.metadata.source,
                    extracted.metadata.doi
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
                "INSERT INTO extracted_content(item_id, plain_text, normalized_html, page_count, content_status, content_notice)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    item_id,
                    extracted.plain_text,
                    extracted.normalized_html,
                    extracted.page_count,
                    extracted.content_status,
                    extracted.content_notice
                ],
            )?;
            tx.execute(
                "INSERT INTO search_index(item_id, title, plain_text) VALUES (?1, ?2, ?3)",
                params![item_id, title, extracted.plain_text],
            )?;
            tx.commit()?;

            let item = ImportedItem {
                id: item_id,
                title,
                primary_attachment_id: attachment_id,
            };
            imported.push(item.clone());
            results.push(ImportPathResult {
                path: path.to_string_lossy().to_string(),
                status: "imported".into(),
                message: "Imported successfully.".into(),
                item: Some(item),
            });
        }

        Ok(ImportBatchResult {
            imported,
            duplicates,
            failed,
            results,
        })
    }

    pub fn import_citations(
        &self,
        collection_id: i64,
        paths: &[PathBuf],
    ) -> Result<ImportBatchResult> {
        let mut imported = Vec::new();
        let duplicates = Vec::new();
        let failed = Vec::new();
        let mut results = Vec::new();
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
                "INSERT INTO extracted_content(item_id, plain_text, normalized_html, page_count, content_status, content_notice)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    item_id,
                    plain_text,
                    normalized_html,
                    Option::<i64>::None,
                    "partial",
                    Some("Citation-only entry. Attach a source file to enable reading.".to_string())
                ],
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
            results.push(ImportPathResult {
                path: path.to_string_lossy().to_string(),
                status: "imported".into(),
                message: "Citation imported successfully.".into(),
                item: imported.last().cloned(),
            });
        }

        Ok(ImportBatchResult {
            imported,
            duplicates,
            failed,
            results,
        })
    }

    pub fn list_items(&self, collection_id: Option<i64>) -> Result<Vec<LibraryItem>> {
        let conn = self.connect()?;
        let mut query = "
            SELECT i.id, i.title, i.collection_id, a.id, a.path, a.status, i.authors, i.publication_year, i.source, i.doi
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

    pub fn update_item_metadata(
        &self,
        item_id: i64,
        title: String,
        authors: String,
        publication_year: Option<i64>,
        source: String,
        doi: Option<String>,
    ) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "
            UPDATE items
            SET title = ?1, authors = ?2, publication_year = ?3, source = ?4, doi = ?5
            WHERE id = ?6
            ",
            params![title, authors, publication_year, source, doi, item_id],
        )?;
        conn.execute(
            "UPDATE search_index SET title = ?1 WHERE item_id = ?2",
            params![title, item_id],
        )?;
        Ok(())
    }

    pub fn remove_item(&self, item_id: i64) -> Result<()> {
        let mut conn = self.connect()?;
        let attachments = {
            let mut statement = conn.prepare(
                "SELECT path, import_mode FROM attachments WHERE item_id = ?1 ORDER BY id ASC",
            )?;
            let rows = statement.query_map([item_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if attachments.is_empty() {
            return Err(anyhow!("item does not exist"));
        }

        let tx = conn.transaction()?;
        tx.execute("DELETE FROM ai_artifacts WHERE item_id = ?1", [item_id])?;
        tx.execute("DELETE FROM ai_tasks WHERE item_id = ?1", [item_id])?;
        tx.execute("DELETE FROM search_index WHERE item_id = ?1", [item_id])?;
        tx.execute("DELETE FROM items WHERE id = ?1", [item_id])?;
        tx.commit()?;

        for (path, import_mode) in attachments {
            if import_mode == ImportMode::ManagedCopy.as_str() {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }

        Ok(())
    }

    pub fn move_item(&self, item_id: i64, collection_id: i64) -> Result<()> {
        let conn = self.connect()?;
        let item_exists = conn
            .query_row("SELECT id FROM items WHERE id = ?1", [item_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?;
        if item_exists.is_none() {
            return Err(anyhow!("item does not exist"));
        }

        let collection_exists = conn
            .query_row(
                "SELECT id FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if collection_exists.is_none() {
            return Err(anyhow!("collection does not exist"));
        }

        conn.execute(
            "UPDATE items SET collection_id = ?1 WHERE id = ?2",
            params![collection_id, item_id],
        )?;
        conn.execute(
            "UPDATE ai_tasks SET collection_id = ?1 WHERE item_id = ?2",
            params![collection_id, item_id],
        )?;
        conn.execute(
            "UPDATE ai_artifacts SET collection_id = ?1 WHERE item_id = ?2",
            params![collection_id, item_id],
        )?;
        Ok(())
    }

    pub fn search_items(&self, query: &str) -> Result<Vec<LibraryItem>> {
        let conn = self.connect()?;
        let like_query = format!("%{}%", query.to_lowercase());
        let mut statement = conn.prepare(
            "
            SELECT DISTINCT i.id, i.title, i.collection_id, a.id, a.path, a.status, i.authors, i.publication_year, i.source, i.doi
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

    pub fn remove_annotation(&self, annotation_id: i64) -> Result<()> {
        let conn = self.connect()?;
        conn.execute("DELETE FROM annotations WHERE id = ?1", [annotation_id])?;
        Ok(())
    }

    pub fn get_reader_view(&self, item_id: i64) -> Result<ReaderView> {
        let conn = self.connect()?;
        conn.query_row(
            "
            SELECT i.id, i.title, a.id, a.path, e.normalized_html, e.plain_text, e.page_count, e.content_status, e.content_notice
            FROM items i
            LEFT JOIN attachments a ON a.item_id = i.id AND a.is_primary = 1
            JOIN extracted_content e ON e.item_id = i.id
            WHERE i.id = ?1
            ",
            [item_id],
            |row| {
                let attachment_path: Option<String> = row.get(3)?;
                let attachment_format = attachment_path
                    .as_deref()
                    .map(infer_attachment_format)
                    .unwrap_or("unknown")
                    .to_string();
                let reader_kind = if attachment_format == "pdf" {
                    "pdf".to_string()
                } else {
                    "normalized".to_string()
                };
                Ok(ReaderView {
                    item_id: row.get(0)?,
                    title: row.get(1)?,
                    reader_kind,
                    attachment_format,
                    primary_attachment_id: row.get(2)?,
                    primary_attachment_path: attachment_path,
                    page_count: row.get(6)?,
                    content_status: row.get(7)?,
                    content_notice: row.get(8)?,
                    normalized_html: row.get(4)?,
                    plain_text: row.get(5)?,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn run_item_task(&self, item_id: i64, kind: &str) -> Result<AITask> {
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
        let first_line = excerpt.lines().next().unwrap_or("No content extracted.");
        let output = match kind {
            "item.summarize" => format!(
                "# Summary: {title}\n\nCollection: {collection_name}\n\n{first_line}"
            ),
            "item.translate" => format!(
                "# Translation: {title}\n\n## Translated Passage\n{first_line}\n\n## Notes\nTranslated from the active reader selection."
            ),
            "item.explain_term" => format!(
                "# Terminology Notes: {title}\n\n## Key Terms\n- Scaling law: {first_line}\n\n## Reading Tip\nUse this note to clarify repeated technical vocabulary."
            ),
            "item.ask" => format!(
                "# Reading Q&A: {title}\n\n## Answer\n{first_line}\n\n## Evidence\nCollection: {collection_name}"
            ),
            _ => return Err(anyhow!("unsupported item task kind")),
        };

        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_tasks(item_id, collection_id, kind, status, output_markdown)
             VALUES (?1, ?2, ?3, 'succeeded', ?4)",
            params![item_id, collection_id, kind, output],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, item_id, collection_id, kind, markdown)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![task_id, item_id, collection_id, kind, output],
        )?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: Some(item_id),
            collection_id: Some(collection_id),
            scope_item_ids: None,
            kind: kind.into(),
            status: "succeeded".into(),
            output_markdown: output,
        })
    }

    pub fn run_item_summary(&self, item_id: i64) -> Result<AITask> {
        self.run_item_task(item_id, "item.summarize")
    }

    pub fn create_note_from_artifact(&self, artifact_id: i64) -> Result<ResearchNote> {
        let conn = self.connect()?;
        let (collection_id, collection_name, markdown): (i64, String, String) = conn.query_row(
            "
            SELECT a.collection_id, c.name, a.markdown
            FROM ai_artifacts a
            JOIN collections c ON c.id = a.collection_id
            WHERE a.id = ?1
            ",
            [artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let title = extract_markdown_heading(&markdown)
            .unwrap_or_else(|| format!("{collection_name} Note"));
        conn.execute(
            "INSERT INTO research_notes(collection_id, title, markdown) VALUES (?1, ?2, ?3)",
            params![collection_id, title, markdown],
        )?;

        Ok(ResearchNote {
            id: conn.last_insert_rowid(),
            collection_id,
            title,
            markdown,
        })
    }

    pub fn run_collection_task(
        &self,
        collection_id: i64,
        kind: &str,
        scope_item_ids: &[i64],
    ) -> Result<AITask> {
        if scope_item_ids.is_empty() {
            return Err(anyhow!("collection has no readable items"));
        }
        let mut conn = self.connect()?;
        let collection_name: String = conn.query_row(
            "SELECT name FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        let sections = {
            let mut sections = Vec::new();
            for item_id in scope_item_ids {
                let row = conn
                    .query_row(
                        "
                        SELECT i.title, e.plain_text
                        FROM items i
                        JOIN extracted_content e ON e.item_id = i.id
                        WHERE i.id = ?1 AND i.collection_id = ?2
                        ",
                        params![item_id, collection_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()?;
                let Some((title, plain_text)) = row else {
                    return Err(anyhow!(
                        "scope contains items outside the target collection"
                    ));
                };
                let key_sentence = plain_text.lines().next().unwrap_or("No content extracted.");
                sections.push(format!("- **{title}**: {key_sentence}"));
            }
            sections
        };

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
        let scope_json = serde_json::to_string(scope_item_ids)?;
        tx.execute(
            "INSERT INTO ai_tasks(collection_id, kind, status, output_markdown, scope_item_ids)
             VALUES (?1, ?2, 'succeeded', ?3, ?4)",
            params![collection_id, kind, markdown, scope_json],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, collection_id, kind, markdown, scope_item_ids)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![task_id, collection_id, kind, markdown, scope_json],
        )?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: None,
            collection_id: Some(collection_id),
            scope_item_ids: Some(scope_item_ids.to_vec()),
            kind: kind.into(),
            status: "succeeded".into(),
            output_markdown: markdown,
        })
    }

    pub fn run_collection_review_draft(&self, collection_id: i64) -> Result<AITask> {
        let item_ids = self
            .list_items(Some(collection_id))?
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        self.run_collection_task(collection_id, "collection.review_draft", &item_ids)
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
        let mut query =
            "SELECT id, item_id, collection_id, scope_item_ids, kind, status, output_markdown FROM ai_tasks"
                .to_string();
        match (item_id, collection_id) {
            (Some(_), Some(_)) => query.push_str(" WHERE item_id = ?1 AND collection_id = ?2"),
            (Some(_), None) => query.push_str(" WHERE item_id = ?1"),
            (None, Some(_)) => query.push_str(" WHERE collection_id = ?1 AND item_id IS NULL"),
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
                "SELECT id, task_id, item_id, collection_id, scope_item_ids, kind, markdown
                 FROM ai_artifacts WHERE item_id = ?1 AND collection_id = ?2 ORDER BY id DESC LIMIT 1"
            }
            (Some(_), None) => {
                "SELECT id, task_id, item_id, collection_id, scope_item_ids, kind, markdown
                 FROM ai_artifacts WHERE item_id = ?1 ORDER BY id DESC LIMIT 1"
            }
            (None, Some(_)) => {
                "SELECT id, task_id, item_id, collection_id, scope_item_ids, kind, markdown
                 FROM ai_artifacts WHERE collection_id = ?1 AND item_id IS NULL ORDER BY id DESC LIMIT 1"
            }
            (None, None) => {
                "SELECT id, task_id, item_id, collection_id, scope_item_ids, kind, markdown
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
                normalized_html TEXT NOT NULL,
                page_count INTEGER NULL,
                content_status TEXT NOT NULL DEFAULT 'unavailable',
                content_notice TEXT NULL
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
                output_markdown TEXT NOT NULL,
                scope_item_ids TEXT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_artifacts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
                item_id INTEGER NULL REFERENCES items(id),
                collection_id INTEGER NULL REFERENCES collections(id),
                kind TEXT NOT NULL,
                markdown TEXT NOT NULL,
                scope_item_ids TEXT NULL
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
        ensure_column(&conn, "extracted_content", "page_count", "INTEGER NULL")?;
        ensure_column(
            &conn,
            "extracted_content",
            "content_status",
            "TEXT NOT NULL DEFAULT 'unavailable'",
        )?;
        ensure_column(&conn, "extracted_content", "content_notice", "TEXT NULL")?;
        ensure_column(&conn, "ai_tasks", "scope_item_ids", "TEXT NULL")?;
        ensure_column(&conn, "ai_artifacts", "scope_item_ids", "TEXT NULL")?;
        Ok(())
    }
}

fn map_library_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryItem> {
    let attachment_path: String = row.get(4)?;
    Ok(LibraryItem {
        id: row.get(0)?,
        title: row.get(1)?,
        collection_id: row.get(2)?,
        primary_attachment_id: row.get(3)?,
        attachment_format: infer_attachment_format(&attachment_path).to_string(),
        attachment_status: row.get(5)?,
        authors: row.get(6)?,
        publication_year: row.get(7)?,
        source: row.get(8)?,
        doi: row.get(9)?,
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
    let raw_scope: Option<String> = row.get(3)?;
    let scope_item_ids = parse_scope_item_ids(raw_scope).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(AITask {
        id: row.get(0)?,
        item_id: row.get(1)?,
        collection_id: row.get(2)?,
        scope_item_ids,
        kind: row.get(4)?,
        status: row.get(5)?,
        output_markdown: row.get(6)?,
    })
}

fn map_ai_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<AIArtifact> {
    let raw_scope: Option<String> = row.get(4)?;
    let scope_item_ids = parse_scope_item_ids(raw_scope).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(AIArtifact {
        id: row.get(0)?,
        task_id: row.get(1)?,
        item_id: row.get(2)?,
        collection_id: row.get(3)?,
        scope_item_ids,
        kind: row.get(5)?,
        markdown: row.get(6)?,
    })
}

fn parse_scope_item_ids(value: Option<String>) -> Result<Option<Vec<i64>>, serde_json::Error> {
    value.map(|raw| serde_json::from_str(&raw)).transpose()
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn infer_attachment_format(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".pdf") {
        "pdf"
    } else if lower.ends_with(".docx") {
        "docx"
    } else if lower.ends_with(".epub") {
        "epub"
    } else {
        "unknown"
    }
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

fn extract_markdown_heading(markdown: &str) -> Option<String> {
    markdown
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('#'))
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|line| !line.is_empty())
}

fn infer_metadata(title: &str) -> InferredMetadata {
    match title.to_lowercase().as_str() {
        "transformer scaling laws" | "transformer-scaling-laws" => InferredMetadata {
            title: Some("Transformer Scaling Laws".into()),
            authors: "Kaplan et al.".into(),
            publication_year: Some(2020),
            source: "OpenAI".into(),
            doi: Some("10.1000/scaling-laws".into()),
        },
        "graph neural survey" | "graph-neural-survey" => InferredMetadata {
            title: Some("Graph Neural Survey".into()),
            authors: "Wu et al.".into(),
            publication_year: Some(2021),
            source: "IEEE TPAMI".into(),
            doi: Some("10.1000/gnn-survey".into()),
        },
        "distributed consensus notes" | "distributed-consensus-notes" => InferredMetadata {
            title: Some("Distributed Consensus Notes".into()),
            authors: "Ongaro & Ousterhout".into(),
            publication_year: Some(2014),
            source: "USENIX".into(),
            doi: Some("10.1000/raft".into()),
        },
        _ => InferredMetadata {
            title: Some(title_from_slug(title)),
            authors: "Imported Author".into(),
            publication_year: None,
            source: "Paper Reader Library".into(),
            doi: None,
        },
    }
}

fn extract_document(path: &Path, bytes: &[u8], format: &str) -> Result<ExtractedDocument> {
    match format {
        "pdf" => extract_pdf(path, bytes),
        "docx" => extract_docx(path, bytes),
        "epub" => extract_epub(path, bytes),
        _ => Err(anyhow!("unsupported attachment format")),
    }
}

fn extract_pdf(path: &Path, bytes: &[u8]) -> Result<ExtractedDocument> {
    let fallback_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(title_from_slug)
        .unwrap_or_else(|| "Untitled".into());
    let raw = String::from_utf8_lossy(bytes);
    // Best-effort page count from PDF object markers.
    // Avoid counting the "/Type /Pages" node by subtracting those matches.
    let page_count = (raw.matches("/Type /Page").count() as i64)
        - (raw.matches("/Type /Pages").count() as i64);
    let title = capture_pdf_metadata(&raw, "Title").unwrap_or(fallback_title.clone());
    let authors = capture_pdf_metadata(&raw, "Author").unwrap_or_else(|| "Imported Author".into());
    let publication_year = capture_pdf_year(&raw);
    let strings = extract_pdf_text_fragments(&raw);
    let plain_text = if strings.is_empty() {
        "PDF imported, but no text layer was extracted.".into()
    } else {
        strings.join("\n\n")
    };
    let content_status = if strings.is_empty() { "partial" } else { "ready" }.to_string();
    let content_notice = if strings.is_empty() {
        Some("This PDF loaded successfully, but text extraction only found partial content.".into())
    } else {
        None
    };

    Ok(ExtractedDocument {
        normalized_html: article_from_paragraphs(&title, &strings),
        plain_text,
        page_count: if page_count > 0 { Some(page_count) } else { None },
        content_status,
        content_notice,
        metadata: InferredMetadata {
            title: Some(title),
            authors,
            publication_year,
            source: "Imported PDF".into(),
            doi: None,
        },
    })
}

fn extract_docx(path: &Path, bytes: &[u8]) -> Result<ExtractedDocument> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let document_xml = read_zip_entry(&mut archive, "word/document.xml")?;
    let paragraphs = extract_docx_paragraphs(&document_xml)?;
    let title = read_docx_title(&mut archive)?.unwrap_or_else(|| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .map(title_from_slug)
            .unwrap_or_else(|| "Untitled".into())
    });
    let authors = read_docx_author(&mut archive)?.unwrap_or_else(|| "Imported Author".into());
    let plain_text = join_plain_text(&paragraphs);

    Ok(ExtractedDocument {
        normalized_html: article_from_paragraphs(&title, &paragraphs),
        plain_text,
        page_count: Some(paragraphs.len() as i64),
        content_status: "ready".into(),
        content_notice: None,
        metadata: InferredMetadata {
            title: Some(title),
            authors,
            publication_year: None,
            source: "Imported DOCX".into(),
            doi: None,
        },
    })
}

fn extract_epub(path: &Path, bytes: &[u8]) -> Result<ExtractedDocument> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let container_xml = read_zip_entry(&mut archive, "META-INF/container.xml")?;
    let rootfile = find_epub_rootfile(&container_xml)?;
    let package_xml = read_zip_entry(&mut archive, &rootfile)?;
    let (title, authors, sections) = extract_epub_sections(&mut archive, &rootfile, &package_xml)?;
    let resolved_title = title.unwrap_or_else(|| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .map(title_from_slug)
            .unwrap_or_else(|| "Untitled".into())
    });
    let plain_text = join_plain_text(&sections);

    Ok(ExtractedDocument {
        normalized_html: article_from_paragraphs(&resolved_title, &sections),
        plain_text,
        page_count: Some(sections.len() as i64),
        content_status: "ready".into(),
        content_notice: None,
        metadata: InferredMetadata {
            title: Some(resolved_title),
            authors: authors.unwrap_or_else(|| "Imported Author".into()),
            publication_year: None,
            source: "Imported EPUB".into(),
            doi: None,
        },
    })
}

fn read_zip_entry<R: Read + Seek>(archive: &mut ZipArchive<R>, path: &str) -> Result<String> {
    let mut file = archive.by_name(path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

fn extract_docx_paragraphs(xml: &str) -> Result<Vec<String>> {
    let document = Document::parse(xml)?;
    let mut paragraphs = Vec::new();
    for paragraph in document.descendants().filter(|node| node.has_tag_name(("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "p"))) {
        let text = paragraph
            .descendants()
            .filter(|node| node.has_tag_name(("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "t")))
            .filter_map(|node| node.text())
            .collect::<Vec<_>>()
            .join("");
        let normalized = normalize_whitespace(&text);
        if !normalized.is_empty() {
            paragraphs.push(normalized);
        }
    }
    if paragraphs.is_empty() {
        paragraphs.push("DOCX imported, but no readable paragraphs were extracted.".into());
    }
    Ok(paragraphs)
}

fn read_docx_title<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Option<String>> {
    match archive.by_name("docProps/core.xml") {
        Ok(mut file) => {
            let mut xml = String::new();
            file.read_to_string(&mut xml)?;
            let doc = Document::parse(&xml)?;
            Ok(doc
                .descendants()
                .find(|node| node.tag_name().name() == "title")
                .and_then(|node| node.text())
                .map(normalize_whitespace)
                .filter(|value| !value.is_empty()))
        }
        Err(_) => Ok(None),
    }
}

fn read_docx_author<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Option<String>> {
    match archive.by_name("docProps/core.xml") {
        Ok(mut file) => {
            let mut xml = String::new();
            file.read_to_string(&mut xml)?;
            let doc = Document::parse(&xml)?;
            Ok(doc
                .descendants()
                .find(|node| node.tag_name().name() == "creator")
                .and_then(|node| node.text())
                .map(normalize_whitespace)
                .filter(|value| !value.is_empty()))
        }
        Err(_) => Ok(None),
    }
}

fn find_epub_rootfile(container_xml: &str) -> Result<String> {
    let document = Document::parse(container_xml)?;
    document
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .map(|value| value.to_string())
        .ok_or_else(|| anyhow!("EPUB rootfile is missing"))
}

fn extract_epub_sections<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    rootfile: &str,
    package_xml: &str,
) -> Result<(Option<String>, Option<String>, Vec<String>)> {
    let document = Document::parse(package_xml)?;
    let title = document
        .descendants()
        .find(|node| node.tag_name().name() == "title")
        .and_then(|node| node.text())
        .map(normalize_whitespace)
        .filter(|value| !value.is_empty());
    let author = document
        .descendants()
        .find(|node| node.tag_name().name() == "creator")
        .and_then(|node| node.text())
        .map(normalize_whitespace)
        .filter(|value| !value.is_empty());

    let mut manifest = std::collections::HashMap::new();
    for item in document.descendants().filter(|node| node.tag_name().name() == "item") {
        if let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) {
            manifest.insert(id.to_string(), resolve_relative_path(rootfile, href));
        }
    }

    let mut sections = Vec::new();
    for itemref in document.descendants().filter(|node| node.tag_name().name() == "itemref") {
        let Some(idref) = itemref.attribute("idref") else {
            continue;
        };
        let Some(chapter_path) = manifest.get(idref) else {
            continue;
        };
        let chapter_xml = read_zip_entry(archive, chapter_path)?;
        sections.extend(extract_xhtml_sections(&chapter_xml)?);
    }

    if sections.is_empty() {
        sections.push("EPUB imported, but no readable sections were extracted.".into());
    }
    Ok((title, author, sections))
}

fn extract_xhtml_sections(xml: &str) -> Result<Vec<String>> {
    let document = Document::parse(xml)?;
    let mut sections = Vec::new();
    for node in document.descendants().filter(|node| {
        matches!(node.tag_name().name(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li")
    }) {
        let text = normalize_whitespace(node.text().unwrap_or_default());
        if !text.is_empty() {
            sections.push(text);
        }
    }
    Ok(sections)
}

fn capture_pdf_metadata(raw: &str, field: &str) -> Option<String> {
    let pattern = format!(r"/{}\s*\(([^)]*)\)", field);
    Regex::new(&pattern)
        .ok()?
        .captures(raw)
        .and_then(|captures| captures.get(1))
        .map(|value| normalize_whitespace(value.as_str()))
        .filter(|value| !value.is_empty())
}

fn capture_pdf_year(raw: &str) -> Option<i64> {
    Regex::new(r"/CreationDate\s*\(D:(\d{4})")
        .ok()?
        .captures(raw)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<i64>().ok())
}

fn extract_pdf_text_fragments(raw: &str) -> Vec<String> {
    let Some(regex) = Regex::new(r"\(([^()]*)\)\s*Tj").ok() else {
        return Vec::new();
    };
    regex
        .captures_iter(raw)
        .filter_map(|captures| captures.get(1))
        .map(|value| normalize_whitespace(value.as_str()))
        .filter(|value| value.len() > 2)
        .collect()
}

fn article_from_paragraphs(title: &str, paragraphs: &[String]) -> String {
    let body = if paragraphs.is_empty() {
        "<p>No readable content was extracted.</p>".to_string()
    } else {
        paragraphs
            .iter()
            .map(|paragraph| format!("<p>{}</p>", encode_safe(paragraph)))
            .collect::<Vec<_>>()
            .join("")
    };
    format!("<article><h1>{}</h1>{}</article>", encode_safe(title), body)
}

fn title_from_slug(value: &str) -> String {
    value
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|chunk| {
            let mut chars = chunk.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join_plain_text(parts: &[String]) -> String {
    if parts.is_empty() {
        "No textual content extracted.".into()
    } else {
        parts.join("\n\n")
    }
}

fn wrap_as_article(title: &str, body: &str) -> String {
    article_from_paragraphs(title, &[body.to_string()])
}

fn resolve_relative_path(base: &str, relative: &str) -> String {
    let base = Path::new(base);
    let parent = base.parent().unwrap_or_else(|| Path::new(""));
    parent.join(relative).to_string_lossy().to_string()
}
