import type { QaProbeFinding, QaRootCause, QaRunAction, QaTaskIntent, QaVerdict } from '../shared/types';
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

export interface ProbeTaskAnalysis {
  isProbe: boolean;
  isExpectation: boolean;
  target: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'check', 'confirm', 'do',
  'ensure', 'for', 'from', 'go', 'in', 'into', 'is', 'it', 'its', 'me', 'of', 'on',
  'open', 'page', 'please', 'show', 'site', 'that', 'the', 'this', 'to', 'use',
  'user', 'verify', 'with', 'whether', 'if', 'see'
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectProbeTask(task: string): ProbeTaskAnalysis {
  const text = normalize(task);
  const exploratory = hasAny(text, [
    /\b(can|could|would) you\b.*\b(see|check|tell|find out|look)\b.*\b(if|whether)\b/,
    /\b(see|check|tell|find out|look)\b.*\b(if|whether)\b/,
    /\b(does|do|is|are|has|have)\b.+\b(available|present|visible|integrated|supported|support|exist|exists|enabled|included)\b/,
    /\b(is|are)\b.+\b(on|in)\b.+\b(site|page|app|modal|menu|form)\b/
  ]);
  const expectation = hasAny(text, [
    /\b(ensure|verify|confirm|validate|assert|test)\b.+\b(exists?|available|present|visible|integrated|supported|enabled|included)\b/,
    /\b(should|must|needs? to|expected to|supposed to)\b.+\b(exists?|be available|be present|be visible|support|include|have)\b/
  ]);
  const isProbe = exploratory || expectation;
  return {
    isProbe,
    isExpectation: expectation,
    target: isProbe ? extractProbeTarget(task) : ''
  };
}

function extractProbeTarget(task: string): string {
  const normalized = normalize(task);
  const quoted = Array.from(task.matchAll(/"([^"]+)"|'([^']+)'/g))
    .map((match) => normalize(match[1] || match[2] || ''))
    .find(Boolean);
  if (quoted) return quoted;

  const patterns = [
    /\b(?:does|do|has|have)\s+(?:this|the\s+\w+|site|page|app|website)\s+(?:support|have|include|offer)\s+(.+?)(?:\s+(?:available|present|visible|integrated|supported|enabled|included|on|in)\b|$)/,
    /\b(?:is|are)\s+(.+?)\s+(?:available|present|visible|integrated|supported|enabled|included|on|in)\b/,
    /\b(?:if|whether)\s+(.+?)(?:\s+(?:is|are|has|have|exists?|available|present|visible|integrated|supported|enabled|included|on|in)\b|$)/,
    /\b(?:does|do|is|are|has|have)\s+(.+?)(?:\s+(?:available|present|visible|integrated|supported|support|exists?|enabled|included|on|in)\b|$)/,
    /\b(?:ensure|verify|confirm|validate|assert|test)\s+(.+?)(?:\s+(?:exists?|is|are|available|present|visible|integrated|supported|enabled|included)\b|$)/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = cleanProbeTarget(match?.[1] || '');
    if (candidate) return candidate;
  }
  return cleanProbeTarget(normalized);
}

function cleanProbeTarget(value: string): string {
  const cleaned = value
    .replace(/\b(can|could|would|you|please|see|check|tell|find|out|look|whether|if|does|do|is|are|has|have|site|page|app|website|modal|menu|form)\b/g, ' ')
    .replace(/\b(exists?|available|present|visible|integrated|supported|support|enabled|included|there|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').filter((token) => token.length > 1 && !STOP_WORDS.has(token)).join(' ').slice(0, 80);
}

export function detectTaskIntent(task: string): TaskIntentAnalysis {
  const text = normalize(task);
  const probe = detectProbeTask(task);
  if (probe.isProbe) {
    return {
      intent: 'DISCOVERY_PROBE',
      confidence: probe.isExpectation ? 0.72 : 0.82,
      requiresFieldsAtStart: false,
      verificationStyle: 'Answer whether the requested target is present, absent, or inconclusive from scoped DOM/page evidence.'
    };
  }
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
    .replace(/\b(page|form|field|fields|input|inputs|button|link|menu)\b/g, ' ');
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

function formatProbeActual(finding: QaProbeFinding): string {
  const target = finding.target || 'requested target';
  const alternatives = finding.observedAlternatives?.length
    ? ` Alternatives observed: ${finding.observedAlternatives.join(', ')}.`
    : '';
  if (finding.outcome === 'PRESENT') return `${target} observed${finding.observedMatches?.length ? `: ${finding.observedMatches.join(', ')}` : ''}`;
  if (finding.outcome === 'ABSENT') return `${target} not observed.${alternatives}`;
  return `${target} inconclusive`;
}

function visibleProbeTexts(observation: PageObservation): string[] {
  const compact = observation.compactFinalState;
  const compactTexts = compact
    ? [
        compact.pageTextExcerpt,
        ...compact.visibleButtons.map((item) => `${item.label} ${item.text || ''}`),
        ...compact.visibleLinks.map((item) => `${item.label} ${item.text || ''}`),
        ...compact.visibleOptions.map((item) => `${item.label} ${item.text || ''}`),
        ...compact.candidateActions.map((item) => `${item.label} ${item.text || ''}`),
        ...compact.visibleHeadings,
        ...compact.errorMessages,
        ...compact.selectedOptions,
        ...compact.disabledOptions
      ]
    : [];
  const registryTexts = elementRegistryForObservation(observation).map((element) =>
    `${element.description || ''} ${element.text || ''} ${element.value || ''} ${element.href || ''} ${element.role || ''} ${element.type || ''}`
  );
  return [observation.pageText, ...compactTexts, ...registryTexts].filter(Boolean);
}

function inferProbeFinding(input: {
  task: string;
  observation: PageObservation;
  llmReport?: CliReport | null;
  evidence: string[];
}): QaProbeFinding | null {
  const probe = detectProbeTask(input.task);
  if (!probe.isProbe) return null;
  const reported = input.llmReport?.probeFinding;
  if (reported?.outcome && reported.target && Array.isArray(reported.evidence)) {
    return {
      target: reported.target,
      outcome: reported.outcome,
      scope: reported.scope,
      observedMatches: reported.observedMatches || [],
      observedAlternatives: reported.observedAlternatives || [],
      evidence: reported.evidence,
      summary: reported.summary
    };
  }

  const target = probe.target || extractGoalKeywords(input.task).join(' ') || 'requested target';
  const targetText = normalize(target);
  const evidenceText = [
    ...input.evidence,
    ...(input.llmReport?.evidence || []),
    ...(input.llmReport?.stepsExecuted || [])
  ].join(' ');
  const visibleTexts = visibleProbeTexts(input.observation);
  const visibleText = visibleTexts.join(' ');
  const combined = normalize(`${evidenceText} ${visibleText}`);
  const exactTargetSeen = Boolean(targetText && combined.includes(targetText));
  const negativeEvidence = new RegExp(`\\b(no|not|without|absent|missing|unavailable|not observed|not found)\\b.{0,80}\\b${escapeRegExp(targetText)}\\b|\\b${escapeRegExp(targetText)}\\b.{0,80}\\b(no|not|absent|missing|unavailable|not observed|not found)\\b`, 'i')
    .test(`${evidenceText} ${visibleText}`);

  if (negativeEvidence) {
    return {
      target,
      outcome: 'ABSENT',
      scope: 'checked visible page state and report evidence',
      observedAlternatives: extractObservedAlternatives(`${evidenceText} ${visibleText}`, target),
      evidence: compactEvidence([input.llmReport?.evidence?.[0], input.evidence[0], visibleTexts.find((text) => normalize(text).includes('continue with') || normalize(text).includes('export') || normalize(text).includes('available'))]),
      summary: `${target} was not observed in the checked scope.`
    };
  }

  if (exactTargetSeen) {
    const match = visibleTexts.find((text) => normalize(text).includes(targetText)) || input.llmReport?.evidence?.find((text) => normalize(text).includes(targetText));
    return {
      target,
      outcome: 'PRESENT',
      scope: 'checked visible page state and report evidence',
      observedMatches: match ? [match.replace(/\s+/g, ' ').trim().slice(0, 160)] : [target],
      evidence: compactEvidence([match, input.evidence[0], input.llmReport?.evidence?.[0]]),
      summary: `${target} was observed in the checked scope.`
    };
  }

  return null;
}

function extractObservedAlternatives(text: string, target: string): string[] {
  const alternatives = Array.from(text.matchAll(/\b(?:Continue with|Sign in with|Log in with|Export(?: as)?|Download(?: as)?|Available options?:?)\s+([A-Za-z0-9 /+._-]{2,48})/gi))
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter((value) => value && !normalize(value).includes(normalize(target)));
  return [...new Set(alternatives)].slice(0, 8);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  if (intent === 'DISCOVERY_PROBE') {
    const probe = detectProbeTask(input.task);
    const finding = inferProbeFinding(input);
    if (finding && finding.outcome !== 'INCONCLUSIVE') {
      const absenceFailedExpectation = probe.isExpectation && finding.outcome === 'ABSENT';
      return {
        passed: !absenceFailedExpectation,
        status: absenceFailedExpectation ? 'FAIL' : 'PASS',
        rootCause: absenceFailedExpectation ? 'WEBSITE_BUG' : undefined,
        expected: probe.isExpectation ? `${finding.target} is present` : `${finding.target} availability is answered`,
        actual: formatProbeActual(finding),
        evidence: compactEvidence([finding.summary, ...finding.evidence, ...baseEvidence]),
        message: finding.summary
      };
    }
    return {
      passed: false,
      status: 'BLOCKED',
      rootCause: 'GOAL_NOT_REACHED',
      expected: probe.target ? `${probe.target} availability answered from scoped evidence` : 'Availability question answered from scoped evidence',
      actual: finding ? formatProbeActual(finding) : 'No conclusive present/absent finding',
      evidence: baseEvidence,
      message: 'The final state did not prove whether the requested target was present or absent.'
    };
  }

  if (input.llmReport && input.llmReport.result !== 'PASS') {
    return {
      passed: false,
      status: input.llmReport.result === 'FAIL' ? 'FAIL' : 'BLOCKED',
      rootCause: 'GOAL_NOT_REACHED',
      expected: 'Task completed successfully',
      actual: `LLM reported ${input.llmReport.result}`,
      evidence: baseEvidence,
      message: 'The agent determined it could not successfully complete or verify the task.'
    };
  }

  const reportPassed = reportClaimsPass(input.llmReport);
  if (intent === 'NAVIGATION') {
    const passed = hasKeywordEvidence && Boolean(url || title || pageText);
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: keywords.length ? `Navigation state containing: ${keywords.join(', ')}` : 'Requested navigation target reached',
      actual: passed ? true : 'Navigation target was not visible in URL/title/page text',
      evidence: baseEvidence,
      message: passed ? undefined : 'The final page state did not prove the requested navigation target.'
    };
  }

  if (intent === 'SEARCH_OR_DISCOVERY') {
    const searchState = /\b(search|results?|matches|found|showing)\b/i.test(`${combinedState} ${actionText}`);
    const passed = hasKeywordEvidence && searchState;
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: keywords.length ? `Search/discovery evidence containing: ${keywords.join(', ')}` : 'Requested result visible',
      actual: passed ? true : 'Search or discovery result evidence was not visible',
      evidence: baseEvidence,
      message: passed ? undefined : 'The final page state did not prove the requested search/discovery result.'
    };
  }

  if (intent === 'TRANSACTION_OR_CART') {
    const addExecuted = actions.some((action) => {
      const text = `${action.action} ${action.target || ''} ${action.label || ''} ${String(action.input ?? '')}`;
      return (/\badd\b.*\b(cart|bag|basket|product|item)\b/i.test(text) || /\b(continue|checkout|submit|place order|review order)\b/i.test(text)) &&
        !/\b(shopping bag|view bag|view cart|open bag|open cart|review bag|review cart)\b/i.test(text);
    });
    const cartState = /\b(cart|bag|basket|checkout|quantity|item added|added|subtotal)\b/i.test(combinedState);
    const passed = addExecuted && cartState && hasKeywordEvidence;
    return {
      passed,
      status: passed ? 'PASS' : 'BLOCKED',
      rootCause: passed ? undefined : 'GOAL_NOT_REACHED',
      expected: 'Add action executed and final cart/bag state contains requested target evidence',
      actual: passed ? true : 'Cart/bag outcome was not deterministically verified',
      evidence: baseEvidence,
      message: passed ? undefined : 'Product/configuration progress is not enough; the final cart/bag outcome was not verified.'
    };
  }

  const generalPassed = reportPassed && hasKeywordEvidence;

  return {
    passed: generalPassed,
    status: generalPassed ? 'PASS' : 'BLOCKED',
    rootCause: generalPassed ? undefined : 'GOAL_NOT_REACHED',
    expected: keywords.length ? `State containing: ${keywords.join(', ')}` : 'Task completed',
    actual: generalPassed ? true : (reportPassed ? 'Keywords not found in final state' : 'Agent did not provide passing evidence'),
    evidence: baseEvidence,
    message: generalPassed ? undefined : 'The final state did not deterministically prove the requested objective.'
  };
}
