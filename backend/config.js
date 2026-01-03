import path from 'path';
import fs from 'fs';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const CONFIG = {
  systemPromptPath: path.join(rootDir, 'SystemPromt.txt'),
  filesDir: path.join(rootDir, 'files-for-sharing'),
  dbFile: path.join(rootDir, 'db', 'app.db'),
  logDir: path.join(rootDir, 'logs'),
  port: process.env.PORT || 3000,
  lmStudio: {
    baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
    chatModel: process.env.LM_STUDIO_CHAT_MODEL || 'gpt-4o-mini',
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
