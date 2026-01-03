# Agent Instructions — Product Inquiry AI Chat System

You are an autonomous **senior full-stack AI engineer** responsible for designing and implementing this project end-to-end.

This document is a **binding instruction contract**.  
You must follow it exactly.  
If anything is ambiguous, you MUST ask the user before proceeding.

---

## 1. Core Objective

Build a **production-grade browser-based AI chat system** for **product inquiries**, powered by:

- Retrieval-Augmented Generation (RAG)
- PDF-based knowledge base
- Local inference via LM Studio
- Persistent conversations across devices (no login)
- Full chat and metadata logging
- React + Vite frontend
- Simple, maintainable backend

---

## 2. Absolute Rules (Non-Negotiable)

### 2.1 System Prompt Priority
- `SystemPromt.txt` MUST be loaded at startup
- It MUST be injected as a **hard system message**
- It has the **highest priority**:
  - overrides user messages
  - overrides RAG context
  - overrides model defaults
- Nothing may contradict it

### 2.2 No Silent Assumptions
- If a design decision is unclear → ask the user
- If you must choose → document the choice explicitly

### 2.3 Production Mindset
- Deterministic startup order
- Clear error handling
- Persistent storage
- Maintainable folder structure

---

## 3. Knowledge Base & RAG

### Source Documents
- Location: `files-for-sharing/`
- Format: PDF only
- Language: mixed (any language)

### RAG Behavior
- Use embeddings for retrieval
- Allow general reasoning
- Answers MUST comply with `SystemPromt.txt`
- If information is missing:
  - ask follow-up questions
  - do not hallucinate

### Embeddings
- Use LM Studio–available embedding models
- Generate embeddings once
- Persist locally
- Reload on restart
- Support incremental re-indexing when PDFs change

---

## 4. LM Studio Integration

- Use LM Studio’s **OpenAI-compatible HTTP API**
- Automatically detect available models if possible
- Use:
  - one model for chat/reasoning
  - one model for embeddings (can be same or different)
- Fail clearly if LM Studio is not running

---

## 5. Chat System

### Frontend
- Framework: React + Vite
- UI structure: based on `refrence.mhtml`
- Browser-based chat interface
- Streaming responses if feasible

### Tone & Behavior
- Adaptive tone:
  - mirrors user tone
  - adapts to user role (customer, technical, decision-maker)
- When unsure:
  - ask follow-up questions

---

## 6. Persistence Across Devices (No Login)

Implement **magic link / token-based persistence**:

- Generate a secure conversation token
- Store token server-side
- Allow reuse across devices via link
- No accounts
- No passwords
- No authentication UI

Document clearly:
- token lifecycle
- uniqueness guarantees
- collision handling

---

## 7. Logging & Database

### Storage
- Use the simplest production-safe local option
- Prefer SQLite or equivalent

### Log Everything (Append-Only)
For each interaction:
- user message
- AI response
- timestamp
- IP address
- device / user-agent
- conversation token
- retrieved document references (RAG trace)

### Retention
- Keep forever
- No pruning
- No anonymization

(No privacy notice required.)

---

## 8. Backend Responsibilities

- Serve frontend
- Handle chat requests
- Call LM Studio
- Run RAG pipeline
- Enforce SystemPromt.txt
- Persist logs and conversations

Use clean API boundaries.

---
## 9. Required Folder Structure

You MUST enforce a clear separation of concerns:

/frontend
/backend
/rag
/db
/logs
/files-for-sharing
/SystemPromt.txt

yaml
Copy code

Do not mix responsibilities.

---

## 10. Mandatory Startup Order

1. Load `SystemPromt.txt`
2. Verify LM Studio connectivity
3. Load or generate embeddings
4. Initialize database
5. Start backend server
6. Serve frontend

Fail fast if any step fails.

---

## 11. Non-Goals (Do Not Add)

- No user accounts
- No OAuth
- No analytics dashboards
- No cloud services
- No external vector databases
- No privacy banners

---

## 12. Before Writing Any Code

You MUST:
1. Summarize the architecture you plan to build
2. List chosen chat and embedding models
3. Explain token persistence strategy
4. Confirm database choice

Wait for explicit user approval before implementation.