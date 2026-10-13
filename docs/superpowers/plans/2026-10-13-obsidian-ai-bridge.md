# Obsidian AI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the local Mavis AI assistant reach the existing Render-hosted VibeCode gateway through a separate token-protected, read-only endpoint.

**Architecture:** The local process keeps retrieval inside the Mavis vault and Bitrix snapshot index, sends only the user question plus bounded excerpts to a dedicated assistant-service endpoint, and renders the returned answer with local source citations. The endpoint accepts a new `MAVIS_OBSIDIAN_TOKEN`, never exposes Vibe credentials, and has input size, rate, and concurrency limits.

**Tech Stack:** Node/Express service on Render, Python 3 local Mavis AI, Obsidian local plugin.

## Global Constraints

- Bitrix24 remains read-only.
- The Vibe key stays only in Render environment variables; it is never returned to the local client.
- A dedicated random `MAVIS_OBSIDIAN_TOKEN` authenticates only the local bridge.
- Context is capped and contains no tokens, webhook URLs, or download URLs.

---

### Task 1: Add the protected Render endpoint

**Files:**
- Modify: `server.js`
- Test: `test/obsidian-chat.test.js`

**Interfaces:**
- Consumes: `POST /api/obsidian-chat`, `Authorization: Bearer <MAVIS_OBSIDIAN_TOKEN>`, JSON `{question, context, history}`.
- Produces: JSON `{ok, answer, facts, recommendations}`; no credentials or side effects.

- [ ] **Step 1: Write failing tests** for missing/wrong authorization, successful bounded request, and provider failure returning a safe error.
- [ ] **Step 2: Implement `obsidianChatAuthorized` and `POST /api/obsidian-chat`** with 900-character question maximum, 32 KiB context maximum, existing Vibe completion function, read-only system prompt, and existing rate/concurrency guard.
- [ ] **Step 3: Run the focused test file** and confirm the endpoint is covered.

### Task 2: Route local Mavis AI through the bridge

**Files:**
- Modify: `/Users/admin/MavisAI/mavis_ai.py`
- Modify: `/Users/admin/MavisAI/test_mavis_ai_archive.py`

**Interfaces:**
- Consumes: `MAVIS_OBSIDIAN_BRIDGE_URL`, `MAVIS_OBSIDIAN_TOKEN`; local search results.
- Produces: `run_agent(question)` answer with an `Источники:` section.

- [ ] **Step 1: Write a failing test** with a mocked bridge response that checks the local context is bounded and the answer retains local source paths.
- [ ] **Step 2: Implement bridge fallback** before direct Vibe access: gather at most six vault and six redacted Bitrix snippets, POST to the bridge with a 60-second timeout, and reject non-HTTPS bridge URLs.
- [ ] **Step 3: Run the local Mavis AI tests** and perform one live generic question through the bridge.

### Task 3: Configure, deploy, and verify

**Files:**
- Modify: local `/Users/admin/MavisAI/.env.local` (private, mode 600)
- Render environment: `MAVIS_OBSIDIAN_TOKEN`

- [ ] **Step 1: Generate one random bridge token** and set it only in the Render service and local private environment.
- [ ] **Step 2: Commit and push the service source** to `main`; Render auto-deploys the dashboard service.
- [ ] **Step 3: Confirm deployment success and make one generic source-cited request** from the local assistant.
- [ ] **Step 4: Enable the Obsidian plugin only after explicit in-product confirmation**, then submit the same generic query through the panel.
