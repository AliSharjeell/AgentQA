#!/usr/bin/env node
/**
 * qa-cli — Headless QA automation tool for coding agents.
 *
 * Runs QA tasks against any URL using browser-harness (headless Chrome)
 * and an LLM (OpenAI/Anthropic) to generate and execute test scripts.
 *
 * Usage:
 *   qa-cli run --url <URL> --prompt <PROMPT> [options]
 *
 * Options:
 *   --url        Target URL (required)
 *   --prompt     QA task prompt (required)
 *   --provider   API provider: openai | anthropic
 *   --api-key    API key (or set $QA_API_KEY env)
 *   --model      Model name
 *   --verbose    Print step progress to stderr
 *   --timeout    Max seconds (default: 120)
 *
 * Output:
 *   stdout: JSON { ok, summary, steps[], durationMs, url, error }
 *   stderr: step progress (when --verbose)
 *   exit:   0 = pass, 1 = fail
 */
import { loadSettings } from "../core/settings";
import { runQaTask } from "../core/engine";
import type { AppSettings, ApiProvider } from "../shared/types";

// ─── Argument Parser ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verbose") {
      result.verbose = true;
    } else if (arg.startsWith("--") && i + 1 < argv.length) {
      const key = arg.slice(2);
      result[key] = argv[++i];
    } else if (!result._command) {
      result._command = arg;
    }
  }
  return result;
}

// ─── Logging Helpers ─────────────────────────────────────────────────────────

function log(message: string): void {
  process.stderr.write(message + "\n");
}

function logStep(instruction: string, status: string, detail?: string): void {
  const icon = status === "done" ? "✓" : status === "failed" ? "✗" : "⋯";
  const suffix = detail ? ` — ${detail}` : "";
  log(`  ${icon} ${instruction}${suffix}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._command as string | undefined;

  if (!command || command === "help" || command === "--help") {
    log(`
qa-cli — Headless QA automation for coding agents

USAGE:
  qa-cli run --url <URL> --prompt <PROMPT> [options]

OPTIONS:
  --url        Target URL to test (required)
  --prompt     QA task description (required)
  --provider   API provider: openai | anthropic (default: from settings)
  --api-key    API key (default: from settings or $QA_API_KEY)
  --model      Model name (default: from settings)
  --verbose    Print step progress to stderr
  --timeout    Max seconds per step (default: 120)

OUTPUT:
  stdout → JSON { ok, summary, steps[], durationMs, url, error }
  exit 0 = pass, exit 1 = fail
`);
    process.exit(0);
  }

  if (command !== "run") {
    log(`Unknown command: ${command}. Use "qa-cli run --url <URL> --prompt <PROMPT>".`);
    process.exit(1);
  }

  const url = args.url as string | undefined;
  const prompt = args.prompt as string | undefined;
  const verbose = Boolean(args.verbose);

  if (!url || !prompt) {
    log("Error: --url and --prompt are required.");
    log('Usage: qa-cli run --url <URL> --prompt "<PROMPT>"');
    process.exit(1);
  }

  // Merge settings: file defaults → env vars → CLI args
  const fileSettings = loadSettings();
  const settings: AppSettings = {
    apiProvider: (args.provider as ApiProvider) || fileSettings.apiProvider || "anthropic",
    apiKey: (args["api-key"] as string) || process.env.QA_API_KEY || fileSettings.apiKey || "",
    apiBaseUrl: fileSettings.apiBaseUrl || "",
    model: (args.model as string) || fileSettings.model || ""
  };

  if (!settings.apiKey) {
    log("Error: No API key found. Pass --api-key, set $QA_API_KEY, or save in desktop app settings.");
    process.exit(1);
  }

  const timeoutMs = args.timeout ? parseInt(args.timeout as string, 10) * 1000 : 120000;

  if (verbose) {
    log(`\n🔍 QA Agent — ${url}`);
    log(`   Prompt: ${prompt}`);
    log(`   Provider: ${settings.apiProvider} / ${settings.model || "(default)"}`);
    log("");
  }

  const result = await runQaTask({
    targetUrl: url,
    prompt,
    settings,
    timeoutMs,
    onStep: verbose
      ? (event) => logStep(event.instruction, event.status, event.result || event.error)
      : undefined
  });

  // Output JSON result to stdout
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (verbose) {
    log("");
    log(result.ok ? "✅ PASS" : "❌ FAIL");
    log(`   ${result.summary}`);
    log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.error) log(`   Error: ${result.error}`);
    log("");
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.stdout.write(JSON.stringify({
    ok: false,
    summary: "CLI crashed.",
    steps: [],
    durationMs: 0,
    url: "",
    error: message
  }, null, 2) + "\n");
  process.exit(1);
});
