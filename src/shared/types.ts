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

export type AgentRunMode = "standard" | "browser-use" | "advanced";

export type AgentExecutorKind = "registry-app" | "standard-cdp" | "browser-use" | "browser-harness-dev";

export type AgentElementType =
  | "button"
  | "input"
  | "text"
  | "link"
  | "checkbox"
  | "select"
  | "list"
  | "image"
  | "unknown";

export type AgentActionName =
  | "open_url"
  | "click"
  | "tap"
  | "type"
  | "read"
  | "scroll"
  | "wait"
  | "press_key"
  | "select"
  | "assert"
  | "batch"
  | "tell_user"
  | "ask_user"
  | "request_executor_switch"
  | "finish_task"
  | "error";

export type AgentActionStatus = "success" | "failed" | "skipped" | "needs_user" | "blocked";

export type AgentActionErrorCode =
  | "ELEMENT_NOT_FOUND"
  | "TIMEOUT"
  | "NAVIGATION_FAILED"
  | "ASSERTION_FAILED"
  | "LLM_PARSE_ERROR"
  | "BOT_PROTECTION"
  | "EXECUTOR_UNAVAILABLE"
  | "SWITCH_DENIED"
  | "UNKNOWN";

export interface AgentBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AvailableElement {
  id: string;
  type: AgentElementType;
  description: string;
  value?: string | null;
  selector?: string;
  bbox?: AgentBoundingBox;
  visible: boolean;
  enabled: boolean;
  confidence: number;
}

export interface AgentObservation {
  session_id: string;
  url: string;
  title: string;
  current_screen: string;
  available_elements: AvailableElement[];
  page_text_summary: string;
  screenshot_path?: string;
  console_errors: string[];
  network_errors: string[];
}

export interface AgentAction {
  action: AgentActionName;
  target_id?: string | null;
  value?: string | null;
  reason?: string;
  confidence?: number;
  actions?: AgentAction[];
}

export interface AgentActionResult {
  step: number;
  action: AgentActionName | string;
  target_id?: string | null;
  status: AgentActionStatus;
  error_code?: AgentActionErrorCode;
  message: string;
  screen_before?: string;
  screen_after?: string;
  url_before?: string;
  url_after?: string;
  screenshot_before?: string;
  screenshot_after?: string;
  timestamp: string;
  executor: AgentExecutorKind;
}

export interface AgentPlanStep {
  id: string;
  description: string;
  status: "PENDING" | "CURRENT" | "DONE" | "FAILED" | "BLOCKED";
  linked_action_step?: number;
}

export interface AgentPlan {
  plan_id: string;
  steps: AgentPlanStep[];
}

export interface ExecutorSwitchRequest {
  from: AgentExecutorKind;
  to: AgentExecutorKind;
  reason: string;
  status: "approved" | "denied";
  message: string;
  timestamp: string;
}

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
  mode?: AgentRunMode;
  maxSteps?: number;
  allowEscalation?: boolean;
}

export interface QaTaskInput {
  name: string;
  targetUrl: string;
  visionMode?: boolean;
  mode?: AgentRunMode;
  maxSteps?: number;
  allowEscalation?: boolean;
}

export interface QaTaskUpdate {
  name?: string;
  targetUrl?: string;
  status?: TaskStatus;
  visionMode?: boolean;
  mode?: AgentRunMode;
  maxSteps?: number;
  allowEscalation?: boolean;
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
