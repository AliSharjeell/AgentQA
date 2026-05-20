import type { AppSettings } from '../shared/types';
import { callForScript } from './api';
import {
  buildActionScript,
  buildObservationScript,
  runHarnessScript,
  type CliReport,
  type HarnessStepEvent,
  type ObservedElement,
  type PageObservation,
  type QaFault,
  type StructuredAction
} from './harness';
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
}

type FinishAction = 'finish_task' | 'fail_task';
type AgentAction = StructuredAction | ({ action: FinishAction; reason?: string; description?: string });

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
  const parsed = JSON.parse(json) as Partial<AgentResponse>;
  if (!parsed.activePhase || typeof parsed.activePhase.action !== 'string') {
    throw new Error(`Agent response missing activePhase.action: ${json}`);
  }
  return {
    thought: parsed.thought || '',
    plan: Array.isArray(parsed.plan) ? parsed.plan : [],
    activePhase: parsed.activePhase,
    faults: Array.isArray(parsed.faults) ? parsed.faults : [],
    report: parsed.report || null
  };
}

function isStructuredAction(action: AgentAction): action is StructuredAction {
  return !['finish_task', 'fail_task'].includes(action.action);
}

function describeAction(action: AgentAction, target?: ObservedElement | null): string {
  if (!isStructuredAction(action)) return action.action === 'finish_task' ? 'Finish task' : 'Fail task';
  const targetText = target ? ` ${target.id} "${target.description}"` : '';
  const valueText = action.value ? ` value "${action.value.slice(0, 80)}"` : '';
  return `${action.action}${targetText}${valueText}`;
}

function actionSignature(action: AgentAction): string {
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
  if (!isStructuredAction(action) || action.action !== 'navigate' || !action.url || history.length === 0) return false;
  return normalizeUrl(action.url) === normalizeUrl(targetUrl);
}

function findTarget(action: AgentAction, observation: PageObservation): ObservedElement | null {
  if (!isStructuredAction(action) || !action.targetId) return null;
  return observation.availableElements.find((el) => el.id === action.targetId) || null;
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

export async function runQaTask(options: RunTaskOptions): Promise<TaskResult> {
  const { targetUrl, prompt, settings, cdpUrl, timeoutMs = 120000 } = options;
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
  const maxSteps = 30;

  addStep(`Open and inspect ${targetUrl}`, 'running');
  onStep({ instruction: `Open and inspect ${targetUrl}`, status: 'running' });

  const initial = await runHarnessScript(buildObservationScript(targetUrl, true), (event) => {
    onStep(event);
    addStep(event.instruction, event.status as TaskStep['status'], event.result, event.error);
  }, cdpUrl, timeoutMs);

  if (!initial.ok) {
    const report = makeReport({
      result: 'INFRA_FAILED',
      scenario: prompt,
      summary: initial.error || initial.summary,
      finalUrl: targetUrl,
      history,
      faults: [{
        severity: 'critical',
        type: 'infra',
        title: 'Initial browser observation failed',
        details: initial.error || initial.summary,
        evidence: [initial.summary, initial.error || ''],
        url: targetUrl,
        step: 'initial observation'
      }],
      evidence: [initial.error || initial.summary]
    });
    return finishWithReport(report, 'Initial browser observation failed.', targetUrl);
  }

  observation = parseObservation(initial.summary, targetUrl);
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
      visionMode: options.visionMode
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
    const target = findTarget(action, observation);
    const actionDescription = describeAction(action, target);

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
      report.faultLog = mergeFaults(report.faultLog || [], faults);
      if (!report.consoleErrors?.length) report.consoleErrors = observation.consoleErrors;
      return finishWithReport(report, parsed.thought || report.evidence[0] || report.result, currentUrl);
    }

    if (!isStructuredAction(action)) {
      const result = `Unsupported terminal action without report: ${action.action}`;
      history.push({ step: stepNum, action: action.action, status: 'failed', result, url: currentUrl });
      lastActionResult = result;
      continue;
    }

    if (isRestartNavigation(action, targetUrl, history)) {
      const result = `Blocked restart navigation to ${action.url}`;
      history.push({ step: stepNum, action: 'navigate', value: action.url, status: 'blocked', result, url: currentUrl });
      lastActionResult = result;
      blockedActionSignature = actionSignature(action);
      resetDirective = `You attempted to restart the flow by navigating to the target URL. Do not restart. Continue from the current page state or fail with evidence.`;
      continue;
    }

    const signature = actionSignature(action);
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

    if (['click', 'type', 'read'].includes(action.action) && !target) {
      const result = `Target ${action.targetId || '(missing)'} is not available in the current DOM observation.`;
      history.push({ step: stepNum, action: action.action, targetId: action.targetId, status: 'failed', result, url: currentUrl });
      lastActionResult = result;
      resetDirective = `The requested target was not present. Select a visible targetId from the current available elements, scroll, read state, or fail with evidence.`;
      continue;
    }

    const executableAction: StructuredAction = { ...action, description: actionDescription };
    addStep(actionDescription, 'running');
    onStep({ instruction: actionDescription, status: 'running' });

    const result = await runHarnessScript(buildActionScript(executableAction, target, targetUrl), (event) => {
      onStep(event);
      addStep(event.instruction, event.status as TaskStep['status'], event.result, event.error);
    }, cdpUrl, timeoutMs);

    const parsedObservation = parseObservation(result.summary, targetUrl);
    if (parsedObservation.page.url || parsedObservation.availableElements.length || parsedObservation.pageText) {
      observation = parsedObservation;
      currentUrl = observation.page.url || currentUrl;
      faults = addConsoleFaults(faults, observation, actionDescription);
    }

    const actionResult = (() => {
      try {
        const summary = JSON.parse(result.summary) as { actionResult?: string };
        return summary.actionResult || result.summary;
      } catch {
        return result.error || result.summary;
      }
    })();

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
