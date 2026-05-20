import type { AgentExecutorKind, AgentRunMode, AppSettings } from '../shared/types';
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
  report?: CliReport;
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

function parseObservation(raw: string, targetUrl: string): PageObservation {
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
  const valueText = action.value ? ` value "${action.value.slice(0, 80)}"` : '';
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

function resolveExecutableAction(action: StructuredAction, observation: PageObservation): { action?: StructuredAction; target: ObservedElement | null; error?: string } {
  if (action.action !== 'batch') {
    const target = targetForId(action.targetId, observation);
    if (['click', 'type', 'read'].includes(action.action) && !target) {
      return { target: null, error: `Target ${action.targetId || '(missing)'} is not available in the current DOM observation.` };
    }
    return { action, target };
  }

  const subactions = action.actions || [];
  if (typeof action.confidence !== 'number' || action.confidence < 0.9) {
    return { target: null, error: 'Batch action blocked: confidence must be at least 0.90.' };
  }
  if (subactions.length < 2 || subactions.length > 5) {
    return { target: null, error: 'Batch action blocked: it must contain 2 to 5 sub-actions.' };
  }

  const resolvedSubactions: StructuredAction[] = [];
  for (const [index, item] of subactions.entries()) {
    if (item.action === 'batch') {
      return { target: null, error: `Batch action blocked: nested batch at sub-action ${index + 1}.` };
    }
    const target = targetForId(item.targetId, observation);
    if (['click', 'type', 'read'].includes(item.action) && !target) {
      return { target: null, error: `Batch action blocked: target ${item.targetId || '(missing)'} is unavailable for sub-action ${index + 1}.` };
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

function resultToOk(report: CliReport): boolean {
  return report.result === 'PASS';
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

export async function runQaTask(options: RunTaskOptions): Promise<TaskResult> {
  const { targetUrl, prompt, settings, cdpUrl, timeoutMs = 120000 } = options;
  const mode: AgentRunMode = options.mode || 'standard';
  const allowEscalation = Boolean(options.allowEscalation);
  const onStep = options.onStep || (() => {});
  const steps: TaskStep[] = [];
  const startTime = Date.now();

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

  const finishWithReport = (report: CliReport, summary: string, url: string): TaskResult => {
    for (const step of steps) {
      if (step.status === 'running') step.status = report.result === 'PASS' ? 'done' : 'failed';
    }
    return {
      ok: resultToOk(report),
      summary,
      steps,
      durationMs: Date.now() - startTime,
      url,
      error: resultToOk(report) ? null : (report.confirmedBugs.join(', ') || report.warnings.join(', ') || summary),
      report
    };
  };

  if (!settings.apiKey) {
    return {
      ok: false,
      summary: 'No API key configured.',
      steps,
      durationMs: Date.now() - startTime,
      url: targetUrl,
      error: 'Save an API key in settings or pass --api-key so the QA agent can generate actions.'
    };
  }

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
  const maxSteps = options.maxSteps && options.maxSteps > 0 ? options.maxSteps : 25;
  const numberedObjectiveCount = countNumberedObjectives(prompt);
  const executorStepHandler = (event: HarnessStepEvent): void => {
    onStep(event);
    addStep(event.instruction, event.status as TaskStep['status'], event.result, event.error);
  };
  let executor: AgentExecutor = createAgentExecutor({
    mode,
    targetUrl,
    cdpUrl,
    timeoutMs,
    onStep: executorStepHandler
  });
  await executor.startSession({ targetUrl, mode, cdpUrl, timeoutMs });

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
  currentUrl = observation.page.url || targetUrl;
  faults = addConsoleFaults(faults, observation, 'initial observation');
  lastActionResult = `Loaded ${currentUrl}`;

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

    const resolved = resolveExecutableAction(action, observation);
    if (resolved.error || !resolved.action) {
      const result = resolved.error || 'Action could not be resolved against the current DOM observation.';
      history.push({ step: stepNum, action: action.action, targetId: action.targetId, status: 'failed', result, url: currentUrl });
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
      currentUrl = observation.page.url || currentUrl;
      faults = addConsoleFaults(faults, observation, actionDescription);
    }

    const actionResult = result.actionResult || result.message;

    history.push({
      step: stepNum,
      action: action.action,
      targetId: action.targetId,
      targetDescription: target?.description,
      value: action.value || action.url || String(action.dy ?? action.seconds ?? ''),
      status: result.ok ? (action.action === 'read' ? 'read' : 'success') : 'failed',
      result: actionResult,
      url: currentUrl
    });

    lastActionResult = result.ok ? actionResult : `Action failed: ${actionResult}`;
    if (result.ok) {
      if (action.action === 'scroll') {
        scrollStreak++;
      } else if (['click', 'type', 'navigate', 'batch'].includes(action.action)) {
        scrollStreak = 0;
        blockedScrollAttempts = 0;
      }
      resetDirective = null;
      if (signature !== blockedActionSignature) blockedActionSignature = null;
    } else {
      resetDirective = `The last action failed. Do not retry it blindly. Use the updated DOM, choose another tactic, or fail with evidence.`;
    }
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
