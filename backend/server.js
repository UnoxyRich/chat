import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { CONFIG, ensureDirectories } from './config.js';
import { initDatabase, upsertConversation, addMessage, listMessages, logInteraction } from './db.js';
import { ingestDocuments, retrieveContext, createOpenAIClient } from '../rag/rag.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

ensureDirectories();
const db = initDatabase();
let systemPrompt = '';
let openaiClient = null;

async function loadSystemPrompt() {
  systemPrompt = fs.readFileSync(CONFIG.systemPromptPath, 'utf-8');
}

async function verifyLMStudio(client) {
  try {
    const res = await client.models.list();
    const modelIds = res.data.map((m) => m.id);
    if (!modelIds.includes(CONFIG.lmStudio.chatModel)) {
      console.warn(`Configured chat model ${CONFIG.lmStudio.chatModel} not found. Using first available.`);
      if (modelIds.length) {
        CONFIG.lmStudio.chatModel = modelIds[0];
      }
    }
    if (!modelIds.includes(CONFIG.lmStudio.embeddingModel)) {
      console.warn(`Configured embedding model ${CONFIG.lmStudio.embeddingModel} not found. Using first available.`);
      if (modelIds.length) {
        CONFIG.lmStudio.embeddingModel = modelIds[0];
      }
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
  await ingestDocuments(db, openaiClient);
}

startup()
  .then(() => {
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/token', (req, res) => {
  const token = generateToken();
  upsertConversation(db, token);
  res.json({ token });
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
    const { context, sources } = await retrieveContext(db, openaiClient, message);
    const messages = buildMessages(history, context, message);
    const completion = await openaiClient.chat.completions.create({
      model: CONFIG.lmStudio.chatModel,
      messages
    });
    const replyText = completion.choices[0].message.content;
    const aiMessage = addMessage(db, token, 'assistant', replyText);
    logInteraction(db, token, userMessage.id, aiMessage.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ragSources: JSON.stringify(sources)
    });
    res.json({ reply: replyText, sources });
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
