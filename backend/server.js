import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { CONFIG, ensureDirectories } from './config.js';
import {
  initDatabase,
  upsertConversation,
  addMessage,
  listMessages,
  logInteraction,
  getRecentIndexingJobs
} from './db.js';
import chokidar from 'chokidar';
import { ingestDocuments, ingestDocument, retrieveContext, createOpenAIClient } from '../rag/rag.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

ensureDirectories();
const db = initDatabase();
let systemPrompt = '';
let openaiClient = null;
const pendingFiles = new Set();
const indexingState = {
  state: 'idle',
  currentFile: null,
  lastResult: null
};

const TOKEN_ESTIMATE_DIVISOR = 4;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / TOKEN_ESTIMATE_DIVISOR);
}

async function loadSystemPrompt() {
  systemPrompt = fs.readFileSync(CONFIG.systemPromptPath, 'utf-8');
}

async function verifyLMStudio(client) {
  try {
    const res = await client.models.list();
    const modelIds = res.data.map((m) => m.id);
    if (!modelIds.includes(CONFIG.lmStudio.chatModel)) {
      throw new Error(`Configured chat model ${CONFIG.lmStudio.chatModel} not found in LM Studio.`);
    }

    if (!modelIds.includes(CONFIG.lmStudio.embeddingModel)) {
      const preferredEmbedding = modelIds.find((id) => id !== CONFIG.lmStudio.chatModel && id.toLowerCase().includes('embed'));
      const alternative = preferredEmbedding || modelIds.find((id) => id !== CONFIG.lmStudio.chatModel) || CONFIG.lmStudio.chatModel;
      CONFIG.lmStudio.embeddingModel = alternative;
      console.warn(
        `Configured embedding model not found. Using ${CONFIG.lmStudio.embeddingModel}${
          alternative === CONFIG.lmStudio.chatModel ? ' (chat model fallback)' : ''
        }.`
      );
    }
  } catch (err) {
    console.error('Failed to connect to LM Studio', err.message);
    throw new Error('LM Studio is not reachable');
  }
}

async function startup() {
  await loadSystemPrompt();
  openaiClient = createOpenAIClient();
  await verifyLMStudio(openaiClient);
  indexingState.state = 'indexing';
  indexingState.currentFile = 'initial-scan';
  const results = await ingestDocuments(db, openaiClient);
  indexingState.lastResult = { filename: 'initial-scan', status: 'completed', results, completedAt: Date.now() };
  indexingState.state = 'idle';
  indexingState.currentFile = null;
  console.log(`Using chat model ${CONFIG.lmStudio.chatModel} with context window ${CONFIG.contextWindow}.`);
  console.log(`Using embedding model ${CONFIG.lmStudio.embeddingModel}.`);
}

startup()
  .then(() => {
    startFileWatcher();
    app.listen(CONFIG.port, () => {
      console.log(`Backend running on port ${CONFIG.port}`);
    });
  })
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });

function buildMessages(history, context, userInput) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (context) {
    messages.push({ role: 'system', content: `RAG context:\n${context}` });
  }
  history.forEach((msg) => {
    messages.push({ role: msg.role, content: msg.content });
  });
  messages.push({ role: 'user', content: userInput });
  return messages;
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

let processingQueue = false;

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (pendingFiles.size > 0) {
    const [next] = pendingFiles;
    pendingFiles.delete(next);
    indexingState.state = 'indexing';
    indexingState.currentFile = next;
    try {
      const result = await ingestDocument(db, openaiClient, next);
      indexingState.lastResult = { ...result, completedAt: Date.now() };
      console.log(`Indexed ${next}: ${result.status}`);
    } catch (err) {
      indexingState.lastResult = { filename: next, status: 'error', error: err.message, completedAt: Date.now() };
      console.error(`Failed to index ${next}:`, err.message);
    }
    indexingState.state = 'idle';
    indexingState.currentFile = null;
  }
  processingQueue = false;
}

function enqueueFile(filename) {
  if (!filename.toLowerCase().endsWith('.pdf')) return;
  pendingFiles.add(path.basename(filename));
  processQueue();
}

function startFileWatcher() {
  const watcher = chokidar.watch(CONFIG.filesDir, { ignoreInitial: true, depth: 0 });
  watcher.on('add', enqueueFile);
  watcher.on('change', enqueueFile);
  console.log(`Watching ${CONFIG.filesDir} for new or updated PDFs...`);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/token', (req, res) => {
  const token = generateToken();
  upsertConversation(db, token);
  res.json({ token });
});

app.get('/api/indexing/status', (req, res) => {
  res.json({
    state: indexingState.state,
    currentFile: indexingState.currentFile,
    queue: Array.from(pendingFiles),
    lastResult: indexingState.lastResult,
    recentJobs: getRecentIndexingJobs(db, 15)
  });
});

app.get('/api/conversation/:token', (req, res) => {
  const { token } = req.params;
  const messages = listMessages(db, token);
  res.json({ messages });
});

app.post('/api/chat', async (req, res) => {
  const { token, message } = req.body;
  if (!token || !message) {
    return res.status(400).json({ error: 'token and message are required' });
  }
  upsertConversation(db, token);
  const history = listMessages(db, token);
  const userMessage = addMessage(db, token, 'user', message);
  try {
    const { contextChunks, sources } = await retrieveContext(db, openaiClient, message);

    const systemTokens = estimateTokens(systemPrompt);
    const userTokens = estimateTokens(message);
    const historyWithTokens = history.map((msg) => ({ ...msg, tokens: estimateTokens(msg.content) }));
    let trimmedHistory = [...historyWithTokens];

    let selectedContext = contextChunks.map((chunk) => ({ ...chunk, tokens: estimateTokens(chunk.text) }));

    const computeReserved = (historyMsgs, contextMsgs) => {
      const historyTokens = historyMsgs.reduce((sum, msg) => sum + msg.tokens, 0);
      const contextTokens = contextMsgs.reduce((sum, chunk) => sum + chunk.tokens, 0);
      return systemTokens + userTokens + historyTokens + contextTokens;
    };

    const targetWindow = CONFIG.contextWindow;
    let reservedTokens = computeReserved(trimmedHistory, selectedContext);

    while (reservedTokens >= targetWindow && trimmedHistory.length > 0) {
      trimmedHistory.shift();
      reservedTokens = computeReserved(trimmedHistory, selectedContext);
    }

    while (reservedTokens >= targetWindow && selectedContext.length > 0) {
      selectedContext.pop();
      reservedTokens = computeReserved(trimmedHistory, selectedContext);
    }

    if (reservedTokens >= targetWindow) {
      throw new Error('Insufficient context window for request even after trimming history and context.');
    }

    const remainingForGeneration = targetWindow - reservedTokens;
    const maxGenerationTokens = Math.min(CONFIG.outputTokenCap, remainingForGeneration);

    if (maxGenerationTokens <= 0) {
      throw new Error('No tokens available for generation after budgeting.');
    }

    const finalHistory = trimmedHistory.map(({ tokens, ...rest }) => rest);
    const finalContextText = selectedContext.map((chunk) => chunk.text).join('\n\n');
    const finalSources = sources.slice(0, selectedContext.length);

    console.log(
      JSON.stringify(
        {
          event: 'token_budget',
          totalContextTokens: reservedTokens,
          reservedTokens,
          maxGenerationTokens,
          systemTokens,
          userTokens,
          historyTokens: trimmedHistory.reduce((sum, msg) => sum + msg.tokens, 0),
          contextTokens: selectedContext.reduce((sum, chunk) => sum + chunk.tokens, 0)
        },
        null,
        2
      )
    );

    const messages = buildMessages(finalHistory, finalContextText, message);
    const completion = await openaiClient.chat.completions.create({
      model: CONFIG.lmStudio.chatModel,
      messages,
      max_tokens: maxGenerationTokens
    });
    const replyText = completion.choices[0].message.content;
    const aiMessage = addMessage(db, token, 'assistant', replyText);
    logInteraction(db, token, userMessage.id, aiMessage.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ragSources: JSON.stringify(finalSources)
    });
    res.json({ reply: replyText, sources: finalSources });
  } catch (err) {
    console.error('Chat error', err.message);
    res.status(500).json({ error: 'Chat failed', details: err.message });
  }
});

app.use(express.static(path.join(ROOT_DIR, 'frontend', 'dist')));
app.get('*', (req, res) => {
  const indexPath = path.join(ROOT_DIR, 'frontend', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send('Frontend not built yet');
  }
});
