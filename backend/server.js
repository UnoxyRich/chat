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
  getRecentIndexingJobs,
  getAllEmbeddings
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

const MAX_COMPLETION_ATTEMPTS = 2;
const MAX_HISTORY_MESSAGES = 6;
const DEFAULT_REQUEST_ID_PREFIX = 'chat';
const RAG_CONTEXT_CHAR_LIMIT = 4000;
const MIN_RETRY_TOKEN_BUFFER = 512;

function createRequestId(prefix = DEFAULT_REQUEST_ID_PREFIX) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

async function loadSystemPrompt() {
  systemPrompt = fs.readFileSync(CONFIG.systemPromptPath, 'utf-8');
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

  console.log('[LM Studio] Available models:', modelIds.join(', '));

  if (!modelIds.includes(CONFIG.lmStudio.chatModel)) {
    throw new Error(`Chat model ${CONFIG.lmStudio.chatModel} not available in LM Studio`);
  }

  if (!modelIds.includes(CONFIG.lmStudio.embeddingModel)) {
    throw new Error(
      `Embedding model '${CONFIG.lmStudio.embeddingModel}' not found in LM Studio. Available models: [${modelIds.join(', ')}]`
    );
  }

  console.log(`[LM Studio] Embedding model ready: ${CONFIG.lmStudio.embeddingModel}`);
  return { embeddingModel: CONFIG.lmStudio.embeddingModel };
}

async function startup() {
  await loadSystemPrompt();
  validateLMStudioEndpoint();
  openaiClient = createOpenAIClient();
  const { embeddingModel } = await verifyLMStudio(openaiClient);
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
  const embeddedChunks = getAllEmbeddings(db).length;
  if (embeddedChunks === 0) {
    throw new Error('No PDF chunks were embedded. Confirm the PDFs contain text and retry ingestion.');
  }
  indexingState.lastResult = { filename: 'initial-scan', status: 'completed', results, completedAt: Date.now() };
  indexingState.state = 'idle';
  indexingState.currentFile = null;
  console.log('[LLM] Chat model pinned:', CONFIG.lmStudio.chatModel);
  console.log('[LLM] Embedding model pinned:', embeddingModel);
  console.log(`[RAG] Embedded chunks confirmed: ${embeddedChunks}`);
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

function getInstructionTexts(language) {
  const safetyInstruction =
    'Use only the provided RAG context to answer. If the context is missing or insufficient, say you cannot find the information and ask for a specific product name or documentation. Never invent details.';
  const languageInstruction =
    language === 'zh'
      ? '请使用用户提问的语言进行回答，若缺少上下文，请礼貌告知无法找到相关信息，不要猜测。'
      : "Respond in the user's language. If you lack sufficient context, politely state that and do not guess.";
  return { safetyInstruction, languageInstruction };
}

function getTrimmedHistory(conversationId) {
  const history = listMessages(db, conversationId);
  return history.slice(-MAX_HISTORY_MESSAGES).map(({ role, content }) => ({ role, content }));
}

function buildMessages(context, history, language, ragNote) {
  const { safetyInstruction, languageInstruction } = getInstructionTexts(language);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: safetyInstruction },
    { role: 'system', content: languageInstruction }
  ];
  if (ragNote) {
    messages.push({ role: 'system', content: ragNote });
  }
  if (context) {
    messages.push({ role: 'system', content: `RAG context:\n${context}` });
  }
  history.forEach((msg) => {
    messages.push({ role: msg.role, content: msg.content });
  });
  return messages;
}

function analyzeCompletion(completion) {
  const choice = completion?.choices?.[0];
  const finishReason = choice?.finish_reason || choice?.finishReason;
  const content = choice?.message?.content ? choice.message.content.trim() : '';
  const hasContent = Boolean(content);
  const invalidFinishReason = finishReason && finishReason !== 'stop';
  const missingFinishReason = !finishReason;
  return {
    content,
    finishReason,
    invalid: !hasContent || invalidFinishReason || missingFinishReason
  };
}

async function generateCompletionWithRecovery(messages, initialMaxTokens, requestId = 'chat-unknown') {
  let attempt = 0;
  let maxTokens = initialMaxTokens;
  let lastError = null;

  while (attempt < MAX_COMPLETION_ATTEMPTS) {
    try {
      const completion = await openaiClient.chat.completions.create({
        model: CONFIG.lmStudio.chatModel,
        messages,
        max_tokens: maxTokens,
        stream: false
      });
      console.log(
        JSON.stringify(
          {
            event: 'lmstudio_completion_raw',
            requestId,
            attempt: attempt + 1,
            model: CONFIG.lmStudio.chatModel,
            response: completion
          },
          null,
          2
        )
      );
      if (!completion?.choices?.length) {
        throw new Error('LM Studio returned no choices');
      }
      const { content, finishReason, invalid } = analyzeCompletion(completion);
      if (!invalid) {
        return { replyText: content, finishReason };
      }
      lastError = new Error(
        `LLM returned an invalid response (finish_reason=${finishReason || 'none'}, length=${content.length})`
      );
    } catch (err) {
      lastError = err;
    }

    attempt += 1;
    if (attempt >= MAX_COMPLETION_ATTEMPTS) {
      break;
    }

    maxTokens = Math.min(
      CONFIG.outputTokenCap,
      Math.max(Math.floor(maxTokens * 2), maxTokens + MIN_RETRY_TOKEN_BUFFER)
    );
    console.warn(
      `[LLM] Regenerating response (requestId=${requestId}, attempt ${attempt + 1}) with max_tokens=${maxTokens} after issue: ${lastError?.message}`
    );
  }

  throw lastError || new Error('LLM response was empty or invalid after retries');
}

function buildFallbackReply(language) {
  return language === 'zh'
    ? '我暂时无法生成完整的回答。请告诉我具体的产品名称、型号或提供相关PDF，我会立即再次查找。'
    : 'I ran into an issue generating a complete answer. Please share the exact product name, model, or upload the related PDF so I can try again right away.';
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
  const requestId = createRequestId();
  console.log(
    JSON.stringify(
      {
        event: 'chat_request',
        requestId,
        token,
        messagePreview: message.slice(0, 200),
        chatModel: CONFIG.lmStudio.chatModel,
        embeddingModel: CONFIG.lmStudio.embeddingModel
      },
      null,
      2
    )
  );
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
    console.log(
      JSON.stringify(
        { event: 'http_response', requestId, type: 'greeting', replyLength: greetingReply.length },
        null,
        2
      )
    );
    return res.json({ message: greetingReply, sources: [], finishReason: 'greeting', requestId });
  }

  let contextChunks = [];
  let sources = [];
  let maxScore = null;
  let ragNote = null;

  try {
    const retrievalResult = await retrieveContext(db, openaiClient, message, requestId, { language });
    contextChunks = retrievalResult.contextChunks || [];
    sources = retrievalResult.sources || [];
    maxScore = retrievalResult.maxScore ?? null;
    console.log(`[RAG] Retrieved ${contextChunks.length} chunks for query (max score: ${maxScore ?? 'n/a'})`);
  } catch (err) {
    console.warn('RAG retrieval failed; continuing without context', err.message, { requestId });
    ragNote =
      language === 'zh'
        ? '未找到相关文档上下文，将直接根据当前问题回答。'
        : 'No relevant document context was found. Continuing with the model only.';
  }

  if (!contextChunks.length) {
    ragNote =
      ragNote ||
      (language === 'zh'
        ? '未找到相关文档上下文，将直接根据当前问题回答。'
        : 'No relevant document context was found. Continuing with the model only.');
  }

  const trimmedContext = contextChunks
    .slice(0, CONFIG.retrieval.topK)
    .map((chunk) => chunk.text)
    .join('\n\n');
  const contextText =
    trimmedContext.length > RAG_CONTEXT_CHAR_LIMIT
      ? `${trimmedContext.slice(0, RAG_CONTEXT_CHAR_LIMIT)}...`
      : trimmedContext;
  const finalSources = sources.slice(0, Math.max(contextChunks.length, 1));

  const historyMessages = getTrimmedHistory(token);
  const messages = buildMessages(contextText, historyMessages, language, ragNote);
  const promptSummary = {
    messageCount: messages.length,
    totalChars: messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0),
    messages: messages.map((msg) => ({ role: msg.role, length: msg.content?.length || 0 }))
  };
  console.log(JSON.stringify({ event: 'prompt_structure', requestId, ...promptSummary }, null, 2));

  try {
    const { replyText, finishReason } = await generateCompletionWithRecovery(
      messages,
      CONFIG.outputTokenCap,
      requestId
    );
    const finalReply = replyText && replyText.trim().length > 0 ? replyText.trim() : buildFallbackReply(language);
    const aiMessage = addMessage(db, token, 'assistant', finalReply);
    logInteraction(db, token, userMessage.id, aiMessage.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ragSources: JSON.stringify(finalSources)
    });
    console.log(
      JSON.stringify(
        {
          event: 'http_response',
          requestId,
          type: 'chat_success',
          replyLength: finalReply.length,
          sourcesCount: finalSources.length,
          replyPreview: finalReply.slice(0, 200),
          finishReason: finishReason || 'stop'
        },
        null,
        2
      )
    );
    res.json({ message: finalReply, sources: finalSources, finishReason: finishReason || 'stop', requestId, note: ragNote });
  } catch (err) {
    console.error('Chat error', err.message, { requestId });
    const fallbackReply = buildFallbackReply(language);
    const aiMessage = addMessage(db, token, 'assistant', fallbackReply);
    logInteraction(db, token, userMessage.id, aiMessage.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ragSources: JSON.stringify(finalSources)
    });
    res.json({ message: fallbackReply, sources: finalSources, finishReason: 'fallback', requestId, note: ragNote });
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
