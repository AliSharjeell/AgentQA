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
  | "fill"
  | "type"
  | "check"
  | "uncheck"
  | "radio"
  | "hover"
  | "upload_file"
  | "read"
  | "scroll"
  | "wait"
  | "wait_for"
  | "press_key"
  | "select"
  | "assert"
  | "assert_text"
  | "assert_url"
  | "assert_visible"
  | "assert_value"
  | "assert_checked"
  | "assert_selected"
  | "assert_count"
  | "screenshot"
  | "batch"
  | "tell_user"
  | "ask_user"
  | "request_executor_switch"
  | "finish_task"
  | "error";

export type AgentActionStatus = "success" | "failed" | "skipped" | "needs_user" | "blocked";

export type QaVerdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "BLOCKED" | "WARNING" | "SKIPPED";

export type QaRootCause =
  | "WEBSITE_BUG"
  | "AGENT_LIMITATION"
  | "AGENT_INTERNAL_ERROR"
  | "VERIFICATION_MAPPING_ERROR"
  | "TEST_DATA_ISSUE"
  | "ENVIRONMENT_ISSUE"
  | "AMBIGUOUS"
  | "REPORT_INCONSISTENCY";

export type QaSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type QaEvidenceStatus = "COMPLETE" | "PARTIAL" | "MISSING";

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

export interface FieldRegistryEntry {
  field_id: string;
  label: string;
  selector: string;
  tag: string;
  type: string;
  name: string;
  html_id: string;
  initial_value: string;
  planned_value?: string;
  actual_value?: string;
  label_source: 'label-for' | 'aria-label' | 'aria-labelledby' | 'placeholder' | 'visual-proximity' | 'name' | 'id';
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  nearby_text: string[];
  // For <select> elements
  options?: Array<{ value: string; label: string; selected: boolean }>;
  selected_value?: string;
  selected_label?: string;
}

export type FieldRegistry = FieldRegistryEntry[];

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

export interface QaSelectActual {
  value: string;
  label: string;
}

export interface QaVerificationResult {
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
  actual_select?: QaSelectActual;
  status: QaVerdict;
  rootCause?: QaRootCause;
  message?: string;
}

export interface QaRunAction {
  action_id: string;
  action: string;
  target?: string;
  field_id?: string;
  input?: string | number | boolean | null;
  initial_value?: string | number | boolean | null;
  planned_value?: string | number | boolean | null;
  actual_value?: string | number | boolean | null;
  action_result: "SUCCESS" | "FAILED" | "BLOCKED" | "SKIPPED";
  verification?: QaVerificationResult;
  screenshot?: string;
  timestamp: string;
  sub_actions?: QaRunAction[];
}

export interface QaAssertionResult {
  id: string;
  description: string;
  status: QaVerdict;
  expected?: string | number | boolean | null;
  actual?: string | number | boolean | null;
  rootCause?: QaRootCause;
  evidence?: string[];
  message?: string;
  required?: boolean;
}

export interface QaAcceptanceCriterion {
  id: string;
  description: string;
  status: QaVerdict;
  assertionIds?: string[];
}

export type QaIssueCategory =
  | 'PRODUCT_ISSUE'
  | 'AGENT_ISSUE'
  | 'VERIFIER_ISSUE'
  | 'TEST_DATA_ISSUE'
  | 'ENVIRONMENT_ISSUE'
  | 'REPORT_ISSUE';

export interface QaIssue {
  id: string;
  title: string;
  type: QaRootCause;
  category?: QaIssueCategory;
  severity: QaSeverity;
  status: QaVerdict;
  expected: string;
  actual: string;
  affected_elements: string[];
  evidence: {
    screenshots: string[];
    dom_snapshot?: string;
    action_trace?: string;
  };
  recommendation: string;
  reproSteps?: string[];
}

export interface QaEnvironment {
  browser: string;
  viewport: string;
  os: string;
  headless: boolean;
}

export interface QaRunStats {
  actions_total: number;
  actions_successful: number;
  actions_failed: number;
  assertions_total: number;
  assertions_passed: number;
  assertions_failed: number;
  assertions_blocked: number;
  console_errors: number;
  network_errors: number;
}

export interface QaArtifactManifest {
  html_report: string;
  markdown_report: string;
  json_result: string;
  screenshots_dir: string;
  action_trace?: string;
  dom_before?: string;
  dom_after?: string;
  console_log?: string;
  network_log?: string;
  accessibility_tree?: string;
  trace?: string;
  video?: string;
}

export interface QaRunResult {
  run_id: string;
  test_id: string;
  title: string;
  target_url: string;
  status: QaVerdict;
  root_cause: QaRootCause;
  severity: QaSeverity;
  summary: string;
  environment: QaEnvironment;
  stats: QaRunStats;
  acceptance_criteria: QaAcceptanceCriterion[];
  issues: QaIssue[];
  actions: QaRunAction[];
  assertions: QaAssertionResult[];
  artifacts: QaArtifactManifest;
  evidence_status: QaEvidenceStatus;
  reproducible_steps: string[];
  recommendation: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  raw_agent_report?: {
    status?: string;
    trusted: boolean;
    reason?: string;
    raw_data?: unknown;
  };
  validator_review?: QaValidatorResult;
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

// ─── Validator LLM ────────────────────────────────────────────────────────

export type QaValidatorVerdict = "VALID_REPORT" | "REPORT_NEEDS_FIX" | "UNTRUSTWORTHY_REPORT";

export interface QaValidatorPatch {
  path: string;
  old_value: string;
  new_value: string;
  reason: string;
}

export interface QaValidatorFinding {
  id: string;
  type:
    | "FIELD_MAPPING_ERROR"
    | "VERDICT_CONFLICT"
    | "WRONG_ROOT_CAUSE"
    | "EXPECTED_VALUE_MISMATCH"
    | "EVIDENCE_MISSING"
    | "ASSERTION_LOGIC_ERROR"
    | "REPORT_QUALITY_ISSUE";
  severity: QaSeverity;
  message: string;
  affected_report_paths: string[];
  recommended_fix: string;
}

export interface QaValidatorResult {
  verdict: QaValidatorVerdict;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  can_show_to_user: boolean;
  summary: string;
  critical_findings: QaValidatorFinding[];
  suggested_report_patches: QaValidatorPatch[];
  final_recommendation: "SHOW" | "REGENERATE_REPORT" | "RERUN_TEST" | "NEED_HUMAN_REVIEW";
}

export type ValidatorReview = QaValidatorResult;

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
  templateId?: string;
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
  templateId?: string;
  visionMode?: boolean;
  mode?: AgentRunMode;
  maxSteps?: number;
  allowEscalation?: boolean;
}

export interface QaTaskUpdate {
  name?: string;
  targetUrl?: string;
  templateId?: string;
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
  runId?: string;
  testId?: string;
  taskName: string;
  title?: string;
  targetUrl: string;
  status?: QaVerdict;
  rootCause?: QaRootCause;
  severity?: QaSeverity;
  overallStatus: "pass" | "fail" | "partial" | QaVerdict;
  summary: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  blockedSteps?: number;
  warningSteps?: number;
  skippedSteps: number;
  startTime: string;
  endTime: string;
  durationMs: number;
  steps: QaReportStep[];
  screenshots: string[];
  acceptanceCriteria?: QaAcceptanceCriterion[];
  issues?: QaIssue[];
  actions?: QaRunAction[];
  assertions?: QaAssertionResult[];
  artifacts?: QaArtifactManifest;
  evidenceStatus?: QaEvidenceStatus;
  reproducibleSteps?: string[];
  recommendation?: string;
  resultJson?: QaRunResult;
  aiReasoning: string;
}

export interface QaTemplate {
  id: string;
  title: string;
  task: string;
  url?: string;
  category: "form" | "login" | "ecommerce" | "responsive" | "accessibility";
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
  listTemplates: () => Promise<QaTemplate[]>;
  readArtifact: (taskId: string, artifactPath: string) => Promise<{ ok: boolean; content?: string; dataUrl?: string; error?: string }>;

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
