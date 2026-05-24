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

export interface ProviderRetryEvent {
  timestamp: string;
  provider: ApiProvider;
  model: string;
  phase: string;
  attempt: number;
  status: number;
  type: string;
  recovered: boolean;
  retryAfterMs: number;
  error?: string;
}

export type TaskStatus = "todo" | "running" | "done" | "failed" | "paused";

export type TaskStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type BrowserMode = "headed" | "headless";

export type AgentRunMode = "standard" | "browser-use" | "advanced";

export type AgentExecutorKind = "registry-app" | "standard-cdp" | "browser-use" | "browser-harness-dev";

export type QaTaskIntent =
  | "FORM_INTERACTION"
  | "AUTH_FLOW"
  | "DISCOVERY_PROBE"
  | "SEARCH_OR_DISCOVERY"
  | "NAVIGATION"
  | "TRANSACTION_OR_CART"
  | "SETTINGS_CHANGE"
  | "CONTENT_VERIFICATION"
  | "GENERAL_TASK";

export type AgentElementType =
  | "button"
  | "input"
  | "text"
  | "link"
  | "checkbox"
  | "select"
  | "list"
  | "image"
  | "menu"
  | "menuitem"
  | "tab"
  | "card"
  | "dialog"
  | "combobox"
  | "searchbox"
  | "option"
  | "accordion"
  | "dropdown"
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
  | "solve_captcha"
  | "batch"
  | "tell_user"
  | "ask_user"
  | "request_executor_switch"
  | "finish_task"
  | "error";

export type AgentActionStatus = "success" | "failed" | "skipped" | "needs_user" | "blocked";

export type QaVerdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "BLOCKED" | "WARNING" | "SKIPPED" | "INFRA_FAILED" | "AGENT_FAILED";

export type QaRootCause =
  | "WEBSITE_BUG"
  | "AGENT_LIMITATION"
  | "AGENT_INTERNAL_ERROR"
  | "VERIFICATION_MAPPING_ERROR"
  | "VERIFICATION_SELECTOR_FAILURE"
  | "ASSERTION_EXPECTED_VALUE_MISMATCH"
  | "TEST_DATA_ISSUE"
  | "ENVIRONMENT_ISSUE"
  | "AMBIGUOUS"
  | "REPORT_INCONSISTENCY"
  | "VERIFIER_RUNTIME_ERROR"
  | "BROWSER_EVALUATION_ERROR"
  | "FIELD_REGISTRY_EMPTY"
  | "NO_FIELDS_FOUND"
  | "PAGE_NOT_INTERACTIVE_OR_OBSERVATION_FAILED"
  | "PAGE_OBSERVATION_EMPTY"
  | "GOAL_NOT_REACHED"
  | "REQUIRED_AFFORDANCE_NOT_FOUND"
  | "CTA_NOT_FOUND"
  | "CTA_NOT_FOUND_AFTER_PREREQUISITES"
  | "REQUIRED_PREREQUISITES_UNRESOLVED"
  | "NO_PROGRESS"
  | "BOT_OR_REGION_BLOCK"
  | "AMBIGUOUS_STATE"
  | "LLM_PROVIDER_UNAVAILABLE";

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
  pageUrl?: string;
  temporary_observation_id: string;
  label: string;
  selector: string;
  selector_candidates?: string[];
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
  // Post-action verification
  value?: string;
  checked?: boolean;
  
  // For <select> elements
  options?: Array<{ value: string; label: string; selected: boolean }>;
  selected_value?: string;
  selected_label?: string;
}

export type FieldRegistry = FieldRegistryEntry[];

export interface ElementRegistryEntry {
  id: string;
  type: string;
  description: string;
  value?: string | null;
  text?: string;
  options?: Array<{
    value: string;
    label: string;
    selected?: boolean;
    disabled?: boolean;
  }>;
  tag: string;
  selector: string;
  href?: string;
  role?: string;
  name?: string;
  classes?: string;
  x: number;
  y: number;
  visible: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
}

export type ElementRegistry = ElementRegistryEntry[];

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

export interface QaNetworkErrorDetail {
  url: string;
  method: string;
  status: number | string;
  resource_type: string;
  is_critical: boolean;
  reason: string;
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
  network_errors: (string | QaNetworkErrorDetail)[];
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

export type QaProbeOutcome = "PRESENT" | "ABSENT" | "INCONCLUSIVE";

export interface QaProbeFinding {
  target: string;
  outcome: QaProbeOutcome;
  scope?: string;
  observedMatches?: string[];
  observedAlternatives?: string[];
  evidence: string[];
  summary?: string;
}

export interface QaRunAction {
  action_id: string;
  action: string;
  target?: string;
  field_id?: string;
  temporary_observation_id?: string;
  label?: string;
  selector?: string;
  input?: string | number | boolean | null;
  initial_value?: string | number | boolean | null;
  planned_value?: string | number | boolean | null;
  post_action_actual_value?: string | number | boolean | null;
  post_action_verification?: QaVerificationResult;
  final_actual_value?: string | number | boolean | null;
  final_verification?: QaVerificationResult;
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
  field_id?: string;
  selector?: string;
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

export interface QaObjectiveMilestone {
  id: string;
  label: string;
  status: QaVerdict;
  rootCause?: QaRootCause;
  evidence: string[];
  message?: string;
}

export interface QaCompactElementState {
  id?: string;
  label: string;
  selector?: string;
  role?: string;
  type?: string;
  enabled: boolean;
  bbox?: { x: number; y: number; width?: number; height?: number };
  text?: string;
}

export interface QaCompactFinalState {
  url: string;
  title: string;
  scrollY?: number;
  pageTextExcerpt: string;
  visibleHeadings: string[];
  visibleButtons: QaCompactElementState[];
  visibleLinks: QaCompactElementState[];
  visibleOptions: QaCompactElementState[];
  cartIndicators: string[];
  errorMessages: string[];
  selectedOptions: string[];
  disabledOptions: string[];
  candidateActions: QaCompactElementState[];
}

export type QaIssueCategory =
  | 'PRODUCT_ISSUE'
  | 'AGENT_ISSUE'
  | 'VERIFIER_ISSUE'
  | 'TEST_DATA_ISSUE'
  | 'ENVIRONMENT_ISSUE'
  | 'REPORT_ISSUE'
  | 'PROVIDER_ISSUE';

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
  critical_network_errors?: number;
  field_registry_count?: number;
  element_registry_count?: number;
  verified_fields_count?: number;
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
  status_source?: "VERIFICATION_ENGINE";
  root_cause?: QaRootCause;
  severity: QaSeverity;
  summary: string;
  environment: QaEnvironment;
  stats: QaRunStats;
  network_errors?: (string | QaNetworkErrorDetail)[];
  acceptance_criteria: QaAcceptanceCriterion[];
  objective_milestones?: QaObjectiveMilestone[];
  compact_final_state?: QaCompactFinalState;
  issues: QaIssue[];
  product_issues?: QaIssue[];
  agent_issues?: QaIssue[];
  verifier_issues?: QaIssue[];
  test_data_issues?: QaIssue[];
  environment_issues?: QaIssue[];
  report_issues?: QaIssue[];
  probe_finding?: QaProbeFinding;
  actions: QaRunAction[];
  assertions: QaAssertionResult[];
  artifacts: QaArtifactManifest;
  evidence_status: QaEvidenceStatus;
  reproducible_steps: string[];
  recommendation: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  verification_summary?: {
    status: QaVerdict;
    field_registry_count: number;
    element_registry_count?: number;
    verified_fields_count: number;
    verifier_error?: string;
  };
  raw_agent_report?: {
    status?: string;
    trusted: boolean;
    reason?: string;
    raw_data?: unknown;
  };
  validator_review?: QaValidatorResult;
  provider_events?: ProviderRetryEvent[];
  provider_warnings?: string[];
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
  groqApiKey?: string;
  enableCaptchaSolver?: boolean;
  batching?: {
    mode: "dynamic" | "fixed";
    defaultBatchSize: number;
    maxBatchSize: number;
    allowLargeBatches: boolean;
    requireSamePageForBatch: boolean;
    verifyAfterBatch: boolean;
    verifyEachSubAction: boolean;
  };
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
  providerEvents?: ProviderRetryEvent[];
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
  category: "form" | "auth" | "transaction" | "responsive" | "accessibility";
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
  testGroqCaptcha: (base64Image: string | null, groqKey?: string) => Promise<{ ok: boolean; text: string }>;
  solveCaptchaManually: () => Promise<{ ok: boolean; message?: string; error?: string }>;

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
