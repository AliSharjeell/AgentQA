import fs from 'node:fs';
import path from 'node:path';
import type { AgentExecutorKind, AgentRunMode } from '../shared/types';
import type { PageObservation, QaFault } from './harness';
import { detectTaskIntent, elementRegistryForObservation } from './intent';
import type { QaObjectiveProgress } from './state';
import { buildObjectiveProgress } from './state';

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
  thought?: string;
  pageSummary?: string;
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
  mode?: AgentRunMode;
  currentExecutor?: AgentExecutorKind;
  allowEscalation?: boolean;
  objectiveProgress?: QaObjectiveProgress;
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
1. You are a general QA agent. Do not assume every task is a form-fill task.
2. Use the full observed page state: fields, buttons, links, menus, search controls, product cards, headings, text, modals, and navigation.
3. If no editable fields exist, continue with other interactive elements. Do not stop because FieldRegistry is empty.
4. Maintain the full task plan and mark only verified steps as DONE.
5. If a tactic fails, choose a different visible affordance, scroll, read state, wait, or fail with evidence.
6. Never claim PASS without DOM/page evidence.
7. Only report a website bug when deterministic evidence proves the product behavior is wrong.
8. For transaction/cart tasks, viewing a cart/bag icon or menu is not the same as adding an item. Verify an add action and final cart/bag state.
9. Do not jump directly to the final CTA if the page has unresolved required sections.
10. If an action (like clicking a button) fails or does not advance the state, reason about missing prerequisites. Scroll up to check for unfulfilled requirements (e.g., missed required fields, unchecked terms, or missing prior steps).`;
}

function summarizeFields(observation: PageObservation): string {
  return (observation.fieldRegistry || [])
    .slice(0, 80)
    .map((field) => {
      const flags = [
        field.value ? `value=${String(field.value).slice(0, 80)}` : '',
        field.selected_label ? `selected=${field.selected_label}` : '',
        typeof field.checked === 'boolean' ? `checked=${field.checked}` : '',
        field.selector ? `selector=${field.selector.slice(0, 90)}` : ''
      ].filter(Boolean).join(', ');
      return `- ${field.temporary_observation_id} / ${field.field_id} (${field.type}): "${field.label}"${flags ? ` [${flags}]` : ''}`;
    })
    .join('\n') || 'No editable fields detected.';
}

function summarizeElements(observation: PageObservation): string {
  return elementRegistryForObservation(observation)
    .slice(0, 100)
    .map((el) => {
      const flags = [
        el.disabled ? 'disabled' : '',
        el.checked ? 'checked' : '',
        el.selected ? 'selected' : '',
        typeof el.expanded === 'boolean' ? `expanded=${el.expanded}` : '',
        el.selector ? `selector=${el.selector.slice(0, 90)}` : '',
        el.classes && !el.description.includes(el.classes) ? `class=${el.classes.slice(0, 80)}` : '',
        el.href ? `href=${el.href.slice(0, 120)}` : '',
        el.value ? `value=${String(el.value).slice(0, 80)}` : '',
        el.options?.length ? `options=${el.options.map((option) => `${option.selected ? '*' : ''}${option.label || option.value}`).filter(Boolean).slice(0, 12).join(' | ').slice(0, 240)}` : ''
      ].filter(Boolean).join(', ');
      return `- ${el.id} (${el.type}): "${el.description}"${flags ? ` [${flags}]` : ''}`;
    })
    .join('\n') || 'No interactable elements detected.';
}

function summarizeHistory(history: AgentHistoryEntry[]): string {
  return history
    .map((entry) => {
      const target = entry.targetId ? ` ${entry.targetId}` : '';
      const value = entry.value ? ` value="${entry.value.slice(0, 80)}"` : '';
      const thoughtStr = entry.thought ? `\n   Reasoning: ${entry.thought}` : '';
      const summaryStr = entry.pageSummary ? `\n   Page Context: ${entry.pageSummary}` : '';
      return `${entry.step}. ${entry.action}${target}${value} -> ${entry.status}: ${entry.result}${thoughtStr}${summaryStr}`;
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

function summarizeObjectiveProgress(progress: QaObjectiveProgress): string {
  const next = progress.next_unresolved_section;
  return [
    `Current goal: ${progress.current_goal}`,
    `Milestones: ${JSON.stringify(progress.milestones)}`,
    next ? `Next unresolved section: ${next.section_label}` : 'Next unresolved section: none detected',
    next ? `Reason: ${next.reason}` : '',
    next?.candidate_actions.length
      ? `Candidate actions: ${next.candidate_actions.map((action) => `${action.id || ''} "${action.label}" ${action.enabled ? 'enabled' : 'disabled'}`).join('; ')}`
      : '',
    progress.final_cta_search_gated ? 'Final CTA search is gated: resolve the current required/prerequisite section before searching for the final CTA.' : 'Final CTA search is not currently gated.',
    progress.clicked_elements.length ? `Already clicked/changed: ${progress.clicked_elements.join(' | ')}` : '',
    progress.visited_scroll_positions.length ? `Visited scroll positions: ${progress.visited_scroll_positions.join(', ')}` : '',
    progress.recent_no_progress_actions.length ? `No-progress actions: ${progress.recent_no_progress_actions.join(' | ')}` : '',
    progress.warnings.length ? `Warnings: ${progress.warnings.join(' ')}` : '',
    `Action priority: ${progress.action_priority.join(' -> ')}`
  ].filter(Boolean).join('\n');
}

export function buildPrompt(input: PromptInput): string {
  const taskIntent = detectTaskIntent(input.taskName);
  const objectiveProgress = input.objectiveProgress || buildObjectiveProgress({
    task: input.taskName,
    intent: taskIntent.intent,
    observation: input.observation,
    actions: [],
    history: input.history
  });
  const visionRules = input.visionMode
    ? `Vision mode is enabled. You may report visual bugs only when backed by screenshot or DOM/visual evidence available in context.`
    : `Text mode is enabled. Do not report visual-only bugs as confirmed. Add a warning if a visual check is required but unavailable.`;

  return `You are AgentQA, a QA automation agent controlling a browser through a strict action protocol.
You do not write Python or JavaScript. You return one JSON object only. The engine executes exactly one active action and then sends you the updated page state.

Task: ${input.taskName}
Target URL: ${input.targetUrl}
Current URL: ${input.currentUrl}
Current title: ${input.observation.page.title || ''}
Task intent: ${taskIntent.intent} (${taskIntent.verificationStyle})
Run mode: ${input.mode || 'standard'}
Current executor: ${input.currentExecutor || 'standard-cdp'}
Executor escalation allowed: ${input.allowEscalation ? 'yes' : 'no'}
Last action result: ${input.lastActionResult || 'None'}

Current plan:
${summarizePlan(input.plan)}

Action history:
${summarizeHistory(input.history)}

Known QA faults:
${summarizeFaults(input.faults)}

Objective progress memory:
${summarizeObjectiveProgress(objectiveProgress)}

${input.resetDirective ? `Loop reset directive:\n${input.resetDirective}\n` : ''}
${input.blockedActionSignature ? `Forbidden next action signature: ${input.blockedActionSignature}\n` : ''}

FieldRegistry (editable controls only):
${summarizeFields(input.observation)}

ElementRegistry (all observed interactive affordances):
${summarizeElements(input.observation)}

Page text excerpt:
${input.observation.pageText.slice(0, 2600) || 'No page text detected.'}

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
- fill/type: requires targetId and value. Use only for editable controls in FieldRegistry or clearly editable targets in ElementRegistry.
- select: requires targetId and value. Use for native <select>, comboboxes, dropdowns, listboxes, and menu/list choices when the desired option text/value is known. The engine verifies the selected DOM value after the action.
- check/uncheck/radio: requires targetId and verifies checked state after the action.
- hover: requires targetId.
- upload_file: requires targetId and absolute file path value.
- press_key: use value or key for special keys only, such as Enter, Escape, Tab, ArrowDown, ArrowUp. Do not use for normal text entry.
- wait_for: requires targetId or selector-like value and waits for visibility.
- read: requires targetId.
- scroll: use dy, negative scrolls down in browser-harness.
- wait: use seconds, max 10.
- assert_text/assert_url/assert_visible/assert_value/assert_checked/assert_selected/assert_count: use when the expected final state is known. Assertion failures are website bugs only when the expected behavior is clear.
- screenshot: requires an output path value. Prefer letting the engine collect standard evidence screenshots automatically.
- navigate: use only to follow an actual intended URL, never to restart the same flow after failure.
- batch: multiple deterministic sub-actions in one browser turn (configured dynamically, usually up to 50). Use only when confidence is 0.90 or higher, such as filling visible fields then clicking their visible submit/continue control. Do not batch steps that require observing changed DOM between them.
- request_executor_switch: use only when the current executor is objectively blocked. Set value to "standard-cdp", "browser-use", or "browser-harness-dev". The orchestrator may deny the request.
- finish_task: only when PASS/FAIL/AGENT_FAILED/INFRA_FAILED report is ready.
- fail_task: when you must stop with a non-PASS report.

Important:
- The original task text is authoritative. Do not rewrite, shorten, or replace the scenario.
- If the task contains a numbered checklist, every numbered item must be completed or explicitly failed before PASS.
- Do not restart the task from the beginning when stuck.
- You are not limited to form fields. Use clickable links, buttons, menus, nav bars, search boxes, filters, cards, dropdowns, modals, forms, page text, and headings.
- For each step: understand the current goal, pick the most relevant visible affordance, execute safe action(s), observe again, and stop only when the goal can be verified.
- Do not jump directly to the final CTA if the page has unresolved required sections. Complex flows often require selecting options, answering prerequisite questions, or scrolling through sections before the final button appears.
- Action selection priority: first resolve a visible required/unresolved section; second click a relevant next/continue/add/final CTA only when prerequisites appear resolved or the CTA is already visible; third scroll to reveal the next section only when current viewport has no useful unresolved controls; fourth open cart/bag only after add action or once for diagnostic evidence; fifth stop as blocked after no-progress evidence.
- If no elements are detected after navigation, wait and re-observe before acting. Do not scroll from an empty observation.
- Avoid repeating the same scroll/click without new evidence.
- If FieldRegistry is empty but ElementRegistry has usable affordances, continue planning with ElementRegistry.
- Only block on missing fields when the current step specifically requires an editable field.
- Prefer a high-confidence batch for obvious forms with all required fields and submit button visible. Include "confidence": 0.90 or higher. If not that certain, use one action.
- For native select elements with listed options, use select with the exact visible option label or option value.
- For custom dropdowns/comboboxes, click or select the control, then observe/select a visible role=option/menuitem/list option. If the popup has a search field, type into the searchbox/textbox first and press_key Enter only when that is how the widget confirms.
- For popup search inputs, type only into the visible input/searchbox/textbox/contenteditable target. If typing does not change its value/text in the next observation, choose another visible editable target or fail as AGENT_FAILED with evidence.
- Do not keep scrolling as a search strategy. After two scrolls without finding a useful visible target, choose a different tactic or fail with evidence.
- Do not ask to switch executors unless recent action results show repeated failures or an executor limitation.
- When close to the step limit, do not rush a false PASS. The harness may separately ask for a bounded step extension if the task is clearly near completion.
- If an element is missing, scroll/read/wait or choose another visible element.
- If selecting product options, choose the required base/default option from current DOM text and verify selection before add-to-cart.
- For cart tasks, do not treat a global cart/bag icon click as an add-to-cart/add-to-bag action. It can only verify cart state.
- Never treat a missing final CTA as a website bug until required prerequisites are resolved and deterministic verification confirms the final action is unavailable.
- Keep a QA fault log. A failed automation action is not automatically a site bug.
- PASS must cite exact DOM/cart evidence when the task requires exact product names or cart contents.
- If the task cannot progress because the needed UI affordance is missing, report AGENT_FAILED with a clear REQUIRED_AFFORDANCE_NOT_FOUND reason.
- ${visionRules}

Return exactly this JSON shape:
{
  "thought": "Short reasoning for the next action.",
  "pageSummary": "Very brief summary of what you currently see on the screen (e.g. Shopping cart with 1 item, or specific product page).",
  "plan": [
    { "step": 1, "description": "Open relevant page", "status": "DONE" },
    { "step": 2, "description": "Current work", "status": "CURRENT" }
  ],
  "activePhase": {
    "action": "click | fill | type | select | check | uncheck | radio | hover | upload_file | press_key | wait_for | read | scroll | wait | navigate | assert_text | assert_url | assert_visible | assert_value | assert_checked | assert_selected | assert_count | screenshot | batch | request_executor_switch | finish_task | fail_task",
    "targetId": "elem_0 when needed",
    "value": "text when needed",
    "key": "Enter when action is press_key",
    "url": "url when action is navigate",
    "dy": -650,
    "seconds": 1,
    "confidence": 0.95,
    "actions": [
      { "action": "type", "targetId": "elem_0", "value": "text" },
      { "action": "click", "targetId": "elem_1" }
    ],
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
