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

let embeddingClientRef = null;
let embeddingQueue = Promise.resolve();
let embeddingWarmupPromise = null;
let chatWarmupPromise = null;

function queueEmbeddingTask(task) {
  const run = embeddingQueue.then(() => task());
  embeddingQueue = run.catch(() => {});
  return run;
}

function ensureSingleEmbeddingClient(client) {
  if (embeddingClientRef && embeddingClientRef !== client) {
    console.warn('[RAG] Embedding client switched after initialization; reusing the first instance.');
    return embeddingClientRef;
  }
  embeddingClientRef = client;
  return embeddingClientRef;
}

async function embedBatch(client, texts) {
  const embeddingModel = CONFIG.lmStudio.embeddingModel;
  const stableClient = ensureSingleEmbeddingClient(client);
  return queueEmbeddingTask(async () => {
    try {
      const response = await stableClient.embeddings.create({ model: embeddingModel, input: texts });
      return response.data.map((item) => item.embedding);
    } catch (err) {
      throw new Error(`Embedding request failed: ${err.message}`);
    }
  });
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
    console.log(`[RAG] Skipping unchanged document ${filename}`);
    return { filename, status: 'skipped' };
  }

  const jobId = startIndexingJob(db, filename, stat.mtimeMs, hash);
  try {
    console.log(`[RAG] Parsing and chunking document ${filename}`);
    const data = await pdf(buffer);
    const chunks = splitText(data.text, CONFIG.retrieval.chunkSize, CONFIG.retrieval.chunkOverlap);
    console.log(`[RAG] Generated ${chunks.length} chunks for ${filename}`);
    const embeddings = await embedBatch(client, chunks);
    const docId = replaceDocumentMetadata(db, filename, stat.mtimeMs, hash);
    embeddings.forEach((embedding, idx) => {
      storeEmbeddingChunk(db, docId, idx, embedding, chunks[idx]);
    });
    console.log(`[RAG] Stored embeddings for ${filename}`);
    completeIndexingJob(db, jobId);
    return { filename, status: 'indexed', chunks: chunks.length };
  } catch (err) {
    failIndexingJob(db, jobId, err.message);
    throw err;
  }
  return results;
}

export async function ingestDocuments(db, client) {
  console.log(`[RAG] Scanning PDFs in ${CONFIG.filesDir}`);
  const files = fs.readdirSync(CONFIG.filesDir).filter((file) => file.toLowerCase().endsWith('.pdf'));
  console.log(`[RAG] Found ${files.length} PDFs`);
  if (files.length === 0) {
    console.log('[RAG] No PDFs to index');
    return [];
  }
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
  console.log('[RAG] Index ready');
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
  const rows = getAllEmbeddings(db);
  if (!rows.length) {
    return { contextChunks: [], sources: [], maxScore: null };
  }

  const queryEmbedding = (await embedBatch(client, [query]))[0];
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
  const maxScore = top.length ? top[0].score : null;
  const filtered = top.filter((item) => item.score >= CONFIG.retrieval.minScore);

  const contextChunks = filtered.map((item) => ({
    text: `Source: ${item.filename} [chunk ${item.chunkIndex}]\n${item.text}`,
    filename: item.filename,
    chunkIndex: item.chunkIndex,
    score: item.score
  }));

  return { contextChunks, sources: filtered, maxScore };
}

export function validateLMStudioEndpoint() {
  const parsed = new URL(CONFIG.lmStudio.baseURL);
  if (!parsed.hostname) {
    throw new Error('LM Studio baseURL must include a hostname');
  }
  if (!parsed.port) {
    throw new Error('LM Studio baseURL must include an explicit port');
  }
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    console.warn(
      `[LM Studio] WARNING: baseURL ${parsed.origin} is not local. Ensure LM Studio is not exposed beyond the host machine.`
    );
  }
  return parsed;
}

export function createOpenAIClient() {
  const validated = validateLMStudioEndpoint();
  return new OpenAI({ baseURL: validated.toString(), apiKey: process.env.LM_STUDIO_API_KEY || 'not-needed' });
}

export async function warmUpModels(client) {
  const warmupLabel = '[LM Studio] Warm-up';
  if (!embeddingWarmupPromise) {
    embeddingWarmupPromise = queueEmbeddingTask(async () => {
      console.log(`${warmupLabel} embedding start`);
      try {
        await ensureSingleEmbeddingClient(client).embeddings.create({
          model: CONFIG.lmStudio.embeddingModel,
          input: 'warmup'
        });
        console.log(`${warmupLabel} embedding complete`);
      } catch (err) {
        console.error(`${warmupLabel} embedding failed`, err.message);
        throw err;
      }
    });
  }
  if (!chatWarmupPromise) {
    chatWarmupPromise = (async () => {
      console.log(`${warmupLabel} chat start`);
      try {
        await client.chat.completions.create({
          model: CONFIG.lmStudio.chatModel,
          messages: [{ role: 'system', content: 'warmup' }, { role: 'user', content: 'warmup' }],
          max_tokens: 160
        });
        console.log(`${warmupLabel} chat complete`);
      } catch (err) {
        console.error(`${warmupLabel} chat failed`, err.message);
        throw err;
      }
    })();
  }
  await Promise.all([embeddingWarmupPromise, chatWarmupPromise]);
}
