import React, { useEffect, useState, useRef } from 'react';

const API_BASE = '';

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
      <div className="meta">{isAssistant ? 'AI' : 'You'}</div>
      <div className="bubble">
        {isAssistant ? <MarkdownContent content={content} /> : <div className="plaintext">{content}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const { token, messages, setMessages, loading, setLoading } = useConversation();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const chatRef = useRef(null);

  useEffect(() => {
    if (!chatRef.current) return;
    const el = chatRef.current;
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 120;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading]);

  async function sendMessage(e) {
    e.preventDefault();
    if (!input.trim() || !token) return;
    setError('');
    const userMsg = { role: 'user', content: input, local: true };
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

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Kollmorgen Product Assistant</p>
          <h1>Technical chat with product knowledge</h1>
          <p className="subtitle">Token-based sessions. Share this link to continue on any device.</p>
        </div>
      </header>
      <main>
        <div className="chat" ref={chatRef}>
          {messages.map((msg, idx) => (
            <Message key={idx} role={msg.role} content={msg.content} />
          ))}
          {loading && <div className="status">Thinking…</div>}
          {error && <div className="error">{error}</div>}
        </div>
        <form className="input" onSubmit={sendMessage}>
          <div className="input-field">
            <textarea
              value={input}
              placeholder="Ask about products, integrations, or specifications"
              onChange={(e) => setInput(e.target.value)}
              disabled={!token || loading}
              rows={2}
            />
          </div>
          <button type="submit" disabled={!token || loading}>
            {loading ? 'Working…' : 'Send'}
          </button>
        </form>
      </main>
    </div>
  );
}
