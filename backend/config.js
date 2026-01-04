import path from 'path';
import fs from 'fs';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const embeddingModel =
  process.env.EMBEDDING_MODEL ??
  process.env.LM_STUDIO_EMBEDDING_MODEL ??
  'text-embedding-nomic-embed-text-v1.5';
const DEFAULT_OUTPUT_TOKENS = 4096;
const configuredOutputTokens = parseInt(process.env.MAX_OUTPUT_TOKENS || `${DEFAULT_OUTPUT_TOKENS}`, 10);
const outputTokenCap = Math.max(DEFAULT_OUTPUT_TOKENS, configuredOutputTokens);

export const CONFIG = {
  systemPromptPath: path.join(rootDir, 'SystemPromt.txt'),
  filesDir: path.join(rootDir, 'files-for-uploading'),
  dbFile: path.join(rootDir, 'db', 'app.db'),
  logDir: path.join(rootDir, 'logs'),
  port: process.env.PORT || 3000,
  contextWindow: 262144,
  outputTokenCap,
  minCompletionTokens: 1024,
  lmStudio: {
    baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
    chatModel: process.env.LM_STUDIO_CHAT_MODEL || 'qwen/qwen3-vl-8b',
    embeddingModel
  },
  retrieval: {
    chunkSize: 800,
    chunkOverlap: 100,
    topK: 2
  }
};

export function ensureDirectories() {
  [path.dirname(CONFIG.dbFile), CONFIG.logDir, CONFIG.filesDir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}
