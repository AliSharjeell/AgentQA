---
name: agentqa-cli
description: Run automated QA tests against web apps using the AgentQA headless CLI tool. It navigates to a URL, performs the requested prompt, and returns structured test results.
---

# AgentQA CLI Skill

This skill allows you (the AI Agent) to run automated, headless QA tests on web applications using the `agentqa` CLI. This is incredibly useful for verifying your own code changes!

## When to use this skill
- After you implement a new feature, to verify the UI works.
- After fixing a bug, to ensure the bug is resolved.
- When the user asks you to "test the app" or "QA the site".
- When you want to verify that a web application is running and functional.

## Prerequisites

The CLI requires an API key for Anthropic or OpenAI to power its own reasoning engine. Ensure the following environment variables are available, or ask the user to provide them:
- `QA_API_KEY` (Required)
- `QA_API_PROVIDER` (Optional, defaults to `anthropic`)
- `QA_API_MODEL` (Optional)

## How to use the CLI

The CLI is registered globally as `agentqa` after a global installation. If running from the repository source, you can build and use the compiled index:

```bash
# Global install (recommended)
npm install -g @alisharjeel/agentqa

# Or run from source
npm run build:cli
node out/cli/index.js <URL> <PROMPT>
```

### Subcommands & Syntax

1. **Run a QA test (Implicit or Explicit `run`)**
   ```bash
   # Direct implicit syntax (recommended)
   agentqa https://example.com "Test the user login" --verbose
   
   # Explicit run subcommand syntax
   agentqa run https://example.com "Test the user login" --json
   ```

2. **Manage Configuration (`config`)**
   Launches an interactive wizard to configure settings, or directly sets settings:
   ```bash
   # Interactive setup
   agentqa config
   
   # Direct configuration
   agentqa config --api-key sk-xxxx --provider anthropic --model "Opus 4.7" --vision off
   ```

3. **Launch Desktop App (`app`)**
   Spawns the Electron Desktop app GUI directly from the CLI:
   ```bash
   agentqa app
   ```

### Testing Options
- `--url`: Target URL to test.
- `--prompt`: QA task description.
- `--provider`: API provider (`openai` | `anthropic`).
- `--api-key`: API key override.
- `--model`: Model override.
- `--verbose`: Prints step-by-step stdout/stderr progress.
- `--mode`: Testing mode (`text` | `vision`), defaults to `text`.
- `--json`: Output final result as JSON to stdout instead of text report.

### Output Format
The CLI outputs **structured JSON** to `stdout` for agent or pipeline parsing:
```json
{
  "ok": true,
  "summary": "No confirmed bugs found.",
  "steps": [...],
  "durationMs": 15000,
  "url": "https://example.com",
  "error": null
}
```

## Example Execution
```bash
# Setup your credentials
agentqa config --api-key sk-ant-12345 --provider anthropic

# Execute a test
agentqa https://practicetestautomation.com/practice-test-login/ "Test valid login with student/Password123" --verbose
```
