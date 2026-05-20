import type { AgentExecutorKind, AgentRunMode, AgentActionErrorCode, AgentActionStatus } from '../shared/types';
import {
  buildActionScript,
  buildObservationScript,
  runHarnessScript,
  type HarnessStepEvent,
  type ObservedElement,
  type PageObservation,
  type StructuredAction
} from './harness';

export interface ExecutorSessionConfig {
  targetUrl: string;
  mode: AgentRunMode;
  cdpUrl?: string;
  timeoutMs: number;
}

export interface ExecutorSessionInfo {
  sessionId: string;
  mode: AgentRunMode;
  executor: AgentExecutorKind;
}

export interface ExecutorActionOutcome {
  ok: boolean;
  status: AgentActionStatus;
  errorCode?: AgentActionErrorCode;
  message: string;
  observation: PageObservation;
  actionResult?: string;
  executor: AgentExecutorKind;
}

export interface ScreenshotResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface AgentExecutor {
  readonly kind: AgentExecutorKind;
  startSession(config: ExecutorSessionConfig): Promise<ExecutorSessionInfo>;
  openUrl(url: string): Promise<ExecutorActionOutcome>;
  observe(): Promise<ExecutorActionOutcome>;
  execute(action: StructuredAction, target: ObservedElement | null): Promise<ExecutorActionOutcome>;
  screenshot(): Promise<ScreenshotResult>;
  stopSession(): Promise<void>;
}

export interface ExecutorFactoryOptions {
  kind?: AgentExecutorKind;
  mode: AgentRunMode;
  targetUrl: string;
  cdpUrl?: string;
  timeoutMs: number;
  onStep: (event: HarnessStepEvent) => void;
}

function emptyObservation(targetUrl: string): PageObservation {
  return {
    taskUrl: targetUrl,
    page: { url: targetUrl, title: '' },
    availableElements: [],
    interactiveElements: [],
    pageText: '',
    consoleErrors: []
  };
}

export function parsePageObservation(raw: string, targetUrl: string): PageObservation {
  try {
    const parsed = JSON.parse(raw) as Partial<PageObservation>;
    const elements = parsed.availableElements || parsed.interactiveElements || [];
    return {
      taskUrl: parsed.taskUrl || targetUrl,
      page: parsed.page || { url: targetUrl, title: '' },
      availableElements: elements,
      interactiveElements: elements,
      pageText: parsed.pageText || '',
      consoleErrors: parsed.consoleErrors || []
    };
  } catch {
    return emptyObservation(targetUrl);
  }
}

function extractActionResult(summary: string, fallback: string): string {
  try {
    const parsed = JSON.parse(summary) as { actionResult?: string };
    return parsed.actionResult || fallback || summary;
  } catch {
    return fallback || summary;
  }
}

function statusFor(ok: boolean, errorCode?: AgentActionErrorCode): AgentActionStatus {
  if (ok) return 'success';
  if (errorCode === 'EXECUTOR_UNAVAILABLE' || errorCode === 'SWITCH_DENIED') return 'blocked';
  return 'failed';
}

class BrowserHarnessExecutor implements AgentExecutor {
  readonly kind: AgentExecutorKind;
  private config: ExecutorSessionConfig | null = null;
  private observation: PageObservation;

  constructor(
    kind: AgentExecutorKind,
    private readonly onStep: (event: HarnessStepEvent) => void
  ) {
    this.kind = kind;
    this.observation = emptyObservation('');
  }

  async startSession(config: ExecutorSessionConfig): Promise<ExecutorSessionInfo> {
    this.config = config;
    this.observation = emptyObservation(config.targetUrl);
    return {
      sessionId: `agentqa-${Date.now()}`,
      mode: config.mode,
      executor: this.kind
    };
  }

  async openUrl(url: string): Promise<ExecutorActionOutcome> {
    const config = this.requireConfig();
    const result = await runHarnessScript(buildObservationScript(url, true), this.onStep, config.cdpUrl, config.timeoutMs);
    return this.toOutcome(result.ok, result.summary, result.error, url);
  }

  async observe(): Promise<ExecutorActionOutcome> {
    const config = this.requireConfig();
    const result = await runHarnessScript(buildObservationScript(config.targetUrl, false), this.onStep, config.cdpUrl, config.timeoutMs);
    return this.toOutcome(result.ok, result.summary, result.error, config.targetUrl);
  }

  async execute(action: StructuredAction, target: ObservedElement | null): Promise<ExecutorActionOutcome> {
    const config = this.requireConfig();
    const result = await runHarnessScript(buildActionScript(action, target, config.targetUrl), this.onStep, config.cdpUrl, config.timeoutMs);
    const outcome = this.toOutcome(result.ok, result.summary, result.error, config.targetUrl);
    outcome.actionResult = extractActionResult(result.summary, result.error || result.summary);
    outcome.message = outcome.actionResult;
    return outcome;
  }

  async screenshot(): Promise<ScreenshotResult> {
    return { ok: false, error: 'Screenshot capture is not implemented for this executor yet.' };
  }

  async stopSession(): Promise<void> {
    this.config = null;
  }

  private requireConfig(): ExecutorSessionConfig {
    if (!this.config) throw new Error('Executor session has not been started.');
    return this.config;
  }

  private toOutcome(ok: boolean, summary: string, error: string | undefined, targetUrl: string): ExecutorActionOutcome {
    const observation = parsePageObservation(summary, targetUrl);
    if (observation.page.url || observation.availableElements.length || observation.pageText) {
      this.observation = observation;
    }
    const errorCode = ok ? undefined : 'UNKNOWN' as const;
    return {
      ok,
      status: statusFor(ok, errorCode),
      errorCode,
      message: ok ? (summary || 'Action completed.') : (error || summary || 'Executor action failed.'),
      observation: this.observation,
      executor: this.kind
    };
  }
}

class UnavailableExecutor implements AgentExecutor {
  readonly kind: AgentExecutorKind;
  private observation: PageObservation;

  constructor(kind: AgentExecutorKind, targetUrl: string) {
    this.kind = kind;
    this.observation = emptyObservation(targetUrl);
  }

  async startSession(config: ExecutorSessionConfig): Promise<ExecutorSessionInfo> {
    this.observation = emptyObservation(config.targetUrl);
    return {
      sessionId: `agentqa-unavailable-${Date.now()}`,
      mode: config.mode,
      executor: this.kind
    };
  }

  async openUrl(): Promise<ExecutorActionOutcome> {
    return this.unavailable();
  }

  async observe(): Promise<ExecutorActionOutcome> {
    return this.unavailable();
  }

  async execute(): Promise<ExecutorActionOutcome> {
    return this.unavailable();
  }

  async screenshot(): Promise<ScreenshotResult> {
    return { ok: false, error: `${this.kind} is not available in this build.` };
  }

  async stopSession(): Promise<void> {}

  private unavailable(): ExecutorActionOutcome {
    return {
      ok: false,
      status: 'blocked',
      errorCode: 'EXECUTOR_UNAVAILABLE',
      message: `${this.kind} is not installed or wired in this build. Use standard mode or advanced browser-harness-dev mode.`,
      observation: this.observation,
      executor: this.kind
    };
  }
}

export function isExecutorAvailable(kind: AgentExecutorKind): boolean {
  return kind === 'standard-cdp' || kind === 'browser-harness-dev';
}

export function executorKindForMode(mode: AgentRunMode): AgentExecutorKind {
  if (mode === 'browser-use') return 'browser-use';
  return 'standard-cdp';
}

export function createAgentExecutor(options: ExecutorFactoryOptions): AgentExecutor {
  const kind = options.kind || executorKindForMode(options.mode);
  if (!isExecutorAvailable(kind)) {
    return new UnavailableExecutor(kind, options.targetUrl);
  }
  return new BrowserHarnessExecutor(kind, options.onStep);
}
