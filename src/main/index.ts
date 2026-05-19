/**
 * Main process for QA Automation AI.
 *
 * ## Architecture
 *
 * Main Window (Electron BrowserWindow)
 * ├── React Renderer → Task UI, Chat, Reports
 * └── WebContentsView → Live Browser Preview (target URL)
 *
 * Renderer ──IPC──► Main Process
 *   window.qaApi.*       ipcMain.handle()
 *   window.qaApi.onXxx() ipcMain.on() / webContents.send()
 *
 * ## Browser-Use Integration
 *
 * QA Agent (browser-use) runs in its own Playwright browser instance:
 * - Each task gets a fresh headless/headed Chromium browser
 * - Agent uses AI (Claude/OpenAI) to plan and execute steps
 * - Screenshots captured per step and saved to userData/screenshots/
 * - Progress emitted to renderer via IPC events
 *
 * ## Data Storage
 *
 * JSON files in app.getPath("userData"):
 * - qa-tasks-store.json  → QA tasks + reports (qaTaskRepo)
 * - settings.json        → user preferences (AppSettings)
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  dialog,
  ipcMain,
  shell,
  session
} from "electron";
import type {
  AppSettings,
  AppStatus,
  AppProgressEvent,
  BrowserState,
  NavigateInput,
  QaTask,
  QaTaskInput,
  QaTaskUpdate,
  QaReport,
  TaskStatus,
  TaskStepStatus
} from "../shared/types";
import {
  listTasks,
  createTask,
  getTaskById,
  updateTask,
  deleteTask,
  setTaskSteps,
  updateStepStatus,
  attachReport,
  getTaskReport,
  generateId
} from "./db/qaTaskRepo";

const PREVIEW_DEBUG_PORT = 9223;

// ─── Browser-Use Agent ───────────────────────────────────────────────────────

async function runBrowserHarnessTask(task: QaTask): Promise<boolean> {
  const steps: QaTask["steps"] = [];
  const startTime = new Date().toISOString();

  const addStep = (instruction: string, status: TaskStepStatus, result?: string, error?: string): void => {
    steps.push({
      id: generateId(),
      order: steps.length + 1,
      instruction,
      status,
      result,
      error,
      timestamp: new Date().toISOString()
    });
    setTaskSteps(task.id, [...steps]);
  };

  try {
    emitProgress({ type: "task_progress", taskId: task.id, message: "Running browser-harness in preview..." });
    const settings = loadSettings();
    const harnessResult = await runBrowserHarnessAgent(task, settings, (event) => {
      if (event.status === "running") {
        // Auto-complete any previous running step
        const lastStep = steps[steps.length - 1];
        if (lastStep && lastStep.status === "running" && lastStep.instruction !== event.instruction) {
          lastStep.status = "done";
          lastStep.timestamp = new Date().toISOString();
        }

        // Check if a step with this instruction already exists in running state
        const existing = steps.find(s => s.instruction === event.instruction && s.status === "running");
        if (!existing) {
          addStep(event.instruction, "running");
        }
        return;
      }

      // Find the step with the matching instruction (search backwards)
      const matchingStep = [...steps].reverse().find(s => s.instruction === event.instruction);
      if (matchingStep) {
        matchingStep.status = event.status;
        matchingStep.result = event.result;
        matchingStep.error = event.error;
        matchingStep.timestamp = new Date().toISOString();
        setTaskSteps(task.id, [...steps]);
      } else {
        // Fallback: update the last step if it is running
        const lastStep = steps[steps.length - 1];
        if (lastStep && lastStep.status === "running") {
          lastStep.status = event.status;
          lastStep.result = event.result;
          lastStep.error = event.error;
          lastStep.timestamp = new Date().toISOString();
          setTaskSteps(task.id, [...steps]);
        } else {
          addStep(event.instruction, event.status, event.result, event.error);
        }
      }
    });

    // Clean up any remaining running steps to done
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "done";
        step.timestamp = new Date().toISOString();
      }
    }
    setTaskSteps(task.id, [...steps]);

    if (!harnessResult.ok) {
      throw new Error(harnessResult.error);
    }

    const endTime = new Date().toISOString();
    const passedSteps = steps.filter((step) => step.status === "done").length;
    const failedSteps = steps.filter((step) => step.status === "failed").length;
    const report: QaReport = {
      taskId: task.id,
      taskName: task.name,
      targetUrl: task.targetUrl,
      overallStatus: "pass",
      summary: harnessResult.summary,
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      skippedSteps: 0,
      startTime,
      endTime,
      durationMs: new Date(endTime).getTime() - new Date(startTime).getTime(),
      steps: steps.map((step) => ({
        instruction: step.instruction,
        status: step.status,
        result: step.result ?? "",
        duration: 0,
        error: step.error
      })),
      screenshots: [],
      aiReasoning: "Executed by browser-harness against the embedded preview browser via CDP."
    };

    attachReport(task.id, report);
    updateTask(task.id, { status: "done" });
    emitProgress({ type: "task_complete", taskId: task.id, data: report });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const runningStep = [...steps].reverse().find((step) => step.status === "running");
    if (runningStep) {
      runningStep.status = "failed";
      runningStep.error = message;
      runningStep.timestamp = new Date().toISOString();
    } else {
      addStep("Run browser check", "failed", undefined, message);
    }

    // Clean up all other running steps to done
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "done";
        step.timestamp = new Date().toISOString();
      }
    }

    setTaskSteps(task.id, [...steps]);
    emitProgress({ type: "task_failed", taskId: task.id, message });
    updateTask(task.id, { status: "failed" });
    return true;
  }
}

type HarnessStepEvent = {
  instruction: string;
  status: TaskStepStatus;
  result?: string;
  error?: string;
};

type HarnessCheckResult = {
  ok: boolean;
  summary: string;
  error?: string;
};

async function runBrowserHarnessAgent(
  task: QaTask,
  settings: AppSettings,
  onStep: (event: HarnessStepEvent) => void
): Promise<HarnessCheckResult> {
  // Native Electron implementation of the observation step for speed and efficiency
  let observation: { ok: boolean; summary: string; error?: string } = {
    ok: false,
    summary: "DOM inspection failed."
  };

  try {
    if (!browserView) {
      throw new Error("Preview browser is not initialized.");
    }
    const view = browserView;

    onStep({ instruction: `Open ${task.targetUrl}`, status: "running" });
    await view.webContents.loadURL(task.targetUrl).catch(() => {});
    
    // Wait for page to finish loading
    if (view.webContents.isLoading()) {
      await Promise.race([
        new Promise<void>((resolve) => {
          view.webContents.once('did-stop-loading', () => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)) // 8s timeout fallback
      ]);
    }
    
    // Let page settle for a brief moment
    await new Promise((r) => setTimeout(r, 1200));

    const url = view.webContents.getURL();
    const title = view.webContents.getTitle();
    
    onStep({ instruction: `Open ${task.targetUrl}`, status: "done", result: `Loaded ${url}` });
    onStep({ instruction: "Inspect DOM with browser-harness", status: "running" });

    // Evaluate JavaScript in the browser view to scrape visible elements
    const elements = await view.webContents.executeJavaScript(`(() => {
      const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="link"],[tabindex]'));
      const visibleNodes = nodes.filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      return visibleNodes.slice(0, 500).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
        return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: text.slice(0, 140),
          href: el.href || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          classes: String(el.className || '').slice(0, 120),
          visible: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      });
    })()`).catch(() => []);

    const observationData = {
      taskUrl: task.targetUrl,
      page: { url, title },
      interactiveElements: elements
    };

    const observationSummary = JSON.stringify(observationData);
    observation = {
      ok: true,
      summary: observationSummary
    };
    onStep({ instruction: "Inspect DOM with browser-harness", status: "done", result: observationSummary.slice(0, 3500) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    observation = {
      ok: false,
      summary: "DOM inspection failed.",
      error: msg
    };
    onStep({ instruction: "Inspect DOM with browser-harness", status: "failed", error: msg });
  }

  if (!settings.apiKey) {
    return {
      ok: false,
      summary: "Browser-harness inspected the page, but no model is configured to decide actions.",
      error: "Save an API key in Settings so the QA agent can reason over the DOM snapshot and generate actions."
    };
  }

  let previousFailure = observation.ok ? "" : observation.error ?? observation.summary;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    onStep({ instruction: `Plan browser actions with model (attempt ${attempt})`, status: "running" });
    const harnessScript = await generateBrowserHarnessScript(task, settings, observation.summary, previousFailure, attempt);
    onStep({ instruction: `Plan browser actions with model (attempt ${attempt})`, status: "done", result: "Generated browser-harness action script." });
    const result = await runBrowserHarnessScript(harnessScript, onStep);

    if (result.ok) {
      return result;
    }

    previousFailure = [
      previousFailure,
      `Attempt ${attempt} failed: ${result.error ?? result.summary}`
    ].filter(Boolean).join("\n");
  }

  return {
    ok: false,
    summary: "Browser-harness could not complete the task after inspecting and retrying.",
    error: previousFailure || "No successful action sequence was produced."
  };
}

async function generateBrowserHarnessScript(
  task: QaTask,
  settings: AppSettings,
  observation: string,
  previousFailure: string,
  attempt: number
): Promise<string> {
  const prompt = `You are generating Python code for browser-harness, a CDP browser automation harness.
The code will be piped directly to the browser-harness CLI and will control the already-visible live preview browser.

Task: ${task.name}
Target URL: ${task.targetUrl}
Attempt: ${attempt} of 3

Current browser/DOM observation:
${observation}

Previous failure or retry context:
${previousFailure || "None"}

Available helper functions include:
- goto_url(url)
- wait_for_load()
- page_info() -> dict with url/title/viewport data
- js(source) -> evaluate JavaScript in the page
- click_at_xy(x, y)
- type_text(text)

Required output:
- Return only Python code. No markdown fences.
- The code must call emit(...) for progress and final result.
- Use this exact emit helper:
def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)
- Emit steps with {"instruction": "...", "status": "running"|"done"|"failed", "result": "...", "error": "..."}.
- Emit exactly one final event: {"final": True, "ok": bool, "summary": "...", "error": "..."}. Ensure that the "summary" is:
  - For standard verification tasks: A short, natural-language 1-line explanation of the final outcome (e.g., "Successfully logged in and verified the settings tab is visible.").
  - For exploratory, audit, or bug-finding tasks (e.g., "Explore the website, test forms, and find all bugs"): A clean, detailed, multi-line bulleted list outlining every identified bug, broken flow, or validation result.

Instructions for the Agent:
- Start by opening the target URL, unless you are already on a logged-in dashboard/subpage that is closer to the task goal.
- If the task is a conceptual check, diagnostic, or question (e.g., asking if a feature exists, checking version numbers, or answering conceptual questions), you can write a script that answers the question directly in the final summary event based on your DOM observations (setting ok=True) and finishes immediately without needing to perform extra browser actions.
- Reuse existing logged-in sessions! If the browser state shows you are already logged in or have session state, do not trigger a fresh login sequence.
- Actively Navigate! If the target elements (like a login or checkout button) are not on the landing page, look at the interactive elements list for navigation links (e.g. "Sign in", "Login", "Register", "Menu", "Sign Up"). Click one of them to navigate to the correct page first. Do not fail on the landing page if the controls aren't there.
- Inspect DOM state with js(...) before acting.
- Choose actions from observed DOM and page state. Do not assume this is GitHub-specific.
- Use click_at_xy(...) for clicks and type_text(...) for typing.
- After each action, wait_for_load() or verify DOM/URL changes with js(...) and page_info().
- If an action fails, try one alternate reasonable selector/coordinate before final failure.
- If the task cannot be fully verified, return ok=False with a clear error and what was observed.
`;

  try {
    const response = settings.apiProvider === "openai"
      ? await callOpenAiForHarnessScript(settings, prompt)
      : await callAnthropicForHarnessScript(settings, prompt);
    return normalizeHarnessScript(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildGenericBrowserHarnessScript(task, `Could not generate a task-specific harness script: ${message}`);
  }
}

async function callAnthropicForHarnessScript(settings: AppSettings, prompt: string): Promise<string> {
  const res = await fetch(`${settings.apiBaseUrl || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.model || "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic-compatible API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
  return data.content?.find((part) => part.type === "text")?.text ?? "";
}

async function callOpenAiForHarnessScript(settings: AppSettings, prompt: string): Promise<string> {
  const res = await fetch(`${settings.apiBaseUrl || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI-compatible API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function normalizeHarnessScript(script: string): string {
  const trimmed = script.trim();
  const fenceMatch = trimmed.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function buildObservationBrowserHarnessScript(task: QaTask): string {
  return `
import json

target_url = ${JSON.stringify(task.targetUrl)}

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

try:
    emit({"instruction": "Open " + target_url, "status": "running"})
    goto_url(target_url)
    wait_for_load()
    info = page_info()
    emit({"instruction": "Open " + target_url, "status": "done", "result": "Loaded " + info.get("url", target_url)})

    emit({"instruction": "Inspect DOM with browser-harness", "status": "running"})
    elements = js("""(() => {
      const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="link"],[tabindex]'));
      return nodes.slice(0, 120).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
        return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: text.slice(0, 140),
          href: el.href || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          classes: String(el.className || '').slice(0, 120),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      });
    })()""")
    observation = {
        "taskUrl": target_url,
        "page": info,
        "interactiveElements": elements
    }
    emit({"instruction": "Inspect DOM with browser-harness", "status": "done", "result": json.dumps(observation)[:3500]})
    emit({"final": True, "ok": True, "summary": json.dumps(observation)})
except Exception as exc:
    emit({"instruction": "Inspect DOM with browser-harness", "status": "failed", "error": str(exc)})
    emit({"final": True, "ok": False, "summary": "DOM inspection failed.", "error": str(exc)})
`;
}

function buildGenericBrowserHarnessScript(task: QaTask, note?: string): string {
  return `
import json
import time

target_url = ${JSON.stringify(task.targetUrl)}
task_name = ${JSON.stringify(task.name)}
note = ${JSON.stringify(note ?? "")}

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

try:
    emit({"instruction": "Open " + target_url, "status": "running"})
    goto_url(target_url)
    wait_for_load()
    info = page_info()
    emit({"instruction": "Open " + target_url, "status": "done", "result": "Loaded " + info.get("url", target_url)})

    emit({
        "instruction": "Inspect page state with browser-harness",
        "status": "done",
        "result": "Active page: " + info.get("title", "") + " (" + info.get("url", target_url) + ")"
    })
    emit({
        "final": True,
        "ok": False,
        "summary": "Browser-harness opened the page, but no task-specific script was generated.",
        "error": note or "No LLM-generated harness script was available for: " + task_name
    })
except Exception as exc:
    emit({
        "instruction": "Run browser-harness repository check",
        "status": "failed",
        "error": str(exc)
    })
    emit({
        "final": True,
        "ok": False,
        "summary": "Browser-harness repository check failed.",
        "error": str(exc)
    })
`;
}

function runBrowserHarnessScript(
  script: string,
  onStep: (event: HarnessStepEvent) => void
): Promise<HarnessCheckResult> {
  return new Promise((resolve) => {
    const { executable, args } = resolveBrowserHarnessCommand();
    const child = spawn(executable, args, {
      shell: false,
      env: {
        ...process.env,
        BU_CDP_URL: `http://127.0.0.1:${PREVIEW_DEBUG_PORT}`
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let finalResult: HarnessCheckResult | null = null;
    let stderr = "";
    let stdout = "";
    let stdoutBuffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        summary: "Browser-harness timed out.",
        error: "The harness process did not return a final result within 120 seconds."
      });
    }, 120000);

    const finish = (result: HarnessCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const handleLine = (line: string): void => {
      if (!line.startsWith("BH_EVENT ")) return;
      try {
        const event = JSON.parse(line.slice("BH_EVENT ".length)) as Partial<HarnessStepEvent> & Partial<HarnessCheckResult> & { final?: boolean };
        if (event.final) {
          finalResult = {
            ok: Boolean(event.ok),
            summary: event.summary ?? "",
            error: event.error
          };
          return;
        }

        if (event.instruction) {
          onStep({
            instruction: event.instruction,
            status: event.status ?? "running",
            result: event.result,
            error: event.error
          });
        }
      } catch (err) {
        // ignore malformed lines
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      stdoutBuffer += chunk.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        summary: "Browser-harness could not be started.",
        error: `${error.message}. Install it with: uv tool install git+https://github.com/browser-use/browser-harness`
      });
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer.trim());
      }
      if (finalResult) {
        finish(finalResult);
      } else {
        finish({
          ok: false,
          summary: "Browser-harness exited prematurely.",
          error: `Process exited with code ${code}.\nStderr: ${stderr}\nStdout: ${stdout}`
        });
      }
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

interface ResolvedCommand {
  executable: string;
  args: string[];
}

function resolveBrowserHarnessCommand(): ResolvedCommand {
  if (process.env.BROWSER_HARNESS_PATH && fs.existsSync(process.env.BROWSER_HARNESS_PATH)) {
    return { executable: process.env.BROWSER_HARNESS_PATH, args: [] };
  }

  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    // 1. Try AppData Roaming uv tools python.exe for instant execution bypass (saves wrapper startup lag)
    const pythonExePath = path.join(userProfile, "AppData", "Roaming", "uv", "tools", "browser-harness", "Scripts", "python.exe");
    if (fs.existsSync(pythonExePath)) {
      return { executable: pythonExePath, args: ["-m", "browser_harness.run"] };
    }

    // 2. Try standard local bin path
    const uvToolPath = path.join(userProfile, ".local", "bin", "browser-harness.exe");
    if (fs.existsSync(uvToolPath)) {
      return { executable: uvToolPath, args: [] };
    }
  }

  return { executable: "browser-harness", args: [] };
}

async function getPreviewAutomationTarget(
  playwright: typeof import("playwright"),
  targetUrl: string
): Promise<{
  page: import("playwright").Page;
  context: import("playwright").BrowserContext;
  disconnect: () => void;
}> {
  if (!browserView) {
    throw new Error("Preview browser is not ready yet.");
  }

  await browserView.webContents.loadURL(targetUrl).catch(() => {});

  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${PREVIEW_DEBUG_PORT}`);
  const deadline = Date.now() + 5000;
  const normalize = (url: string): string => url.replace(/\/$/, "");

  while (Date.now() < deadline) {
    const previewUrl = browserView.webContents.getURL();

    for (const context of browser.contexts()) {
      const previewPage = context
        .pages()
        .find((page) => normalize(page.url()) === normalize(targetUrl) || normalize(page.url()) === normalize(previewUrl));

      if (previewPage) {
        return {
          page: previewPage,
          context,
          disconnect: () => {
            const disconnect = (browser as unknown as { disconnect?: () => void }).disconnect;
            if (disconnect) disconnect.call(browser);
          }
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("Could not attach automation to the preview browser. Restart the app and try again.");
}

async function capturePageScreenshot(
  page: import("playwright").Page,
  screenshotDir: string
): Promise<string | undefined> {
  try {
    const filename = `screenshot-${Date.now()}.png`;
    const filePath = path.join(screenshotDir, filename);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return undefined;
  }
}

// ─── Window References ────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let browserView: BrowserView | null = null;

// ─── Browser State ─────────────────────────────────────────────────────────

let browserState: BrowserState = {
  url: "",
  title: "",
  ready: false,
  message: "Idle"
};

// ─── App State ─────────────────────────────────────────────────────────────

let runningTaskId: string | null = null;
let stopTaskFlag = false;
let taskQueue: string[] = [];

const settingsPath = () =>
  path.join(app.getPath("userData"), "settings.json");

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(settingsPath())) {
      return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as AppSettings;
    }
  } catch { /* ignore */ }
  return {
    apiProvider: "anthropic",
    apiKey: "",
    apiBaseUrl: "",
    model: "claude-sonnet-4-20250514"
  };
}

function saveSettingsToDisk(settings: AppSettings): void {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

// ─── Browser View Management ───────────────────────────────────────────────

function createBrowserView(): void {
  browserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: "persist:browserview"
    }
  });

  browserView.webContents.on("did-start-loading", () => {
    browserState = { ...browserState, ready: false, message: "Loading..." };
    sendBrowserState();
  });

  browserView.webContents.on("did-stop-loading", () => {
    const url = browserView!.webContents.getURL();
    const title = browserView!.webContents.getTitle();
    browserState = { ...browserState, url, title, ready: true, message: "Ready" };
    sendBrowserState();
  });

  browserView.webContents.on("did-fail-load", (_, errorCode, errorDescription) => {
    browserState = { ...browserState, ready: false, message: `Load failed: ${errorDescription} (${errorCode})` };
    sendBrowserState();
  });

  browserView.webContents.on("page-title-updated", (_, title) => {
    browserState = { ...browserState, title };
    sendBrowserState();
  });

  browserView.webContents.on("did-navigate", (_, url) => {
    browserState = { ...browserState, url };
    sendBrowserState();
  });

  browserView.webContents.setWindowOpenHandler((details) => {
    void browserView?.webContents.loadURL(details.url);
    return { action: "deny" };
  });
}

function attachBrowserViewToMain(): void {
  if (!mainWindow || !browserView) return;
  mainWindow.addBrowserView(browserView);
  resizeBrowserView();
  mainWindow.on("resize", resizeBrowserView);
}

function resizeBrowserView(): void {
  if (!mainWindow || !browserView) return;
  const bounds = mainWindow.getContentBounds();
  const sidebarW = 288;
  const titleH = 48;
  browserView.setBounds({
    x: sidebarW,
    y: titleH,
    width: Math.max(600, bounds.width - sidebarW),
    height: Math.max(400, bounds.height - titleH)
  });
}

function sendBrowserState(): void {
  mainWindow?.webContents.send("browser:stateChanged", browserState);
}

// ─── Window Creation ───────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: "QA Automation AI",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#d4d4d8",
      height: 48
    },
    backgroundColor: process.platform === "win32" ? "#00000000" : "#09090b",
    backgroundMaterial: process.platform === "win32" ? "mica" : undefined,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    browserView = null;
  });
}

// ─── QA Task Runner ───────────────────────────────────────────────────────

async function runQaTask(taskId: string): Promise<void> {
  const task = getTaskById(taskId);
  if (!task) return;

  runningTaskId = taskId;
  stopTaskFlag = false;

  try {
    updateTask(taskId, { status: "running" });

    if (await runBrowserHarnessTask(task)) {
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitProgress({ type: "task_failed", taskId, message });
    updateTask(taskId, { status: "failed" });
  } finally {
    if (runningTaskId === taskId) {
      runningTaskId = null;
    }
    runNextQueuedTask();
  }
}

function enqueueTask(taskId: string): void {
  if (runningTaskId === taskId || taskQueue.includes(taskId)) return;
  const task = getTaskById(taskId);
  if (!task || task.status === "done" || task.status === "failed") return;

  if (!runningTaskId) {
    startQueuedTask(taskId);
    return;
  }

  taskQueue.push(taskId);
  emitProgress({ type: "task_progress", taskId, message: "Queued behind the running task." });
}

function startQueuedTask(taskId: string): void {
  void runQaTask(taskId).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    emitProgress({ type: "task_failed", taskId, message });
    updateTask(taskId, { status: "failed" });
    if (runningTaskId === taskId) {
      runningTaskId = null;
    }
    runNextQueuedTask();
  });
}

function runNextQueuedTask(): void {
  if (runningTaskId) return;

  while (taskQueue.length > 0) {
    const nextTaskId = taskQueue.shift()!;
    const task = getTaskById(nextTaskId);
    if (!task || task.status === "done" || task.status === "failed") continue;
    startQueuedTask(nextTaskId);
    return;
  }
}

function isBrowserHarnessRepositoryTask(task: QaTask): boolean {
  return /repositor(?:y|ies)|repo\s+tab|tab\s+works/i.test(task.name);
}

function isBrowserHarnessRepoOwnerProfileTask(task: QaTask): boolean {
  return /within a repo|inside a repo|repo.+profile|profile.+repo|owner.+profile|main profile/i.test(task.name);
}

function isToolUseResponseError(message: string): boolean {
  return /expected tool use in response|model returned empty action|no next action returned|success=false/i.test(message);
}

// ─── Progress Emitter ─────────────────────────────────────────────────────

function emitProgress(event: AppProgressEvent): void {
  mainWindow?.webContents.send("app:progress", event);
}

function emitTaskProgress(task: QaTask): void {
  mainWindow?.webContents.send("tasks:progress", task);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────

function registerIpc(): void {
  // ── App / Settings ──
  ipcMain.handle("app:status", (): AppStatus => ({
    running: runningTaskId !== null,
    message: runningTaskId ? `Running task: ${runningTaskId}` : "Ready",
    currentTaskId: runningTaskId ?? undefined
  }));

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:save", (_, settings: AppSettings) => {
    saveSettingsToDisk(settings);
  });

  ipcMain.handle("testApiConnection", async (_, url, method, headers, body) => {
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body && method !== "GET" && method !== "HEAD" ? { body } : {})
      });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (err) {
      return { ok: false, status: 0, body: String(err) };
    }
  });

  // ── Browser ──
  ipcMain.handle("browser:state", (): BrowserState => browserState);

  ipcMain.handle("browser:navigate", async (_, input: NavigateInput) => {
    if (!browserView) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (browserView.webContents as any).loadURL(input.url, {
      waitUntil: input.waitUntil ?? "domcontentloaded",
      timeout: 30000
    } as Record<string, unknown>);
  });

  ipcMain.handle("browser:refresh", () => {
    browserView?.webContents.reload();
  });

  ipcMain.handle("browser:back", () => {
    browserView?.webContents.goBack();
  });

  ipcMain.handle("browser:forward", () => {
    browserView?.webContents.goForward();
  });

  ipcMain.handle("browser:mode", (_, mode: "headed" | "headless") => {
    console.log("[IPC] browser:mode", mode);
  });

  // ── QA Tasks ──
  ipcMain.handle("tasks:list", () => listTasks());

  ipcMain.handle("tasks:create", (_, input: QaTaskInput): QaTask => {
    const task = createTask(input);
    if (browserView) {
      browserView.webContents.loadURL(input.targetUrl).catch(() => {});
    }
    enqueueTask(task.id);
    return task;
  });

  ipcMain.handle("tasks:update", (_, id: string, update: QaTaskUpdate): QaTask => {
    const task = updateTask(id, update);
    emitTaskProgress(task);
    return task;
  });

  ipcMain.handle("tasks:delete", (_, id: string) => {
    taskQueue = taskQueue.filter((taskId) => taskId !== id);
    if (runningTaskId === id) {
      stopTaskFlag = true;
      runningTaskId = null;
    }
    deleteTask(id);
  });

  ipcMain.handle("tasks:start", (_, taskId: string) => {
    if (runningTaskId === taskId) return;
    enqueueTask(taskId);
  });

  ipcMain.handle("tasks:stop", (_, taskId: string) => {
    taskQueue = taskQueue.filter((queuedTaskId) => queuedTaskId !== taskId);
    if (runningTaskId === taskId) {
      stopTaskFlag = true;
    }
  });

  ipcMain.handle("tasks:pause", (_, taskId: string) => {
    if (runningTaskId === taskId) {
      updateTask(taskId, { status: "paused" });
    }
  });

  ipcMain.handle("tasks:resume", (_, taskId: string) => {
    if (runningTaskId === taskId) {
      updateTask(taskId, { status: "running" });
    }
  });

  // ── Reports ──
  ipcMain.handle("reports:get", (_, taskId: string): QaReport | null => {
    return getTaskReport(taskId);
  });

  ipcMain.handle("reports:export", async (_, taskId: string, format: "json" | "markdown") => {
    const report = getTaskReport(taskId);
    if (!report) return { canceled: true };

    const result = await dialog.showSaveDialog(mainWindow!, {
      title: `Export QA Report (${format.toUpperCase()})`,
      defaultPath: `qa-report-${taskId}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    let content: string;
    if (format === "json") {
      content = JSON.stringify(report, null, 2);
    } else {
      content = generateMarkdownReport(report);
    }

    fs.writeFileSync(result.filePath, content, "utf8");
    return { canceled: false, filePath: result.filePath };
  });
}

function generateMarkdownReport(report: QaReport): string {
  const statusBadge =
    report.overallStatus === "pass" ? "✅ PASS" :
    report.overallStatus === "fail" ? "❌ FAIL" : "⚠️  PARTIAL";

  const lines = [
    `# QA Report: ${report.taskName}`,
    "",
    `**Status:** ${statusBadge}`,
    `**Target URL:** ${report.targetUrl}`,
    `**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`,
    `**Started:** ${report.startTime}`,
    `**Ended:** ${report.endTime}`,
    "",
    `## Summary`,
    "",
    report.summary,
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Steps | ${report.totalSteps} |`,
    `| Passed | ${report.passedSteps} |`,
    `| Failed | ${report.failedSteps} |`,
    `| Skipped | ${report.skippedSteps} |`,
    "",
    `## Steps`,
    "",
    "| # | Instruction | Status | Result |",
    "|---|------------|--------|--------|",
    ...report.steps.map((step, i) => {
      const statusIcon =
        step.status === "done" ? "✅" :
        step.status === "failed" ? "❌" :
        step.status === "skipped" ? "⏭️ " : "⏳";
      const statusText = step.status.charAt(0).toUpperCase() + step.status.slice(1);
      const resultText = (step.result || step.error || "—").replace(/\n/g, " ").slice(0, 80);
      return `| ${i + 1} | ${step.instruction} | ${statusIcon} ${statusText} | ${resultText} |`;
    }),
    "",
    report.aiReasoning ? `## AI Reasoning\n\n${report.aiReasoning}` : ""
  ];

  return lines.join("\n");
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────

app.commandLine.appendSwitch("remote-debugging-port", String(PREVIEW_DEBUG_PORT));

app.whenReady().then(() => {
  app.setAppUserModelId("com.qa-automation-ai.app");
  Menu.setApplicationMenu(null);
  session.defaultSession.setCertificateVerifyProc(() => ({ action: "grant" }));

  registerIpc();
  createWindow();
  createBrowserView();
  mainWindow?.webContents.once("did-finish-load", () => {
    attachBrowserViewToMain();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
