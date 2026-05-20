/**
 * agentqa — Headless QA automation tool for coding agents.
 *
 * Runs QA tasks against any URL using browser-harness (headless Chrome)
 * and an LLM (OpenAI/Anthropic) to generate and execute test scripts.
 *
 * Usage:
 *   agentqa run --url <URL> --prompt <PROMPT> [options]
 *   agentqa run <URL> <PROMPT>
 *   agentqa config
 *   agentqa config [options]
 *   agentqa app
 *
 * Options:
 *   --url        Target URL
 *   --prompt     QA task prompt
 *   --provider   API provider: openai | anthropic
 *   --api-key    API key (or set $QA_API_KEY env)
 *   --model      Model name
 *   --verbose    Print step progress to stderr
 *   --timeout    Max seconds (default: 120)
 *   --mode       Testing mode: text | vision (default: text)
 *   --json       Output result as JSON instead of text report
 *
 * Output:
 *   stdout: Text-based QA report (or JSON if --json is used)
 *   stderr: step progress (when --verbose)
 *   exit:   0 = pass, 1 = fail
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../core/settings";
import { runQaTask } from "../core/engine";
import type { AppSettings, ApiProvider } from "../shared/types";

// ─── Argument Parser ─────────────────────────────────────────────────────────

interface ParsedArgs {
  options: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--vision") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        options.vision = argv[++i];
      } else {
        options.vision = true;
      }
    } else if (
      (arg === "--url" ||
       arg === "--prompt" ||
       arg === "--provider" ||
       arg === "--api-key" ||
       arg === "--model" ||
       arg === "--timeout" ||
       arg === "--mode") &&
      i + 1 < argv.length
    ) {
      const key = arg.slice(2);
      options[key] = argv[++i];
    } else if (arg.startsWith("-")) {
      const key = arg.replace(/^-+/, "");
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        options[key] = argv[++i];
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { options, positionals };
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

// ─── Interactive Wizard & App Launcher Helpers ───────────────────────────────

async function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runConfigWizard(): Promise<void> {
  const current = loadSettings();
  log("=== AgentQA by Ali Sharjeel - Configuration Wizard ===");
  log("Press Enter to keep the current value.\n");

  const providerInput = await askQuestion(`API Provider (${current.apiProvider || "anthropic"}): `);
  let provider = current.apiProvider || "anthropic";
  if (providerInput) {
    const lower = providerInput.toLowerCase();
    if (lower === "openai" || lower === "anthropic") {
      provider = lower as ApiProvider;
    } else {
      log(`Warning: Unknown provider "${providerInput}". Defaulting to current: ${provider}`);
    }
  }

  const apiKeyPrompt = current.apiKey
    ? `API Key (currently ******${current.apiKey.slice(-4)}): `
    : "API Key: ";
  const apiKeyInput = await askQuestion(apiKeyPrompt);
  const apiKey = apiKeyInput || current.apiKey || "";

  const defaultModel = provider === "openai" ? "gpt-4.1-mini" : "claude-sonnet-4-20250514";
  const currentModel = current.model || defaultModel;
  const modelInput = await askQuestion(`Model (${currentModel}): `);
  const model = modelInput || currentModel;

  const currentVision = current.visionMode ? "on" : "off";
  const visionInput = await askQuestion(`Vision Mode (on/off) [${currentVision}]: `);
  let visionMode = current.visionMode || false;
  if (visionInput) {
    const lower = visionInput.toLowerCase();
    visionMode = lower === "on" || lower === "true" || lower === "yes" || lower === "1";
  }

  const updated: AppSettings = {
    apiProvider: provider,
    apiKey,
    apiBaseUrl: current.apiBaseUrl,
    model,
    visionMode
  };

  saveSettings(updated);
  log("\n✓ Configuration saved successfully!");
  console.log(JSON.stringify({
    apiProvider: provider,
    apiKey: apiKey ? "******" + apiKey.slice(-4) : "",
    model,
    visionMode
  }, null, 2));
  process.exit(0);
}

async function runElectronApp(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageRoot = path.resolve(__dirname, "../..");

  const mainBuiltPath = path.join(packageRoot, "out", "main", "index.js");
  if (!fs.existsSync(mainBuiltPath)) {
    log(`Error: Built app assets not found at ${mainBuiltPath}`);
    log("Please run 'npm run build' inside the installation directory first.");
    process.exit(1);
  }

  log("Resolving Electron binary...");
  try {
    const electronModule = await import("electron");
    const electronPath = electronModule.default || electronModule;
    
    if (typeof electronPath === "string" && fs.existsSync(electronPath)) {
      log("Launching AgentQA App...");
      const child = spawn(electronPath, [packageRoot], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      process.exit(0);
    } else {
      log(`Error: Resolved Electron path is not a valid file: ${electronPath}`);
      process.exit(1);
    }
  } catch (err) {
    log("Error: Could not import 'electron' package.");
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { options, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0] as string | undefined;

  const SUBCOMMANDS = new Set(["run", "config", "app", "help"]);

  if (!command && Object.keys(options).length === 0 || command === "help" || command === "--help" || options.help) {
    log(`\x1b[36m\x1b[1m    ___                         __  ____  ___  
   /   |  ____ ____  ____  / /_/ __ \\/   | 
  / /| | / __ \`/ _ \\/ __ \\/ __/ / / / /| | 
 / ___ |/ /_/ /  __/ / / / /_/ /_/ / ___ | 
/_/  |_|\\__, /\\___/_/ /_/\\__/\\___\\_/_/  |_|
       /____/                              \x1b[0m

agentqa by Ali Sharjeel — Headless QA automation for coding agents & CI/CD

USAGE:
  agentqa run --url <URL> --prompt <PROMPT> [options]
  agentqa run <URL> <PROMPT> [options]
  agentqa <URL> <PROMPT> [options]
  agentqa config [--provider <p>] [--api-key <k>] [--model <m>] [--vision <on|off>]
  agentqa app

SUBCOMMANDS:
  run          Execute a QA test (default subcommand)
  config       Interactive setup wizard or set configuration keys
  app          Launches the Electron Desktop App GUI
  help         Display this help message

OPTIONS:
  --url        Target URL to test
  --prompt     QA task description
  --provider   API provider: openai | anthropic (default: from settings)
  --api-key    API key (default: from settings or $QA_API_KEY)
  --model      Model name (default: from settings)
  --verbose    Print step progress to stderr
  --timeout    Max seconds per step (default: 120)
  --mode       Testing mode: text | vision (default: text)
  --json       Output result as JSON instead of text report

EXAMPLES:
  agentqa run https://google.com "Verify search works"
  agentqa config --api-key my-api-key --provider anthropic
  agentqa app
`);
    process.exit(0);
  }

  // Handle configuration subcommand
  if (command === "config") {
    const providerVal = options.provider || options.apiProvider;
    const apiKeyVal = options["api-key"] || options.apiKey;
    const modelVal = options.model;
    const visionVal = options.vision !== undefined ? options.vision : options.visionMode;

    const fileSettings = loadSettings();

    // Check if any CLI options were provided to config command
    if (providerVal || apiKeyVal || modelVal || visionVal !== undefined) {
      let visionMode: boolean | undefined;
      if (visionVal !== undefined) {
        if (typeof visionVal === "boolean") {
          visionMode = visionVal;
        } else {
          const s = String(visionVal).toLowerCase();
          visionMode = s === "on" || s === "true" || s === "yes" || s === "1";
        }
      }

      const updated: AppSettings = {
        ...fileSettings,
        apiProvider: (providerVal ? String(providerVal) : fileSettings.apiProvider) as ApiProvider,
        apiKey: apiKeyVal ? String(apiKeyVal) : fileSettings.apiKey,
        model: modelVal ? String(modelVal) : fileSettings.model,
        visionMode: visionMode !== undefined ? visionMode : fileSettings.visionMode
      };

      saveSettings(updated);
      log("✓ Configuration updated successfully!");
      console.log(JSON.stringify({
        apiProvider: updated.apiProvider,
        apiKey: updated.apiKey ? "******" + updated.apiKey.slice(-4) : "",
        model: updated.model,
        visionMode: updated.visionMode
      }, null, 2));
      process.exit(0);
    }

    // Run interactive wizard if no options were passed
    await runConfigWizard();
    return;
  }

  // Handle desktop app subcommand
  if (command === "app") {
    await runElectronApp();
    return;
  }

  // Handle test execution (implicit or explicit run)
  let url = options.url as string | undefined;
  let prompt = options.prompt as string | undefined;
  const verbose = Boolean(options.verbose);

  // If URL/prompt are not specified via flags, parse them from positionals
  const cleanPositionals = command === "run" ? positionals.slice(1) : positionals;

  const isUrl = (str: string) => /^(https?:\/\/|localhost|127\.0\.0\.1)/i.test(str) || (str.includes(".") && !str.includes(" "));

  if (cleanPositionals.length >= 2) {
    const pos1 = cleanPositionals[0];
    const pos2 = cleanPositionals[1];
    if (isUrl(pos1) && !isUrl(pos2)) {
      url = url || pos1;
      prompt = prompt || pos2;
    } else if (isUrl(pos2) && !isUrl(pos1)) {
      url = url || pos2;
      prompt = prompt || pos1;
    } else {
      url = url || pos1;
      prompt = prompt || pos2;
    }
  } else if (cleanPositionals.length === 1) {
    if (url && !prompt) {
      prompt = cleanPositionals[0];
    } else if (prompt && !url) {
      url = cleanPositionals[0];
    } else {
      if (isUrl(cleanPositionals[0])) {
        url = cleanPositionals[0];
      } else {
        prompt = cleanPositionals[0];
      }
    }
  }

  if (!url || !prompt) {
    log("Error: Target URL and QA prompt description are required.");
    log("Usage examples:");
    log("  agentqa https://example.com \"Verify signup page\"");
    log("  agentqa run --url https://example.com --prompt \"Verify signup page\"");
    process.exit(1);
  }

  // Merge settings: file defaults → env vars → CLI args
  const fileSettings = loadSettings();
  const settings: AppSettings = {
    apiProvider: (options.provider as ApiProvider) || (process.env.QA_API_PROVIDER as ApiProvider) || fileSettings.apiProvider || "anthropic",
    apiKey: (options["api-key"] as string) || process.env.QA_API_KEY || fileSettings.apiKey || "",
    apiBaseUrl: process.env.QA_API_URL || fileSettings.apiBaseUrl || "",
    model: (options.model as string) || process.env.QA_API_MODEL || fileSettings.model || "",
    visionMode: fileSettings.visionMode
  };

  if (!settings.apiKey) {
    log("Error: No API key found. Pass --api-key, set $QA_API_KEY, or run 'agentqa config' to configure.");
    process.exit(1);
  }

  const timeoutMs = options.timeout ? parseInt(options.timeout as string, 10) * 1000 : 120000;

  if (verbose) {
    log(`\n=========================================`);
    log(`   agentqa by Ali Sharjeel`);
    log(`=========================================`);
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
    visionMode: options.mode === "vision" || Boolean(options.vision) || settings.visionMode,
    onStep: verbose
      ? (event) => logStep(event.instruction, event.status, event.result || event.error)
      : undefined
  });

  const isJson = Boolean(options.json);

  if (isJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const r = result.report;
    if (r) {
      log("");
      process.stdout.write(`RESULT: ${r.result}\n`);
      process.stdout.write(`SCENARIO: ${r.scenario}\n`);
      process.stdout.write(`CONFIRMED BUGS: ${r.confirmedBugs?.join(", ") || "None"}\n`);
      process.stdout.write(`WARNINGS: ${r.warnings?.join(", ") || "None"}\n`);
      process.stdout.write(`STEPS EXECUTED: ${r.stepsExecuted?.join(", ") || "None"}\n`);
      process.stdout.write(`EVIDENCE: ${r.evidence?.join(", ") || "None"}\n`);
      process.stdout.write(`FINAL URL: ${r.finalUrl || "Unknown"}\n`);
      process.stdout.write(`SCREENSHOTS: ${r.screenshots?.join(", ") || "None"}\n`);
      process.stdout.write(`CONSOLE ERRORS: ${r.consoleErrors?.join(", ") || "None"}\n`);
      process.stdout.write(`FIX RECOMMENDATIONS: ${r.fixRecommendations?.join(", ") || "None"}\n`);
    } else {
      log("");
      process.stdout.write(`RESULT: ${result.ok ? "PASS" : "FAIL"}\n`);
      process.stdout.write(`SCENARIO: ${prompt}\n`);
      process.stdout.write(`SUMMARY: ${result.summary}\n`);
      if (result.error) process.stdout.write(`ERROR: ${result.error}\n`);
    }
  }

  if (verbose && !isJson) {
    log("");
    log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    log("");
  }

  const isPassed = result.ok && (!result.report || result.report.result === "PASS");
  process.exit(isPassed ? 0 : 1);
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
