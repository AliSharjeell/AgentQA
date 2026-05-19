# AgentQA

AI-powered QA testing tool that explores websites, fills forms, clicks buttons, and finds bugs — automatically. Available as a **desktop app** with live browser preview and as a **headless CLI** for coding agents.

---

## Two Interfaces, One Engine

| | Desktop App | CLI (`agentqa`) |
|---|---|---|
| **For** | Manual QA, demos, debugging | Coding agents, CI/CD pipelines |
| **Browser** | Embedded BrowserView (visible) | Headless Chrome (via browser-harness) |
| **Output** | Interactive UI with step progress | Structured JSON to stdout |
| **AI** | OpenAI / Anthropic (configurable) | Same — uses shared settings |

---

## Quick Start

### Prerequisites

- **Node.js 20+** and **npm 10+**
- **browser-harness** — `uv tool install git+https://github.com/browser-use/browser-harness`
- An API key for **OpenAI** or **Anthropic**

### Install

```bash
git clone https://github.com/AliSharjeell/AgentQA.git
cd AgentQA
npm install
```

### Desktop App

```bash
npm run dev
```

Opens an Electron window with a sidebar for tasks and a live browser preview. Configure your API key in **Settings**, then create a task with a URL and prompt.

### CLI (for Coding Agents)

```bash
# Build the CLI
npm run build:cli

# Run a QA task
node out/cli/index.js run \
  --url https://saucedemo.com \
  --prompt "Login with standard_user/secret_sauce, add 2 items to cart, complete checkout" \
  --api-key sk-ant-xxx \
  --verbose
```

---

## CLI Usage

```
agentqa run --url <URL> --prompt <PROMPT> [options]

Options:
  --url        Target URL to test (required)
  --prompt     QA task description (required)
  --provider   API provider: openai | anthropic (default: from settings)
  --api-key    API key (default: from settings or $QA_API_KEY)
  --model      Model name (default: from settings)
  --verbose    Print step progress to stderr
  --timeout    Max seconds (default: 120)
```

### Output Format

**stdout** — structured JSON for agent consumption:

```json
{
  "ok": true,
  "summary": "Successfully logged in, added 2 items, completed checkout. No confirmed bugs found.",
  "steps": [
    { "instruction": "Open login page", "status": "done", "result": "Loaded https://saucedemo.com" },
    { "instruction": "Enter credentials", "status": "done", "result": "Filled username and password" },
    { "instruction": "Submit login", "status": "done", "result": "Now at /inventory.html" },
    { "instruction": "Add products to cart", "status": "done", "result": "Added 2 items" },
    { "instruction": "Complete checkout", "status": "done", "result": "Order confirmed" }
  ],
  "durationMs": 14200,
  "url": "https://saucedemo.com",
  "error": null
}
```

**Exit codes:** `0` = pass, `1` = fail.

### Agent Integration Example

```bash
# Use with environment variable
export QA_API_KEY=sk-ant-xxx

# Pipe result to jq
result=$(node out/cli/index.js run --url https://staging.myapp.com --prompt "Test the signup form")
echo $result | jq '.ok'

# In a CI script
if node out/cli/index.js run --url "$PREVIEW_URL" --prompt "Verify login and dashboard"; then
  echo "QA passed"
else
  echo "QA failed"
fi
```

---

## Project Structure

```
src/
├── core/                    # Shared engine (no Electron dependency)
│   ├── settings.ts          # Load/save settings.json
│   ├── api.ts               # OpenAI / Anthropic LLM callers
│   ├── prompt.ts            # LLM prompt template for browser automation
│   ├── harness.ts           # browser-harness spawner + set_value preamble
│   └── engine.ts            # Orchestrator: observe → LLM → act → retry
├── cli/                     # Headless CLI frontend
│   └── index.ts             # Arg parser, runner, JSON output
├── main/                    # Electron desktop app (main process)
│   ├── index.ts             # Window, BrowserView, IPC registration
│   └── db/
│       └── qaTaskRepo.ts    # Task + report JSON storage
├── preload/                 # Context bridge (renderer ↔ main)
│   └── index.ts
├── renderer/                # React frontend
│   ├── index.html
│   └── src/
│       ├── main.tsx         # React entry point
│       ├── App.tsx          # Sidebar nav + page router
│       ├── styles.css       # Tailwind + design system
│       └── pages/           # UI pages (Dashboard, Settings, etc.)
├── shared/                  # Types shared across all targets
│   └── types.ts
scripts/
└── build-cli.mjs            # esbuild bundler for CLI
```

---

## How It Works

1. **Observe** — Scrapes the page DOM for interactive elements (buttons, inputs, links) with coordinates
2. **Plan** — Sends the DOM observation + user prompt to an LLM (Claude/GPT) which generates a Python browser-harness script
3. **Act** — Pipes the script to `browser-harness` which controls Chrome via CDP (fills forms, clicks buttons, navigates)
4. **Retry** — If the script fails, retries up to 3 times with the error context
5. **Report** — Returns structured results with pass/fail, step details, and a summary

### Key Design Decisions

- **`set_value()` over `fill_input()`** — Uses JavaScript to set input values (via prototype descriptor + event dispatch) instead of CDP key events, which avoids double-typing in Electron's BrowserView
- **No browser bundled** — Uses `browser-harness` which manages its own Chrome daemon. No Playwright browser download required
- **Shared engine** — `src/core/` has zero Electron imports, so it works in both the desktop app and headless CLI

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electron 34 |
| Build tool | electron-vite 3 + esbuild (CLI) |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS 3 |
| Icons | Lucide React |
| Browser automation | browser-harness (CDP) |
| AI | Anthropic Claude / OpenAI GPT |
| Language | TypeScript 5 (ES2022) |

---

## Available Scripts

```bash
npm run dev          # Desktop app with HMR
npm run build        # Production build (desktop)
npm run build:cli    # Bundle CLI to out/cli/index.js
npm run typecheck    # TypeScript check (full project)
npm run typecheck:cli  # TypeScript check (CLI only)
npm run start        # Preview production build
```

---

## Configuration

Settings are stored in `%APPDATA%/agentqa/settings.json` (shared between desktop and CLI):

```json
{
  "apiProvider": "anthropic",
  "apiKey": "sk-ant-xxx",
  "apiBaseUrl": "",
  "model": "claude-sonnet-4-20250514"
}
```

The CLI also accepts settings via command-line flags and environment variables. You can create a `.env` file or export them directly in your shell:

```bash
QA_API_PROVIDER=anthropic
QA_API_KEY=sk-ant-xxx
QA_API_MODEL=claude-3-5-sonnet-20241022
QA_API_URL=https://api.anthropic.com
```

*Note: In Node.js 20+, you can load a `.env` file natively using `node --env-file=.env out/cli/index.js run ...`*

---

## QA Agent Rules

The AI agent follows these rules when testing:

- Never report a bug unless verified twice after waiting, scrolling, and checking the correct page
- If no bugs are found, say **"No confirmed bugs found"** — never invent issues
- If navigation fails or URL becomes `chrome-error://chromewebdata`, mark as **infrastructure failure**, not a website bug
- Use `set_value()` for all form inputs (React/Vue compatible)
- Wrap all scripts in try/except with structured error output

---

## Troubleshooting

### "Browser-harness could not be started"

Install it: `uv tool install git+https://github.com/browser-use/browser-harness`

### Double-typing in form fields

This was fixed by using `set_value()` (JavaScript-based) instead of `fill_input()` (CDP key events). If you see it, make sure you're on the latest build.

### CLI returns "No API key found"

Pass `--api-key`, set `$QA_API_KEY`, or save your key in the desktop app's Settings page.

### Desktop app shows loading bar when page is already loaded

Fixed — the app now skips `loadURL()` if the preview is already on the target URL.

---

## License

MIT