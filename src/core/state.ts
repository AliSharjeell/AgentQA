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

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function flattenActions(actions: QaRunAction[]): QaRunAction[] {
  return actions.flatMap((action) => action.sub_actions?.length ? flattenActions(action.sub_actions) : [action]);
}

function actionText(action: QaRunAction): string {
  return normalize(`${action.action} ${action.target || ''} ${action.label || ''} ${action.selector || ''} ${String(action.input ?? '')}`);
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
