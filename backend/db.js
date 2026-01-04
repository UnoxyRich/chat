import Database from 'better-sqlite3';
import { CONFIG } from './config.js';

export function initDatabase() {
  const db = new Database(CONFIG.dbFile);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      user_message_id INTEGER,
      ai_message_id INTEGER,
      ip TEXT,
      user_agent TEXT,
      rag_sources TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id),
      FOREIGN KEY(user_message_id) REFERENCES messages(id),
      FOREIGN KEY(ai_message_id) REFERENCES messages(id)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id)
    );
    CREATE TABLE IF NOT EXISTS indexing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT,
      mtime INTEGER,
      hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_interactions_conversation ON interactions(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_document ON embeddings(document_id);
    CREATE INDEX IF NOT EXISTS idx_indexing_jobs_started ON indexing_jobs(started_at DESC);
  `);

  return db;
}

export function upsertConversation(db, token) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(token);
  if (!existing) {
    db.prepare('INSERT INTO conversations(id, created_at, last_active_at) VALUES (?, ?, ?)').run(token, now, now);
  } else {
    db.prepare('UPDATE conversations SET last_active_at = ? WHERE id = ?').run(now, token);
  }
}

export function addMessage(db, conversationId, role, content) {
  const now = Date.now();
  const result = db
    .prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, role, content, now);
  db.prepare('UPDATE conversations SET last_active_at = ? WHERE id = ?').run(now, conversationId);
  return { id: result.lastInsertRowid, created_at: now };
}

export function listMessages(db, conversationId) {
  return db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversationId);
}

export function logInteraction(db, conversationId, userMessageId, aiMessageId, metadata = {}) {
  const { ip, userAgent, ragSources } = metadata;
  db.prepare(
    'INSERT INTO interactions(conversation_id, user_message_id, ai_message_id, ip, user_agent, rag_sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(conversationId, userMessageId, aiMessageId, ip || null, userAgent || null, ragSources || null, Date.now());
}

export function replaceDocumentMetadata(db, filename, mtime, hash) {
  const existing = db.prepare('SELECT id FROM documents WHERE filename = ?').get(filename);
  const now = Date.now();
  if (existing) {
    db.prepare('UPDATE documents SET mtime = ?, hash = ? WHERE id = ?').run(mtime, hash, existing.id);
    db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(existing.id);
    return existing.id;
  }
  const result = db
    .prepare('INSERT INTO documents(filename, mtime, hash, created_at) VALUES (?, ?, ?, ?)')
    .run(filename, mtime, hash, now);
  return result.lastInsertRowid;
}

export function getDocumentByFilename(db, filename) {
  return db.prepare('SELECT * FROM documents WHERE filename = ?').get(filename);
}

export function storeEmbeddingChunk(db, documentId, chunkIndex, embedding, text) {
  db.prepare(
    'INSERT INTO embeddings(document_id, chunk_index, embedding, text) VALUES (?, ?, ?, ?)'
  ).run(documentId, chunkIndex, Buffer.from(new Float32Array(embedding).buffer), text);
}

export function getAllEmbeddings(db) {
  return db
    .prepare('SELECT embeddings.id, documents.filename, embeddings.chunk_index, embeddings.embedding, embeddings.text FROM embeddings JOIN documents ON documents.id = embeddings.document_id')
    .all();
}

export function startIndexingJob(db, filename, mtime, hash) {
  const result = db
    .prepare(
      'INSERT INTO indexing_jobs(filename, status, started_at, mtime, hash) VALUES (?, ?, ?, ?, ?)'
    )
    .run(filename, 'running', Date.now(), mtime || null, hash || null);
  return result.lastInsertRowid;
}

export function completeIndexingJob(db, jobId) {
  db.prepare('UPDATE indexing_jobs SET status = ?, completed_at = ?, error = NULL WHERE id = ?').run(
    'success',
    Date.now(),
    jobId
  );
}

export function failIndexingJob(db, jobId, error) {
  db.prepare('UPDATE indexing_jobs SET status = ?, completed_at = ?, error = ? WHERE id = ?').run(
    'error',
    Date.now(),
    error,
    jobId
  );
}

export function getRecentIndexingJobs(db, limit = 10) {
  return db
    .prepare(
      'SELECT id, filename, status, started_at, completed_at, error, mtime, hash FROM indexing_jobs ORDER BY started_at DESC LIMIT ?'
    )
    .all(limit);
}

export function listConversations(db, limit = 100) {
  return db
    .prepare(
      `SELECT
        c.id,
        c.created_at,
        c.last_active_at,
        (
          SELECT content FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'user'
          ORDER BY m.id ASC
          LIMIT 1
        ) AS first_user_message,
        (
          SELECT content FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.id DESC
          LIMIT 1
        ) AS last_message
      FROM conversations c
      ORDER BY c.last_active_at DESC
      LIMIT ?`
    )
    .all(limit);
}
