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

  useEffect(() => {
    async function initToken() {
      const params = new URLSearchParams(window.location.search);
      const existing = params.get('token') || localStorage.getItem('conversation_token');
      if (existing) {
        setToken(existing);
        await loadConversation(existing);
        return;
      }
      const res = await fetch(`${API_BASE}/api/token`, { method: 'POST' });
      const data = await res.json();
      setToken(data.token);
      localStorage.setItem('conversation_token', data.token);
      const url = new URL(window.location.href);
      url.searchParams.set('token', data.token);
      window.history.replaceState({}, '', url.toString());
    }
    initToken();
  }, []);

  async function loadConversation(tok) {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/conversation/${tok}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } finally {
      setLoading(false);
    }
  }

  return { token, messages, setMessages, loading, setLoading, loadConversation };
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

export default function App() {
  const { token, messages, setMessages, loading, setLoading } = useConversation();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [indexingStatus, setIndexingStatus] = useState({ state: 'indexing' });
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

  const handleScroll = () => {
    if (!chatRef.current) return;
    const el = chatRef.current;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 80);
  };

  const showIndexing = indexingStatus.state === 'indexing';
  const isError = indexingStatus.state === 'error';
  const currentLabel = indexingStatus.currentFile;

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
          <div className="chat-surface">
            <div className="indexing-status" role="status" aria-live="polite">
              {showIndexing ? (
                <>
                  <span className="status-dot active" />
                  <div>
                    <div className="status-title">Indexing documents…</div>
                    <div className="status-caption">
                      {currentLabel ? `Building: ${currentLabel}` : 'Rebuilding knowledge base at startup'}
                    </div>
                  </div>
                </>
              ) : isError ? (
                <>
                  <span className="status-dot" />
                  <div>
                    <div className="status-title">Knowledge base unavailable</div>
                    <div className="status-caption">
                      {indexingStatus.error || 'No documents were successfully indexed. Add PDFs and restart.'}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <span className="status-dot" />
                  <div>
                    <div className="status-title">Knowledge base ready</div>
                    <div className="status-caption">
                      {`Indexed ${indexingStatus.processedFiles || 0} files (${indexingStatus.totalChunks || 0} chunks)`}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="chat-window" ref={chatRef} aria-live="polite" onScroll={handleScroll}>
              {messages.length === 0 && !loading ? (
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
