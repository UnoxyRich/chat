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

const TOKEN_ESTIMATE_DIVISOR = 4;
const CONTEXT_TOKEN_BUDGET = 20000;
const PROMPT_TOKEN_BUDGET = 30000;
const MAX_COMPLETION_ATTEMPTS = 2;
const MIN_RETRY_TOKEN_BUFFER = 1024;
const MAX_HISTORY_MESSAGES = 6;
const DEFAULT_REQUEST_ID_PREFIX = 'chat';
const STREAM_EVENT_CONTENT_TYPE = 'text/event-stream';
const STREAM_EVENT_PREFIX = 'data: ';

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / TOKEN_ESTIMATE_DIVISOR);
}

function createRequestId(prefix = DEFAULT_REQUEST_ID_PREFIX) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function setEventStreamHeaders(res) {
  res.setHeader('Content-Type', STREAM_EVENT_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function writeStreamEvent(res, payload) {
  res.write(`${STREAM_EVENT_PREFIX}${JSON.stringify(payload)}\n\n`);
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

function buildMessages(context, history, language) {
  const { safetyInstruction, languageInstruction } = getInstructionTexts(language);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: safetyInstruction },
    { role: 'system', content: languageInstruction }
  ];
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

async function streamCompletionWithRecovery(messages, initialMaxTokens, requestId, onToken) {
  let attempt = 0;
  let maxTokens = initialMaxTokens;
  let lastError = null;

  while (attempt < MAX_COMPLETION_ATTEMPTS) {
    let collected = '';
    let tokenCount = 0;
    let firstTokenLatencyMs = null;
    const start = Date.now();

    try {
      console.log(
        JSON.stringify(
          { event: 'stream_start', requestId, attempt: attempt + 1, maxTokens, model: CONFIG.lmStudio.chatModel },
          null,
          2
        )
      );
      const stream = await openaiClient.chat.completions.create({
        model: CONFIG.lmStudio.chatModel,
        messages,
        max_tokens: maxTokens,
        stream: true
      });

      let lastFinishReason = null;
      for await (const part of stream) {
        const delta = part?.choices?.[0]?.delta?.content;
        const finishReason = part?.choices?.[0]?.finish_reason || part?.choices?.[0]?.finishReason;
        if (delta) {
          collected += delta;
          tokenCount += 1;
          if (firstTokenLatencyMs === null) {
            firstTokenLatencyMs = Date.now() - start;
            console.log(
              JSON.stringify(
                { event: 'stream_first_token', requestId, attempt: attempt + 1, latencyMs: firstTokenLatencyMs },
                null,
                2
              )
            );
          }
          onToken(delta);
        }
        if (finishReason) {
          lastFinishReason = finishReason;
        }
      }

      console.log(
        JSON.stringify(
          {
            event: 'stream_end',
            requestId,
            attempt: attempt + 1,
            tokenCount,
            durationMs: Date.now() - start,
            firstTokenLatencyMs,
            finishReason: lastFinishReason || 'unknown'
          },
          null,
          2
        )
      );

      if (collected.length > 0) {
        return {
          replyText: collected,
          finishReason: lastFinishReason || 'streamed',
          tokenCount,
          firstTokenLatencyMs,
          interrupted: false
        };
      }

      lastError = new Error('Stream returned no tokens');
    } catch (err) {
      if (collected.length > 0) {
        console.warn(
          JSON.stringify(
            {
              event: 'stream_error_after_tokens',
              requestId,
              attempt: attempt + 1,
              tokenCount,
              message: err.message
            },
            null,
            2
          )
        );
        return {
          replyText: collected,
          finishReason: 'error',
          tokenCount,
          firstTokenLatencyMs,
          interrupted: true
        };
      }
      lastError = err;
    }

    attempt += 1;
    if (attempt >= MAX_COMPLETION_ATTEMPTS) {
      break;
    }

    maxTokens = Math.min(CONFIG.outputTokenCap, Math.max(Math.floor(maxTokens * 2), maxTokens + MIN_RETRY_TOKEN_BUFFER));
    console.warn(
      `[LLM] Regenerating streamed response (requestId=${requestId}, attempt ${attempt + 1}) with max_tokens=${maxTokens} after issue: ${
        lastError?.message
      }`
    );
  }

  throw lastError || new Error('LLM stream was empty or invalid after retries');
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
  setEventStreamHeaders(res);
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

  const streamState = { streamedText: '', sources: [], usedFallback: false };
  const pushToken = (tokenText) => {
    if (!tokenText) return;
    streamState.streamedText += tokenText;
    writeStreamEvent(res, { type: 'token', token: tokenText });
  };
  const endStream = (payload = {}) => {
    writeStreamEvent(res, { type: 'done', ...payload });
    res.end();
  };

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
    pushToken(greetingReply);
    endStream({ sources: [], finishReason: 'greeting' });
    return;
  }

  try {
    const { contextChunks, sources, maxScore } = await retrieveContext(db, openaiClient, message, requestId, { language });
    console.log(`[RAG] Retrieved ${contextChunks.length} chunks for query (max score: ${maxScore ?? 'n/a'})`);

    const historyMessages = getTrimmedHistory(token);
    const { safetyInstruction, languageInstruction } = getInstructionTexts(language);
    const systemTokens =
      estimateTokens(systemPrompt) +
      estimateTokens(safetyInstruction) +
      estimateTokens(languageInstruction) +
      50;
    const conversationTokens = historyMessages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
    let selectedContext = contextChunks.map((chunk) => ({ ...chunk, tokens: estimateTokens(chunk.text) }));

    const computeReserved = (contextMsgs) => {
      const contextTokens = contextMsgs.reduce((sum, chunk) => sum + chunk.tokens, 0);
      return systemTokens + conversationTokens + contextTokens;
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
    if (remainingForGeneration < CONFIG.minCompletionTokens) {
      throw new Error('Insufficient tokens available for generation (requires at least 1024 tokens).');
    }

    const maxGenerationTokens = Math.min(CONFIG.outputTokenCap, remainingForGeneration);

    const finalContextText = selectedContext.map((chunk) => chunk.text).join('\n\n');
    const finalSources = sources.slice(0, selectedContext.length);

    if (selectedContext.length === 0) {
      const noDataReply =
        language === 'zh'
          ? '没有找到相关的文档内容。请告诉我具体的产品名称或型号，或上传对应的PDF文件，我可以立即为你查阅。你希望我查看哪款产品？'
          : 'I could not find relevant information in the indexed documents. Which exact product or document should I check? Please share the product name/model or upload the related PDF so I can help right away.';
      const aiMessage = addMessage(db, token, 'assistant', noDataReply);
      logInteraction(db, token, userMessage.id, aiMessage.id, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        ragSources: JSON.stringify([])
      });
      console.log(
        JSON.stringify(
          {
            event: 'http_response',
            requestId,
            type: 'no_context',
            replyLength: noDataReply.length,
            replyPreview: noDataReply.slice(0, 200)
          },
          null,
          2
        )
      );
      pushToken(noDataReply);
      endStream({ sources: [], finishReason: 'no_context' });
      return;
    }

    console.log(
      JSON.stringify(
        {
          event: 'token_budget',
          reservedTokens,
          maxGenerationTokens,
          systemTokens,
          conversationTokens,
          contextTokens: selectedContext.reduce((sum, chunk) => sum + chunk.tokens, 0)
        },
        null,
        2
      )
    );

    const messages = buildMessages(finalContextText, historyMessages, language);
    const promptSummary = {
      messageCount: messages.length,
      totalChars: messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0),
      messages: messages.map((msg) => ({ role: msg.role, length: msg.content?.length || 0 }))
    };
    console.log(JSON.stringify({ event: 'prompt_structure', requestId, ...promptSummary }, null, 2));
    const { replyText, interrupted, finishReason } = await streamCompletionWithRecovery(
      messages,
      maxGenerationTokens,
      requestId,
      pushToken
    );
    const finalReply = replyText && replyText.trim().length > 0 ? replyText : streamState.streamedText;
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
          stream: {
            tokenCount: streamState.streamedText.length,
            finishReason: finishReason || 'streamed',
            interrupted: Boolean(interrupted)
          }
        },
        null,
        2
      )
    );
    endStream({ sources: finalSources, finishReason: finishReason || 'streamed', interrupted: Boolean(interrupted) });
  } catch (err) {
    console.error('Chat error', err.message, { requestId });
    let fallbackReply = streamState.streamedText;
    if (!fallbackReply) {
      fallbackReply = buildFallbackReply(language);
      streamState.usedFallback = true;
      pushToken(fallbackReply);
    }
    const aiMessage = addMessage(db, token, 'assistant', fallbackReply);
    logInteraction(db, token, userMessage.id, aiMessage.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ragSources: JSON.stringify([])
    });
    console.log(
      JSON.stringify(
        {
          event: 'http_response',
          requestId,
          type: 'chat_fallback',
          replyLength: fallbackReply.length,
          replyPreview: fallbackReply.slice(0, 200),
          streamFallbackUsed: streamState.usedFallback
        },
        null,
        2
      )
    );
    endStream({ sources: [], finishReason: 'fallback', streamFallbackUsed: streamState.usedFallback });
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
