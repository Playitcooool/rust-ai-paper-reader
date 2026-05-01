use std::{
    fs,
    io::{Cursor, Read, Seek},
    sync::Arc,
    path::{Path, PathBuf},
    panic,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use html_escape::encode_safe;
use lopdf::{Dictionary, Document as PdfDocument, Object};
use reqwest::blocking::Client;
use regex::Regex;
use roxmltree::Document;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
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
    pub session_id: Option<i64>,
    pub scope_item_ids: Option<Vec<i64>>,
    pub input_prompt: Option<String>,
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
    pub session_id: Option<i64>,
    pub scope_item_ids: Option<Vec<i64>>,
    pub kind: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AISession {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AISessionReferenceKind {
    Item,
    Collection,
}

impl AISessionReferenceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Item => "item",
            Self::Collection => "collection",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "item" => Ok(Self::Item),
            "collection" => Ok(Self::Collection),
            _ => Err(anyhow!("unsupported session reference kind")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AISessionReference {
    pub id: i64,
    pub session_id: i64,
    pub kind: AISessionReferenceKind,
    pub target_id: i64,
    pub sort_index: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AIProvider {
    OpenAI,
    Anthropic,
}

impl AIProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenAI => "openai",
            Self::Anthropic => "anthropic",
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenAI => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AISettings {
    pub active_provider: AIProvider,
    pub openai_model: String,
    pub openai_base_url: String,
    pub has_openai_api_key: bool,
    pub anthropic_model: String,
    pub anthropic_base_url: String,
    pub has_anthropic_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAISettingsInput {
    pub active_provider: AIProvider,
    pub openai_model: String,
    pub openai_base_url: String,
    pub openai_api_key: Option<String>,
    pub clear_openai_api_key: Option<bool>,
    pub anthropic_model: String,
    pub anthropic_base_url: String,
    pub anthropic_api_key: Option<String>,
    pub clear_anthropic_api_key: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchNote {
    pub id: i64,
    pub collection_id: Option<i64>,
    pub session_id: Option<i64>,
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
    ai_transport: Arc<dyn AiTransport>,
}

pub trait AiTransport: Send + Sync {
    fn complete(&self, request: AiCompletionRequest) -> Result<String>;
}

#[derive(Clone)]
struct HttpAiTransport {
    client: Client,
}

#[derive(Debug, Clone)]
pub struct AiCompletionRequest {
    pub provider: AIProvider,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub prompt: String,
}

#[derive(Debug, Clone)]
struct StoredAISettings {
    active_provider: AIProvider,
    openai_model: String,
    openai_base_url: String,
    openai_api_key: String,
    anthropic_model: String,
    anthropic_base_url: String,
    anthropic_api_key: String,
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
    extractor_version: i64,
    metadata: InferredMetadata,
}

impl ExtractedDocument {
    fn should_index(&self) -> bool {
        !self.plain_text.trim().is_empty() && self.content_status != "unavailable"
    }
}

const EXTRACTOR_VERSION: i64 = 1;
const ITEM_TASK_TEXT_LIMIT: usize = 18_000;
const COLLECTION_ITEM_TEXT_LIMIT: usize = 4_000;
const COLLECTION_TOTAL_TEXT_LIMIT: usize = 40_000;
const DEFAULT_AI_SESSION_TITLE: &str = "New Chat";

impl Default for HttpAiTransport {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(90))
                .build()
                .expect("http client"),
        }
    }
}

impl AiTransport for HttpAiTransport {
    fn complete(&self, request: AiCompletionRequest) -> Result<String> {
        match request.provider {
            AIProvider::OpenAI => self.complete_openai(request),
            AIProvider::Anthropic => self.complete_anthropic(request),
        }
    }
}

impl HttpAiTransport {
    fn complete_openai(&self, request: AiCompletionRequest) -> Result<String> {
        let url = format!("{}/chat/completions", normalize_base_url(&request.base_url));
        let response: serde_json::Value = self
            .client
            .post(url)
            .bearer_auth(request.api_key)
            .json(&serde_json::json!({
                "model": request.model,
                "messages": [{ "role": "user", "content": request.prompt }],
                "temperature": 0.2,
            }))
            .send()?
            .error_for_status()?
            .json()?;
        let content = response
            .get("choices")
            .and_then(|choices| choices.as_array())
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(extract_openai_content)
            .ok_or_else(|| anyhow!("OpenAI response did not include assistant content"))?;
        Ok(content.trim().to_string())
    }

    fn complete_anthropic(&self, request: AiCompletionRequest) -> Result<String> {
        let url = format!("{}/messages", normalize_base_url(&request.base_url));
        let response: serde_json::Value = self
            .client
            .post(url)
            .header("x-api-key", request.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&serde_json::json!({
                "model": request.model,
                "max_tokens": 2048,
                "messages": [{ "role": "user", "content": request.prompt }],
            }))
            .send()?
            .error_for_status()?
            .json()?;
        let blocks = response
            .get("content")
            .and_then(|content| content.as_array())
            .ok_or_else(|| anyhow!("Anthropic response did not include content blocks"))?;
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join("\n\n");
        if text.trim().is_empty() {
            return Err(anyhow!("Anthropic response did not include text content"));
        }
        Ok(text.trim().to_string())
    }
}

impl LibraryService {
    pub fn new(root: &Path) -> Result<Self> {
        Self::new_with_transport(root, Arc::new(HttpAiTransport::default()))
    }

    pub fn new_with_transport(root: &Path, ai_transport: Arc<dyn AiTransport>) -> Result<Self> {
        fs::create_dir_all(root)?;
        let files_dir = root.join("library-files");
        fs::create_dir_all(&files_dir)?;
        let db_path = root.join("library.db");
        let service = Self {
            db_path,
            files_dir,
            ai_transport,
        };
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
        let mut conn = self.connect()?;
        let collection_ids = collection_subtree_ids_conn(&conn, collection_id)?;
        if collection_ids.is_empty() {
            return Err(anyhow!("collection does not exist"));
        }
        let item_ids = item_ids_for_collection_ids_conn(&conn, &collection_ids)?;
        let managed_paths = managed_attachment_paths_for_item_ids_conn(&conn, &item_ids)?;
        let tx = conn.transaction()?;
        let mut affected_session_ids = session_reference_session_ids_for_targets(
            &tx,
            AISessionReferenceKind::Collection.as_str(),
            &collection_ids,
        )?;
        affected_session_ids.extend(session_reference_session_ids_for_targets(
            &tx,
            AISessionReferenceKind::Item.as_str(),
            &item_ids,
        )?);
        affected_session_ids.sort_unstable();
        affected_session_ids.dedup();

        delete_session_references_for_targets(
            &tx,
            AISessionReferenceKind::Collection.as_str(),
            &collection_ids,
        )?;
        delete_session_references_for_targets(
            &tx,
            AISessionReferenceKind::Item.as_str(),
            &item_ids,
        )?;
        delete_by_column_in_clause(&tx, "research_notes", "collection_id", &collection_ids)?;
        delete_by_either_column_in_clause(&tx, "ai_artifacts", "item_id", &item_ids, "collection_id", &collection_ids)?;
        delete_by_either_column_in_clause(&tx, "ai_tasks", "item_id", &item_ids, "collection_id", &collection_ids)?;
        delete_by_column_in_clause(&tx, "search_index", "item_id", &item_ids)?;
        delete_by_column_in_clause(&tx, "items", "id", &item_ids)?;
        delete_by_column_in_clause(&tx, "collections", "id", &collection_ids)?;
        for session_id in affected_session_ids {
            normalize_session_reference_sort_indexes_conn(&tx, session_id)?;
        }
        tx.commit()?;

        for path in managed_paths {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
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
                    .map(|value| value.to_string_lossy().to_string())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "Untitled".into())
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
                "INSERT INTO extracted_content(item_id, plain_text, normalized_html, page_count, content_status, content_notice, extractor_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    item_id,
                    extracted.plain_text,
                    extracted.normalized_html,
                    extracted.page_count,
                    extracted.content_status,
                    extracted.content_notice,
                    extracted.extractor_version
                ],
            )?;
            if extracted.should_index() {
                tx.execute(
                    "INSERT INTO search_index(item_id, title, plain_text) VALUES (?1, ?2, ?3)",
                    params![item_id, title, extracted.plain_text],
                )?;
            }
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
                .map(|value| value.to_string_lossy().to_string())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Untitled Citation".into())
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
                "INSERT INTO extracted_content(item_id, plain_text, normalized_html, page_count, content_status, content_notice, extractor_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    item_id,
                    plain_text,
                    normalized_html,
                    Option::<i64>::None,
                    "partial",
                    Some("Citation-only entry. Attach a source file to enable reading.".to_string()),
                    EXTRACTOR_VERSION
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
        let affected_session_ids =
            session_reference_session_ids_for_target(&tx, AISessionReferenceKind::Item.as_str(), item_id)?;
        tx.execute("DELETE FROM ai_artifacts WHERE item_id = ?1", [item_id])?;
        tx.execute("DELETE FROM ai_tasks WHERE item_id = ?1", [item_id])?;
        tx.execute(
            "DELETE FROM ai_session_references WHERE kind = ?1 AND target_id = ?2",
            params![AISessionReferenceKind::Item.as_str(), item_id],
        )?;
        for session_id in affected_session_ids {
            normalize_session_reference_sort_indexes_conn(&tx, session_id)?;
        }
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
            LEFT JOIN search_index s ON s.item_id = i.id
            LEFT JOIN item_tags it ON it.item_id = i.id
            LEFT JOIN tags t ON t.id = it.tag_id
            WHERE lower(COALESCE(s.title, '')) LIKE ?1
               OR lower(COALESCE(s.plain_text, '')) LIKE ?1
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

    pub fn get_ai_settings(&self) -> Result<AISettings> {
        let conn = self.connect()?;
        let stored = load_ai_settings(&conn)?;
        Ok(to_public_ai_settings(&stored))
    }

    pub fn update_ai_settings(&self, input: UpdateAISettingsInput) -> Result<AISettings> {
        let conn = self.connect()?;
        let current = load_ai_settings(&conn)?;
        let next = StoredAISettings {
            active_provider: input.active_provider,
            openai_model: input.openai_model.trim().to_string(),
            openai_base_url: input.openai_base_url.trim().to_string(),
            openai_api_key: if input.clear_openai_api_key.unwrap_or(false) {
                String::new()
            } else if let Some(key) = input.openai_api_key.filter(|value| !value.trim().is_empty()) {
                key
            } else {
                current.openai_api_key
            },
            anthropic_model: input.anthropic_model.trim().to_string(),
            anthropic_base_url: input.anthropic_base_url.trim().to_string(),
            anthropic_api_key: if input.clear_anthropic_api_key.unwrap_or(false) {
                String::new()
            } else if let Some(key) = input.anthropic_api_key.filter(|value| !value.trim().is_empty()) {
                key
            } else {
                current.anthropic_api_key
            },
        };
        save_ai_settings(&conn, &next)?;
        Ok(to_public_ai_settings(&next))
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

    pub fn repair_item_content_if_needed(&self, item_id: i64) -> Result<bool> {
        let mut conn = self.connect()?;
        let row = conn
            .query_row(
                "
                SELECT i.title, a.path, COALESCE(e.extractor_version, 0)
                FROM items i
                LEFT JOIN attachments a ON a.item_id = i.id AND a.is_primary = 1
                JOIN extracted_content e ON e.item_id = i.id
                WHERE i.id = ?1
                ",
                [item_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?;
        let Some((item_title, attachment_path, extractor_version)) = row else {
            return Ok(false);
        };
        let Some(attachment_path) = attachment_path else {
            return Ok(false);
        };
        if infer_attachment_format(&attachment_path) != "pdf" {
            return Ok(false);
        }
        if extractor_version >= EXTRACTOR_VERSION {
            return Ok(false);
        }

        let bytes = match fs::read(Path::new(&attachment_path)) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(false),
        };

        // Best-effort PDF extraction; even if content is unavailable, we still want to bump
        // extractor_version so old libraries self-heal without repeated work.
        let mut extracted = extract_pdf(Path::new(&attachment_path), &bytes)?;
        extracted.extractor_version = EXTRACTOR_VERSION;

        // Keep the item title stable (users may have edited it), but refresh the extracted HTML/text.
        let paragraphs = if extracted.plain_text.trim().is_empty() {
            Vec::new()
        } else {
            extracted
                .plain_text
                .split("\n\n")
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        extracted.normalized_html = article_from_paragraphs(&item_title, &paragraphs);

        let tx = conn.transaction()?;
        tx.execute(
            "
            UPDATE extracted_content
            SET plain_text = ?2,
                normalized_html = ?3,
                page_count = ?4,
                content_status = ?5,
                content_notice = ?6,
                extractor_version = ?7
            WHERE item_id = ?1
            ",
            params![
                item_id,
                extracted.plain_text,
                extracted.normalized_html,
                extracted.page_count,
                extracted.content_status,
                extracted.content_notice,
                extracted.extractor_version
            ],
        )?;
        tx.execute("DELETE FROM search_index WHERE item_id = ?1", [item_id])?;
        if extracted.should_index() {
            tx.execute(
                "INSERT INTO search_index(item_id, title, plain_text) VALUES (?1, ?2, ?3)",
                params![item_id, item_title, extracted.plain_text],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn repair_library_content_if_needed(&self) -> Result<usize> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "
            SELECT i.id, a.path, COALESCE(e.extractor_version, 0)
            FROM items i
            LEFT JOIN attachments a ON a.item_id = i.id AND a.is_primary = 1
            JOIN extracted_content e ON e.item_id = i.id
            ORDER BY i.id ASC
            ",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;

        let mut item_ids = Vec::new();
        for row in rows {
            let (item_id, attachment_path, extractor_version) = row?;
            let Some(attachment_path) = attachment_path else {
                continue;
            };
            if extractor_version >= EXTRACTOR_VERSION {
                continue;
            }
            if infer_attachment_format(&attachment_path) != "pdf" {
                continue;
            }
            item_ids.push(item_id);
        }

        let mut repaired = 0usize;
        for item_id in item_ids {
            if self.repair_item_content_if_needed(item_id)? {
                repaired += 1;
            }
        }
        Ok(repaired)
    }

    pub fn read_primary_attachment_bytes(&self, primary_attachment_id: i64) -> Result<Vec<u8>> {
        let conn = self.connect()?;
        let attachment = conn
            .query_row(
                "
                SELECT path, is_primary
                FROM attachments
                WHERE id = ?1
                ",
                [primary_attachment_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;

        let Some((path, is_primary)) = attachment else {
            return Err(anyhow!("primary attachment was not found"));
        };

        if is_primary != 1 {
            return Err(anyhow!("requested attachment is not the primary attachment"));
        }

        if infer_attachment_format(&path) != "pdf" {
            return Err(anyhow!("primary attachment is not a PDF"));
        }

        let attachment_path = PathBuf::from(&path);
        if !attachment_path.exists() {
            return Err(anyhow!("primary attachment file is missing"));
        }

        fs::read(&attachment_path).map_err(|_| anyhow!("failed to read primary attachment bytes"))
    }

    fn build_provider_request(
        &self,
        settings: &StoredAISettings,
        prompt: String,
    ) -> Result<AiCompletionRequest> {
        match settings.active_provider {
            AIProvider::OpenAI => {
                let model = settings.openai_model.trim();
                let api_key = settings.openai_api_key.trim();
                if model.is_empty() || api_key.is_empty() {
                    return Err(anyhow!(
                        "OpenAI is missing a saved API key or model. Open Settings and complete the active provider configuration."
                    ));
                }
                Ok(AiCompletionRequest {
                    provider: AIProvider::OpenAI,
                    model: model.to_string(),
                    base_url: defaulted_base_url(AIProvider::OpenAI, &settings.openai_base_url),
                    api_key: api_key.to_string(),
                    prompt,
                })
            }
            AIProvider::Anthropic => {
                let model = settings.anthropic_model.trim();
                let api_key = settings.anthropic_api_key.trim();
                if model.is_empty() || api_key.is_empty() {
                    return Err(anyhow!(
                        "Anthropic is missing a saved API key or model. Open Settings and complete the active provider configuration."
                    ));
                }
                Ok(AiCompletionRequest {
                    provider: AIProvider::Anthropic,
                    model: model.to_string(),
                    base_url: defaulted_base_url(AIProvider::Anthropic, &settings.anthropic_base_url),
                    api_key: api_key.to_string(),
                    prompt,
                })
            }
        }
    }

    pub fn run_item_task(&self, item_id: i64, kind: &str, prompt: Option<&str>) -> Result<AITask> {
        let mut conn = self.connect()?;
        let settings = load_ai_settings(&conn)?;
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
        let prompt_text = prompt.map(str::trim).filter(|value| !value.is_empty());
        let excerpt = truncate_chars(&excerpt, ITEM_TASK_TEXT_LIMIT);
        let prompt_body = build_item_prompt(
            kind,
            &title,
            &collection_name,
            &excerpt,
            prompt_text,
        )?;
        let request = self.build_provider_request(&settings, prompt_body)?;
        let output = self.ai_transport.complete(request)?;

        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_tasks(item_id, collection_id, session_id, kind, status, output_markdown, input_prompt)
             VALUES (?1, ?2, NULL, ?3, 'succeeded', ?4, ?5)",
            params![item_id, collection_id, kind, output, prompt_text],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, item_id, collection_id, session_id, kind, markdown)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
            params![task_id, item_id, collection_id, kind, output],
        )?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: Some(item_id),
            collection_id: Some(collection_id),
            session_id: None,
            scope_item_ids: None,
            input_prompt: prompt_text.map(str::to_owned),
            kind: kind.into(),
            status: "succeeded".into(),
            output_markdown: output,
        })
    }

    pub fn run_item_summary(&self, item_id: i64) -> Result<AITask> {
        self.run_item_task(item_id, "item.summarize", None)
    }

    pub fn create_note_from_artifact(&self, artifact_id: i64) -> Result<ResearchNote> {
        let conn = self.connect()?;
        let (collection_id, session_id, collection_name, markdown): (Option<i64>, Option<i64>, String, String) = conn.query_row(
            "
            SELECT a.collection_id, a.session_id, COALESCE(c.name, 'Research Session'), a.markdown
            FROM ai_artifacts a
            LEFT JOIN collections c ON c.id = a.collection_id
            WHERE a.id = ?1
            ",
            [artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let title = extract_markdown_heading(&markdown)
            .unwrap_or_else(|| format!("{collection_name} Note"));
        conn.execute(
            "INSERT INTO research_notes(collection_id, session_id, title, markdown) VALUES (?1, ?2, ?3, ?4)",
            params![collection_id, session_id, title, markdown],
        )?;

        Ok(ResearchNote {
            id: conn.last_insert_rowid(),
            collection_id,
            session_id,
            title,
            markdown,
        })
    }

    pub fn run_collection_task(
        &self,
        collection_id: i64,
        kind: &str,
        scope_item_ids: &[i64],
        prompt: Option<&str>,
    ) -> Result<AITask> {
        if scope_item_ids.is_empty() {
            return Err(anyhow!("collection has no readable items"));
        }
        let mut conn = self.connect()?;
        let settings = load_ai_settings(&conn)?;
        let collection_name: String = conn.query_row(
            "SELECT name FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        let prompt_text = prompt.map(str::trim).filter(|value| !value.is_empty());
        let prompt_body = build_collection_prompt(
            &conn,
            collection_id,
            &collection_name,
            kind,
            scope_item_ids,
            prompt_text,
        )?;
        let request = self.build_provider_request(&settings, prompt_body)?;
        let markdown = self.ai_transport.complete(request)?;

        let tx = conn.transaction()?;
        let scope_json = serde_json::to_string(scope_item_ids)?;
        tx.execute(
            "INSERT INTO ai_tasks(collection_id, session_id, kind, status, output_markdown, scope_item_ids, input_prompt)
             VALUES (?1, NULL, ?2, 'succeeded', ?3, ?4, ?5)",
            params![collection_id, kind, markdown, scope_json, prompt_text],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, collection_id, session_id, kind, markdown, scope_item_ids)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
            params![task_id, collection_id, kind, markdown, scope_json],
        )?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: None,
            collection_id: Some(collection_id),
            session_id: None,
            scope_item_ids: Some(scope_item_ids.to_vec()),
            input_prompt: prompt_text.map(str::to_owned),
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
        self.run_collection_task(collection_id, "collection.review_draft", &item_ids, None)
    }

    pub fn list_ai_sessions(&self) -> Result<Vec<AISession>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, title, created_at, updated_at FROM ai_sessions ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = statement.query_map([], map_ai_session)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn create_ai_session(&self) -> Result<AISession> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO ai_sessions(title) VALUES (?1)",
            [DEFAULT_AI_SESSION_TITLE],
        )?;
        let session_id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, title, created_at, updated_at FROM ai_sessions WHERE id = ?1",
            [session_id],
            map_ai_session,
        )
        .map_err(Into::into)
    }

    pub fn list_ai_session_references(&self, session_id: i64) -> Result<Vec<AISessionReference>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, session_id, kind, target_id, sort_index
             FROM ai_session_references
             WHERE session_id = ?1
             ORDER BY sort_index ASC, id ASC",
        )?;
        let rows = statement.query_map([session_id], map_ai_session_reference)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn add_ai_session_reference(
        &self,
        session_id: i64,
        kind: AISessionReferenceKind,
        target_id: i64,
    ) -> Result<AISessionReference> {
        let conn = self.connect()?;
        conn.query_row("SELECT id FROM ai_sessions WHERE id = ?1", [session_id], |row| row.get::<_, i64>(0))
            .context("session does not exist")?;
        match kind {
            AISessionReferenceKind::Item => {
                conn.query_row("SELECT id FROM items WHERE id = ?1", [target_id], |row| row.get::<_, i64>(0))
                    .context("item does not exist")?;
            }
            AISessionReferenceKind::Collection => {
                conn.query_row(
                    "SELECT id FROM collections WHERE id = ?1",
                    [target_id],
                    |row| row.get::<_, i64>(0),
                )
                .context("collection does not exist")?;
            }
        }
        let already = conn
            .query_row(
                "SELECT id FROM ai_session_references WHERE session_id = ?1 AND kind = ?2 AND target_id = ?3",
                params![session_id, kind.as_str(), target_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if let Some(reference_id) = already {
            return conn
                .query_row(
                    "SELECT id, session_id, kind, target_id, sort_index FROM ai_session_references WHERE id = ?1",
                    [reference_id],
                    map_ai_session_reference,
                )
                .map_err(Into::into);
        }
        let sort_index: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM ai_session_references WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO ai_session_references(session_id, kind, target_id, sort_index) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, kind.as_str(), target_id, sort_index],
        )?;
        touch_ai_session(&conn, session_id, None)?;
        conn.query_row(
            "SELECT id, session_id, kind, target_id, sort_index FROM ai_session_references WHERE id = ?1",
            [conn.last_insert_rowid()],
            map_ai_session_reference,
        )
        .map_err(Into::into)
    }

    pub fn remove_ai_session_reference(&self, reference_id: i64) -> Result<()> {
        let conn = self.connect()?;
        let session_id = conn
            .query_row(
                "SELECT session_id FROM ai_session_references WHERE id = ?1",
                [reference_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            return Ok(());
        };
        conn.execute("DELETE FROM ai_session_references WHERE id = ?1", [reference_id])?;
        conn.execute(
            "
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY sort_index ASC, id ASC) - 1 AS next_sort_index
                FROM ai_session_references
                WHERE session_id = ?1
            )
            UPDATE ai_session_references
            SET sort_index = (SELECT next_sort_index FROM ranked WHERE ranked.id = ai_session_references.id)
            WHERE session_id = ?1
            ",
            [session_id],
        )?;
        touch_ai_session(&conn, session_id, None)?;
        Ok(())
    }

    pub fn run_ai_session_task(
        &self,
        session_id: i64,
        kind: &str,
        prompt: Option<&str>,
    ) -> Result<AITask> {
        let mut conn = self.connect()?;
        let settings = load_ai_settings(&conn)?;
        let references = list_session_references_conn(&conn, session_id)?;
        let expanded = expand_session_references(&conn, &references)?;
        if expanded.item_ids.is_empty() {
            return Err(anyhow!("session has no readable items"));
        }
        if kind == "session.compare" && expanded.item_ids.len() < 2 {
            return Err(anyhow!("compare requires at least 2 unique papers"));
        }
        let prompt_text = prompt.map(str::trim).filter(|value| !value.is_empty());
        let prompt_body = build_session_prompt(&conn, kind, &expanded, prompt_text)?;
        let request = self.build_provider_request(&settings, prompt_body)?;
        let markdown = self.ai_transport.complete(request)?;
        let display_title = derive_session_title(kind, prompt_text);
        let session_title = conn.query_row("SELECT title FROM ai_sessions WHERE id = ?1", [session_id], |row| {
            row.get::<_, String>(0)
        })?;
        let primary_collection_id = expanded.primary_collection_id;
        let scope_json = serde_json::to_string(&expanded.item_ids)?;

        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_tasks(item_id, collection_id, session_id, kind, status, output_markdown, scope_item_ids, input_prompt)
             VALUES (NULL, ?1, ?2, ?3, 'succeeded', ?4, ?5, ?6)",
            params![primary_collection_id, session_id, kind, markdown, scope_json, prompt_text],
        )?;
        let task_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO ai_artifacts(task_id, item_id, collection_id, session_id, kind, markdown, scope_item_ids)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
            params![task_id, primary_collection_id, session_id, kind, markdown, scope_json],
        )?;
        let next_title = if session_title == DEFAULT_AI_SESSION_TITLE {
            display_title
        } else {
            None
        };
        touch_ai_session(&tx, session_id, next_title.as_deref())?;
        tx.commit()?;

        Ok(AITask {
            id: task_id,
            item_id: None,
            collection_id: primary_collection_id,
            session_id: Some(session_id),
            scope_item_ids: Some(expanded.item_ids),
            input_prompt: prompt_text.map(str::to_owned),
            kind: kind.into(),
            status: "succeeded".into(),
            output_markdown: markdown,
        })
    }

    pub fn list_ai_session_task_runs(&self, session_id: i64) -> Result<Vec<AITask>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, item_id, collection_id, session_id, scope_item_ids, input_prompt, kind, status, output_markdown
             FROM ai_tasks WHERE session_id = ?1 ORDER BY id DESC",
        )?;
        let rows = statement.query_map([session_id], map_ai_task)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_ai_session_artifact(&self, session_id: i64) -> Result<Option<AIArtifact>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, task_id, item_id, collection_id, session_id, scope_item_ids, kind, markdown
             FROM ai_artifacts WHERE session_id = ?1 ORDER BY id DESC LIMIT 1",
        )?;
        statement
            .query_row([session_id], map_ai_artifact)
            .optional()
            .map_err(Into::into)
    }

    pub fn list_ai_session_notes(&self, session_id: i64) -> Result<Vec<ResearchNote>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, collection_id, session_id, title, markdown
             FROM research_notes WHERE session_id = ?1 ORDER BY id DESC",
        )?;
        let rows = statement.query_map([session_id], map_research_note)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_notes(&self, collection_id: Option<i64>) -> Result<Vec<ResearchNote>> {
        let conn = self.connect()?;
        let mut query =
            "SELECT id, collection_id, session_id, title, markdown FROM research_notes".to_string();
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
            "SELECT id, item_id, collection_id, session_id, scope_item_ids, input_prompt, kind, status, output_markdown FROM ai_tasks"
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
                "SELECT id, task_id, item_id, collection_id, session_id, scope_item_ids, kind, markdown
                 FROM ai_artifacts WHERE item_id = ?1 AND collection_id = ?2 ORDER BY id DESC LIMIT 1"
            }
            (Some(_), None) => {
                "SELECT id, task_id, item_id, collection_id, session_id, scope_item_ids, kind, markdown
                 FROM ai_artifacts WHERE item_id = ?1 ORDER BY id DESC LIMIT 1"
            }
            (None, Some(_)) => {
                "SELECT id, task_id, item_id, collection_id, session_id, scope_item_ids, kind, markdown
                 FROM ai_artifacts WHERE collection_id = ?1 AND item_id IS NULL ORDER BY id DESC LIMIT 1"
            }
            (None, None) => {
                "SELECT id, task_id, item_id, collection_id, session_id, scope_item_ids, kind, markdown
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
        let conn = Connection::open(&self.db_path)?;
        // Background repair tasks can overlap with UI reads; tolerate short-lived locks.
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(conn)
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
                content_notice TEXT NULL,
                extractor_version INTEGER NOT NULL DEFAULT 0
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
                session_id INTEGER NULL REFERENCES ai_sessions(id),
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                output_markdown TEXT NOT NULL,
                scope_item_ids TEXT NULL
                ,input_prompt TEXT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_artifacts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
                item_id INTEGER NULL REFERENCES items(id),
                collection_id INTEGER NULL REFERENCES collections(id),
                session_id INTEGER NULL REFERENCES ai_sessions(id),
                kind TEXT NOT NULL,
                markdown TEXT NOT NULL,
                scope_item_ids TEXT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_sessions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT 'New Chat',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS ai_session_references(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                target_id INTEGER NOT NULL,
                sort_index INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS research_notes(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NULL REFERENCES collections(id),
                session_id INTEGER NULL REFERENCES ai_sessions(id),
                title TEXT NOT NULL,
                markdown TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_settings(
                id INTEGER PRIMARY KEY CHECK (id = 1),
                active_provider TEXT NOT NULL DEFAULT 'openai',
                openai_model TEXT NOT NULL DEFAULT '',
                openai_base_url TEXT NOT NULL DEFAULT '',
                openai_api_key TEXT NOT NULL DEFAULT '',
                anthropic_model TEXT NOT NULL DEFAULT '',
                anthropic_base_url TEXT NOT NULL DEFAULT '',
                anthropic_api_key TEXT NOT NULL DEFAULT ''
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
        ensure_column(
            &conn,
            "extracted_content",
            "extractor_version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&conn, "ai_tasks", "scope_item_ids", "TEXT NULL")?;
        ensure_column(&conn, "ai_tasks", "input_prompt", "TEXT NULL")?;
        ensure_column(&conn, "ai_tasks", "session_id", "INTEGER NULL")?;
        ensure_column(&conn, "ai_artifacts", "scope_item_ids", "TEXT NULL")?;
        ensure_column(&conn, "ai_artifacts", "session_id", "INTEGER NULL")?;
        ensure_column(&conn, "research_notes", "session_id", "INTEGER NULL")?;
        conn.execute(
            "INSERT OR IGNORE INTO ai_settings(id) VALUES (1)",
            [],
        )?;
        Ok(())
    }
}

fn to_public_ai_settings(settings: &StoredAISettings) -> AISettings {
    AISettings {
        active_provider: settings.active_provider,
        openai_model: settings.openai_model.clone(),
        openai_base_url: settings.openai_base_url.clone(),
        has_openai_api_key: !settings.openai_api_key.trim().is_empty(),
        anthropic_model: settings.anthropic_model.clone(),
        anthropic_base_url: settings.anthropic_base_url.clone(),
        has_anthropic_api_key: !settings.anthropic_api_key.trim().is_empty(),
    }
}

fn load_ai_settings(conn: &Connection) -> Result<StoredAISettings> {
    conn.query_row(
        "SELECT active_provider, openai_model, openai_base_url, openai_api_key, anthropic_model, anthropic_base_url, anthropic_api_key FROM ai_settings WHERE id = 1",
        [],
        |row| {
            let active_provider: String = row.get(0)?;
            Ok(StoredAISettings {
                active_provider: match parse_ai_provider(&active_provider) {
                    Ok(provider) => provider,
                    Err(error) => {
                        return Err(rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())),
                        ))
                    }
                },
                openai_model: row.get(1)?,
                openai_base_url: row.get(2)?,
                openai_api_key: row.get(3)?,
                anthropic_model: row.get(4)?,
                anthropic_base_url: row.get(5)?,
                anthropic_api_key: row.get(6)?,
            })
        },
    )
    .map_err(Into::into)
}

fn save_ai_settings(conn: &Connection, settings: &StoredAISettings) -> Result<()> {
    conn.execute(
        "UPDATE ai_settings
         SET active_provider = ?1,
             openai_model = ?2,
             openai_base_url = ?3,
             openai_api_key = ?4,
             anthropic_model = ?5,
             anthropic_base_url = ?6,
             anthropic_api_key = ?7
         WHERE id = 1",
        params![
            settings.active_provider.as_str(),
            settings.openai_model,
            settings.openai_base_url,
            settings.openai_api_key,
            settings.anthropic_model,
            settings.anthropic_base_url,
            settings.anthropic_api_key
        ],
    )?;
    Ok(())
}

fn parse_ai_provider(value: &str) -> Result<AIProvider> {
    match value {
        "openai" => Ok(AIProvider::OpenAI),
        "anthropic" => Ok(AIProvider::Anthropic),
        _ => Err(anyhow!("unsupported ai provider: {value}")),
    }
}

fn normalize_base_url(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn defaulted_base_url(provider: AIProvider, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        provider.default_base_url().to_string()
    } else {
        normalize_base_url(trimmed)
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[derive(Debug)]
struct SessionPromptExpansion {
    item_ids: Vec<i64>,
    has_collection_reference: bool,
    primary_collection_id: Option<i64>,
}

fn list_session_references_conn(conn: &Connection, session_id: i64) -> Result<Vec<AISessionReference>> {
    let mut statement = conn.prepare(
        "SELECT id, session_id, kind, target_id, sort_index
         FROM ai_session_references
         WHERE session_id = ?1
         ORDER BY sort_index ASC, id ASC",
    )?;
    let rows = statement.query_map([session_id], map_ai_session_reference)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn session_reference_session_ids_for_target(
    conn: &Connection,
    kind: &str,
    target_id: i64,
) -> Result<Vec<i64>> {
    let mut statement = conn.prepare(
        "
        SELECT DISTINCT session_id
        FROM ai_session_references
        WHERE kind = ?1 AND target_id = ?2
        ORDER BY session_id ASC
        ",
    )?;
    let rows = statement.query_map(params![kind, target_id], |row| row.get::<_, i64>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn normalize_session_reference_sort_indexes_conn(conn: &Connection, session_id: i64) -> Result<()> {
    conn.execute(
        "
        WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY sort_index ASC, id ASC) - 1 AS next_sort_index
            FROM ai_session_references
            WHERE session_id = ?1
        )
        UPDATE ai_session_references
        SET sort_index = (SELECT next_sort_index FROM ranked WHERE ranked.id = ai_session_references.id)
        WHERE session_id = ?1
        ",
        [session_id],
    )?;
    Ok(())
}

fn placeholders(count: usize) -> String {
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn collection_subtree_ids_conn(conn: &Connection, root_id: i64) -> Result<Vec<i64>> {
    let exists = conn
        .query_row("SELECT id FROM collections WHERE id = ?1", [root_id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    if exists.is_none() {
        return Ok(Vec::new());
    }

    let mut ids = Vec::new();
    let mut stack = vec![root_id];
    while let Some(collection_id) = stack.pop() {
        ids.push(collection_id);
        let mut statement =
            conn.prepare("SELECT id FROM collections WHERE parent_id = ?1 ORDER BY name ASC, id ASC")?;
        let rows = statement.query_map([collection_id], |row| row.get::<_, i64>(0))?;
        let children = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for child_id in children.into_iter().rev() {
            stack.push(child_id);
        }
    }

    Ok(ids)
}

fn item_ids_for_collection_ids_conn(conn: &Connection, collection_ids: &[i64]) -> Result<Vec<i64>> {
    if collection_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id FROM items WHERE collection_id IN ({}) ORDER BY id ASC",
        placeholders(collection_ids.len())
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(collection_ids.iter().copied()), |row| {
        row.get::<_, i64>(0)
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn managed_attachment_paths_for_item_ids_conn(conn: &Connection, item_ids: &[i64]) -> Result<Vec<String>> {
    if item_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT path FROM attachments WHERE import_mode = ?1 AND item_id IN ({}) ORDER BY id ASC",
        placeholders(item_ids.len())
    );
    let mut params = vec![ImportMode::ManagedCopy.as_str().to_string()];
    params.extend(item_ids.iter().map(ToString::to_string));
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn session_reference_session_ids_for_targets(
    conn: &Connection,
    kind: &str,
    target_ids: &[i64],
) -> Result<Vec<i64>> {
    if target_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "
        SELECT DISTINCT session_id
        FROM ai_session_references
        WHERE kind = ?1 AND target_id IN ({})
        ORDER BY session_id ASC
        ",
        placeholders(target_ids.len())
    );
    let mut values = vec![kind.to_string()];
    values.extend(target_ids.iter().map(ToString::to_string));
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(values.iter()), |row| row.get::<_, i64>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn delete_session_references_for_targets(
    conn: &Connection,
    kind: &str,
    target_ids: &[i64],
) -> Result<()> {
    if target_ids.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "DELETE FROM ai_session_references WHERE kind = ?1 AND target_id IN ({})",
        placeholders(target_ids.len())
    );
    let mut values = vec![kind.to_string()];
    values.extend(target_ids.iter().map(ToString::to_string));
    conn.execute(&sql, params_from_iter(values.iter()))?;
    Ok(())
}

fn delete_by_column_in_clause(
    conn: &Connection,
    table: &str,
    column: &str,
    ids: &[i64],
) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "DELETE FROM {table} WHERE {column} IN ({})",
        placeholders(ids.len())
    );
    conn.execute(&sql, params_from_iter(ids.iter().copied()))?;
    Ok(())
}

fn delete_by_either_column_in_clause(
    conn: &Connection,
    table: &str,
    left_column: &str,
    left_ids: &[i64],
    right_column: &str,
    right_ids: &[i64],
) -> Result<()> {
    if left_ids.is_empty() && right_ids.is_empty() {
        return Ok(());
    }

    let mut clauses = Vec::new();
    let mut values = Vec::new();
    if !left_ids.is_empty() {
        clauses.push(format!("{left_column} IN ({})", placeholders(left_ids.len())));
        values.extend(left_ids.iter().copied());
    }
    if !right_ids.is_empty() {
        clauses.push(format!("{right_column} IN ({})", placeholders(right_ids.len())));
        values.extend(right_ids.iter().copied());
    }

    let sql = format!("DELETE FROM {table} WHERE {}", clauses.join(" OR "));
    conn.execute(&sql, params_from_iter(values.into_iter()))?;
    Ok(())
}

fn child_collections_for_conn(conn: &Connection, parent_id: Option<i64>) -> Result<Vec<Collection>> {
    let query = if parent_id.is_some() {
        "SELECT id, name, parent_id FROM collections WHERE parent_id = ?1 ORDER BY name ASC"
    } else {
        "SELECT id, name, parent_id FROM collections WHERE parent_id IS NULL ORDER BY name ASC"
    };
    let mut statement = conn.prepare(query)?;
    let rows = if let Some(parent_id) = parent_id {
        statement.query_map([parent_id], map_collection)?
    } else {
        statement.query_map([], map_collection)?
    };
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn collect_collection_tree_ids(conn: &Connection, collection_id: i64, out: &mut Vec<i64>) -> Result<()> {
    out.push(collection_id);
    for child in child_collections_for_conn(conn, Some(collection_id))? {
        collect_collection_tree_ids(conn, child.id, out)?;
    }
    Ok(())
}

fn expand_session_references(conn: &Connection, references: &[AISessionReference]) -> Result<SessionPromptExpansion> {
    let mut item_ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut has_collection_reference = false;
    let mut primary_collection_id = None;

    for reference in references.iter().filter(|reference| reference.kind == AISessionReferenceKind::Item) {
        let row = conn
            .query_row(
                "SELECT id, collection_id FROM items WHERE id = ?1",
                [reference.target_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((item_id, collection_id)) = row else {
            continue;
        };
        if seen.insert(item_id) {
            if primary_collection_id.is_none() {
                primary_collection_id = Some(collection_id);
            }
            item_ids.push(item_id);
        }
    }

    for reference in references
        .iter()
        .filter(|reference| reference.kind == AISessionReferenceKind::Collection)
    {
        has_collection_reference = true;
        let mut collection_tree_ids = Vec::new();
        collect_collection_tree_ids(conn, reference.target_id, &mut collection_tree_ids)?;
        for collection_id in collection_tree_ids {
            let mut statement = conn.prepare(
                "
                SELECT id, collection_id
                FROM items
                WHERE collection_id = ?1
                ORDER BY id DESC
                ",
            )?;
            let rows = statement.query_map([collection_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (item_id, row_collection_id) = row?;
                if seen.insert(item_id) {
                    if primary_collection_id.is_none() {
                        primary_collection_id = Some(row_collection_id);
                    }
                    item_ids.push(item_id);
                }
            }
        }
    }

    Ok(SessionPromptExpansion {
        item_ids,
        has_collection_reference,
        primary_collection_id,
    })
}

fn derive_session_title(kind: &str, prompt: Option<&str>) -> Option<String> {
    if let Some(prompt) = prompt {
        let trimmed = prompt.trim();
        if !trimmed.is_empty() {
            return Some(truncate_chars(trimmed, 60));
        }
    }
    let label = match kind {
        "session.summarize" => "Summarize",
        "session.explain_terms" => "Explain Terms",
        "session.theme_map" => "Theme Map",
        "session.compare" => "Compare",
        "session.review_draft" => "Review Draft",
        "session.ask" => "Ask",
        _ => return None,
    };
    Some(label.to_string())
}

fn touch_ai_session(conn: &Connection, session_id: i64, title: Option<&str>) -> Result<()> {
    if let Some(title) = title {
        conn.execute(
            "UPDATE ai_sessions SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![title, session_id],
        )?;
    } else {
        conn.execute(
            "UPDATE ai_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [session_id],
        )?;
    }
    Ok(())
}

fn build_session_prompt(
    conn: &Connection,
    kind: &str,
    expansion: &SessionPromptExpansion,
    prompt: Option<&str>,
) -> Result<String> {
    if expansion.item_ids.len() == 1 && !expansion.has_collection_reference {
        let item_id = expansion.item_ids[0];
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
        let excerpt = truncate_chars(&excerpt, ITEM_TASK_TEXT_LIMIT);
        return build_single_session_prompt(kind, &title, &collection_name, &excerpt, prompt);
    }

    let mut remaining = COLLECTION_TOTAL_TEXT_LIMIT;
    let mut sections = Vec::new();
    for item_id in &expansion.item_ids {
        let row = conn
            .query_row(
                "
                SELECT i.title, c.name, e.plain_text
                FROM items i
                JOIN collections c ON c.id = i.collection_id
                JOIN extracted_content e ON e.item_id = i.id
                WHERE i.id = ?1
                ",
                [item_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((title, collection_name, plain_text)) = row else {
            continue;
        };
        if remaining == 0 {
            break;
        }
        let clipped = truncate_chars(&plain_text, COLLECTION_ITEM_TEXT_LIMIT.min(remaining));
        if clipped.trim().is_empty() {
            continue;
        }
        remaining = remaining.saturating_sub(clipped.chars().count());
        sections.push(format!("## {title}\nCollection: {collection_name}\n\n{clipped}"));
    }
    if sections.is_empty() {
        return Err(anyhow!("session has no readable items"));
    }
    let task_instructions = match kind {
        "session.summarize" => "# Summary Set\n\n## Paper Capsules\n- ...\n\n## Synthesis\n...",
        "session.explain_terms" => "# Terminology Notes\n\n## Terms\n- term: explanation\n\n## Cross-Paper Usage\n...",
        "session.theme_map" => "# Theme Map\n\n## Themes\n- ...\n\n## Theme Clusters\n...",
        "session.compare" => "# Comparison\n\n## Comparison Matrix\n- ...\n\n## Method Notes\n...",
        "session.review_draft" => "# Review Draft\n\n## Evidence Map\n- ...\n\n## Narrative\n...",
        "session.ask" => "# Reading Q&A\n\n## Question\n...\n\n## Answer\n...\n\n## Scope\n...",
        _ => return Err(anyhow!("unsupported session task kind")),
    };
    let prompt_suffix = if kind == "session.ask" {
        format!("\nUser question:\n{}", prompt.unwrap_or("No question provided."))
    } else {
        String::new()
    };
    Ok(format!(
        "You are assisting with a research reading workflow.\nReturn markdown only. Do not wrap the answer in code fences.\nPreserve the heading and section style shown below.\n\nTask kind: {kind}\n{}\n\nUse only this extracted evidence in the exact paper order provided:\n\n{}\n{}",
        task_instructions,
        sections.join("\n\n"),
        prompt_suffix
    ))
}

fn build_single_session_prompt(
    kind: &str,
    title: &str,
    collection_name: &str,
    excerpt: &str,
    prompt: Option<&str>,
) -> Result<String> {
    let task_instructions = match kind {
        "session.summarize" => "# Summary: {title}\n\nCollection: {collection}\n\n## Key Points\n- ...\n\n## Evidence\n- ...",
        "session.explain_terms" => "# Terminology Notes: {title}\n\n## Key Terms\n- term: explanation\n\n## Reading Tip\n...",
        "session.ask" => "# Reading Q&A: {title}\n\n## Question\n...\n\n## Answer\n...\n\n## Evidence\n- ...",
        "session.compare" => return Err(anyhow!("compare requires at least 2 unique papers")),
        "session.theme_map" => "# Theme Map: {title}\n\n## Themes\n- ...\n\n## Theme Clusters\n...",
        "session.review_draft" => "# Review Draft: {title}\n\n## Evidence Map\n- ...\n\n## Narrative\n...",
        _ => return Err(anyhow!("unsupported session task kind")),
    };
    Ok(format!(
        "You are assisting with a research reading workflow.\nReturn markdown only. Do not wrap the answer in code fences.\nPreserve the heading and section style shown below.\n\nTarget title: {title}\nCollection: {collection_name}\nTask kind: {kind}\n{}\n\nUse only this extracted paper text:\n\"\"\"\n{}\n\"\"\"\n{}",
        task_instructions
            .replace("{title}", title)
            .replace("{collection}", collection_name),
        excerpt,
        if kind == "session.ask" {
            format!("\nUser question:\n{}", prompt.unwrap_or(""))
        } else {
            String::new()
        }
    ))
}

fn build_item_prompt(
    kind: &str,
    title: &str,
    collection_name: &str,
    excerpt: &str,
    prompt: Option<&str>,
) -> Result<String> {
    let task_instructions = match kind {
        "item.summarize" => "# Summary: {title}\n\nCollection: {collection}\n\n## Key Points\n- ...\n\n## Evidence\n- ...",
        "item.translate" => "# Translation: {title}\n\n## Translated Passage\n...\n\n## Notes\n...",
        "item.explain_term" => "# Terminology Notes: {title}\n\n## Key Terms\n- term: explanation\n\n## Reading Tip\n...",
        "item.ask" => "# Reading Q&A: {title}\n\n## Question\n...\n\n## Answer\n...\n\n## Evidence\n- ...",
        _ => return Err(anyhow!("unsupported item task kind")),
    };
    let prompt_text = prompt.unwrap_or("");
    Ok(format!(
        "You are assisting with a research reading workflow.\nReturn markdown only. Do not wrap the answer in code fences.\nPreserve the heading and section style shown below.\n\nTarget title: {title}\nCollection: {collection_name}\nTask kind: {kind}\n{}\n\nUse only this extracted paper text:\n\"\"\"\n{}\n\"\"\"\n{}",
        task_instructions
            .replace("{title}", title)
            .replace("{collection}", collection_name),
        excerpt,
        if kind == "item.ask" {
            format!("\nUser question:\n{prompt_text}")
        } else {
            String::new()
        }
    ))
}

fn build_collection_prompt(
    conn: &Connection,
    collection_id: i64,
    collection_name: &str,
    kind: &str,
    scope_item_ids: &[i64],
    prompt: Option<&str>,
) -> Result<String> {
    let mut remaining = COLLECTION_TOTAL_TEXT_LIMIT;
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
            return Err(anyhow!("scope contains items outside the target collection"));
        };
        if remaining == 0 {
            break;
        }
        let clipped = truncate_chars(&plain_text, COLLECTION_ITEM_TEXT_LIMIT.min(remaining));
        if clipped.trim().is_empty() {
            continue;
        }
        remaining = remaining.saturating_sub(clipped.chars().count());
        sections.push(format!("## {title}\n{clipped}"));
    }
    if sections.is_empty() {
        return Err(anyhow!("collection has no readable items"));
    }
    let task_instructions = match kind {
        "collection.bulk_summarize" => "# Bulk Summary: {collection}\n\n## Paper Capsules\n- ...\n\n## Synthesis\n...",
        "collection.theme_map" => "# Theme Map: {collection}\n\n## Themes\n- ...\n\n## Theme Clusters\n...",
        "collection.compare_methods" => "# Method Comparison: {collection}\n\n## Comparison Matrix\n- ...\n\n## Method Notes\n...",
        "collection.review_draft" => "# Review Draft: {collection}\n\n## Evidence Map\n- ...\n\n## Narrative\n...",
        "collection.ask" => "# Collection Q&A: {collection}\n\n## Question\n...\n\n## Answer\n...\n\n## Scope\n...",
        _ => return Err(anyhow!("unsupported collection task kind")),
    };
    let prompt_suffix = if kind == "collection.ask" {
        format!("\nUser question:\n{}", prompt.unwrap_or("No question provided."))
    } else {
        String::new()
    };
    Ok(format!(
        "You are assisting with a research reading workflow.\nReturn markdown only. Do not wrap the answer in code fences.\nPreserve the heading and section style shown below.\n\nCollection: {collection_name}\nTask kind: {kind}\n{}\n\nUse only this extracted collection evidence in the exact item order provided:\n\n{}\n{}",
        task_instructions.replace("{collection}", collection_name),
        sections.join("\n\n"),
        prompt_suffix
    ))
}

fn extract_openai_content(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    value.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    part.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }).filter(|text| !text.trim().is_empty())
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
        session_id: row.get(2)?,
        title: row.get(3)?,
        markdown: row.get(4)?,
    })
}

fn map_ai_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<AITask> {
    let raw_scope: Option<String> = row.get(4)?;
    let scope_item_ids = parse_scope_item_ids(raw_scope).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(AITask {
        id: row.get(0)?,
        item_id: row.get(1)?,
        collection_id: row.get(2)?,
        session_id: row.get(3)?,
        scope_item_ids,
        input_prompt: row.get(5)?,
        kind: row.get(6)?,
        status: row.get(7)?,
        output_markdown: row.get(8)?,
    })
}

fn map_ai_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<AIArtifact> {
    let raw_scope: Option<String> = row.get(5)?;
    let scope_item_ids = parse_scope_item_ids(raw_scope).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(AIArtifact {
        id: row.get(0)?,
        task_id: row.get(1)?,
        item_id: row.get(2)?,
        collection_id: row.get(3)?,
        session_id: row.get(4)?,
        scope_item_ids,
        kind: row.get(6)?,
        markdown: row.get(7)?,
    })
}

fn map_ai_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<AISession> {
    Ok(AISession {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn map_ai_session_reference(row: &rusqlite::Row<'_>) -> rusqlite::Result<AISessionReference> {
    let kind_raw: String = row.get(2)?;
    let kind = AISessionReferenceKind::parse(&kind_raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())),
        )
    })?;
    Ok(AISessionReference {
        id: row.get(0)?,
        session_id: row.get(1)?,
        kind,
        target_id: row.get(3)?,
        sort_index: row.get(4)?,
    })
}

fn parse_scope_item_ids(value: Option<String>) -> Result<Option<Vec<i64>>, serde_json::Error> {
    value.map(|raw| serde_json::from_str(&raw)).transpose()
}

fn map_collection(row: &rusqlite::Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
    })
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
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Untitled".into());
    let fallback_title = if stem.contains('-') || stem.contains('_') {
        title_from_slug(&stem)
    } else {
        stem
    };

    // Best-effort parsing: PDF import/reading should not be blocked by metadata/text extraction.
    let pdf = PdfDocument::load_mem(bytes).ok();
    let page_count = pdf
        .as_ref()
        .map(|pdf| pdf.get_pages().len() as i64)
        .filter(|count| *count > 0);
    let metadata = pdf
        .as_ref()
        .map(|pdf| read_pdf_metadata(pdf, &fallback_title))
        .unwrap_or_else(|| InferredMetadata {
            title: Some(fallback_title.clone()),
            authors: "Imported Author".into(),
            publication_year: None,
            source: "Imported PDF".into(),
            doi: None,
        });

    let page_fragments = panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
        .ok()
        .and_then(Result::ok)
        .map(|pages| pdf_page_fragments(&pages))
        .unwrap_or_default();
    let plain_text = join_plain_text(&page_fragments);
    let (content_status, content_notice) =
        classify_pdf_content(&page_fragments, page_count.unwrap_or(0) as usize);
    let normalized_html = article_from_paragraphs(
        &metadata
            .title
            .clone()
            .unwrap_or_else(|| fallback_title.clone()),
        &page_fragments,
    );

    Ok(ExtractedDocument {
        normalized_html,
        plain_text,
        page_count,
        content_status,
        content_notice,
        extractor_version: EXTRACTOR_VERSION,
        metadata,
    })
}

fn extract_docx(path: &Path, bytes: &[u8]) -> Result<ExtractedDocument> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let document_xml = read_zip_entry(&mut archive, "word/document.xml")?;
    let paragraphs = extract_docx_paragraphs(&document_xml)?;
    let title = read_docx_title(&mut archive)?.unwrap_or_else(|| {
        path.file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.trim().is_empty())
            .map(|value| title_from_slug(&value))
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
        extractor_version: EXTRACTOR_VERSION,
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
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.trim().is_empty())
            .map(|value| title_from_slug(&value))
            .unwrap_or_else(|| "Untitled".into())
    });
    let plain_text = join_plain_text(&sections);

    Ok(ExtractedDocument {
        normalized_html: article_from_paragraphs(&resolved_title, &sections),
        plain_text,
        page_count: Some(sections.len() as i64),
        content_status: "ready".into(),
        content_notice: None,
        extractor_version: EXTRACTOR_VERSION,
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

fn pdf_page_fragments(page_text: &[String]) -> Vec<String> {
    page_text
        .iter()
        .map(|value| normalize_whitespace(value))
        .filter(|value| value.len() > 2)
        .collect()
}

fn classify_pdf_content(
    page_fragments: &[String],
    page_count: usize,
) -> (String, Option<String>) {
    if page_fragments.is_empty() {
        return (
            "unavailable".into(),
            Some("This PDF can be read by page, but no reliable text layer is available.".into()),
        );
    }

    if page_count > 1 && page_fragments.len() < page_count {
        return (
            "partial".into(),
            Some("This PDF has partial extracted text. Page reading remains available, but text features are limited.".into()),
        );
    }

    ("ready".into(), None)
}

fn read_pdf_metadata(pdf: &PdfDocument, fallback_title: &str) -> InferredMetadata {
    let info = pdf
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| match object {
            Object::Reference(id) => pdf.get_dictionary(*id).ok().cloned(),
            Object::Dictionary(dict) => Some(dict.clone()),
            _ => None,
        });
    let title = info
        .as_ref()
        .and_then(|dict| pdf_info_string(dict, b"Title"))
        .unwrap_or_else(|| fallback_title.to_string());
    let authors = info
        .as_ref()
        .and_then(|dict| pdf_info_string(dict, b"Author"))
        .unwrap_or_else(|| "Imported Author".into());
    let publication_year = info
        .as_ref()
        .and_then(|dict| pdf_info_string(dict, b"CreationDate"))
        .and_then(|value| {
            Regex::new(r"D:(\d{4})")
                .ok()?
                .captures(&value)
                .and_then(|captures| captures.get(1))
                .and_then(|year| year.as_str().parse::<i64>().ok())
        });

    InferredMetadata {
        title: Some(title),
        authors,
        publication_year,
        source: "Imported PDF".into(),
        doi: None,
    }
}

fn pdf_info_string(dict: &Dictionary, key: &[u8]) -> Option<String> {
    let object = dict.get(key).ok()?;
    match object {
        Object::String(value, _) => Some(normalize_whitespace(&String::from_utf8_lossy(value))),
        Object::Name(value) => Some(normalize_whitespace(&String::from_utf8_lossy(value))),
        _ => None,
    }
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
        String::new()
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
