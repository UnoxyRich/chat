# Product Inquiry AI Chat System

A production-grade, browser-based AI chat system for answering **product inquiries** using **PDF-based knowledge**, **local LLM inference**, and **retrieval-augmented generation (RAG)**.

This project is designed to be:
- Privacy-controlled
- Locally hosted
- Maintainable
- Production-ready

---

## ✨ Features

- AI chat interface in the browser
- RAG over product PDFs
- Mixed-language document support
- Local inference via LM Studio
- Persistent conversations across devices (no login)
- Adaptive conversational tone
- Full interaction logging (chat, IP, device, RAG trace)

---

## 🧠 Architecture Overview

Browser (React + Vite)
↓
Backend API
↓
RAG Pipeline
↓
LM Studio (Chat + Embeddings)
↓
Local Database (Logs & Conversations)

yaml
Copy code

---

## 📁 Project Structure

/frontend # React + Vite UI
/backend # API server & orchestration
/rag # Embedding & retrieval logic
/db # Database files
/logs # Optional raw logs
/files-for-sharing # Product PDFs
/SystemPromt.txt # Hard system instruction

yaml
Copy code

---

## 📄 Knowledge Base

- All product descriptions live in `files-for-sharing/`
- Supported format: **PDF**
- Supported languages: **any**
- Documents are indexed using embeddings
- Retrieval results are injected into the AI context

---

## 🧾 System Prompt

`SystemPromt.txt` defines **hard behavioral rules** for the AI.

It:
- Is injected as a system message
- Overrides user input
- Overrides retrieved document context
- Cannot be bypassed

---

## 🔐 Conversation Persistence

- No user accounts
- No passwords
- No login
- Conversations persist using **secure magic link / token**
- Same token = same conversation across devices

---

## 🗃 Logging & Data Retention

The system logs all interactions, including:
- User messages
- AI responses
- Timestamps
- IP addresses
- Device/user-agent info
- Conversation tokens
- Retrieved document references

Logs are:
- Append-only
- Stored locally
- Kept forever

---

## 🚀 Running the Project (High Level)

1. Ensure LM Studio is installed and running
2. Place PDFs into `files-for-sharing/`
3. Start backend server
4. Start frontend
5. Open the browser UI and chat

(Exact commands depend on implementation details.)

---

## ⚠️ Important Notes

- This system is intended for **production use**
- There is no privacy notice by design
- All chats are logged
- Local inference ensures full data control

---

## 📌 Non-Goals

This project intentionally does **not** include:
- User accounts
- Authentication systems
- Cloud dependencies
- External vector databases
- Analytics dashboards

---

## 📄 License

To be defined by the project owner.