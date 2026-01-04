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
  listConversations,
  getRecentIndexingJobs
} from './db.js';
import chokidar from 'chokidar';
import {
  ingestDocuments,
  ingestDocument,
  retrieveContext,
  createOpenAIClient,
  warmUpModels,
  validateLMStudioEndpoint
} from '../rag/rag.js';

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

function resolveEmbeddingModel(modelIds) {
  const configuredEmbedding = CONFIG.lmStudio.embeddingModel;
  const preferredEmbedding =
    configuredEmbedding === 'text-embedding-3-large'
      ? 'text-embedding-mxbai-embed-large-v1'
      : configuredEmbedding;
  const fallbackEmbedding = 'text-embedding-nomic-embed-text-v1.5';

  const remapped = configuredEmbedding === 'text-embedding-3-large';
  if (remapped) {
    console.warn(
      `[LM Studio] Embedding model ${configuredEmbedding} is deprecated; attempting ${preferredEmbedding} instead.`
    );
  }

  if (modelIds.includes(preferredEmbedding)) {
    return { embeddingModel: preferredEmbedding, fallbackUsed: false, remapped };
  }

  if (preferredEmbedding === 'text-embedding-mxbai-embed-large-v1' && modelIds.includes(fallbackEmbedding)) {
    console.warn(
      `[LM Studio] Embedding model ${preferredEmbedding} not available; falling back to ${fallbackEmbedding}.`
    );
    return { embeddingModel: fallbackEmbedding, fallbackUsed: true, remapped };
  }

  throw new Error(`Embedding model ${preferredEmbedding} not available in LM Studio`);
}

async function verifyLMStudio(client) {
  let modelIds;
  try {
    const res = await client.models.list();
    modelIds = res.data.map((m) => m.id);
  } catch (err) {
    console.error('Failed to connect to LM Studio', err.message);
    throw new Error(`LM Studio is not reachable at ${CONFIG.lmStudio.baseURL}: ${err.message}`);
  }

  if (!modelIds.includes(CONFIG.lmStudio.chatModel)) {
    throw new Error(`Chat model ${CONFIG.lmStudio.chatModel} not available in LM Studio`);
  }

  const { embeddingModel, fallbackUsed, remapped } = resolveEmbeddingModel(modelIds);
  CONFIG.lmStudio.embeddingModel = embeddingModel;
  return { embeddingModel, fallbackUsed, remapped };
}

async function startup() {
  await loadSystemPrompt();
  validateLMStudioEndpoint();
  openaiClient = createOpenAIClient();
  const { embeddingModel, fallbackUsed, remapped } = await verifyLMStudio(openaiClient);
  await warmUpModels(openaiClient);
  indexingState.state = 'indexing';
  indexingState.currentFile = 'initial-scan';
  console.log('[RAG] Initial ingestion starting');
  const results = await ingestDocuments(db, openaiClient);
  if (!results.length) {
    throw new Error(
      `No PDFs found in ${CONFIG.filesDir}. Place the knowledge base PDFs there so embeddings can be generated.`
    );
  }
  indexingState.lastResult = { filename: 'initial-scan', status: 'completed', results, completedAt: Date.now() };
  indexingState.state = 'idle';
  indexingState.currentFile = null;
  console.log('[LLM] Chat model pinned:', CONFIG.lmStudio.chatModel);
  console.log('[LLM] Embedding model pinned:', embeddingModel);
  if (remapped) {
    console.log('[LLM] Embedding model remapped from text-embedding-3-large to preferred option.');
  }
  if (fallbackUsed) {
    console.log('[LLM] Embedding model fallback in use; update LM Studio to restore preferred model.');
  }
  console.log('[RAG] Embedding engine ready');
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

function isGreeting(text) {
  const normalized = text.trim().toLowerCase().replace(/[!,.。！？]/g, '');
  const greetings = ['hi', 'hello', 'hey', 'hola', '你好', '您好'];
  return greetings.includes(normalized);
}

function detectLanguage(text) {
  if (/[^\x00-\x7F]/.test(text) && /[\u4e00-\u9fff]/.test(text)) {
    return 'zh';
  }
  return 'en';
}

function buildMessages(context, userInput, language) {
  const safetyInstruction =
    'Use only the provided RAG context to answer. If the context is missing or insufficient, say you cannot find the information and ask for a specific product name or documentation. Never invent details.';
  const languageInstruction =
    language === 'zh'
      ? '请使用用户提问的语言进行回答，若缺少上下文，请礼貌告知无法找到相关信息，不要猜测。'
      : 'Respond in the user\'s language. If you lack sufficient context, politely state that and do not guess.';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: safetyInstruction },
    { role: 'system', content: languageInstruction }
  ];
  if (context) {
    messages.push({ role: 'system', content: `RAG context:\n${context}` });
  }
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
  upsertConversation(db, token);
  const messages = listMessages(db, token);
  res.json({ messages });
});

app.get('/api/conversations', (req, res) => {
  const conversations = listConversations(db, 100);
  res.json({ conversations });
});


app.post('/api/chat', async (req, res) => {
  const { token, message } = req.body;
  if (!token || !message) {
    return res.status(400).json({ error: 'token and message are required' });
  }
  upsertConversation(db, token);
  const userMessage = addMessage(db, token, 'user', message);
  const language = detectLanguage(message);
  const greetingReply =
    language === 'zh' ? '你好！很高兴和你交流，我可以怎样帮助你？' : 'Hello! How can I help you today?';

  if (isGreeting(message)) {
    const aiMessage = addMessage(db, token, 'assistant', greetingReply);
    logInteraction(db, token, userMessage.id, aiMessage.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ragSources: JSON.stringify([])
    });
    return res.json({ reply: greetingReply, sources: [] });
  }

  try {
    const { contextChunks, sources, maxScore } = await retrieveContext(db, openaiClient, message);
    console.log(`[RAG] Retrieved ${contextChunks.length} chunks for query (max score: ${maxScore ?? 'n/a'})`);

    const systemTokens = estimateTokens(systemPrompt) + estimateTokens(greetingReply) + 50;
    const userTokens = estimateTokens(message);
    let selectedContext = contextChunks.map((chunk) => ({ ...chunk, tokens: estimateTokens(chunk.text) }));

    const CONTEXT_TOKEN_BUDGET = 2000;
    const PROMPT_TOKEN_BUDGET = 3000;

    const computeReserved = (contextMsgs) => {
      const contextTokens = contextMsgs.reduce((sum, chunk) => sum + chunk.tokens, 0);
      return systemTokens + userTokens + contextTokens;
    };

    let reservedTokens = computeReserved(selectedContext);

    while (reservedTokens > CONTEXT_TOKEN_BUDGET && selectedContext.length > 0) {
      selectedContext.pop();
      reservedTokens = computeReserved(selectedContext);
    }

    if (reservedTokens >= PROMPT_TOKEN_BUDGET) {
      throw new Error('Insufficient context window for request even after trimming context.');
    }

    const remainingForGeneration = PROMPT_TOKEN_BUDGET - reservedTokens;
    const maxGenerationTokens = Math.min(CONFIG.outputTokenCap, remainingForGeneration);

    if (maxGenerationTokens <= 0) {
      throw new Error('No tokens available for generation after budgeting.');
    }

    const finalContextText = selectedContext.map((chunk) => chunk.text).join('\n\n');
    const finalSources = sources.slice(0, selectedContext.length);

    if (selectedContext.length === 0) {
      const noDataReply =
        language === 'zh'
          ? '没有找到相关的文档内容。请提供具体的产品名称或上传对应的PDF以便我查阅。'
          : 'I could not find relevant information in the indexed documents. Please provide the exact product name or upload the related PDF.';
      const aiMessage = addMessage(db, token, 'assistant', noDataReply);
      logInteraction(db, token, userMessage.id, aiMessage.id, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        ragSources: JSON.stringify([])
      });
      return res.json({ reply: noDataReply, sources: [] });
    }

    console.log(
      JSON.stringify(
        {
          event: 'token_budget',
          reservedTokens,
          maxGenerationTokens,
          systemTokens,
          userTokens,
          contextTokens: selectedContext.reduce((sum, chunk) => sum + chunk.tokens, 0)
        },
        null,
        2
      )
    );

    const messages = buildMessages(finalContextText, message, language);
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
