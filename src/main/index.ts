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

type AgentRunResult = { ok: true } | { ok: false; error: string };

async function runQaTaskWithAgentAsync(task: QaTask, settings: AppSettings): Promise<AgentRunResult> {
  let preview: Awaited<ReturnType<typeof getPreviewAutomationTarget>> | null = null;
  const steps: {
    id: string;
    order: number;
    instruction: string;
    status: TaskStepStatus;
    timestamp: string;
    result?: string;
    error?: string;
  }[] = [];

  let stepCount = 0;

  try {
    const { Agent } = await import("browser-use");
    const playwright = await import("playwright");

    // Build browser-use LLM from settings
    const LlmClass = settings.apiProvider === "openai"
      ? (await import("browser-use/llm/openai")).ChatOpenAI
      : (await import("browser-use/llm/anthropic")).ChatAnthropic;

    const buLlm = new LlmClass({
      apiKey: settings.apiKey,
      ...(settings.apiBaseUrl ? { baseURL: settings.apiBaseUrl } : {}),
      model: settings.model || undefined
    });

    preview = await getPreviewAutomationTarget(playwright, task.targetUrl);
    const page = preview.page;

    // Navigate the embedded preview to the task URL before handing it to browser-use.
    emitProgress({ type: "task_progress", taskId: task.id, message: `Navigating to ${task.targetUrl}...` });
    await page.goto(task.targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

    // Set initial step
    steps.push({
      id: generateId(),
      order: 1,
      instruction: `Navigate to ${task.targetUrl}`,
      status: "done",
      timestamp: new Date().toISOString(),
      result: `Loaded ${task.targetUrl}`
    });
    stepCount = 1;
    setTaskSteps(task.id, [...steps]);
    emitProgress({ type: "task_progress", taskId: task.id, message: `Navigated to ${task.targetUrl}. Starting AI agent...` });

    // Create agent using the connected page
    const agent = new Agent({
      task: task.name,
      llm: buLlm,
      page,
      browser_context: preview.context,
      max_failures: 3,
      use_thinking: true,
      use_judge: false,
      enable_planning: true,
      session_attachment_mode: "shared",
      step_timeout: 120,
      directly_open_url: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      register_new_step_callback: (_summary: any, output: any) => {
        stepCount += 1;
        const stepId = generateId();
        const stepName =
          output?.current_state?.next_goal ??
          output?.current_state?.evaluation_previous_goal ??
          `Browser-use step ${stepCount}`;
        steps.push({
          id: stepId,
          order: stepCount,
          instruction: stepName,
          status: "running",
          timestamp: new Date().toISOString()
        });
        setTaskSteps(task.id, [...steps]);
        emitProgress({ type: "step_complete", taskId: task.id, stepId, message: stepName });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      register_done_callback: (history: any) => {
        const lastStep = steps[steps.length - 1];
        const resultText = (history?.result as any[])?.map((r: { text_content?: string }) => r.text_content ?? "").join(" ") ?? "Task completed";
        if (lastStep && lastStep.status === "running") {
          lastStep.status = "done";
          lastStep.result = resultText.slice(0, 300);
          lastStep.timestamp = new Date().toISOString();
        }
        setTaskSteps(task.id, [...steps]);
      },
      register_should_stop_callback: () => Promise.resolve(stopTaskFlag)
    });

    emitProgress({ type: "task_progress", taskId: task.id, message: "AI agent is analyzing the page..." });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history = await (agent as any).run();
    const isSuccessful = typeof history?.is_successful === "function" ? history.is_successful() : true;
    const finalText = typeof history?.final_result === "function" ? history.final_result() : "";

    if (isSuccessful === false) {
      const lastStep = steps[steps.length - 1];
      if (lastStep) {
        lastStep.status = "failed";
        lastStep.error = finalText || "browser-use completed with success=false.";
        lastStep.timestamp = new Date().toISOString();
      }
      setTaskSteps(task.id, [...steps]);
      return { ok: false, error: finalText || "browser-use completed with success=false." };
    }

    // Finalize any running steps
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "done";
        step.timestamp = new Date().toISOString();
      }
    }
    setTaskSteps(task.id, [...steps]);

    const endTime = new Date().toISOString();
    const passed = steps.filter((s) => s.status === "done").length;
    const failed = steps.filter((s) => s.status === "failed").length;

    const report: QaReport = {
      taskId: task.id,
      taskName: task.name,
      targetUrl: task.targetUrl,
      overallStatus: failed === 0 ? "pass" : passed === 0 ? "fail" : "partial",
      summary: `AI agent completed ${passed}/${steps.length} steps. ${failed} step(s) failed.`,
      totalSteps: steps.length,
      passedSteps: passed,
      failedSteps: failed,
      skippedSteps: 0,
      startTime: task.createdAt,
      endTime,
      durationMs: new Date(endTime).getTime() - new Date(task.createdAt).getTime(),
      steps: steps.map((s) => ({
        instruction: s.instruction,
        status: s.status,
        result: s.result ?? "",
        duration: 0,
        error: s.error
      })),
      screenshots: [],
      aiReasoning: "Executed by browser-use AI agent."
    };

    attachReport(task.id, report);
    updateTask(task.id, { status: failed === 0 ? "done" : "paused" });
    emitProgress({ type: "task_complete", taskId: task.id, data: report });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitProgress({ type: "task_failed", taskId: task.id, message });
    updateTask(task.id, { status: "failed" });
    if (steps.length === 0) {
      steps.push({
        id: generateId(),
        order: 1,
        instruction: "Start browser-use agent in preview browser",
        status: "failed",
        error: message,
        timestamp: new Date().toISOString()
      });
    }
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "failed";
        step.error = message;
        step.timestamp = new Date().toISOString();
      }
    }
    setTaskSteps(task.id, [...steps]);
    return { ok: false, error: message };
  } finally {
    preview?.disconnect();
  }
}

async function runDirectBrowserCheck(task: QaTask): Promise<boolean> {
  if (!/repositor(?:y|ies)|repo\s+tab|tab\s+works/i.test(task.name)) {
    return false;
  }

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
    emitProgress({ type: "task_progress", taskId: task.id, message: "Running browser-harness check in preview..." });
    const harnessResult = await runBrowserHarnessRepositoryCheck(task.targetUrl, (event) => {
      if (event.status === "running") {
        addStep(event.instruction, "running");
        return;
      }

      const step = steps[steps.length - 1];
      if (step && step.status === "running") {
        step.status = event.status;
        step.result = event.result;
        step.error = event.error;
        step.timestamp = new Date().toISOString();
        setTaskSteps(task.id, [...steps]);
      } else {
        addStep(event.instruction, event.status, event.result, event.error);
      }
    });

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
    const runningStep = steps.find((step) => step.status === "running");
    if (runningStep) {
      runningStep.status = "failed";
      runningStep.error = message;
      runningStep.timestamp = new Date().toISOString();
    } else {
      addStep("Run browser check", "failed", undefined, message);
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

function runBrowserHarnessRepositoryCheck(
  targetUrl: string,
  onStep: (event: HarnessStepEvent) => void
): Promise<HarnessCheckResult> {
  const script = `
import json
import time

target_url = ${JSON.stringify(targetUrl)}

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

def find_repo_tab_rect():
    return js("""
(() => {
  const links = Array.from(document.querySelectorAll('a'));
  const link = links.find((item) => /Repositories/i.test(item.textContent || ''));
  if (!link) return null;
  const rect = link.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    text: (link.textContent || '').trim()
  };
})()
""")

def repository_state():
    return js("""
(() => {
  const repoInput = document.querySelector('input[placeholder*="repository" i]');
  const repoList = document.querySelector('[data-testid="repositories-list"], [itemprop="owns"], a[itemprop="name codeRepository"]');
  const links = Array.from(document.querySelectorAll('a'));
  const repoLink = links.find((item) => /Repositories/i.test(item.textContent || ''));
  const selected = repoLink && (
    repoLink.getAttribute('aria-current') === 'page' ||
    repoLink.classList.contains('selected') ||
    repoLink.parentElement?.classList.contains('selected') ||
    getComputedStyle(repoLink).fontWeight === '600'
  );
  return {
    ok: Boolean(repoInput || repoList || selected || /[?&]tab=repositories\\b/i.test(location.href)),
    url: location.href,
    title: document.title,
    hasSearch: Boolean(repoInput),
    hasRepoList: Boolean(repoList),
    selected: Boolean(selected)
  };
})()
""")

try:
    emit({"instruction": "Open " + target_url, "status": "running"})
    goto_url(target_url)
    wait_for_load()
    info = page_info()
    emit({"instruction": "Open " + target_url, "status": "done", "result": "Loaded " + info.get("url", target_url)})

    emit({"instruction": "Click the Repositories tab", "status": "running"})
    rect = find_repo_tab_rect()
    if not rect:
        raise Exception("Could not find the Repositories tab in the preview browser.")
    click_at_xy(rect["x"], rect["y"])
    wait_for_load()
    time.sleep(1)
    state = repository_state()
    if not state.get("ok"):
        raise Exception("Repositories tab did not become active. Current URL: " + state.get("url", "unknown"))
    emit({
        "instruction": "Click the Repositories tab",
        "status": "done",
        "result": "Repositories view is active at " + state.get("url", "unknown")
    })
    emit({
        "final": True,
        "ok": True,
        "summary": "The Repositories tab opened successfully in the live preview browser."
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

  return new Promise((resolve) => {
    const child = spawn("browser-harness", {
      shell: true,
      env: {
        ...process.env,
        BU_CDP_URL: `http://127.0.0.1:${PREVIEW_DEBUG_PORT}`
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let finalResult: HarnessCheckResult | null = null;
    let stderr = "";
    let stdoutBuffer = "";

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

        if (event.instruction && event.status) {
          onStep({
            instruction: event.instruction,
            status: event.status,
            result: event.result,
            error: event.error
          });
        }
      } catch {
        // Ignore non-JSON harness output.
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      resolve({
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
        resolve(finalResult);
        return;
      }

      resolve({
        ok: false,
        summary: "Browser-harness exited without a result.",
        error: stderr.trim() || `browser-harness exited with code ${code ?? "unknown"}`
      });
    });

    child.stdin.end(script);
  });
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
    backgroundColor: "#09090b",
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

    if (isBrowserHarnessTask(task) && await runDirectBrowserCheck(task)) {
      return;
    }

    const settings = loadSettings();
    if (!settings.apiKey) {
      if (await runDirectBrowserCheck(task)) {
        return;
      }

      emitProgress({
        type: "task_failed",
        taskId,
        message: "No API key configured. Add one in Settings, or use a task this app can run with direct browser automation."
      });
      updateTask(taskId, { status: "failed" });
      return;
    }

    emitProgress({ type: "task_progress", taskId, message: "Starting QA task with AI agent..." });

    const agentResult = await runQaTaskWithAgentAsync(task, settings);
    if (!agentResult.ok && isToolUseResponseError(agentResult.error) && await runDirectBrowserCheck(task)) {
      return;
    }
    if (!agentResult.ok) {
      emitProgress({ type: "task_failed", taskId, message: agentResult.error });
      updateTask(taskId, { status: "failed" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitProgress({ type: "task_failed", taskId, message });
    updateTask(taskId, { status: "failed" });
  } finally {
    if (runningTaskId === taskId) {
      runningTaskId = null;
    }
  }
}

function isBrowserHarnessTask(task: QaTask): boolean {
  return /repositor(?:y|ies)|repo\s+tab|tab\s+works/i.test(task.name);
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
    return task;
  });

  ipcMain.handle("tasks:update", (_, id: string, update: QaTaskUpdate): QaTask => {
    const task = updateTask(id, update);
    emitTaskProgress(task);
    return task;
  });

  ipcMain.handle("tasks:delete", (_, id: string) => {
    if (runningTaskId === id) {
      stopTaskFlag = true;
      runningTaskId = null;
    }
    deleteTask(id);
  });

  ipcMain.handle("tasks:start", (_, taskId: string) => {
    if (runningTaskId && runningTaskId !== taskId) {
      throw new Error(`Task ${runningTaskId} is already running. Stop it first.`);
    }
    if (runningTaskId === taskId) return;
    void runQaTask(taskId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      emitProgress({ type: "task_failed", taskId, message });
      updateTask(taskId, { status: "failed" });
      if (runningTaskId === taskId) {
        runningTaskId = null;
      }
    });
  });

  ipcMain.handle("tasks:stop", (_, taskId: string) => {
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
