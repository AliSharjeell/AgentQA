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
import { runQaTask as runEngineQaTask } from "../core/engine";
import { HarnessStepEvent } from "../core/harness";
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
    
    // Ensure the browser view is initialized
    if (browserView && !browserView.webContents.getURL().includes(task.targetUrl)) {
      browserView.webContents.loadURL(task.targetUrl).catch(() => {});
    }

    const engineResult = await runEngineQaTask({
      targetUrl: task.targetUrl,
      prompt: task.name,
      settings,
      cdpUrl: `http://127.0.0.1:${PREVIEW_DEBUG_PORT}`,
      visionMode: task.visionMode,
      onStep: (event: HarnessStepEvent) => {
        if (event.status === "running") {
          const lastStep = steps[steps.length - 1];
          if (lastStep && lastStep.status === "running" && lastStep.instruction !== event.instruction) {
            lastStep.status = "done";
            lastStep.timestamp = new Date().toISOString();
          }
          const existing = steps.find(s => s.instruction === event.instruction && s.status === "running");
          if (!existing) {
            addStep(event.instruction, "running");
          }
          return;
        }

        const matchingStep = [...steps].reverse().find(s => s.instruction === event.instruction);
        if (matchingStep) {
          matchingStep.status = event.status as TaskStepStatus;
          matchingStep.result = event.result;
          matchingStep.error = event.error;
          matchingStep.timestamp = new Date().toISOString();
          setTaskSteps(task.id, [...steps]);
        } else {
          const lastStep = steps[steps.length - 1];
          if (lastStep && lastStep.status === "running") {
            lastStep.status = event.status as TaskStepStatus;
            lastStep.result = event.result;
            lastStep.error = event.error;
            lastStep.timestamp = new Date().toISOString();
            setTaskSteps(task.id, [...steps]);
          } else {
            addStep(event.instruction, event.status as TaskStepStatus, event.result, event.error);
          }
        }
      }
    });

    for (const step of steps) {
      if (step.status === "running") {
        step.status = "done";
        step.timestamp = new Date().toISOString();
      }
    }
    setTaskSteps(task.id, [...steps]);

    if (!engineResult.ok) {
      throw new Error(engineResult.error || engineResult.summary);
    }

    const endTime = new Date().toISOString();
    const passedSteps = steps.filter((step) => step.status === "done").length;
    const failedSteps = steps.filter((step) => step.status === "failed").length;
    
    // Merge engine's LLM-generated report if available
    const r = engineResult.report;
    const overallStatus = r ? (r.result === "PASS" ? "pass" : "fail") : "pass";
    
    const report: QaReport = {
      taskId: task.id,
      taskName: task.name,
      targetUrl: task.targetUrl,
      overallStatus,
      summary: engineResult.summary,
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
      screenshots: r?.screenshots ?? [],
      aiReasoning: r 
        ? `Scenario: ${r.scenario}\n\nConfirmed Bugs: ${r.confirmedBugs.join(', ') || 'None'}\n\nFix Recommendations: ${r.fixRecommendations.join(', ') || 'None'}`
        : "Executed by browser-harness against the embedded preview browser via CDP."
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
  app.setAppUserModelId("com.agentqa.app");
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
