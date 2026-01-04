import React, { useEffect, useState, useRef } from 'react';
import Waves from './Waves.jsx';
import githubMark from './assets/github-mark.svg';

const API_BASE = '';
const STARTER_PROMPTS = [
  'How can you help me?',
  'What are your capabilities?',
  'Tell me about yourself'
];

function sanitizeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyInlineFormatting(text) {
  let escaped = sanitizeHtml(text);
  escaped = escaped.replace(/`([^`]+)`/g, (_, code) => `<code>${sanitizeHtml(code)}</code>`);
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return escaped;
}

function parseTableRow(line) {
  return line
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell, idx, arr) => !(idx === 0 && cell === '') && !(idx === arr.length - 1 && cell === ''));
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;
  let inList = false;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.replace(/```/, '').trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      const escaped = sanitizeHtml(codeLines.join('\n'));
      html.push(`<pre class="md-code"><code class="language-${sanitizeHtml(lang)}">${escaped}</code></pre>`);
      if (i < lines.length && /^```/.test(lines[i])) {
        i += 1;
      }
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      const item = line.replace(/^\s*[-*]\s+/, '');
      html.push(`<li>${applyInlineFormatting(item)}</li>`);
      i += 1;
      const next = lines[i] || '';
      if (!/^\s*[-*]\s+/.test(next)) {
        html.push('</ul>');
        inList = false;
      }
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*[:-]+\s*\|/.test(lines[i + 1] || '')) {
      const headerCells = parseTableRow(line).map((cell) => applyInlineFormatting(cell));
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(parseTableRow(lines[i]).map((cell) => applyInlineFormatting(cell)));
        i += 1;
      }
      const headerHtml = headerCells.map((cell) => `<th>${cell}</th>`).join('');
      const bodyHtml = rows
        .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<div class="md-table"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    if (inList) {
      html.push('</ul>');
      inList = false;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = applyInlineFormatting(headingMatch[2]);
      html.push(`<h${level}>${content}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      html.push('<div class="md-break"></div>');
      i += 1;
      continue;
    }

    html.push(`<p>${applyInlineFormatting(line)}</p>`);
    i += 1;
  }

  if (inList) {
    html.push('</ul>');
  }

  return html.join('');
}

function MarkdownContent({ content }) {
  const html = renderMarkdown(content || '');
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function useConversationManager() {
  const [token, setToken] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [initializing, setInitializing] = useState(true);

  const persistToken = (tok) => {
    localStorage.setItem('conversation_token', tok);
    const url = new URL(window.location.href);
    url.searchParams.set('token', tok);
    window.history.replaceState({}, '', url.toString());
  };

  const refreshConversations = async () => {
    const res = await fetch(`${API_BASE}/api/conversations`);
    const data = await res.json();
    setConversations(data.conversations || []);
    return data.conversations || [];
  };

  const loadConversation = async (tok) => {
    setLoading(true);
    setMessages([]);
    try {
      const res = await fetch(`${API_BASE}/api/conversation/${tok}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } finally {
      setLoading(false);
    }
  };

  const switchConversation = async (tok) => {
    if (!tok) return;
    setToken(tok);
    persistToken(tok);
    await loadConversation(tok);
  };

  const createConversation = async () => {
    const res = await fetch(`${API_BASE}/api/token`, { method: 'POST' });
    const data = await res.json();
    persistToken(data.token);
    setToken(data.token);
    await refreshConversations();
    await loadConversation(data.token);
    return data.token;
  };

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const params = new URLSearchParams(window.location.search);
      let initialToken = params.get('token') || localStorage.getItem('conversation_token');
      const existing = await refreshConversations();
      if (cancelled) return;
      let createdDuringInit = false;

      if (!initialToken) {
        if (existing.length > 0) {
          initialToken = existing[0].id;
          persistToken(initialToken);
        } else {
          initialToken = await createConversation();
          createdDuringInit = true;
          if (cancelled) return;
        }
      }

      if (!createdDuringInit) {
        await switchConversation(initialToken);
      }
      if (!cancelled) {
        setInitializing(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    token,
    messages,
    setMessages,
    loading,
    setLoading,
    conversations,
    refreshConversations,
    createConversation,
    switchConversation,
    initializing
  };
}

function Message({ role, content }) {
  const isAssistant = role === 'assistant';
  return (
    <div className={`message ${isAssistant ? 'assistant' : 'user'}`}>
      <div className="message-meta">{isAssistant ? 'Agent' : 'You'}</div>
      <div className="bubble">
        {isAssistant ? <MarkdownContent content={content} /> : <div className="plaintext">{content}</div>}
      </div>
    </div>
  );
}

function StarterPrompts({ onSelect }) {
  return (
    <div className="starter">
      <div className="starter-meta">
        <div className="agent-icon" aria-hidden="true">🤖</div>
        <div>
          <p className="starter-eyebrow">Kollmorgen Product Assistant</p>
          <h2>Hello! How can I help you today?</h2>
          <p className="starter-caption">Powered by your existing session token. Share this link to pick up where you left off.</p>
        </div>
      </div>
      <div className="starter-prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onSelect(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConversationList({ conversations, activeToken, onSelect, onNew }) {
  return (
    <aside className="chat-menu" aria-label="Chat sessions">
      <div className="chat-menu-header">
        <div>
          <p className="chat-menu-title">Chats</p>
          <p className="chat-menu-caption">Switch without sharing history</p>
        </div>
        <button type="button" className="new-chat" onClick={onNew}>
          + New Chat
        </button>
      </div>
      <div className="chat-menu-body">
        {conversations.length === 0 ? (
          <div className="chat-menu-empty">No chats yet</div>
        ) : (
          conversations.map((chat) => {
            const preview = chat.first_user_message || 'Empty chat';
            const timestamp = new Date(chat.last_active_at || chat.created_at).toLocaleString();
            return (
              <button
                key={chat.id}
                type="button"
                className={`chat-menu-item ${activeToken === chat.id ? 'active' : ''}`}
                onClick={() => onSelect(chat.id)}
              >
                <div className="chat-menu-primary">{preview}</div>
                <div className="chat-menu-meta">{timestamp}</div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

export default function App() {
  const {
    token,
    messages,
    setMessages,
    loading,
    setLoading,
    conversations,
    refreshConversations,
    createConversation,
    switchConversation,
    initializing
  } = useConversationManager();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [indexingStatus, setIndexingStatus] = useState({ state: 'idle', queue: [] });
  const chatRef = useRef(null);

  useEffect(() => {
    if (!chatRef.current) return;
    const el = chatRef.current;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!chatRef.current || !loading) return;
    const el = chatRef.current;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const res = await fetch(`${API_BASE}/api/indexing/status`);
        const data = await res.json();
        if (!cancelled) {
          setIndexingStatus(data);
        }
      } catch (err) {
        if (!cancelled) {
          setIndexingStatus((prev) => ({ ...prev, error: err.message }));
        }
      }
    }

    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleStarter = (prompt) => {
    sendMessage(prompt);
  };

  async function sendMessage(messageOverride) {
    const messageText = typeof messageOverride === 'string' ? messageOverride : input;
    if (!messageText.trim() || !token || initializing) return;
    setError('');
    const userMsg = { role: 'user', content: messageText, local: true };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, message: userMsg.content })
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || 'Chat failed');
        return;
      }
      const data = await res.json();
      setMessages((prev) => [...prev.slice(0, -1), userMsg, { role: 'assistant', content: data.reply }]);
      refreshConversations();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleSelectConversation = async (tok) => {
    if (!tok || tok === token) return;
    setError('');
    setInput('');
    await switchConversation(tok);
  };

  const handleNewChat = async () => {
    setError('');
    setInput('');
    await createConversation();
  };

  const showIndexing = indexingStatus.state === 'indexing' || (indexingStatus.queue || []).length > 0;
  const currentLabel = indexingStatus.currentFile === 'initial-scan' ? 'Preparing knowledge base' : indexingStatus.currentFile;

  return (
    <div className="app-shell">
      <div className="bg-glow glow-one" />
      <div className="bg-glow glow-two" />
      <div className="grid-overlay" aria-hidden="true" />

      <div className="app-content">
        <header className="hero">
          <div className="badge">Kollmorgen Product Assistant</div>
        </header>

        <main className="panel">
          <div className="panel-body">
            <ConversationList
              conversations={conversations}
              activeToken={token}
              onSelect={handleSelectConversation}
              onNew={handleNewChat}
            />

            <div className="chat-surface">
              <div className="indexing-status" role="status" aria-live="polite">
                {showIndexing ? (
                  <>
                    <span className="status-dot active" />
                    <div>
                      <div className="status-title">Indexing new documents…</div>
                      <div className="status-caption">
                        {currentLabel ? `Working on ${currentLabel}` : 'Queueing detected uploads'}
                        {indexingStatus.queue && indexingStatus.queue.length > 0
                          ? ` • Next: ${indexingStatus.queue.join(', ')}`
                          : ''}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="status-dot" />
                    <div>
                      <div className="status-title">Knowledge base ready</div>
                      <div className="status-caption">Watching for new PDFs in /files-for-uploading</div>
                    </div>
                  </>
                )}
              </div>
              <div className="chat-window" ref={chatRef} aria-live="polite">
                {initializing ? (
                  <div className="chat-loading">Loading chats…</div>
                ) : messages.length === 0 && !loading ? (
                  <StarterPrompts onSelect={handleStarter} />
                ) : (
                  <>
                    {messages.map((msg, idx) => (
                      <Message key={idx} role={msg.role} content={msg.content} />
                    ))}
                    {loading && (
                      <div className="message assistant">
                        <div className="typing">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    )}
                  </>
                )}
                {error && <div className="alert">{error}</div>}
              </div>

              <form className="chat-form" onSubmit={handleSubmit}>
                <div className="input-wrapper">
                  <textarea
                    value={input}
                    placeholder="Type your message here..."
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={!token || loading || initializing}
                    rows={2}
                  />
                </div>
              </form>
            </div>
          </div>
        </main>
      </div>

      <a
        className="github-link"
        href="https://github.com/UnoxyRich/chat"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View on GitHub"
      >
        <img src={githubMark} alt="GitHub" />
      </a>

      <Waves paused={false} />
    </div>
  );
}
