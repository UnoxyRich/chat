import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdf from 'pdf-parse';
import OpenAI from 'openai';
import { CONFIG } from '../backend/config.js';
import {
  replaceDocumentMetadata,
  storeEmbeddingChunk,
  getAllEmbeddings,
  getDocumentByFilename,
  startIndexingJob,
  completeIndexingJob,
  failIndexingJob
} from '../backend/db.js';

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function splitText(text, chunkSize, chunkOverlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const chunk = text.slice(start, end).trim();
    if (chunk.length) {
      chunks.push(chunk);
    }
    start += chunkSize - chunkOverlap;
  }
  return chunks;
}

async function embedBatch(client, texts) {
  const embeddingModel = CONFIG.lmStudio.embeddingModel;
  const response = await client.embeddings.create({ model: embeddingModel, input: texts });
  return response.data.map((item) => item.embedding);
}

export async function ingestDocument(db, client, filename) {
  const fullPath = path.join(CONFIG.filesDir, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File ${filename} no longer exists`);
  }
  const stat = fs.statSync(fullPath);
  const buffer = fs.readFileSync(fullPath);
  const hash = hashBuffer(buffer);
  const existing = getDocumentByFilename(db, filename);
  if (existing && existing.hash === hash && existing.mtime === stat.mtimeMs) {
    return { filename, status: 'skipped' };
  }

  const jobId = startIndexingJob(db, filename, stat.mtimeMs, hash);
  try {
    const data = await pdf(buffer);
    const chunks = splitText(data.text, CONFIG.retrieval.chunkSize, CONFIG.retrieval.chunkOverlap);
    const embeddings = await embedBatch(client, chunks);
    const docId = replaceDocumentMetadata(db, filename, stat.mtimeMs, hash);
    embeddings.forEach((embedding, idx) => {
      storeEmbeddingChunk(db, docId, idx, embedding, chunks[idx]);
    });
    completeIndexingJob(db, jobId);
    return { filename, status: 'indexed', chunks: chunks.length };
  } catch (err) {
    failIndexingJob(db, jobId, err.message);
    throw err;
  }
}

export async function ingestDocuments(db, client) {
  const files = fs.readdirSync(CONFIG.filesDir).filter((file) => file.toLowerCase().endsWith('.pdf'));
  const results = [];
  let hasError = false;
  for (const file of files) {
    try {
      const result = await ingestDocument(db, client, file);
      results.push(result);
    } catch (err) {
      results.push({ filename: file, status: 'error', error: err.message });
      hasError = true;
    }
  }
  if (hasError) {
    const failed = results.filter((r) => r.status === 'error').map((r) => r.filename).join(', ');
    throw new Error(`Failed to ingest: ${failed}`);
  }
  return results;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function retrieveContext(db, client, query) {
  const queryEmbedding = (await embedBatch(client, [query]))[0];
  const rows = getAllEmbeddings(db);
  const scored = rows.map((row) => {
    const vector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const score = cosineSimilarity(queryEmbedding, Array.from(vector));
    return {
      score,
      filename: row.filename,
      chunkIndex: row.chunk_index,
      text: row.text
    };
  });
  const top = scored.sort((a, b) => b.score - a.score).slice(0, CONFIG.retrieval.topK);
  const contextChunks = top.map((item) => ({
    text: `Source: ${item.filename} [chunk ${item.chunkIndex}]\n${item.text}`,
    filename: item.filename,
    chunkIndex: item.chunkIndex,
    score: item.score
  }));
  return { contextChunks, sources: top };
}

export function createOpenAIClient() {
  return new OpenAI({ baseURL: CONFIG.lmStudio.baseURL, apiKey: process.env.LM_STUDIO_API_KEY || 'not-needed' });
}
