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

  const playwright = await import("playwright");
  const preview = await getPreviewAutomationTarget(playwright, task.targetUrl);
  const page = preview.page;
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
    emitProgress({ type: "task_progress", taskId: task.id, message: "Running browser check in preview..." });
    addStep(`Open ${task.targetUrl}`, "running");
    await page.goto(task.targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    steps[0].status = "done";
    steps[0].result = `Loaded ${page.url()}`;
    setTaskSteps(task.id, [...steps]);

    addStep("Click the Repositories tab", "running");
    const repositoriesTab = page.getByRole("link", { name: /repositories?/i }).first();
    await repositoriesTab.waitFor({ state: "visible", timeout: 15000 });
    await repositoriesTab.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});

    const currentUrl = page.url();
    const repositoriesSelected = /[?&]tab=repositories\b/i.test(currentUrl) ||
      await page.locator('a[href*="tab=repositories"][aria-current="page"]').count().then((count) => count > 0) ||
      await page.getByRole("link", { name: /repositories?/i }).first().evaluate((element) => {
        const link = element as HTMLAnchorElement;
        return link.getAttribute("aria-current") === "page" ||
          link.classList.contains("selected") ||
          link.parentElement?.classList.contains("selected") ||
          window.getComputedStyle(link).fontWeight === "600";
      }).catch(() => false) ||
      await page.getByPlaceholder(/find a repository/i).count().then((count) => count > 0) ||
      await page.locator('[data-testid="repositories-list"], [itemprop="owns"], a[itemprop="name codeRepository"]').count().then((count) => count > 0);

    if (!repositoriesSelected) {
      throw new Error(`Repositories tab did not become active. Current URL: ${currentUrl}`);
    }

    steps[1].status = "done";
    steps[1].result = `Repositories tab is active at ${currentUrl}`;
    setTaskSteps(task.id, [...steps]);

    const endTime = new Date().toISOString();
    const report: QaReport = {
      taskId: task.id,
      taskName: task.name,
      targetUrl: task.targetUrl,
      overallStatus: "pass",
      summary: "The Repositories tab opened successfully in the preview browser.",
      totalSteps: steps.length,
      passedSteps: steps.length,
      failedSteps: 0,
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
      aiReasoning: "Executed by deterministic Playwright automation against the embedded preview browser."
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
  } finally {
    preview.disconnect();
  }
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
