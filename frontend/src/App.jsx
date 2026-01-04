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

function useConversation() {
  const [token, setToken] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [initializing, setInitializing] = useState(true);

  const persistToken = (tok) => {
    setToken(tok);
    localStorage.setItem('conversation_token', tok);
    const url = new URL(window.location.href);
    url.searchParams.set('token', tok);
    window.history.replaceState({}, '', url.toString());
  };

  const refreshConversations = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/conversations`);
      const data = await res.json();
      setConversations(data.conversations || []);
      return data.conversations || [];
    } catch (err) {
      console.error('Failed to load conversations', err);
      return [];
    }
  };

  async function loadConversation(tok) {
    setLoading(true);
    setMessages([]);
    try {
      const res = await fetch(`${API_BASE}/api/conversation/${tok}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } finally {
      setLoading(false);
    }
  }

  const createNewConversation = async () => {
    const res = await fetch(`${API_BASE}/api/token`, { method: 'POST' });
    const data = await res.json();
    persistToken(data.token);
    setMessages([]);
    await refreshConversations();
    return data.token;
  };

  const selectConversation = async (tok) => {
    if (!tok) return;
    persistToken(tok);
    await loadConversation(tok);
    await refreshConversations();
  };

  useEffect(() => {
    let cancelled = false;
    async function initToken() {
      try {
        const params = new URLSearchParams(window.location.search);
        const preferred = params.get('token') || localStorage.getItem('conversation_token');
        const currentList = await refreshConversations();
        let activeToken = preferred || (currentList[0] && currentList[0].id);
        if (!activeToken) {
          activeToken = await createNewConversation();
          await loadConversation(activeToken);
        } else {
          persistToken(activeToken);
          await loadConversation(activeToken);
          await refreshConversations();
        }
        persistToken(activeToken);
      } catch (err) {
        console.error('Failed to initialize conversation', err);
      } finally {
        if (!cancelled) {
          setInitializing(false);
        }
      }
    }
    initToken();
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
    loadConversation,
    conversations,
    refreshConversations,
    createNewConversation,
    selectConversation,
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

function formatTimestamp(ts) {
  if (!ts) return 'Just now';
  const date = new Date(ts);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function conversationPreview(conv) {
  const preview = conv.first_user_message || conv.last_message;
  if (!preview) return 'New conversation';
  return preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
}

function ConversationMenu({ conversations, activeToken, onSelect, onNew }) {
  return (
    <aside className="chat-menu">
      <div className="menu-header">
        <div>
          <p className="menu-label">Conversations</p>
          <p className="menu-hint">
            {conversations.length ? 'Select a chat to restore its context.' : 'Start a new chat to begin.'}
          </p>
        </div>
        <button type="button" className="new-chat-btn" onClick={onNew}>
          New Chat
        </button>
      </div>
      <div className="menu-list">
        {conversations.length === 0 ? (
          <div className="menu-empty">No chats yet. Start a new one to begin.</div>
        ) : (
          conversations.map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={`menu-item ${conv.id === activeToken ? 'active' : ''}`}
              onClick={() => onSelect(conv.id)}
            >
              <div className="menu-title">{conversationPreview(conv)}</div>
              <div className="menu-meta">
                <span className="menu-time">{formatTimestamp(conv.last_active_at || conv.created_at)}</span>
              </div>
            </button>
          ))
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
    loadConversation,
    conversations,
    refreshConversations,
    createNewConversation,
    selectConversation,
    initializing
  } = useConversation();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [indexingStatus, setIndexingStatus] = useState({ state: 'idle', queue: [] });
  const chatRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const hasMessage = input.trim().length > 0;

  useEffect(() => {
    if (!chatRef.current || !autoScroll) return;
    const el = chatRef.current;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, autoScroll]);

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
    if (!messageText.trim() || !token) return;
    setError('');
    const assistantId = `assistant-${Date.now()}`;
    const userMsg = { role: 'user', content: messageText, local: true };
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', streaming: true, id: assistantId }]);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, message: userMsg.content })
      });
      if (!res.ok) {
        const errText = await res.text();
        setError(errText || 'Chat failed');
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        return;
      }
      if (!res.body) {
        setError('No response body from server');
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      const isSse = contentType.includes('text/event-stream');
      const isJson = contentType.includes('application/json');
      const streamDebug = localStorage.getItem('stream_debug') === '1';

      const appendDelta = (delta) => {
        if (!delta) return;
        setMessages((prev) => {
          const updated = [...prev];
          const idx = updated.findIndex((m) => m.id === assistantId);
          if (idx !== -1) {
            const current = updated[idx];
            updated[idx] = {
              ...current,
              content: `${current.content || ''}${delta}`,
              streaming: true
            };
          }
          return updated;
        });
      };

      const finishStream = (sources = []) => {
        setMessages((prev) => {
          const updated = [...prev];
          const idx = updated.findIndex((m) => m.id === assistantId);
          if (idx !== -1) {
            updated[idx] = { ...updated[idx], streaming: false, sources };
          }
          return updated;
        });
        setLoading(false);
      };

      const handlePayload = (payload) => {
        if (!payload) return;
        if (streamDebug) {
          // eslint-disable-next-line no-console
          console.log('[stream][payload]', payload);
        }

        if (payload.type === 'token') {
          appendDelta(payload.token || '');
          return;
        }

        if (payload.type === 'response.output_text.delta') {
          appendDelta(payload.delta || '');
          return;
        }

        if (payload.delta && typeof payload.delta === 'string') {
          appendDelta(payload.delta);
          return;
        }

        if (payload.type === 'done' || payload.type === 'response.completed' || payload.type === 'response.finished') {
          finishStream(payload.sources || []);
          return;
        }

        if (payload.type === 'error') {
          setError(payload.message || 'Chat failed');
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          setLoading(false);
        }
      };

      if (isSse && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let parseFailed = false;

        const processChunk = (chunk, isFinal = false) => {
          const text = decoder.decode(chunk || new Uint8Array(), { stream: !isFinal });
          buffer += text;
          const lines = buffer.split('\n');
          if (!isFinal) {
            buffer = lines.pop();
          } else {
            buffer = '';
          }

          lines.forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return;
            const payloadText = trimmed.slice(5).trim();
            if (streamDebug) {
              // eslint-disable-next-line no-console
              console.log('[stream][raw]', payloadText);
            }
            if (payloadText === '[DONE]') {
              finishStream();
              return;
            }
            try {
              const payload = JSON.parse(payloadText);
              handlePayload(payload);
            } catch (err) {
              parseFailed = true;
              // eslint-disable-next-line no-console
              console.warn('Streaming parse failed; delivering partial content', payloadText, err);
            }
          });
        };

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          processChunk(value, done);
          if (done) break;
        }

        if (parseFailed) {
          setError((prev) => prev || 'Streaming interrupted; partial response shown');
          finishStream();
        }

        await refreshConversations();
        return;
      }

      // Non-streaming JSON response
      if (isJson) {
        const payload = await res.json();
        handlePayload(payload);
        finishStream(payload.sources || []);
        await refreshConversations();
        return;
      }

      // Fallback: attempt JSON parse from full text
      const text = await res.text();
      try {
        const payload = JSON.parse(text);
        handlePayload(payload);
        finishStream(payload.sources || []);
      } catch (err) {
        appendDelta(text);
        finishStream();
        setError((prev) => prev || 'Received non-JSON response; displayed raw text');
      }

      await refreshConversations();
    } catch (err) {
      setError(err.message);
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setLoading(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m))
      );
    }
  }

  const handleNewChat = async () => {
    const newToken = await createNewConversation();
    await loadConversation(newToken);
    setError('');
    setInput('');
    setAutoScroll(true);
  };

  const handleSelectChat = async (tok) => {
    if (!tok || tok === token) return;
    setError('');
    setInput('');
    setAutoScroll(true);
    await selectConversation(tok);
  };

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
          <div className="chat-layout">
            <ConversationMenu
              conversations={conversations}
              activeToken={token}
              onSelect={handleSelectChat}
              onNew={handleNewChat}
            />
            <div className="chat-column">
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
                    <div className="message assistant">
                      <div className="plaintext">Loading your chat…</div>
                    </div>
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
                      disabled={!token || loading}
                      rows={2}
                    />
                    <button
                      type="submit"
                      className={`send-button ${hasMessage && !loading ? 'active' : ''}`}
                      aria-label="Send message"
                      disabled={!token || loading || !hasMessage}
                    >
                      <span className="send-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" role="presentation">
                          <path
                            d="M3.5 9.5 15.8 4.2c.5-.2 1 .3.8.8L11 17.5c-.2.5-.9.5-1.1 0l-2-5-5-2c-.5-.2-.5-.9 0-1z"
                            fill="#000"
                          />
                        </svg>
                      </span>
                    </button>
                  </div>
                </form>
              </div>
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
