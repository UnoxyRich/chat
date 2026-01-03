import React, { useEffect, useState, useRef } from 'react';

const API_BASE = '';

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
  return (
    <div className={`message ${role}`}>
      <div className="role">{role === 'assistant' ? 'AI' : 'You'}</div>
      <div className="bubble">{content}</div>
    </div>
  );
}

export default function App() {
  const { token, messages, setMessages, loading, setLoading } = useConversation();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const chatRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

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
      <header>
        <h1>Kollmorgen Product Assistant</h1>
        <p>Token-based session. Share the link to continue on another device.</p>
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
          <input
            type="text"
            value={input}
            placeholder="Ask about Kollmorgen products"
            onChange={(e) => setInput(e.target.value)}
            disabled={!token}
          />
          <button type="submit" disabled={!token || loading}>
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
