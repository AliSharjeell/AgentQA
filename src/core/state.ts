import type {
  FieldRegistry,
  QaCompactElementState,
  QaCompactFinalState,
  QaObjectiveMilestone,
  QaRootCause,
  QaRunAction,
  QaTaskIntent,
  QaVerdict
} from '../shared/types';
import type { ObservedElement, PageObservation } from './harness';
import { truncateText } from './chunker';
import { elementRegistryForObservation, extractGoalKeywords } from './intent';

export interface CompactStateLimits {
  maxVerifierFields: number;
  maxVerifierElements: number;
  maxTextPerElement: number;
  maxPageText: number;
}

const DEFAULT_LIMITS: CompactStateLimits = {
  maxVerifierFields: 80,
  maxVerifierElements: 120,
  maxTextPerElement: 160,
  maxPageText: 6000
};

type TransactionActionClass = 'ADD_ACTION' | 'CART_VIEW' | 'OTHER';

export interface QaPlanningSection {
  section_label: string;
  reason: string;
  candidate_actions: QaCompactElementState[];
}

export interface QaObjectiveProgress {
  current_goal: string;
  milestones: {
    target_page_reached: boolean;
    required_sections_seen: string[];
    required_sections_resolved: string[];
    final_cta_found: boolean;
    final_cta_clicked: boolean;
    cart_state_verified: boolean;
  };
  next_unresolved_section?: QaPlanningSection;
  final_cta_search_gated: boolean;
  recent_no_progress_actions: string[];
  clicked_elements: string[];
  visited_scroll_positions: number[];
  action_priority: string[];
  warnings: string[];
}

type HistoryLike = Array<{
  action: string;
  targetId?: string;
  targetDescription?: string;
  value?: string;
  result: string;
  status: string;
}>;

const REQUIRED_SECTION_RE = /\b(choose|select|required|option|model|variant|color|size|storage|plan|carrier|payment|billing|method|trade in|trade-in|protection|coverage|delivery|pickup|shipping|terms|contact|address|email|phone|name|configuration|customize|preference)\b/i;
const FINAL_ACTION_RE = /\b(add to cart|add to bag|add to basket|add item|add product|submit|checkout|save|apply|continue|create account|book|reserve|send|buy|purchase|place order)\b/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function flattenActions(actions: QaRunAction[]): QaRunAction[] {
  return actions.flatMap((action) => action.sub_actions?.length ? flattenActions(action.sub_actions) : [action]);
}

function actionText(action: QaRunAction): string {
  return normalize(`${action.action} ${action.target || ''} ${action.label || ''} ${action.selector || ''} ${String(action.input ?? '')}`);
}

export function isEmptyObservation(observation: PageObservation): boolean {
  return (observation.pageText || '').trim().length < 50 && elementRegistryForObservation(observation).length === 0;
}

export function hasFinalActionGoal(task: string, intent: QaTaskIntent): boolean {
  if (['TRANSACTION_OR_CART', 'AUTH_FLOW', 'SETTINGS_CHANGE', 'FORM_INTERACTION'].includes(intent)) return true;
  return FINAL_ACTION_RE.test(task);
}

export function classifyTransactionLabel(label: string): TransactionActionClass {
  const text = normalize(label);
  if (!text) return 'OTHER';
  if (text === 'add') return 'ADD_ACTION';
  if (/\badd\b/.test(text) && /\b(cart|bag|basket)\b/.test(text)) return 'ADD_ACTION';
  if (/\bcontinue\b.*\b(cart|bag|basket)\b/.test(text)) return 'ADD_ACTION';
  if (/\breview\b.*\b(cart|bag|basket)\b.*\b(after add|after adding|added)\b/.test(text)) return 'ADD_ACTION';
  if (/\b(after add|after adding|added)\b.*\breview\b.*\b(cart|bag|basket)\b/.test(text)) return 'ADD_ACTION';
  if (/\b(view|open|show|review)\b.*\b(cart|bag|basket)\b/.test(text)) return 'CART_VIEW';
  if (/^(cart|bag|basket|shopping bag|shopping cart)$/.test(text)) return 'CART_VIEW';
  if (/\bshopping\b.*\b(cart|bag|basket)\b/.test(text)) return 'CART_VIEW';
  return 'OTHER';
}

export function classifyTransactionAction(action: QaRunAction): TransactionActionClass {
  return classifyTransactionLabel(actionText(action));
}

export function hasSuccessfulAddAction(actions: QaRunAction[]): boolean {
  return flattenActions(actions).some((action) => action.action_result === 'SUCCESS' && classifyTransactionAction(action) === 'ADD_ACTION');
}

export function cartViewClicksBeforeAdd(actions: QaRunAction[]): number {
  let addSeen = false;
  let count = 0;
  for (const action of flattenActions(actions)) {
    if (action.action_result !== 'SUCCESS') continue;
    const kind = classifyTransactionAction(action);
    if (kind === 'ADD_ACTION') addSeen = true;
    if (!addSeen && kind === 'CART_VIEW') count++;
  }
  return count;
}

function taskTerms(task: string): string[] {
  return extractGoalKeywords(task).filter((term) => !['add', 'cart', 'bag', 'basket', 'buy', 'purchase', 'order'].includes(normalize(term)));
}

function scoreText(text: string, terms: string[], intent: QaTaskIntent): number {
  const normalized = normalize(text);
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(normalize(term))) score += 5;
  }
  if (intent === 'TRANSACTION_OR_CART') {
    if (classifyTransactionLabel(normalized) === 'ADD_ACTION') score += 12;
    if (classifyTransactionLabel(normalized) === 'CART_VIEW') score += 4;
    if (/\b(required|select|choose|option|payment|carrier|trade|protection|connect later|one time)\b/.test(normalized)) score += 3;
  }
  if (/\b(error|required|unavailable|disabled|not available)\b/.test(normalized)) score += 4;
  return score;
}

function elementText(element: ObservedElement): string {
  return `${element.description || ''} ${element.text || ''} ${element.value || ''} ${element.href || ''} ${element.role || ''} ${element.type || ''}`;
}

function compactElement(element: ObservedElement, maxText: number): QaCompactElementState {
  return {
    id: element.id,
    label: truncateText(element.description || element.text || element.value || element.selector || element.type, maxText),
    selector: truncateText(element.selector, maxText),
    role: element.role,
    type: element.type,
    enabled: !element.disabled,
    bbox: { x: element.x, y: element.y },
    text: truncateText(element.text || element.value || '', maxText)
  };
}

function isFinalActionElement(element: ObservedElement): boolean {
  const text = elementText(element);
  return classifyTransactionLabel(text) === 'ADD_ACTION' || FINAL_ACTION_RE.test(text);
}

function isOptionLikeElement(element: ObservedElement): boolean {
  const role = (element.role || '').toLowerCase();
  const type = (element.type || '').toLowerCase();
  const tag = (element.tag || '').toLowerCase();
  if (['radio', 'checkbox', 'select', 'combobox', 'option', 'card', 'dropdown', 'menuitem', 'tab'].includes(type)) return true;
  if (['radio', 'checkbox', 'option', 'menuitemradio', 'menuitemcheckbox'].includes(role)) return true;
  if (tag === 'select' || tag === 'label') return true;
  return type === 'button' && REQUIRED_SECTION_RE.test(elementText(element));
}

function touchedActionLabels(actions: QaRunAction[]): Set<string> {
  return new Set(flattenActions(actions)
    .filter((action) => action.action_result === 'SUCCESS')
    .flatMap((action) => [action.selector, action.target, action.label, action.temporary_observation_id])
    .filter((item): item is string => Boolean(item))
    .map(normalize));
}

function elementWasTouched(element: ObservedElement, touched: Set<string>): boolean {
  return [element.selector, element.description, element.id, element.text]
    .filter((item): item is string => Boolean(item))
    .some((item) => touched.has(normalize(item)));
}

function optionGroupLabel(element: ObservedElement): string {
  const text = truncateText(element.description || element.text || element.value || element.selector || 'Required section', 80);
  const match = text.match(REQUIRED_SECTION_RE);
  if (match) {
    const start = Math.max(0, match.index ?? 0);
    return truncateText(text.slice(start).trim() || text, 80);
  }
  return text;
}

export function findNextUnresolvedSection(input: {
  task: string;
  intent: QaTaskIntent;
  observation: PageObservation;
  actions: QaRunAction[];
}): QaPlanningSection | null {
  if (!hasFinalActionGoal(input.task, input.intent)) return null;
  const touched = touchedActionLabels(input.actions);
  const selectedText = new Set([
    ...(input.observation.fieldRegistry || [])
      .filter((field) => field.checked || field.selected_value || field.value)
      .map((field) => normalize(`${field.label} ${field.selected_label || field.selected_value || field.value || field.checked}`)),
    ...elementRegistryForObservation(input.observation)
      .filter((element) => element.selected || element.checked)
      .map((element) => normalize(element.description || element.text || element.selector))
  ]);

  const candidates = elementRegistryForObservation(input.observation)
    .filter((element) => element.visible !== false)
    .filter((element) => !isFinalActionElement(element))
    .filter((element) => isOptionLikeElement(element) || REQUIRED_SECTION_RE.test(elementText(element)))
    .filter((element) => !element.selected && !element.checked)
    .filter((element) => !elementWasTouched(element, touched))
    .map((element) => {
      const text = elementText(element);
      const sectionLabel = optionGroupLabel(element);
      const groupResolved = Array.from(selectedText).some((selected) =>
        selected && (selected.includes(normalize(sectionLabel)) || normalize(sectionLabel).includes(selected))
      );
      const score = (REQUIRED_SECTION_RE.test(text) ? 10 : 2) +
        (isOptionLikeElement(element) ? 6 : 0) +
        (element.disabled ? -3 : 0) +
        scoreText(text, taskTerms(input.task), input.intent);
      return { element, sectionLabel, groupResolved, score };
    })
    .filter((item) => !item.groupResolved)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return null;
  const related = candidates
    .filter((item) => normalize(item.sectionLabel) === normalize(best.sectionLabel) || item.score >= best.score - 3)
    .slice(0, 6)
    .map((item) => compactElement(item.element, DEFAULT_LIMITS.maxTextPerElement));

  return {
    section_label: best.sectionLabel,
    reason: 'Visible required/prerequisite controls are available and no selected value has been confirmed for this section.',
    candidate_actions: related
  };
}

function rankedElements(input: {
  task: string;
  intent: QaTaskIntent;
  observation: PageObservation;
  actions: QaRunAction[];
  predicate?: (element: ObservedElement) => boolean;
  limit: number;
  maxText: number;
}): QaCompactElementState[] {
  const terms = taskTerms(input.task);
  const touched = new Set(flattenActions(input.actions).map((action) => action.selector || action.target || action.label).filter(Boolean));
  return elementRegistryForObservation(input.observation)
    .filter((element) => element.visible !== false)
    .filter((element) => input.predicate ? input.predicate(element) : true)
    .map((element) => {
      const text = elementText(element);
      const touchedScore = touched.has(element.selector) || touched.has(element.description) || touched.has(element.id) ? 20 : 0;
      return { element, score: touchedScore + scoreText(text, terms, input.intent) + (element.disabled ? -2 : 0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit)
    .map(({ element }) => compactElement(element, input.maxText));
}

function textSnippets(text: string, patterns: RegExp[], limit: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
  return sentences
    .filter((sentence) => patterns.some((pattern) => pattern.test(sentence)))
    .slice(0, limit)
    .map((sentence) => truncateText(sentence, 220));
}

export function buildCompactFinalState(input: {
  task: string;
  intent: QaTaskIntent;
  observation: PageObservation;
  actions: QaRunAction[];
  limits?: Partial<CompactStateLimits>;
}): QaCompactFinalState {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const pageText = input.observation.pageText || '';
  const buttonLike = (element: ObservedElement) => ['button', 'submit', 'menuitem', 'tab'].includes(element.type) || element.tag === 'button' || element.role === 'button';
  const linkLike = (element: ObservedElement) => element.type === 'link' || element.tag === 'a' || element.role === 'link';
  const optionLike = (element: ObservedElement) => ['option', 'radio', 'checkbox', 'select', 'combobox', 'card'].includes(element.type) || ['option', 'radio', 'checkbox'].includes(element.role || '');
  const actionCandidate = (element: ObservedElement) => scoreText(elementText(element), taskTerms(input.task), input.intent) > 0 || classifyTransactionLabel(elementText(element)) !== 'OTHER';
  const selectedOptions = [
    ...(input.observation.fieldRegistry || []).filter((field) => field.checked || field.selected_value || field.value).map((field) => `${field.label}: ${field.selected_label || field.selected_value || field.value || field.checked}`),
    ...elementRegistryForObservation(input.observation).filter((element) => element.selected || element.checked).map((element) => element.description || element.text || element.selector)
  ];

  return {
    url: input.observation.page.url || '',
    title: input.observation.page.title || '',
    scrollY: input.observation.page.sy,
    pageTextExcerpt: truncateText(pageText, limits.maxPageText),
    visibleHeadings: rankedElements({ ...input, predicate: (element) => /^h[1-6]$/.test(element.tag) || element.role === 'heading', limit: 20, maxText: limits.maxTextPerElement }).map((element) => element.label),
    visibleButtons: rankedElements({ ...input, predicate: buttonLike, limit: 40, maxText: limits.maxTextPerElement }),
    visibleLinks: rankedElements({ ...input, predicate: linkLike, limit: 40, maxText: limits.maxTextPerElement }),
    visibleOptions: rankedElements({ ...input, predicate: optionLike, limit: 50, maxText: limits.maxTextPerElement }),
    cartIndicators: [
      ...rankedElements({ ...input, predicate: (element) => /\b(cart|bag|basket)\b/i.test(elementText(element)), limit: 20, maxText: limits.maxTextPerElement }).map((element) => element.label),
      ...textSnippets(pageText, [/\b(cart|bag|basket|subtotal|quantity|item)\b/i], 8)
    ].slice(0, 24),
    errorMessages: textSnippets(pageText, [/\b(error|required|unavailable|disabled|not available|out of stock|choose|select)\b/i], 10),
    selectedOptions: selectedOptions.map((item) => truncateText(item, limits.maxTextPerElement)).slice(0, 40),
    disabledOptions: rankedElements({ ...input, predicate: (element) => Boolean(element.disabled), limit: 30, maxText: limits.maxTextPerElement }).map((element) => element.label),
    candidateActions: rankedElements({ ...input, predicate: actionCandidate, limit: limits.maxVerifierElements, maxText: limits.maxTextPerElement })
  };
}

export function relevantFieldsForVerification(input: {
  intent: QaTaskIntent;
  registry: FieldRegistry;
  actions: QaRunAction[];
  maxFields?: number;
}): FieldRegistry {
  const maxFields = input.maxFields ?? DEFAULT_LIMITS.maxVerifierFields;
  const fieldActions = flattenActions(input.actions).filter((action) => ['fill', 'type', 'select', 'check', 'uncheck', 'radio'].includes(action.action));
  const touched = new Set(fieldActions.flatMap((action) => [
    action.field_id,
    action.selector,
    action.temporary_observation_id,
    action.target
  ].filter(Boolean)));

  const relevant = input.registry.filter((field) =>
    touched.has(field.field_id) ||
    touched.has(field.selector) ||
    touched.has(field.temporary_observation_id) ||
    Boolean(field.selector_candidates?.some((selector) => touched.has(selector)))
  );

  if (input.intent !== 'FORM_INTERACTION') return relevant.slice(0, maxFields);
  const untouched = input.registry.filter((field) => !relevant.includes(field));
  return [...relevant, ...untouched].slice(0, maxFields);
}

export function compactObservationForReport(input: {
  task: string;
  intent: QaTaskIntent;
  observation: PageObservation;
  actions: QaRunAction[];
  fieldRegistry: FieldRegistry;
  compactState?: QaCompactFinalState;
  limits?: Partial<CompactStateLimits>;
}): PageObservation {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const compactState = input.compactState || buildCompactFinalState(input);
  const relevantElements = rankedElements({
    task: input.task,
    intent: input.intent,
    observation: input.observation,
    actions: input.actions,
    limit: limits.maxVerifierElements,
    maxText: limits.maxTextPerElement
  });
  const elementById = new Map(elementRegistryForObservation(input.observation).map((element) => [element.id, element]));
  const elements = relevantElements
    .map((element) => element.id ? elementById.get(element.id) : null)
    .filter((element): element is ObservedElement => Boolean(element))
    .map((element) => ({
      ...element,
      description: truncateText(element.description, limits.maxTextPerElement),
      text: truncateText(element.text, limits.maxTextPerElement),
      value: element.value === null || element.value === undefined ? element.value : truncateText(String(element.value), limits.maxTextPerElement)
    }));

  return {
    ...input.observation,
    fieldRegistry: input.fieldRegistry,
    elementRegistry: elements,
    availableElements: elements,
    interactiveElements: elements,
    pageText: truncateText(input.observation.pageText, limits.maxPageText),
    compactFinalState: compactState
  } as PageObservation;
}

function milestone(
  id: string,
  label: string,
  status: QaVerdict,
  evidence: string[],
  rootCause?: QaRootCause,
  message?: string
): QaObjectiveMilestone {
  return { id, label, status, evidence: evidence.filter(Boolean).slice(0, 6), rootCause, message };
}

export function transactionMilestones(input: {
  task: string;
  observation: PageObservation;
  actions: QaRunAction[];
  compactState?: QaCompactFinalState;
}): QaObjectiveMilestone[] {
  const compactState = input.compactState || buildCompactFinalState({ task: input.task, intent: 'TRANSACTION_OR_CART', observation: input.observation, actions: input.actions });
  const terms = taskTerms(input.task);
  const finalText = normalize(`${compactState.url} ${compactState.title} ${compactState.pageTextExcerpt}`);
  const actions = flattenActions(input.actions);
  const addClicked = actions.some((action) => action.action_result === 'SUCCESS' && classifyTransactionAction(action) === 'ADD_ACTION');
  const cartViewClicks = actions.filter((action) => action.action_result === 'SUCCESS' && classifyTransactionAction(action) === 'CART_VIEW');
  const addCandidate = compactState.candidateActions.some((element) => classifyTransactionLabel(`${element.label} ${element.text || ''}`) === 'ADD_ACTION');
  const targetFound = terms.length === 0 || terms.some((term) => finalText.includes(normalize(term)) || actions.some((action) => actionText(action).includes(normalize(term))));
  const configurationStarted = targetFound && actions.some((action) => ['click', 'select', 'check', 'radio', 'fill', 'type'].includes(action.action) && classifyTransactionAction(action) !== 'CART_VIEW');
  const optionEvidence = compactState.selectedOptions.length > 0 || actions.some((action) => ['select', 'check', 'radio'].includes(action.action));
  const cartVerified = addClicked &&
    compactState.cartIndicators.length > 0 &&
    (terms.length === 0 || terms.some((term) => finalText.includes(normalize(term)) || compactState.cartIndicators.some((item) => normalize(item).includes(normalize(term)))));

  return [
    milestone(
      'M1_TARGET_ITEM_FOUND',
      'Requested target item/page was found',
      targetFound ? 'PASS' : 'BLOCKED',
      [compactState.url, compactState.title, compactState.pageTextExcerpt.slice(0, 220)],
      targetFound ? undefined : 'GOAL_NOT_REACHED'
    ),
    milestone(
      'M2_CONFIGURATION_STARTED',
      'Configuration or selection flow was started',
      configurationStarted ? 'PASS' : 'BLOCKED',
      actions.slice(-8).map((action) => `${action.action}: ${action.target || action.label || action.selector || ''}`),
      configurationStarted ? undefined : 'GOAL_NOT_REACHED'
    ),
    milestone(
      'M3_REQUIRED_OPTIONS_RESOLVED',
      'Required choices/prerequisites were selected or identified',
      addClicked || addCandidate ? 'PASS' : optionEvidence ? 'WARNING' : 'BLOCKED',
      [...compactState.selectedOptions, ...compactState.errorMessages].slice(0, 8),
      addClicked || addCandidate ? undefined : optionEvidence ? 'REQUIRED_PREREQUISITES_UNRESOLVED' : 'REQUIRED_PREREQUISITES_UNRESOLVED',
      optionEvidence && !addClicked && !addCandidate ? 'Some choices were interacted with, but required prerequisites are not fully proven.' : undefined
    ),
    milestone(
      'M4_ADD_ACTION_FOUND',
      'Add-to-cart/add-to-bag action was found',
      addClicked || addCandidate ? 'PASS' : 'BLOCKED',
      compactState.candidateActions.map((element) => element.label).slice(0, 8),
      addClicked || addCandidate ? undefined : 'CTA_NOT_FOUND'
    ),
    milestone(
      'M5_ADD_ACTION_CLICKED',
      'Add-to-cart/add-to-bag action was executed',
      addClicked ? 'PASS' : 'BLOCKED',
      actions.filter((action) => classifyTransactionAction(action) !== 'OTHER').map((action) => `${classifyTransactionAction(action)}: ${action.target || action.label || action.selector || action.action}`),
      addClicked ? undefined : 'GOAL_NOT_REACHED',
      !addClicked && cartViewClicks.length ? 'Cart/bag view was opened, but no add action was executed.' : undefined
    ),
    milestone(
      'M6_CART_OR_BAG_VERIFIED',
      'Cart/bag state contains the requested item',
      cartVerified ? 'PASS' : 'BLOCKED',
      compactState.cartIndicators,
      cartVerified ? undefined : 'GOAL_NOT_REACHED'
    )
  ];
}

export function repeatedCartViewNoProgress(actions: QaRunAction[], threshold = 3): boolean {
  const tail = flattenActions(actions).filter((action) => action.action_result === 'SUCCESS').slice(-threshold);
  return tail.length >= threshold && tail.every((action) => classifyTransactionAction(action) === 'CART_VIEW');
}

export function buildObjectiveProgress(input: {
  task: string;
  intent: QaTaskIntent;
  observation: PageObservation;
  actions: QaRunAction[];
  history?: HistoryLike;
}): QaObjectiveProgress {
  const compact = buildCompactFinalState({
    task: input.task,
    intent: input.intent,
    observation: input.observation,
    actions: input.actions,
    limits: { maxVerifierElements: 40, maxPageText: 1200 }
  });
  const nextSection = findNextUnresolvedSection(input);
  const finalCtaFound = compact.candidateActions.some((element) => classifyTransactionLabel(`${element.label} ${element.text || ''}`) === 'ADD_ACTION' || FINAL_ACTION_RE.test(`${element.label} ${element.text || ''}`));
  const finalCtaClicked = hasSuccessfulAddAction(input.actions) ||
    flattenActions(input.actions).some((action) => action.action_result === 'SUCCESS' && FINAL_ACTION_RE.test(actionText(action)));
  const milestones = input.intent === 'TRANSACTION_OR_CART'
    ? transactionMilestones({ task: input.task, observation: input.observation, actions: input.actions, compactState: compact })
    : [];
  const cartStateVerified = milestones.some((milestone) => milestone.id === 'M6_CART_OR_BAG_VERIFIED' && milestone.status === 'PASS');
  const clickedElements = flattenActions(input.actions)
    .filter((action) => action.action_result === 'SUCCESS' && ['click', 'select', 'check', 'radio', 'fill', 'type'].includes(action.action))
    .map((action) => action.target || action.label || action.selector || action.action)
    .filter(Boolean)
    .slice(-10);
  const visitedScrollPositions = [
    input.observation.page.sy,
    ...(input.history || [])
      .filter((entry) => entry.action === 'scroll')
      .map((entry) => {
        const match = `${entry.result} ${entry.value || ''}`.match(/\by=(\d+)\b|^\s*(-?\d+)\s*$/);
        return match ? Number(match[1] || match[2]) : undefined;
      })
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const noProgress = (input.history || [])
    .filter((entry) => entry.status === 'blocked' || /no progress|loop|repeated|blocked scroll/i.test(entry.result))
    .map((entry) => `${entry.action}: ${truncateText(entry.result, 120)}`)
    .slice(-5);
  const requiredResolved = compact.selectedOptions;
  const finalCtaSearchGated = hasFinalActionGoal(input.task, input.intent) && Boolean(nextSection) && !finalCtaFound;
  const warnings: string[] = [];
  if (isEmptyObservation(input.observation)) warnings.push('Observation is empty; wait and re-observe before any scroll/click.');
  if (finalCtaSearchGated) warnings.push('Do not scroll/search for the final CTA until the visible unresolved section is handled.');
  if (input.intent === 'TRANSACTION_OR_CART' && cartViewClicksBeforeAdd(input.actions) > 0 && !hasSuccessfulAddAction(input.actions)) {
    warnings.push('Cart/bag view was opened before an add action; do not repeat it until an add action occurs.');
  }

  const actionPriority = [
    isEmptyObservation(input.observation) ? 'Wait 1s and re-observe; do not scroll from an empty observation.' : '',
    nextSection ? `Resolve visible required section: ${nextSection.section_label}.` : '',
    !nextSection && finalCtaFound ? 'Click the relevant final CTA if it matches the goal.' : '',
    !nextSection && !finalCtaFound ? 'Scroll only to reveal the next section or final CTA, then re-observe.' : '',
    input.intent === 'TRANSACTION_OR_CART' ? 'Open cart/bag only after an add action was executed, or once for diagnostic evidence.' : '',
    'Stop as blocked only after no-progress evidence and deterministic final-state checks.'
  ].filter(Boolean);

  return {
    current_goal: input.task,
    milestones: {
      target_page_reached: Boolean(input.observation.page.url || input.observation.page.title || compact.pageTextExcerpt),
      required_sections_seen: nextSection ? [nextSection.section_label] : [],
      required_sections_resolved: requiredResolved,
      final_cta_found: finalCtaFound,
      final_cta_clicked: finalCtaClicked,
      cart_state_verified: cartStateVerified
    },
    next_unresolved_section: nextSection || undefined,
    final_cta_search_gated: finalCtaSearchGated,
    recent_no_progress_actions: noProgress,
    clicked_elements: clickedElements,
    visited_scroll_positions: [...new Set(visitedScrollPositions)].slice(-8),
    action_priority: actionPriority,
    warnings
  };
}
