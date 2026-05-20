/**
 * Shared types for QA Automation AI desktop app.
 *
 * ## How to Add New Types
 *
 * 1. Add the type here in src/shared/types.ts
 * 2. Add corresponding IPC handler in src/main/index.ts
 * 3. Expose via contextBridge in src/preload/index.ts
 * 4. Consume in React components via window.qaApi.*
 *
 * ## Naming Conventions
 *
 * - Interfaces: PascalCase (e.g., QaTask, BrowserSession)
 * - Type aliases: PascalCase (e.g., TaskStatus, TaskStepStatus)
 * - IPC channel names: colon-separated (e.g., "tasks:list", "browser:navigate")
 * - Event names: past-tense noun (e.g., "task:progress", "browser:urlChanged")
 */

// ─── Core Primitives ───────────────────────────────────────────────────────

export type ApiProvider = "openai" | "anthropic";

export type TaskStatus = "todo" | "running" | "done" | "failed" | "paused";

export type TaskStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type BrowserMode = "headed" | "headless";

// ─── API Config ─────────────────────────────────────────────────────────────

export interface AppSettings {
  apiProvider: ApiProvider;
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  visionMode?: boolean;
}

// ─── Browser ───────────────────────────────────────────────────────────────

export interface BrowserState {
  url: string;
  title: string;
  ready: boolean;
  message: string;
}

export interface NavigateInput {
  url: string;
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
}

// ─── QA Tasks ──────────────────────────────────────────────────────────────

export interface QaTaskStep {
  id: string;
  order: number;
  instruction: string;
  status: TaskStepStatus;
  result?: string;
  screenshotPath?: string;
  timestamp: string;
  error?: string;
}

export interface QaTask {
  id: string;
  name: string;
  targetUrl: string;
  status: TaskStatus;
  steps: QaTaskStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  report?: QaReport;
  aiPlan?: string;
  visionMode?: boolean;
}

export interface QaTaskInput {
  name: string;
  targetUrl: string;
  visionMode?: boolean;
}

export interface QaTaskUpdate {
  name?: string;
  targetUrl?: string;
  status?: TaskStatus;
  visionMode?: boolean;
}

// ─── QA Report ─────────────────────────────────────────────────────────────

export interface QaReportStep {
  instruction: string;
  status: TaskStepStatus;
  result: string;
  screenshotPath?: string;
  duration: number;
  error?: string;
}

export interface QaReport {
  taskId: string;
  taskName: string;
  targetUrl: string;
  overallStatus: "pass" | "fail" | "partial";
  summary: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  startTime: string;
  endTime: string;
  durationMs: number;
  steps: QaReportStep[];
  screenshots: string[];
  aiReasoning: string;
}

// ─── App Status ─────────────────────────────────────────────────────────────

export interface AppStatus {
  running: boolean;
  message: string;
  currentTaskId?: string;
}

export interface AppProgressEvent {
  type: "task_progress" | "browser_state" | "step_complete" | "task_complete" | "task_failed";
  taskId?: string;
  stepId?: string;
  data?: unknown;
  message?: string;
  aiThought?: string;
}

// ─── CSV Export ─────────────────────────────────────────────────────────────

export interface CsvExportResult {
  canceled: boolean;
  filePath?: string;
}

// ─── Api Health ─────────────────────────────────────────────────────────────

export interface ApiHealthResult {
  ok: boolean;
  provider: ApiProvider;
  message: string;
}

// ─── QaApi — The IPC API consumed by the renderer ────────────────────────────

export interface QaApi {
  // ── App / Settings ──
  getAppStatus: () => Promise<AppStatus>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  testApiConnection: (url: string, method: string, headers: Record<string, string>, body: string) => Promise<{ ok: boolean; status: number; body: string }>;

  // ── Browser ──
  getBrowserState: () => Promise<BrowserState>;
  navigateTo: (input: NavigateInput) => Promise<void>;
  refreshBrowser: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  setBrowserMode: (mode: BrowserMode) => Promise<void>;

  // ── QA Tasks ──
  listTasks: () => Promise<QaTask[]>;
  createTask: (input: QaTaskInput) => Promise<QaTask>;
  updateTask: (id: string, update: QaTaskUpdate) => Promise<QaTask>;
  deleteTask: (id: string) => Promise<void>;
  startTask: (taskId: string) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  pauseTask: (taskId: string) => Promise<void>;
  resumeTask: (taskId: string) => Promise<void>;

  // ── Reports ──
  getTaskReport: (taskId: string) => Promise<QaReport | null>;
  exportReport: (taskId: string, format: "json" | "markdown") => Promise<CsvExportResult>;

  // ── Events ──
  onAppProgress: (callback: (event: AppProgressEvent) => void) => () => void;
  onBrowserState: (callback: (state: BrowserState) => void) => () => void;
  onTaskProgress: (callback: (task: QaTask) => void) => () => void;
}

/**
 * Extend window with the qaApi API.
 * Usage: window.qaApi.listTasks()
 */
declare global {
  interface Window {
    qaApi: QaApi;
  }
}