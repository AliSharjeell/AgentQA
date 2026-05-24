import type { QaRootCause, QaRunAction, QaTaskIntent, QaVerdict } from '../shared/types';
import type { CliReport, PageObservation } from './harness';

export interface TaskIntentAnalysis {
  intent: QaTaskIntent;
  confidence: number;
  requiresFieldsAtStart: boolean;
  verificationStyle: string;
}

export interface InitialObservationReadiness {
  status: 'continue' | 'blocked';
  rootCause?: QaRootCause;
  summary: string;
}

export interface GoalCompletionResult {
  passed: boolean;
  status: QaVerdict;
  rootCause?: QaRootCause;
  expected: string | boolean;
  actual: string | boolean | null;
  evidence: string[];
  message?: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'check', 'confirm', 'do',
  'ensure', 'for', 'from', 'go', 'in', 'into', 'is', 'it', 'its', 'me', 'of', 'on',
  'open', 'page', 'please', 'show', 'site', 'that', 'the', 'this', 'to', 'use',
  'user', 'verify', 'with'
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectTaskIntent(task: string): TaskIntentAnalysis {
  const text = normalize(task);
  const wantsForm = hasAny(text, [
    /\bfill\b/, /\bform\b/, /\bfields?\b/, /\binputs?\b/, /\btextarea\b/, /\bselect\b/
  ]);
  const wantsAuth = hasAny(text, [
    /\blog ?in\b/, /\blog ?out\b/, /\bsign ?in\b/, /\bsign ?up\b/, /\bauth\b/, /\bcredentials?\b/, /\bpassword\b/
  ]);
  const wantsSearch = hasAny(text, [
    /\bsearch\b/, /\bfind\b/, /\blook for\b/, /\bdiscover\b/, /\bfilter\b/, /\bresults?\b/
  ]);
  const wantsNavigation = hasAny(text, [
    /\bgo to\b/, /\bnavigate\b/, /\bopen\b/, /\bvisit\b/, /\bpricing\b/, /\bsupport\b/, /\bdocs?\b/, /\babout\b/
  ]);
  const wantsTransaction = hasAny(text, [
    /\badd\b.*\b(cart|bag|basket)\b/, /\b(cart|bag|basket)\b/, /\bpurchase\b/, /\border\b/
  ]);
  const wantsSettings = hasAny(text, [
    /\bsettings?\b/, /\bpreferences?\b/, /\btoggle\b/, /\benable\b/, /\bdisable\b/, /\bchange\b/, /\bconfigure\b/
  ]);
  const wantsContent = hasAny(text, [
    /\bvisible\b/, /\btext\b/, /\bimage\b/, /\bheading\b/, /\bcomponent\b/, /\bcontent\b/, /\bcopy\b/
  ]);

  const hasPreFormFlow = wantsSearch || wantsNavigation || wantsTransaction || wantsAuth;
  if (wantsForm && !hasPreFormFlow) {
    return {
      intent: 'FORM_INTERACTION',
      confidence: 0.85,
      requiresFieldsAtStart: true,
      verificationStyle: 'Verify final editable-control values from the DOM.'
    };
  }
  if (wantsForm && hasPreFormFlow) {
    return {
      intent: 'GENERAL_TASK',
      confidence: 0.65,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify the combined multi-step outcome from DOM/page evidence.'
    };
  }
  if (wantsTransaction) {
    return {
      intent: 'TRANSACTION_OR_CART',
      confidence: 0.8,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify the requested item/action is reflected in cart, bag, order, or page state.'
    };
  }
  if (wantsSearch) {
    return {
      intent: 'SEARCH_OR_DISCOVERY',
      confidence: 0.8,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify query/results/content appear in URL, headings, or page text.'
    };
  }
  if (wantsAuth) {
    return {
      intent: 'AUTH_FLOW',
      confidence: 0.75,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify success state or expected auth error from URL/page text.'
    };
  }
  if (wantsSettings) {
    return {
      intent: 'SETTINGS_CHANGE',
      confidence: 0.75,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify the selected setting/toggle/value changed in the DOM.'
    };
  }
  if (wantsNavigation) {
    return {
      intent: 'NAVIGATION',
      confidence: 0.75,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify URL, title, heading, selected state, or page text.'
    };
  }
  if (wantsContent) {
    return {
      intent: 'CONTENT_VERIFICATION',
      confidence: 0.7,
      requiresFieldsAtStart: false,
      verificationStyle: 'Verify requested content is visible in the DOM/page text.'
    };
  }
  return {
    intent: 'GENERAL_TASK',
    confidence: 0.55,
    requiresFieldsAtStart: false,
    verificationStyle: 'Verify the requested outcome from DOM/page evidence.'
  };
}

export function resolveInitialObservationReadiness(
  task: string,
  observation: PageObservation,
  intent: TaskIntentAnalysis = detectTaskIntent(task)
): InitialObservationReadiness {
  const fieldCount = observation.fieldRegistry?.length || 0;
  const elementCount = elementRegistryForObservation(observation).length;

  if (fieldCount === 0 && elementCount === 0) {
    return {
      status: 'blocked',
      rootCause: 'PAGE_NOT_INTERACTIVE_OR_OBSERVATION_FAILED',
      summary: 'The page loaded, but no editable controls or interactive affordances were observed.'
    };
  }

  if (fieldCount === 0 && intent.requiresFieldsAtStart) {
    return {
      status: 'blocked',
      rootCause: 'NO_FIELDS_FOUND',
      summary: 'The task is form-focused, but no editable controls were discovered on the current page.'
    };
  }

  return {
    status: 'continue',
    summary: fieldCount === 0
      ? 'No editable fields were found, but interactive affordances are available for planning.'
      : 'Editable controls and/or interactive affordances are available for planning.'
  };
}

export function elementRegistryForObservation(observation: PageObservation): PageObservation['availableElements'] {
  const seen = new Set<string>();
  const merged = [
    ...(observation.elementRegistry || []),
    ...(observation.availableElements || []),
    ...(observation.interactiveElements || [])
  ];
  return merged.filter((element) => {
    const key = element.id || element.selector || `${element.x}:${element.y}:${element.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractGoalKeywords(task: string): string[] {
  const quoted = Array.from(task.matchAll(/"([^"]+)"|'([^']+)'/g))
    .map((match) => normalize(match[1] || match[2] || ''))
    .filter(Boolean);
  const normalized = normalize(task);
  const afterIntent = normalized
    .replace(/\b(go to|navigate to|open|visit|search for|find|look for|add|verify|check|confirm|ensure|fill|change|set)\b/g, ' ')
    .replace(/\b(page|form|field|fields|input|inputs|button|link|menu|cart|bag|basket|product|item|result|results)\b/g, ' ');
  const tokens = afterIntent
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return [...new Set([...quoted, ...tokens])].slice(0, 8);
}

function extractSearchQuery(task: string): string[] {
  const match = normalize(task).match(/\b(?:search for|find|look for)\s+(.+?)(?:\s+(?:and|then|after|before|in|on)\b|$)/);
  if (!match) return extractGoalKeywords(task);
  return match[1]
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .slice(0, 6);
}

function textContainsAny(haystack: string, needles: string[]): boolean {
  const text = normalize(haystack);
  return needles.some((needle) => text.includes(normalize(needle)));
}

function compactEvidence(items: Array<string | undefined | null>): string[] {
  return items
    .filter((item): item is string => Boolean(item && item.trim()))
    .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 500))
    .slice(0, 6);
}

function successfulActions(actions: QaRunAction[]): QaRunAction[] {
  return actions.flatMap((action) => action.sub_actions?.length ? successfulActions(action.sub_actions) : [action])
    .filter((action) => action.action_result === 'SUCCESS');
}

function reportClaimsPass(llmReport: CliReport | null | undefined): boolean {
  return llmReport?.result === 'PASS' && Boolean(llmReport.evidence?.length || llmReport.stepsExecuted?.length);
}

export function detectGoalCompletion(input: {
  task: string;
  intent?: QaTaskIntent;
  observation: PageObservation;
  llmReport?: CliReport | null;
  evidence: string[];
  actions: QaRunAction[];
}): GoalCompletionResult {
  const intent = input.intent || detectTaskIntent(input.task).intent;
  const url = input.observation.page.url || '';
  const title = input.observation.page.title || '';
  const pageText = input.observation.pageText || '';
  const combinedState = `${url} ${title} ${pageText}`;
  const actions = successfulActions(input.actions);
  const actionText = actions.map((action) => `${action.action} ${action.target || ''} ${action.label || ''} ${String(action.input ?? '')}`).join(' ');
  const reportText = `${input.llmReport?.evidence?.join(' ') || ''} ${input.llmReport?.stepsExecuted?.join(' ') || ''}`;
  const keywords = extractGoalKeywords(input.task);
  const hasKeywordEvidence = keywords.length === 0 || textContainsAny(`${combinedState} ${actionText} ${reportText}`, keywords);
  const baseEvidence = compactEvidence([
    url ? `Final URL: ${url}` : undefined,
    title ? `Final title: ${title}` : undefined,
    pageText ? `Final page text: ${pageText.slice(0, 400)}` : undefined,
    input.evidence[0],
    input.llmReport?.evidence?.[0]
  ]);

  if ((input.observation.fieldRegistry?.length || 0) === 0 &&
    elementRegistryForObservation(input.observation).length === 0 &&
    !pageText.trim() &&
    !title.trim() &&
    !url.trim()) {
    return {
      passed: false,
      status: 'BLOCKED',
      rootCause: 'PAGE_NOT_INTERACTIVE_OR_OBSERVATION_FAILED',
      expected: 'Interactive page state observable',
      actual: null,
      evidence: baseEvidence,
      message: 'No editable controls or interactive affordances were observed.'
    };
  }

  if (intent === 'FORM_INTERACTION') {
    const formActions = actions.filter((action) => ['fill', 'type', 'select', 'check', 'uncheck', 'radio'].includes(action.action));
    if ((input.observation.fieldRegistry?.length || 0) === 0) {
      return {
        passed: false,
        status: 'BLOCKED',
        rootCause: 'NO_FIELDS_FOUND',
        expected: 'Editable controls for the form task',
        actual: 'No editable controls found',
        evidence: baseEvidence,
        message: 'The task requires form fields, but FieldRegistry is empty.'
      };
    }
    const passed = formActions.length > 0 && formActions.every((action) => {
      const verification = action.final_verification || action.post_action_verification || action.verification;
      return !verification || verification.status === 'PASS';
    });
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: 'All planned field values verified from the final DOM',
      actual: passed ? true : 'Form actions were not fully verified',
      evidence: baseEvidence,
      message: passed ? undefined : 'Field interaction did not reach a deterministically verified final state.'
    };
  }

  if (intent === 'NAVIGATION') {
    const passed = hasKeywordEvidence && (reportClaimsPass(input.llmReport) || textContainsAny(`${url} ${title}`, keywords) || actions.some((action) => ['click', 'navigate'].includes(action.action)));
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: keywords.length ? `Navigation state includes ${keywords.join(', ')}` : 'Requested navigation state reached',
      actual: passed ? true : `${url} ${title}`.trim() || null,
      evidence: baseEvidence,
      message: passed ? undefined : 'The final URL/title/page text did not prove the requested navigation target was reached.'
    };
  }

  if (intent === 'SEARCH_OR_DISCOVERY') {
    const query = extractSearchQuery(input.task);
    const resultWords = ['result', 'results', 'showing', 'found', 'search'];
    const passed = textContainsAny(combinedState, query) &&
      (textContainsAny(combinedState, resultWords) || actions.some((action) => ['fill', 'type', 'press_key', 'click', 'navigate'].includes(action.action)) || reportClaimsPass(input.llmReport));
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: query.length ? `Search/discovery state includes ${query.join(', ')}` : 'Search/discovery result visible',
      actual: passed ? true : pageText.slice(0, 300) || null,
      evidence: baseEvidence,
      message: passed ? undefined : 'The final state did not prove search or discovery results for the requested topic.'
    };
  }

  if (intent === 'TRANSACTION_OR_CART') {
    const cartTerms = ['cart', 'bag', 'basket', 'added', 'subtotal', 'quantity', 'item'];
    const itemTerms = keywords.filter((term) => !['cart', 'bag', 'basket', 'add', 'added'].includes(term));
    const hasCartEvidence = textContainsAny(combinedState, cartTerms) || textContainsAny(actionText, cartTerms);
    const itemMatches = itemTerms.length === 0 || textContainsAny(combinedState, itemTerms) || textContainsAny(actionText, itemTerms);
    const passed = hasCartEvidence && itemMatches && (actions.length > 0 || reportClaimsPass(input.llmReport));
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: 'Requested item/action reflected in cart, bag, or transaction state',
      actual: passed ? true : pageText.slice(0, 300) || null,
      evidence: baseEvidence,
      message: passed ? undefined : 'The final state did not prove the requested cart/transaction outcome.'
    };
  }

  if (intent === 'SETTINGS_CHANGE') {
    const changed = actions.some((action) => ['click', 'check', 'uncheck', 'select', 'fill', 'type'].includes(action.action));
    const passed = changed && (hasKeywordEvidence || reportClaimsPass(input.llmReport));
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: 'Requested setting state changed and remains visible',
      actual: passed ? true : pageText.slice(0, 300) || null,
      evidence: baseEvidence,
      message: passed ? undefined : 'The final state did not prove the requested setting changed.'
    };
  }

  if (intent === 'CONTENT_VERIFICATION') {
    const passed = hasKeywordEvidence && (pageText.length > 0 || reportClaimsPass(input.llmReport));
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: keywords.length ? `Visible content includes ${keywords.join(', ')}` : 'Requested content visible',
      actual: passed ? true : pageText.slice(0, 300) || null,
      evidence: baseEvidence,
      message: passed ? undefined : 'The final DOM/page text did not prove the requested content is visible.'
    };
  }

  const passed = reportClaimsPass(input.llmReport) && hasKeywordEvidence && (actions.length > 0 || pageText.length > 0);
  return {
    passed,
    status: passed ? 'PASS' : 'BLOCKED',
    rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
    expected: 'Requested objective verified by DOM/page evidence',
    actual: passed ? true : pageText.slice(0, 300) || null,
    evidence: baseEvidence,
    message: passed ? undefined : 'The final state did not deterministically prove the requested objective.'
  };
}
