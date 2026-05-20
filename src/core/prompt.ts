import fs from 'node:fs';
import path from 'node:path';
import type { PageObservation, QaFault } from './harness';

export interface AgentPlanStep {
  step: number;
  description: string;
  status: 'DONE' | 'CURRENT' | 'PENDING';
}

export interface AgentHistoryEntry {
  step: number;
  action: string;
  targetId?: string;
  targetDescription?: string;
  value?: string;
  status: 'success' | 'failed' | 'blocked' | 'read';
  result: string;
  url: string;
}

export interface PromptInput {
  taskName: string;
  targetUrl: string;
  currentUrl: string;
  observation: PageObservation;
  history: AgentHistoryEntry[];
  plan: AgentPlanStep[];
  lastActionResult: string | null;
  blockedActionSignature: string | null;
  resetDirective: string | null;
  faults: QaFault[];
  visionMode?: boolean;
}

function getCoreBehaviourRules(): string {
  try {
    const customPath = path.join(process.cwd(), 'default_system_prompt.txt');
    if (fs.existsSync(customPath)) {
      return fs.readFileSync(customPath, 'utf8').trim();
    }
  } catch {
    // Ignore custom prompt loading failures.
  }

  return `Core behavior rules:
1. Maintain the full task plan and mark only verified steps as DONE.
2. Use the current page state. Do not restart the flow when stuck.
3. If a tactic fails, choose a different visible element, scroll, read state, wait, or fail with evidence.
4. Never claim PASS without DOM/page evidence.
5. Log confirmed site faults separately from agent/tool failures.`;
}

function summarizeElements(observation: PageObservation): string {
  return observation.availableElements
    .slice(0, 180)
    .map((el) => {
      const flags = [
        el.disabled ? 'disabled' : '',
        el.checked ? 'checked' : '',
        el.selected ? 'selected' : '',
        el.href ? `href=${el.href.slice(0, 120)}` : '',
        el.value ? `value=${String(el.value).slice(0, 80)}` : ''
      ].filter(Boolean).join(', ');
      return `- ${el.id} (${el.type}): "${el.description}"${flags ? ` [${flags}]` : ''}`;
    })
    .join('\n') || 'No interactable elements detected.';
}

function summarizeHistory(history: AgentHistoryEntry[]): string {
  return history
    .slice(-15)
    .map((entry) => {
      const target = entry.targetId ? ` ${entry.targetId}` : '';
      const value = entry.value ? ` value="${entry.value.slice(0, 80)}"` : '';
      return `${entry.step}. ${entry.action}${target}${value} -> ${entry.status}: ${entry.result}`;
    })
    .join('\n') || 'None';
}

function summarizePlan(plan: AgentPlanStep[]): string {
  return plan
    .map((step) => `${step.step}. [${step.status}] ${step.description}`)
    .join('\n') || 'No plan yet. Create one now.';
}

function summarizeFaults(faults: QaFault[]): string {
  return faults
    .map((fault, index) => `${index + 1}. [${fault.severity}/${fault.type}] ${fault.title}: ${fault.details}`)
    .join('\n') || 'None';
}

export function buildPrompt(input: PromptInput): string {
  const visionRules = input.visionMode
    ? `Vision mode is enabled. You may report visual bugs only when backed by screenshot or DOM/visual evidence available in context.`
    : `Text mode is enabled. Do not report visual-only bugs as confirmed. Add a warning if a visual check is required but unavailable.`;

  return `You are AgentQA, a QA automation agent controlling a browser through a strict action protocol.
You do not write Python or JavaScript. You return one JSON object only. The engine executes exactly one active action and then sends you the updated page state.

Task: ${input.taskName}
Target URL: ${input.targetUrl}
Current URL: ${input.currentUrl}
Current title: ${input.observation.page.title || ''}
Last action result: ${input.lastActionResult || 'None'}

Current plan:
${summarizePlan(input.plan)}

Action history:
${summarizeHistory(input.history)}

Known QA faults:
${summarizeFaults(input.faults)}

${input.resetDirective ? `Loop reset directive:\n${input.resetDirective}\n` : ''}
${input.blockedActionSignature ? `Forbidden next action signature: ${input.blockedActionSignature}\n` : ''}

Available elements:
${summarizeElements(input.observation)}

Page text excerpt:
${input.observation.pageText.slice(0, 4500) || 'No page text detected.'}

Console errors:
${input.observation.consoleErrors.length ? input.observation.consoleErrors.join('\n') : 'None'}

${getCoreBehaviourRules()}

QA result classification:
- PASS: the task objective is completed and verified with DOM/page evidence, and no confirmed site bug blocks the scenario.
- FAIL: a genuine website/app bug is confirmed with evidence.
- AGENT_FAILED: automation cannot complete or prove the result, or you are blocked/stuck without confirmed site bug evidence.
- INFRA_FAILED: browser, CDP, harness, network startup, or tool failure.

Action protocol:
- click: requires targetId.
- type: requires targetId and value.
- read: requires targetId.
- scroll: use dy, negative scrolls down in browser-harness.
- wait: use seconds, max 10.
- navigate: use only to follow an actual intended URL, never to restart the same flow after failure.
- finish_task: only when PASS/FAIL/AGENT_FAILED/INFRA_FAILED report is ready.
- fail_task: when you must stop with a non-PASS report.

Important:
- Do not restart the task from the beginning when stuck.
- If an element is missing, scroll/read/wait or choose another visible element.
- If selecting product options, choose the required base/default option from current DOM text and verify selection before add-to-cart.
- Keep a QA fault log. A failed automation action is not automatically a site bug.
- PASS must cite exact DOM/cart evidence when the task requires exact product names or cart contents.
- ${visionRules}

Return exactly this JSON shape:
{
  "thought": "Short reasoning for the next action.",
  "plan": [
    { "step": 1, "description": "Open relevant page", "status": "DONE" },
    { "step": 2, "description": "Current work", "status": "CURRENT" }
  ],
  "activePhase": {
    "action": "click | type | read | scroll | wait | navigate | finish_task | fail_task",
    "targetId": "elem_0 when needed",
    "value": "text when needed",
    "url": "url when action is navigate",
    "dy": -650,
    "seconds": 1,
    "reason": "why this action is next"
  },
  "faults": [
    {
      "severity": "critical | major | minor | warning",
      "type": "site_bug | validation_issue | console_error | blocked_flow | agent_issue | infra",
      "title": "short title",
      "details": "what happened and why it matters",
      "evidence": ["DOM/page/action evidence"],
      "url": "${input.currentUrl}",
      "step": "related step"
    }
  ],
  "report": null
}

When finishing, activePhase.action must be "finish_task" or "fail_task" and report must be:
{
  "result": "PASS | FAIL | INFRA_FAILED | AGENT_FAILED",
  "scenario": "${input.taskName}",
  "confirmedBugs": ["confirmed website bugs only"],
  "warnings": ["warnings and limitations"],
  "stepsExecuted": ["important executed steps"],
  "evidence": ["specific DOM/page evidence for the result"],
  "finalUrl": "${input.currentUrl}",
  "screenshots": [],
  "consoleErrors": [],
  "fixRecommendations": ["developer recommendations when there is a confirmed site bug"],
  "faultLog": []
}`;
}

export function normalizeScript(script: string): string {
  const trimmed = script.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
