import path from 'path';
import fs from 'fs';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const CONFIG = {
  systemPromptPath: path.join(rootDir, 'SystemPromt.txt'),
  filesDir: path.join(rootDir, 'files-for-uploading'),
  dbFile: path.join(rootDir, 'db', 'app.db'),
  logDir: path.join(rootDir, 'logs'),
  port: process.env.PORT || 3000,
  contextWindow: 262144,
  outputTokenCap: parseInt(process.env.MAX_OUTPUT_TOKENS || '4096', 10),
  lmStudio: {
    baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
    chatModel: process.env.LM_STUDIO_CHAT_MODEL || 'qwen/qwen3-vl-8b',
    embeddingModel: process.env.LM_STUDIO_EMBEDDING_MODEL || 'text-embedding-3-large'
  },
  retrieval: {
    chunkSize: 800,
    chunkOverlap: 100,
    topK: 5
  }
};

export function ensureDirectories() {
  [path.dirname(CONFIG.dbFile), CONFIG.logDir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}
