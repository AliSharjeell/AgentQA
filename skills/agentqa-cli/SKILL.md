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

The CLI is located in the project's output directory. If it isn't built yet, you may need to build it:
```bash
npm run build:cli
```

To run a test, execute the CLI and capture its output:
```bash
node out/cli/index.js run --url <URL> --prompt "<YOUR_PROMPT>" --json
```

**Testing Modes:**
- `--mode text` (default): Tells the QA agent to skip visual verifications. Use this since you are a text-only LLM.
- `--mode vision`: Enforces visual/layout verifications. Only use this if you have multimodal capabilities.

### Prompt Engineering for QA
- Be specific about what actions to take. (e.g., "Login with user/pass, click the 'Add to Cart' button, and verify the cart count updates.")
- Ask the engine to look for specific bugs.

### Output Format
The CLI outputs **structured JSON** to `stdout`. 

Example output:
```json
{
  "ok": true,
  "summary": "Successfully logged in. No confirmed bugs found.",
  "steps": [...],
  "durationMs": 14200,
  "url": "http://localhost:3000",
  "error": null
}
```

If `ok` is `true`, the test passed. If `false`, the test failed or an error occurred. 
Read the `summary` field to understand the final result of the test.

## Example Execution

```bash
# Export the key (if not already in environment or .env)
export QA_API_KEY=sk-ant-12345

# Run the test
node out/cli/index.js run --url "http://localhost:3000" --prompt "Click the signup button, fill in a test email, and submit."
```
