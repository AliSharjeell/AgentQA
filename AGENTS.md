# AGENTS.md — AI Agent Guide to AgentQA

This document explains the project structure, conventions, and patterns for AI agents working on or using this codebase.

---

## Project Overview

**AgentQA** is a dual-interface QA automation tool:
1. **Desktop App**: An Electron/React GUI for manual QA testing, debugging, and live browser previews.
2. **Headless CLI (`agentqa`)**: A terminal tool designed specifically for coding agents and CI/CD pipelines to run QA tasks and receive structured JSON output.

Under the hood, AgentQA uses `browser-harness` (a CDP-based browser automation daemon) and an LLM (Anthropic or OpenAI) to dynamically generate Python scripts that navigate websites, fill forms, and verify state.

---

## Repository Structure

```
src/
├── core/                   # Shared business logic (NO Electron dependencies)
│   ├── api.ts              # LLM callers (fetch)
│   ├── engine.ts           # The observe → plan → act → retry loop
│   ├── harness.ts          # Spawns browser-harness and parses output
│   ├── prompt.ts           # The LLM prompt template
│   └── settings.ts         # JSON file persistence (for %APPDATA%/agentqa/)
│
├── cli/                    # Headless Node.js CLI frontend
│   └── index.ts            # Parses args, calls engine.ts, outputs JSON
│
├── main/                   # Electron Main Process (Desktop App)
│   ├── index.ts            # Window creation, IPC handlers
│   └── db/                 # Task and report persistence (JSON)
│
├── preload/                # Context Bridge (Electron)
│   └── index.ts            # Exposes API to React renderer
│
├── renderer/               # React Frontend (Desktop App)
│   └── src/
│       ├── App.tsx         # Sidebar and navigation
│       ├── pages/          # UI pages
│       └── styles.css      # Tailwind CSS / Design System
│
└── shared/                 # Types shared across ALL environments
    └── types.ts            
```

---

## Architecture Rules

### 1. The `core` directory is Sacred
- Files in `src/core/` **MUST NOT** import from `electron`.
- `core` contains the actual QA engine and is shared between the Node CLI and the Electron Main process.
- All dependencies in `core` must be standard Node built-ins (`node:fs`, `node:child_process`) or standard web APIs (`fetch`).

### 2. Browser Automation Paradigm
- We **do not** use Playwright or Puppeteer.
- We use **browser-harness**, an external Python daemon.
- When generating scripts for browser-harness, we use **JavaScript-based form injection** via a provided `set_value(selector, text)` helper. 
- **NEVER** use CDP key events (`fill_input()`) for forms, as it causes double-typing bugs in Electron's BrowserView.

### 3. IPC Communication (Desktop)
- The React renderer NEVER calls Electron directly.
- Uses `contextBridge` in `preload/index.ts`.
- The CLI does not use IPC; it runs directly in Node.

---

## AgentQA CLI for Coding Agents

If you are an AI coding agent operating in a terminal, you can use the global `agentqa` CLI to verify your own code changes!

### Installation
Install the CLI globally:
```bash
npm install -g @alisharjeel/agentqa
```

### Usage
```bash
# Direct run
agentqa http://localhost:3000 "Test the signup flow" --verbose

# Explicit subcommand run
agentqa run http://localhost:3000 "Verify layout" --mode vision
```

### Configuration
Configure settings interactively or directly:
```bash
# Run the configuration wizard
agentqa config

# Set configuration options directly
agentqa config --api-key sk-xxxx --provider anthropic --model "Opus 4.7" --vision off
```

The settings are persisted in `%APPDATA%/agentqa/settings.json`. You can also override configuration via environment variables:
- `QA_API_PROVIDER` (anthropic | openai)
- `QA_API_KEY`
- `QA_API_MODEL`

### Output
The CLI outputs structured JSON to `stdout` and human-readable progress to `stderr` (if `--verbose` is used).

```json
{
  "ok": true,
  "summary": "No confirmed bugs found.",
  "steps": [],
  "durationMs": 15000,
  "url": "http://localhost:3000",
  "error": null
}
```

---

## Contribution Guidelines

- **TypeScript**: Target `ES2022`, module resolution `Bundler`.
- **Formatting**: We use `eslint` and `prettier`. 
- **Commits**: Follow Conventional Commits (`feat:`, `fix:`, `refactor:`).
- **CSS**: Tailwind v3 is used in the frontend. Do not add arbitrary CSS files; use Tailwind utility classes or add to `styles.css` using `@apply`.