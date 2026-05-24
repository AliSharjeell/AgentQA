import crypto from 'node:crypto';
import type { AgentExecutorKind, AgentRunMode, AppSettings } from '../shared/types';
import type { QaRunAction, QaRunResult } from '../shared/types';
import { callForScript } from './api';
import {
  type CliReport,
  type HarnessStepEvent,
  type ObservedElement,
  type PageObservation,
  type QaFault,
  type StructuredAction
} from './harness';
import { createAgentExecutor, isExecutorAvailable, type AgentExecutor } from './executor';
import { buildPrompt, normalizeScript, type AgentHistoryEntry, type AgentPlanStep } from './prompt';
import { EvidenceCollector } from './evidence';
import { createTestPlan } from './planner';
import { buildQaRunResult, applyValidatorGating, writeQaReportFiles } from './reporter';
import { verifyAction, verifyPlanAssertions } from './verification';
import { runValidatorAudit } from './validator';

export interface TaskStep {
  instruction: string;
  status: 'running' | 'done' | 'failed';
  result?: string;
  error?: string;
}

export interface TaskResult {
  ok: boolean;
  summary: string;
  steps: TaskStep[];
  durationMs: number;
  url: string;
  error: string | null;
  report?: QaRunResult;
}

export interface RunTaskOptions {
  targetUrl: string;
  prompt: string;
  settings: AppSettings;
  cdpUrl?: string;
  onStep?: (event: HarnessStepEvent) => void;
  timeoutMs?: number;
  visionMode?: boolean;
  mode?: AgentRunMode;
  maxSteps?: number;
  allowEscalation?: boolean;
  outputDir?: string;
  templateId?: string;
}

type FinishAction = 'finish_task' | 'fail_task';
type SwitchAction = { action: 'request_executor_switch'; value?: string; reason?: string; description?: string };
type AgentAction = StructuredAction | ({ action: FinishAction; reason?: string; description?: string }) | SwitchAction;

interface AgentResponse {
  thought: string;
  plan: AgentPlanStep[];
  activePhase: AgentAction;
  faults?: QaFault[];
  report?: CliReport | null;
}

interface StepBudgetDecision {
  needsMoreSteps: boolean;
  requestedSteps: number;
  reason: string;
  confidence: number;
}

function emptyObservation(targetUrl: string): PageObservation {
  return {
    taskUrl: targetUrl,
    page: { url: targetUrl, title: '' },
    availableElements: [],
    interactiveElements: [],
    fieldRegistry: [],
    pageText: '',
    consoleErrors: [],
    networkErrors: []
  };
}

function parseObservation(raw: string, targetUrl: string): PageObservation {
  try {
    const parsed = JSON.parse(raw) as Partial<PageObservation>;
    const elements = parsed.availableElements || parsed.interactiveElements || [];
    return {
      taskUrl: parsed.taskUrl || targetUrl,
      page: parsed.page || { url: targetUrl, title: '' },
      availableElements: elements,
      interactiveElements: elements,
      fieldRegistry: parsed.fieldRegistry || [],
      pageText: parsed.pageText || '',
      consoleErrors: parsed.consoleErrors || [],
      networkErrors: parsed.networkErrors || []
    };
  } catch {
    return emptyObservation(targetUrl);
  }
}

function extractJsonObject(raw: string): string {
  const normalized = normalizeScript(raw);
  try {
    JSON.parse(normalized);
    return normalized;
  } catch {
    // Continue to extraction.
  }

  const start = normalized.indexOf('{');
  if (start === -1) throw new Error(`No JSON object found in agent response: ${normalized}`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < normalized.length; i++) {
    const char = normalized[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') inString = true;
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return normalized.slice(start, i + 1);
  }

  throw new Error(`Unterminated JSON object in agent response: ${normalized}`);
}

function parseAgentResponse(raw: string): AgentResponse {
  const json = extractJsonObject(raw);
  const parsed = JSON.parse(json) as Partial<AgentResponse> & { active_phase?: AgentAction };
  const activePhase = parsed.activePhase || parsed.active_phase;
  if (!activePhase || typeof activePhase.action !== 'string') {
    throw new Error(`Agent response missing activePhase.action: ${json}`);
  }
  return {
    thought: parsed.thought || '',
    plan: Array.isArray(parsed.plan) ? parsed.plan : [],
    activePhase,
    faults: Array.isArray(parsed.faults) ? parsed.faults : [],
    report: parsed.report || null
  };
}

function parseStepBudgetDecision(raw: string): StepBudgetDecision {
  const json = extractJsonObject(raw);
  const parsed = JSON.parse(json) as Partial<StepBudgetDecision> & {
    needs_more_steps?: boolean;
    requested_steps?: number;
  };
  return {
    needsMoreSteps: Boolean(parsed.needsMoreSteps ?? parsed.needs_more_steps),
    requestedSteps: Number(parsed.requestedSteps ?? parsed.requested_steps ?? 0),
    reason: parsed.reason || 'No reason provided.',
    confidence: Number(parsed.confidence ?? 0)
  };
}

function isStructuredAction(action: AgentAction): action is StructuredAction {
  return !['finish_task', 'fail_task', 'request_executor_switch'].includes(action.action);
}

function describeAction(action: AgentAction, target?: ObservedElement | null): string {
  if (!isStructuredAction(action)) {
    if (action.action === 'request_executor_switch') return `Request executor switch to ${action.value || '(missing)'}`;
    return action.action === 'finish_task' ? 'Finish task' : 'Fail task';
  }
  if (action.action === 'batch') {
    const count = action.actions?.length || 0;
    return action.description || `batch ${count} actions`;
  }
  const targetText = target ? ` ${target.id} "${target.description}"` : '';
  const keyText = action.key ? ` key "${action.key.slice(0, 40)}"` : '';
  const valueText = action.value ? ` value "${action.value.slice(0, 80)}"` : keyText;
  return `${action.action}${targetText}${valueText}`;
}

function actionSignature(action: AgentAction): string {
  if (!isStructuredAction(action)) {
    return [action.action, 'value' in action ? action.value || '' : ''].join('|');
  }
  if (isStructuredAction(action) && action.action === 'batch') {
    return [
      'batch',
      ...(action.actions || []).map((item) => actionSignature(item))
    ].join('||');
  }
  return [
    action.action,
    'targetId' in action ? action.targetId || '' : '',
    'value' in action ? action.value || '' : '',
    'key' in action ? action.key || '' : '',
    'url' in action ? action.url || '' : '',
    'dy' in action ? action.dy ?? '' : '',
    'seconds' in action ? action.seconds ?? '' : ''
  ].join('|');
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function isRestartNavigation(action: AgentAction, targetUrl: string, history: AgentHistoryEntry[]): boolean {
  if (!isStructuredAction(action) || history.length === 0) return false;
  if (action.action === 'batch') {
    return (action.actions || []).some((item) => isRestartNavigation(item, targetUrl, history));
  }
  return action.action === 'navigate' && Boolean(action.url) && normalizeUrl(action.url || '') === normalizeUrl(targetUrl);
}

function findTarget(action: AgentAction, observation: PageObservation): ObservedElement | null {
  if (!isStructuredAction(action) || !action.targetId) return null;
  return observation.availableElements.find((el) => el.id === action.targetId) || null;
}

function targetForId(targetId: string | undefined, observation: PageObservation): ObservedElement | null {
  if (!targetId) return null;
  return observation.availableElements.find((el) => el.id === targetId) || null;
}

function actionRequiresTarget(action: StructuredAction): boolean {
  return [
    'click',
    'type',
    'fill',
    'select',
    'check',
    'uncheck',
    'radio',
    'hover',
    'upload_file',
    'read',
    'assert_visible',
    'assert_value',
    'assert_checked',
    'assert_selected',
    'assert_count'
  ].includes(action.action);
}

function resolveExecutableAction(action: StructuredAction, observation: PageObservation, settings?: import('./settings').AppSettings): { action?: StructuredAction; target: ObservedElement | null; error?: string } {
  if (action.action !== 'batch') {
    const target = targetForId(action.targetId, observation);
    if (action.targetId && !target) {
      return { target: null, error: `Target ${action.targetId} is not available in the current DOM observation.` };
    }
    if (actionRequiresTarget(action) && !target) {
      return { target: null, error: `Target ${action.targetId || '(missing)'} is not available in the current DOM observation.` };
    }
    if (action.action === 'select' && !action.value) {
      return { target, error: 'Select action requires value with the option label or value to choose.' };
    }
    if (['fill', 'type', 'upload_file', 'assert_text', 'assert_url', 'assert_value', 'assert_selected', 'assert_count', 'screenshot'].includes(action.action) && !action.value) {
      return { target, error: `${action.action} action requires value.` };
    }
    return { action, target };
  }

  const subactions = action.actions || [];
  if (typeof action.confidence !== 'number' || action.confidence < 0.9) {
    return { target: null, error: 'Batch action blocked: confidence must be at least 0.90.' };
  }
  const maxBatchSize = settings?.batching?.maxBatchSize ?? 50;
  if (subactions.length < 2 || subactions.length > maxBatchSize) {
    return { target: null, error: `Batch action blocked: it must contain 2 to ${maxBatchSize} sub-actions.` };
  }

  const resolvedSubactions: StructuredAction[] = [];
  for (const [index, item] of subactions.entries()) {
    if (item.action === 'batch') {
      return { target: null, error: `Batch action blocked: nested batch at sub-action ${index + 1}.` };
    }
    const target = targetForId(item.targetId, observation);
    if (item.targetId && !target) {
      return { target: null, error: `Batch action blocked: target ${item.targetId} is unavailable for sub-action ${index + 1}.` };
    }
    if (actionRequiresTarget(item) && !target) {
      return { target: null, error: `Batch action blocked: target ${item.targetId || '(missing)'} is unavailable for sub-action ${index + 1}.` };
    }
    if (item.action === 'select' && !item.value) {
      return { target: null, error: `Batch action blocked: select sub-action ${index + 1} requires value.` };
    }
    if (['fill', 'type', 'upload_file', 'assert_text', 'assert_url', 'assert_value', 'assert_selected', 'assert_count', 'screenshot'].includes(item.action) && !item.value) {
      return { target: null, error: `Batch action blocked: ${item.action} sub-action ${index + 1} requires value.` };
    }
    resolvedSubactions.push({ ...item, _target: target });
  }

  return {
    action: { ...action, actions: resolvedSubactions },
    target: null
  };
}

function mergeFaults(existing: QaFault[], incoming: QaFault[]): QaFault[] {
  const merged = [...existing];
  const seen = new Set(merged.map((fault) => `${fault.type}|${fault.title}|${fault.url}|${fault.step}`));
  for (const fault of incoming) {
    if (!fault || !fault.title) continue;
    const key = `${fault.type}|${fault.title}|${fault.url}|${fault.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      severity: fault.severity || 'warning',
      type: fault.type || 'agent_issue',
      title: fault.title,
      details: fault.details || fault.title,
      evidence: Array.isArray(fault.evidence) ? fault.evidence : [],
      url: fault.url || '',
      step: fault.step || ''
    });
  }
  return merged;
}

function faultToBug(fault: QaFault): string | null {
  if (!['site_bug', 'validation_issue', 'blocked_flow', 'console_error'].includes(fault.type)) return null;
  if (fault.type === 'console_error' && fault.severity === 'warning') return null;
  return `${fault.title}: ${fault.details}`;
}

function makeReport(input: {
  result: CliReport['result'];
  scenario: string;
  summary: string;
  finalUrl: string;
  history: AgentHistoryEntry[];
  faults: QaFault[];
  evidence?: string[];
  warnings?: string[];
  consoleErrors?: string[];
}): CliReport {
  const confirmedBugs = input.faults.map(faultToBug).filter((bug): bug is string => Boolean(bug));
  const warnings = [
    ...(input.warnings || []),
    ...input.faults.filter((fault) => fault.severity === 'warning').map((fault) => `${fault.title}: ${fault.details}`)
  ];
  return {
    result: input.result,
    scenario: input.scenario,
    confirmedBugs,
    warnings,
    stepsExecuted: input.history.map((entry) => `${entry.step}. ${entry.action} -> ${entry.status}: ${entry.result}`),
    evidence: input.evidence?.length ? input.evidence : [input.summary],
    finalUrl: input.finalUrl,
    screenshots: [],
    consoleErrors: input.consoleErrors || [],
    fixRecommendations: confirmedBugs.length ? ['Review the confirmed fault log and fix the affected user flow.'] : [],
    faultLog: input.faults
  };
}

function resultToOk(report: QaRunResult): boolean {
  return report.status === 'PASS' || report.status === 'WARNING' || report.status === 'SKIPPED';
}

function addConsoleFaults(faults: QaFault[], observation: PageObservation, step: string): QaFault[] {
  const consoleFaults = observation.consoleErrors.map((error) => ({
    severity: 'warning' as const,
    type: 'console_error' as const,
    title: 'Console error observed',
    details: error.slice(0, 300),
    evidence: [error],
    url: observation.page.url || '',
    step
  }));
  return mergeFaults(faults, consoleFaults);
}

function countNumberedObjectives(prompt: string): number {
  return prompt
    .split(/\r?\n/)
    .filter((line) => /^\s*\d+\.\s+\S/.test(line))
    .length;
}

function objectiveCoverageCount(report: CliReport | null | undefined, plan: AgentPlanStep[]): number {
  return Math.max(
    report?.stepsExecuted?.length || 0,
    plan.filter((step) => step.status === 'DONE').length
  );
}

function normalizeExecutorTarget(value: string | undefined): AgentExecutorKind | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'standard' || normalized === 'standard-cdp' || normalized === 'cdp') return 'standard-cdp';
  if (normalized === 'browser-use' || normalized === 'browser_use' || normalized === 'browseruse') return 'browser-use';
  if (normalized === 'advanced' || normalized === 'browser-harness-dev' || normalized === 'browser_harness_dev') return 'browser-harness-dev';
  return null;
}

function recentFailureCount(history: AgentHistoryEntry[]): number {
  return history
    .slice(-6)
    .filter((entry) => entry.status === 'failed' || entry.status === 'blocked')
    .length;
}

function decideExecutorSwitch(input: {
  mode: AgentRunMode;
  allowEscalation: boolean;
  current: AgentExecutorKind;
  target: AgentExecutorKind | null;
  history: AgentHistoryEntry[];
}): { approved: boolean; target?: AgentExecutorKind; message: string } {
  if (!input.target) {
    return { approved: false, message: 'Executor switch denied: requested executor is missing or unknown.' };
  }
  if (input.target === input.current) {
    return { approved: false, message: `Executor switch denied: already using ${input.current}.` };
  }
  if (!isExecutorAvailable(input.target)) {
    return { approved: false, message: `Executor switch denied: ${input.target} is not installed or wired in this build.` };
  }
  if (input.target === 'browser-harness-dev' && input.mode !== 'advanced' && !input.allowEscalation) {
    return { approved: false, message: 'Executor switch denied: browser-harness-dev requires advanced mode or allowEscalation.' };
  }
  if (input.target !== 'standard-cdp' && recentFailureCount(input.history) < 2) {
    return { approved: false, message: 'Executor switch denied: not enough recent failed/blocked actions to justify escalation.' };
  }
  return { approved: true, target: input.target, message: `Executor switch approved: ${input.current} -> ${input.target}.` };
}

function buildStepBudgetPrompt(input: {
  taskName: string;
  currentUrl: string;
  history: AgentHistoryEntry[];
  plan: AgentPlanStep[];
  lastActionResult: string | null;
  maxSteps: number;
  observation: PageObservation;
}): string {
  return `You are AgentQA's step-budget controller. The run is at its max step limit.
Return strict JSON only. Decide whether a small step extension is justified.

Original task:
${input.taskName}

Current URL: ${input.currentUrl}
Current max steps: ${input.maxSteps}
Last action result: ${input.lastActionResult || 'None'}

Current plan:
${input.plan.map((step) => `${step.step}. [${step.status}] ${step.description}`).join('\n') || 'No plan.'}

Recent history:
${input.history.slice(-10).map((entry) => `${entry.step}. ${entry.action}${entry.targetId ? ` ${entry.targetId}` : ''} -> ${entry.status}: ${entry.result}`).join('\n') || 'None'}

Visible page text excerpt:
${input.observation.pageText.slice(0, 1200) || 'No page text detected.'}

Rules:
- Say needs_more_steps true only if the task is clearly near completion and the next steps are specific.
- Say false if the agent is looping, lost, missing required evidence, or just exploring.
- requested_steps must be between 1 and 15.
- confidence must be 0 to 1.

Return:
{
  "needs_more_steps": true,
  "requested_steps": 10,
  "reason": "Specific reason tied to current DOM/history.",
  "confidence": 0.85
}`;
}

export async function runQaTask(options: RunTaskOptions): Promise<TaskResult> {
  const { targetUrl, prompt, settings, cdpUrl, timeoutMs = 120000 } = options;
  const mode: AgentRunMode = options.mode || 'standard';
  const allowEscalation = Boolean(options.allowEscalation);
  const onStep = options.onStep || (() => {});
  const steps: TaskStep[] = [];
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();
  const runId = `qa-run-${crypto.randomUUID()}`;
  const testPlan = createTestPlan({ prompt, targetUrl, templateId: options.templateId });
  const evidenceCollector = new EvidenceCollector(runId, options.outputDir);
  const observations: PageObservation[] = [];
  const qaActions: QaRunAction[] = [];
  const evidence: string[] = [];
  let domBeforePath: string | undefined;
  let domAfterPath: string | undefined;
  let actionTracePath: string | undefined;
  let consoleLogPath: string | undefined;
  let networkLogPath: string | undefined;
  let accessibilityTreePath: string | undefined;
  let primaryScreenshotCaptured = false;
  let failureScreenshotCaptured = false;
  let executor: AgentExecutor | undefined;

  const addStep = (instruction: string, status: TaskStep['status'], result?: string, error?: string): void => {
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.instruction === instruction && lastStep.status === 'running') {
      lastStep.status = status;
      lastStep.result = result;
      lastStep.error = error;
      return;
    }
    if (lastStep && lastStep.status === 'running' && lastStep.instruction !== instruction) {
      lastStep.status = 'done';
    }
    steps.push({ instruction, status, result, error });
  };

  let observation = emptyObservation(targetUrl);
  let currentUrl = targetUrl;
  let plan: AgentPlanStep[] = [];
  let faults: QaFault[] = [];
  const history: AgentHistoryEntry[] = [];
  let lastActionResult: string | null = null;
  let lastSignature: string | null = null;
  let repeatCount = 0;
  let trapCount = 0;
  let blockedActionSignature: string | null = null;
  let resetDirective: string | null = null;
  let parseFailures = 0;
  let scrollStreak = 0;
  let blockedScrollAttempts = 0;
  let maxSteps = options.maxSteps && options.maxSteps > 0 ? options.maxSteps : 25;
  let stepBudgetExtensionsUsed = 0;
  const numberedObjectiveCount = countNumberedObjectives(prompt);

  const rememberObservation = (nextObservation: PageObservation): void => {
    observations.push(nextObservation);
  };

  const finishWithReport = async (legacyReport: CliReport, summary: string, url: string): Promise<TaskResult> => {
    const finalObservation = observation || emptyObservation(url);
    if (executor) {
      const finalScreenshot = await evidenceCollector.captureScreenshot(executor, '04_final_state.png', { required: true });
      if (finalScreenshot) evidence.push(finalScreenshot);
      const fullScreenshot = await evidenceCollector.captureScreenshot(executor, '04_final_state_full.png', { full: true, required: true });
      if (fullScreenshot) evidence.push(fullScreenshot);
      accessibilityTreePath = await evidenceCollector.saveAccessibilityTree(executor);
    }
    domAfterPath = evidenceCollector.saveDomSnapshot('dom-after.json', finalObservation);
    consoleLogPath = evidenceCollector.saveConsoleLog(observations);
    networkLogPath = evidenceCollector.saveNetworkLog(observations);
    if (executor && finalObservation.fieldRegistry) {
      const fieldResults = await executor.verifyFields(finalObservation.fieldRegistry);
      for (const entry of finalObservation.fieldRegistry) {
        const fr = fieldResults[entry.field_id];
        if (fr && fr.found) {
          entry.value = fr.value;
          entry.checked = fr.checked;
          entry.selected_value = fr.selected_value;
          entry.selected_label = fr.selected_label;
        }
      }
    }

    const assertions = verifyPlanAssertions({
      plan: testPlan,
      observation: finalObservation,
      llmReport: legacyReport,
      evidence: [...evidence, ...(legacyReport.evidence || [])],
      actions: qaActions
    });
    actionTracePath = evidenceCollector.saveActionTrace(qaActions);
    const artifacts = evidenceCollector.manifest({
      action_trace: actionTracePath,
      dom_before: domBeforePath,
      dom_after: domAfterPath,
      console_log: consoleLogPath,
      network_log: networkLogPath,
      accessibility_tree: accessibilityTreePath
    });
    const finalReport = buildQaRunResult({
      runId,
      plan: testPlan,
      targetUrl,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      actions: qaActions,
      assertions,
      observations,
      llmReport: legacyReport,
      evidence: [...evidence, ...(legacyReport.evidence || [])],
      evidenceWarnings: evidenceCollector.getWarnings(),
      artifacts
    });

    try {
      addStep('Running Validator LLM audit', 'running');
      onStep({ instruction: 'Running Validator LLM audit', status: 'running' });
      const validatorReview = await runValidatorAudit({ settings, result: finalReport, observations });
      applyValidatorGating(finalReport, validatorReview);
      addStep('Running Validator LLM audit', 'done', 'Validator review completed');
      onStep({ instruction: 'Running Validator LLM audit', status: 'done', result: 'Validator review completed' });
    } catch (err: any) {
      addStep('Running Validator LLM audit', 'failed', undefined, err.message);
      onStep({ instruction: 'Running Validator LLM audit', status: 'failed', error: err.message });
      console.error("Validator LLM failed", err);
    }

    writeQaReportFiles(evidenceCollector, finalReport);
    for (const step of steps) {
      if (step.status === 'running') step.status = resultToOk(finalReport) ? 'done' : 'failed';
    }
    return {
      ok: resultToOk(finalReport),
      summary: finalReport.summary || summary,
      steps,
      durationMs: finalReport.duration_ms,
      url,
      error: resultToOk(finalReport) ? null : finalReport.summary,
      report: finalReport
    };
  };

  if (!settings.apiKey) {
    const report = makeReport({
      result: 'AGENT_FAILED',
      scenario: prompt,
      summary: 'No API key configured.',
      finalUrl: targetUrl,
      history,
      faults: [{
        severity: 'critical',
        type: 'agent_issue',
        title: 'No API key configured',
        details: 'Save an API key in settings or pass --api-key so the QA agent can generate actions.',
        evidence: [],
        url: targetUrl,
        step: 'configuration'
      }],
      evidence: ['No API key configured.']
    });
    return finishWithReport(report, 'No API key configured.', targetUrl);
  }

  const executorStepHandler = (event: HarnessStepEvent): void => {
    onStep(event);
    addStep(event.instruction, event.status as TaskStep['status'], event.result, event.error);
  };
  executor = createAgentExecutor({
    mode,
    targetUrl,
    cdpUrl,
    timeoutMs,
    onStep: executorStepHandler
  });
  await executor.startSession({ targetUrl, mode, cdpUrl, timeoutMs });

  const maybeExtendStepBudget = async (stepNum: number): Promise<boolean> => {
    if (stepNum < maxSteps || stepBudgetExtensionsUsed >= 1) return false;
    addStep('Ask whether more steps are needed', 'running');
    onStep({ instruction: 'Ask whether more steps are needed', status: 'running' });
    try {
      const decision = parseStepBudgetDecision(await callForScript(settings, buildStepBudgetPrompt({
        taskName: prompt,
        currentUrl,
        history,
        plan,
        lastActionResult,
        maxSteps,
        observation
      })));
      const requested = Math.max(1, Math.min(15, Math.floor(decision.requestedSteps || 0)));
      if (decision.needsMoreSteps && requested > 0 && decision.confidence >= 0.75) {
        stepBudgetExtensionsUsed++;
        maxSteps += requested;
        const message = `Approved ${requested} more steps: ${decision.reason}`;
        history.push({ step: stepNum, action: 'extend_step_budget', value: String(requested), status: 'success', result: message, url: currentUrl });
        lastActionResult = message;
        addStep('Ask whether more steps are needed', 'done', message);
        onStep({ instruction: 'Ask whether more steps are needed', status: 'done', result: message });
        return true;
      }
      const message = `Step extension denied: ${decision.reason} (confidence ${decision.confidence.toFixed(2)})`;
      history.push({ step: stepNum, action: 'extend_step_budget', value: String(requested), status: 'blocked', result: message, url: currentUrl });
      lastActionResult = message;
      addStep('Ask whether more steps are needed', 'done', message);
      onStep({ instruction: 'Ask whether more steps are needed', status: 'done', result: message });
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      history.push({ step: stepNum, action: 'extend_step_budget', status: 'failed', result: message, url: currentUrl });
      lastActionResult = `Step extension check failed: ${message}`;
      addStep('Ask whether more steps are needed', 'failed', undefined, message);
      onStep({ instruction: 'Ask whether more steps are needed', status: 'failed', error: message });
      return false;
    }
  };

  addStep(`Open and inspect ${targetUrl}`, 'running');
  onStep({ instruction: `Open and inspect ${targetUrl}`, status: 'running' });

  const initial = await executor.openUrl(targetUrl);

  if (!initial.ok) {
    const report = makeReport({
      result: 'INFRA_FAILED',
      scenario: prompt,
      summary: initial.message,
      finalUrl: targetUrl,
      history,
      faults: [{
        severity: 'critical',
        type: 'infra',
        title: 'Initial browser observation failed',
        details: initial.message,
        evidence: [initial.message],
        url: targetUrl,
        step: 'initial observation'
      }],
      evidence: [initial.message]
    });
    return finishWithReport(report, 'Initial browser observation failed.', targetUrl);
  }

  observation = initial.observation;
  rememberObservation(observation);
  currentUrl = observation.page.url || targetUrl;
  faults = addConsoleFaults(faults, observation, 'initial observation');
  lastActionResult = `Loaded ${currentUrl}`;
  domBeforePath = evidenceCollector.saveDomSnapshot('dom-before.json', observation);
  const initialScreenshot = await evidenceCollector.captureScreenshot(executor, '00_initial_page.png', { required: true });
  if (initialScreenshot) evidence.push(initialScreenshot);
  const navigationScreenshot = await evidenceCollector.captureScreenshot(executor, '01_after_navigation.png', { required: true });
  if (navigationScreenshot) evidence.push(navigationScreenshot);

  for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
    addStep(`Plan next QA action (${stepNum}/${maxSteps})`, 'running');
    onStep({ instruction: `Plan next QA action (${stepNum}/${maxSteps})`, status: 'running' });

    const fullPrompt = buildPrompt({
      taskName: prompt,
      targetUrl,
      currentUrl,
      observation,
      history,
      plan,
      lastActionResult,
      blockedActionSignature,
      resetDirective,
      faults,
      visionMode: options.visionMode,
      mode,
      currentExecutor: executor.kind,
      allowEscalation
    });

    let parsed: AgentResponse;
    try {
      parsed = parseAgentResponse(await callForScript(settings, fullPrompt));
      parseFailures = 0;
    } catch (err) {
      parseFailures++;
      const message = err instanceof Error ? err.message : String(err);
      addStep(`Plan next QA action (${stepNum}/${maxSteps})`, 'failed', undefined, message);
      onStep({ instruction: `Plan next QA action (${stepNum}/${maxSteps})`, status: 'failed', error: message });
      history.push({
        step: stepNum,
        action: 'parse_agent_response',
        status: 'failed',
        result: message,
        url: currentUrl
      });
      lastActionResult = `Agent response parse failed: ${message}`;
      if (parseFailures >= 3) {
        const report = makeReport({
          result: 'AGENT_FAILED',
          scenario: prompt,
          summary: 'Agent returned invalid JSON repeatedly.',
          finalUrl: currentUrl,
          history,
          faults,
          evidence: [message],
          consoleErrors: observation.consoleErrors
        });
        return finishWithReport(report, 'Agent returned invalid JSON repeatedly.', currentUrl);
      }
      continue;
    }

    if (parsed.plan.length) plan = parsed.plan;
    faults = mergeFaults(faults, parsed.faults || []);

    addStep(`Plan next QA action (${stepNum}/${maxSteps})`, 'done', parsed.thought);
    onStep({ instruction: `Plan next QA action (${stepNum}/${maxSteps})`, status: 'done', result: parsed.thought });

    const action = parsed.activePhase;
    const initialTarget = findTarget(action, observation);
    const actionDescription = describeAction(action, initialTarget);

    if (parsed.report || action.action === 'finish_task' || action.action === 'fail_task') {
      const report = parsed.report || makeReport({
        result: action.action === 'finish_task' ? 'PASS' : 'AGENT_FAILED',
        scenario: prompt,
        summary: parsed.thought || action.reason || 'Task completed.',
        finalUrl: currentUrl,
        history,
        faults,
        evidence: [parsed.thought || action.reason || 'Task completed.'],
        consoleErrors: observation.consoleErrors
      });
      const coveredObjectives = objectiveCoverageCount(parsed.report, parsed.plan);
      if (report.result === 'PASS' && numberedObjectiveCount > 0 && coveredObjectives < numberedObjectiveCount) {
        const result = `Blocked premature PASS: only ${coveredObjectives} checklist items were marked complete/reported for ${numberedObjectiveCount} numbered objectives.`;
        history.push({ step: stepNum, action: action.action, status: 'blocked', result, url: currentUrl });
        lastActionResult = result;
        resetDirective = `You attempted to finish early. The original task has ${numberedObjectiveCount} numbered objectives. Continue from the current page and complete/verify every remaining objective before PASS.`;
        continue;
      }
      report.faultLog = mergeFaults(report.faultLog || [], faults);
      if (!report.consoleErrors?.length) report.consoleErrors = observation.consoleErrors;
      return finishWithReport(report, parsed.thought || report.evidence[0] || report.result, currentUrl);
    }

    if (action.action === 'request_executor_switch') {
      const targetKind = normalizeExecutorTarget(action.value);
      const decision = decideExecutorSwitch({
        mode,
        allowEscalation,
        current: executor.kind,
        target: targetKind,
        history
      });
      const previousKind = executor.kind;
      if (!decision.approved || !decision.target) {
        history.push({ step: stepNum, action: action.action, value: action.value || '', status: 'blocked', result: decision.message, url: currentUrl });
        lastActionResult = decision.message;
        resetDirective = `Executor switch was denied by policy. Continue with ${executor.kind}, choose a different safe action, or fail with evidence.`;
        continue;
      }

      await executor.stopSession();
      executor = createAgentExecutor({
        kind: decision.target,
        mode,
        targetUrl,
        cdpUrl,
        timeoutMs,
        onStep: executorStepHandler
      });
      await executor.startSession({ targetUrl, mode, cdpUrl, timeoutMs });
      const switchedObservation = await executor.observe();
      if (switchedObservation.ok) {
        observation = switchedObservation.observation;
        rememberObservation(observation);
        currentUrl = observation.page.url || currentUrl;
      }
      const result = switchedObservation.ok
        ? `${decision.message} Re-observed current page with ${decision.target}.`
        : `${decision.message} Re-observe failed after switch: ${switchedObservation.message}`;
      history.push({ step: stepNum, action: action.action, value: `${previousKind}->${decision.target}`, status: switchedObservation.ok ? 'success' : 'failed', result, url: currentUrl });
      lastActionResult = result;
      resetDirective = null;
      continue;
    }

    if (!isStructuredAction(action)) {
      const result = `Unsupported terminal action without report: ${action.action}`;
      history.push({ step: stepNum, action: action.action, status: 'failed', result, url: currentUrl });
      lastActionResult = result;
      continue;
    }

    if (isRestartNavigation(action, targetUrl, history)) {
      const result = `Blocked restart navigation to ${action.action === 'navigate' ? action.url : 'target URL inside batch'}`;
      history.push({ step: stepNum, action: action.action, value: action.action === 'navigate' ? action.url : actionSignature(action), status: 'blocked', result, url: currentUrl });
      lastActionResult = result;
      blockedActionSignature = actionSignature(action);
      resetDirective = `You attempted to restart the flow by navigating to the target URL. Do not restart. Continue from the current page state or fail with evidence.`;
      continue;
    }

    const signature = actionSignature(action);
    if (action.action === 'scroll' && scrollStreak >= 2) {
      blockedScrollAttempts++;
      const result = `Blocked scroll loop: already scrolled ${scrollStreak} times without a click, type, or navigation changing tactics.`;
      history.push({ step: stepNum, action: action.action, value: String(action.dy ?? ''), status: 'blocked', result, url: currentUrl });
      lastActionResult = result;
      resetDirective = `Stop scrolling. You have already used scrolling repeatedly. Choose a visible link/control, navigate to a specific forward URL if justified by the task, read/verify visible state, or fail with evidence. Do not restart from the beginning.`;
      if (blockedScrollAttempts >= 2) {
        const report = makeReport({
          result: 'AGENT_FAILED',
          scenario: prompt,
          summary: 'Agent got stuck scrolling and could not find a reliable next action.',
          finalUrl: currentUrl,
          history,
          faults,
          evidence: [result, observation.pageText.slice(0, 500)],
          consoleErrors: observation.consoleErrors
        });
        return finishWithReport(report, 'Agent got stuck scrolling.', currentUrl);
      }
      continue;
    }

    if (blockedActionSignature && signature === blockedActionSignature) {
      const result = `Blocked repeated action: ${signature}`;
      history.push({ step: stepNum, action: action.action, targetId: 'targetId' in action ? action.targetId : undefined, status: 'blocked', result, url: currentUrl });
      lastActionResult = result;
      resetDirective = `The previous action was explicitly forbidden because it caused a loop. Choose a different tactic or fail with evidence.`;
      continue;
    }

    repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
    lastSignature = signature;
    if (repeatCount >= 3) {
      trapCount++;
      blockedActionSignature = signature;
      resetDirective = `You repeated "${actionDescription}" three times. That exact action is now blocked. Choose a different visible element, scroll, read state, wait, navigate forward only when justified, or fail with evidence.`;
      const result = `Loop trap detected for action: ${actionDescription}`;
      history.push({ step: stepNum, action: action.action, targetId: 'targetId' in action ? action.targetId : undefined, status: 'blocked', result, url: currentUrl });
      lastActionResult = result;
      if (trapCount >= 2) {
        const report = makeReport({
          result: 'AGENT_FAILED',
          scenario: prompt,
          summary: 'Agent got stuck repeating actions and could not complete the QA task.',
          finalUrl: currentUrl,
          history,
          faults,
          evidence: [result],
          consoleErrors: observation.consoleErrors
        });
        return finishWithReport(report, 'Agent got stuck repeating actions.', currentUrl);
      }
      continue;
    }

    const resolved = resolveExecutableAction(action, observation, settings);
    if (resolved.error || !resolved.action) {
      const result = resolved.error || 'Action could not be resolved against the current DOM observation.';
      history.push({ step: stepNum, action: action.action, targetId: action.targetId, status: 'failed', result, url: currentUrl });
      qaActions.push({
        action_id: `A${String(qaActions.length + 1).padStart(3, '0')}`,
        action: action.action,
        target: action.targetId,
        input: action.value || action.key || action.url || null,
        action_result: 'BLOCKED',
        verification: {
          expected: 'Executable action resolved against current DOM',
          actual: result,
          status: 'BLOCKED',
          rootCause: 'AGENT_LIMITATION',
          message: result
        },
        timestamp: new Date().toISOString()
      });
      lastActionResult = result;
      resetDirective = `The requested target was not present. Select a visible targetId from the current available elements, scroll, read state, or fail with evidence.`;
      continue;
    }

    const target = resolved.target;
    const executableAction: StructuredAction = { ...resolved.action, description: actionDescription };
    addStep(actionDescription, 'running');
    onStep({ instruction: actionDescription, status: 'running' });

    const result = await executor.execute(executableAction, target);

    const parsedObservation = result.observation;
    if (parsedObservation.page.url || parsedObservation.availableElements.length || parsedObservation.pageText) {
      observation = parsedObservation;
      rememberObservation(observation);
      currentUrl = observation.page.url || currentUrl;
      faults = addConsoleFaults(faults, observation, actionDescription);
    }

    const actionResult = result.actionResult || result.message;
    let actionScreenshot: string | undefined;
    const actionId = `A${String(qaActions.length + 1).padStart(3, '0')}`;
    const majorAction = ['click', 'type', 'fill', 'select', 'check', 'uncheck', 'radio', 'press_key', 'navigate', 'batch'].includes(action.action);
    if (!primaryScreenshotCaptured && majorAction) {
      actionScreenshot = await evidenceCollector.captureScreenshot(executor, '02_after_primary_action.png');
      primaryScreenshotCaptured = true;
    }
    if (!result.ok) {
      const failureName = failureScreenshotCaptured ? `${actionId}_failure_state.png` : '03_failure_state.png';
      actionScreenshot = await evidenceCollector.captureScreenshot(executor, failureName, { required: true }) || actionScreenshot;
      failureScreenshotCaptured = true;
    } else if (!actionScreenshot && majorAction) {
      actionScreenshot = await evidenceCollector.captureScreenshot(executor, `${actionId}_after_${action.action}.png`);
    }

    history.push({
      step: stepNum,
      action: action.action,
      targetId: action.targetId,
      targetDescription: target?.description,
      value: action.value || action.key || action.url || String(action.dy ?? action.seconds ?? ''),
      status: result.ok ? (action.action === 'read' ? 'read' : 'success') : 'failed',
      result: actionResult,
      url: currentUrl
    });
    qaActions.push(verifyAction({
      actionId,
      action: executableAction,
      target,
      outcome: result,
      screenshot: actionScreenshot,
      timestamp: new Date().toISOString()
    }));
    if (actionScreenshot) evidence.push(actionScreenshot);

    lastActionResult = result.ok ? actionResult : `Action failed: ${actionResult}`;
    if (result.ok) {
      if (action.action === 'scroll') {
        scrollStreak++;
      } else if (['click', 'type', 'fill', 'select', 'check', 'uncheck', 'radio', 'press_key', 'navigate', 'batch'].includes(action.action)) {
        scrollStreak = 0;
        blockedScrollAttempts = 0;
      }
      resetDirective = null;
      if (signature !== blockedActionSignature) blockedActionSignature = null;
    } else {
      resetDirective = `The last action failed. Do not retry it blindly. Use the updated DOM, choose another tactic, or fail with evidence.`;
    }

    await maybeExtendStepBudget(stepNum);
  }

  const report = makeReport({
    result: 'AGENT_FAILED',
    scenario: prompt,
    summary: `Reached maximum limit of ${maxSteps} steps without completing the task.`,
    finalUrl: currentUrl,
    history,
    faults,
    evidence: [lastActionResult || 'Max steps limit exceeded.'],
    consoleErrors: observation.consoleErrors
  });
  return finishWithReport(report, report.evidence[0], currentUrl);
}
