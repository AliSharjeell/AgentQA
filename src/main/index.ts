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
import { createAgentExecutor } from "../core/executor";
import { renderMarkdownReport, toDesktopReport } from "../core/reporter";
import { listQaTemplates } from "../core/templates";
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
    const updated = setTaskSteps(task.id, [...steps]);
    emitTaskProgress(updated);
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
      visionMode: settings.visionMode ?? task.visionMode,
      mode: task.mode || "standard",
      maxSteps: task.maxSteps,
      allowEscalation: Boolean(task.allowEscalation),
      outputDir: path.join(app.getPath("userData"), "qa-runs"),
      templateId: task.templateId,
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
          const updated = setTaskSteps(task.id, [...steps]);
          emitTaskProgress(updated);
        } else {
          const lastStep = steps[steps.length - 1];
          if (lastStep && lastStep.status === "running") {
            lastStep.status = event.status as TaskStepStatus;
            lastStep.result = event.result;
            lastStep.error = event.error;
            lastStep.timestamp = new Date().toISOString();
            const updated = setTaskSteps(task.id, [...steps]);
            emitTaskProgress(updated);
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
    const finalSteps = setTaskSteps(task.id, [...steps]);
    emitTaskProgress(finalSteps);

    if (!engineResult.report) {
      throw new Error(engineResult.error || engineResult.summary);
    }

    const report: QaReport = toDesktopReport({
      taskId: task.id,
      result: engineResult.report,
      stepEvents: steps.map((step) => ({
        instruction: step.instruction,
        status: step.status,
        result: step.result,
        error: step.error
      }))
    });

    attachReport(task.id, report);
    const completedTask = updateTask(task.id, { status: "done" });
    emitTaskProgress(completedTask);
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

    const failedSteps = setTaskSteps(task.id, [...steps]);
    emitTaskProgress(failedSteps);
    emitProgress({ type: "task_failed", taskId: task.id, message });
    const failedTask = updateTask(task.id, { status: "failed" });
    emitTaskProgress(failedTask);
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
    title: "AgentQA",
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
    const runningTask = updateTask(taskId, { status: "running" });
    emitTaskProgress(runningTask);

    if (await runBrowserHarnessTask(task)) {
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitProgress({ type: "task_failed", taskId, message });
    const failedTask = updateTask(taskId, { status: "failed" });
    emitTaskProgress(failedTask);
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

  ipcMain.handle("browser:captureScreenshot", async () => {
    if (!browserView) return null;
    const image = await browserView.webContents.capturePage();
    // Compress to JPEG to avoid Groq base64 URL size limits (often throws "invalid base64 url")
    return `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`;
  });

  // ── Experimental ──
  ipcMain.handle("experimental:testGroqCaptcha", async (_, base64Image: string | null, groqKey?: string) => {
    // If no key provided via args, attempt to read from saved settings as fallback
    let apiKey = groqKey;
    if (!apiKey) {
      try {
        const settingsPath = path.join(app.getPath("userData"), "agentqa-settings.json");
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          apiKey = settings.groqApiKey;
        }
      } catch (e) {
        // Ignore
      }
    }
    if (!apiKey) {
      return { ok: false, text: "No Groq API Key provided. Please add it in Settings." };
    }

    try {
      const messages: any[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "You are a captcha solving agent for a browser automation tool. Analyze this image. If you see a captcha, return a strict JSON array of actions to take. Possible actions: {\"action\":\"click\",\"coordinates\":[x,y]}, {\"action\":\"type\",\"text\":\"xyz\"}. Return ONLY JSON, no markdown."
            }
          ]
        }
      ];

      let finalBase64 = base64Image;
      if (!finalBase64 && browserView) {
        const image = await browserView.webContents.capturePage();
        finalBase64 = `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`;
      }

      if (finalBase64) {
        messages[0].content.push({
          type: "image_url",
          image_url: { url: finalBase64 }
        });
      }

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages,
          temperature: 1,
          max_completion_tokens: 1024,
          top_p: 1
        })
      });
      
      const json = await res.json();
      if (!res.ok) {
        return { ok: false, text: `Error ${res.status}: ${JSON.stringify(json)}` };
      }
      return { ok: true, text: json.choices?.[0]?.message?.content || JSON.stringify(json) };
    } catch (err) {
      return { ok: false, text: String(err) };
    }
  });

  ipcMain.handle("browser:solveCaptchaManually", async () => {
    try {
      const settings = loadSettings();
      const apiKey = settings.groqApiKey;
      if (!apiKey) return { ok: false, error: "No Groq API Key found in settings." };

      if (!browserView) return { ok: false, error: "No browser view active." };
      const image = await browserView.webContents.capturePage();
      const base64Image = `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`;

      const messages: any[] = [{
        role: "user",
        content: [
          { type: "text", text: "You are a captcha solving agent for a browser automation tool. Analyze this image. If you see a captcha, return a strict JSON array of actions to take. Possible actions: {\"action\":\"click\",\"coordinates\":[x,y]}, {\"action\":\"type\",\"text\":\"xyz\"}. Return ONLY JSON, no markdown." },
          { type: "image_url", image_url: { url: base64Image } }
        ]
      }];

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages,
          temperature: 1,
          max_completion_tokens: 1024,
          top_p: 1
        })
      });
      
      const json = await res.json();
      if (!res.ok) return { ok: false, error: `Groq Error ${res.status}: ${JSON.stringify(json)}` };
      
      const textResponse = json.choices?.[0]?.message?.content || "";
      let batchJson;
      try { 
        batchJson = JSON.parse(textResponse);
        if (Array.isArray(batchJson)) {
          batchJson = { action: 'batch', actions: batchJson };
        }
      } catch(e) {}
      
      if (batchJson && batchJson.action === 'batch' && batchJson.actions?.length > 0) {
        const url = browserView.webContents.getURL();
        const cdpUrl = `http://127.0.0.1:${PREVIEW_DEBUG_PORT}`;
        const executor = createAgentExecutor({
          mode: "standard",
          targetUrl: url,
          cdpUrl: cdpUrl,
          timeoutMs: 30000,
          onStep: (event) => console.log("[Vision Captcha]", event.instruction, event.status)
        });
        await executor.startSession({
          mode: "standard",
          targetUrl: url,
          cdpUrl: cdpUrl,
          timeoutMs: 30000
        });
        await executor.execute(batchJson, null);
        await executor.stopSession();
        return { ok: true, message: `Executed ${batchJson.actions.length} vision actions.` };
      } else {
        return { ok: false, error: `Could not parse valid batch JSON from Groq. Raw: ${textResponse}` };
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
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
  ipcMain.handle("templates:list", () => listQaTemplates());

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
      const pausedTask = updateTask(taskId, { status: "paused" });
      emitTaskProgress(pausedTask);
    }
  });

  ipcMain.handle("tasks:resume", (_, taskId: string) => {
    if (runningTaskId === taskId) {
      const runningTask = updateTask(taskId, { status: "running" });
      emitTaskProgress(runningTask);
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
      content = JSON.stringify(report.resultJson || report, null, 2);
    } else {
      content = generateMarkdownReport(report);
    }

    fs.writeFileSync(result.filePath, content, "utf8");
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle("reports:artifact", async (_, taskId: string, artifactPath: string) => {
    const report = getTaskReport(taskId);
    if (!report?.runId) return { ok: false, error: "Report artifact root is unavailable." };
    const root = path.resolve(app.getPath("userData"), "qa-runs", report.runId);
    const resolved = path.resolve(root, artifactPath);
    if (!resolved.startsWith(root)) return { ok: false, error: "Artifact path is outside the report directory." };
    if (!fs.existsSync(resolved)) return { ok: false, error: "Artifact was not found." };
    const ext = path.extname(resolved).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(resolved).toString("base64")}` };
    }
    return { ok: true, content: fs.readFileSync(resolved, "utf8") };
  });
}

function generateMarkdownReport(report: QaReport): string {
  if (report.resultJson) return renderMarkdownReport(report.resultJson);

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
