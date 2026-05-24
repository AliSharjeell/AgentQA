import type {
  QaAssertionResult,
  QaRootCause,
  QaRunAction,
  QaVerdict,
  QaVerificationResult,
  FieldRegistryEntry
} from '../shared/types';
import type { ExecutorActionOutcome } from './executor';
import type { CliReport, ObservedElement, PageObservation, StructuredAction } from './harness';
import type { QaAssertionSpec, QaTestPlan } from './planner';
import { redactSensitiveText, redactValue } from './sanitize';

export function verifyAction(input: {
  actionId: string;
  action: StructuredAction;
  target: ObservedElement | null;
  outcome: ExecutorActionOutcome;
  screenshot?: string;
  timestamp: string;
}): QaRunAction {
  const actionResult = actionResultFor(input.outcome);
  const verification = verificationForAction(input.action, input.target, input.outcome);
  return {
    action_id: input.actionId,
    action: input.action.action,
    target: targetLabel(input.target) || input.action.targetId,
    field_id: input.target?.id || input.action.targetId,
    input: redactValue(input.action.value ?? input.action.key ?? input.action.url ?? null, targetLabel(input.target) || input.action.targetId),
    initial_value: input.target?.value,
    planned_value: input.action.value,
    actual_value: verification?.actual,
    action_result: actionResult,
    verification,
    screenshot: input.screenshot,
    timestamp: input.timestamp,
    ...(input.action.actions && input.action.actions.length > 0
      ? {
          sub_actions: input.action.actions.map((sub, i) =>
            verifyAction({
              actionId: `${input.actionId}.${i + 1}`,
              action: sub as StructuredAction,
              target: null,
              outcome: input.outcome,
              timestamp: input.timestamp
            })
          )
        }
      : {})
  };
}

export function verifyPlanAssertions(input: {
  plan: QaTestPlan;
  observation: PageObservation;
  llmReport?: CliReport | null;
  evidence: string[];
  actions: QaRunAction[];
}): QaAssertionResult[] {
  return input.plan.assertions.map((spec) => verifyPlanAssertion(spec, input.observation, input.llmReport, input.evidence, input.actions));
}

function actionResultFor(outcome: ExecutorActionOutcome): QaRunAction['action_result'] {
  if (outcome.status === 'blocked') return 'BLOCKED';
  if (!outcome.ok) return isAgentLimitation(outcome.message) ? 'BLOCKED' : 'FAILED';
  return 'SUCCESS';
}

function verificationForAction(
  action: StructuredAction,
  target: ObservedElement | null,
  outcome: ExecutorActionOutcome
): QaVerificationResult {
  if (!outcome.ok) {
    return {
      expected: expectedForFailedAction(action),
      actual: outcome.message,
      status: isAgentLimitation(outcome.message) ? 'BLOCKED' : 'FAIL',
      rootCause: isAgentLimitation(outcome.message) ? 'AGENT_LIMITATION' : 'AMBIGUOUS',
      message: outcome.message
    };
  }

  if (target?.disabled && ['type', 'fill', 'select', 'check', 'uncheck', 'radio'].includes(action.action)) {
    return {
      expected: 'enabled editable control',
      actual: 'disabled control',
      status: 'BLOCKED',
      rootCause: 'AGENT_LIMITATION',
      message: 'Target control is disabled and cannot be changed by a normal user action.'
    };
  }

  const actualTarget = findCurrentElement(outcome.observation, target);
  switch (action.action) {
    case 'type':
    case 'fill':
      if (action.value && String(target?.value) === String(action.value)) {
        return {
          expected: 'New value different from initial',
          actual: 'Tried to fill initial value: ' + action.value,
          status: 'BLOCKED',
          rootCause: 'TEST_DATA_ISSUE',
          message: 'Planned value is identical to initial value. Cannot prove fillability.'
        };
      }
      return verifyValue(action.value ?? '', actualTarget, 'AGENT_INTERNAL_ERROR');
    case 'select':
      if (action.value && (String(target?.value) === String(action.value) || String(target?.text) === String(action.value))) {
        return {
          expected: 'New value different from initial',
          actual: 'Tried to select initial value: ' + action.value,
          status: 'BLOCKED',
          rootCause: 'TEST_DATA_ISSUE',
          message: 'Planned value is identical to initial value. Cannot prove fillability.'
        };
      }
      return verifySelected(action.value ?? '', actualTarget, 'AGENT_INTERNAL_ERROR');
    case 'check':
    case 'radio':
      return verifyChecked(true, actualTarget);
    case 'uncheck':
      return verifyChecked(false, actualTarget);
    case 'assert_value':
      return verifyValue(action.value ?? '', actualTarget, 'WEBSITE_BUG');
    case 'assert_checked':
      return verifyChecked(parseExpectedBoolean(action.value, true), actualTarget, 'WEBSITE_BUG');
    case 'assert_selected':
      return verifySelected(action.value ?? '', actualTarget, 'WEBSITE_BUG');
    case 'assert_url':
      return verifyUrl(action.value ?? '', outcome.observation);
    case 'assert_text':
      return verifyText(action.value ?? '', outcome.observation);
    case 'assert_visible': {
      const isVisible = actualTarget && ('visible' in actualTarget ? actualTarget.visible : true);
      return {
        expected: true,
        actual: Boolean(isVisible),
        status: isVisible ? 'PASS' : 'FAIL',
        rootCause: isVisible ? undefined : 'WEBSITE_BUG'
      };
    }
    default:
      return {
        expected: 'Action completed and page state was re-observed',
        actual: outcome.actionResult || outcome.message,
        status: 'PASS'
      };
  }
}

function verifyPlanAssertion(
  spec: QaAssertionSpec,
  observation: PageObservation,
  llmReport: CliReport | null | undefined,
  evidence: string[],
  actions: QaRunAction[]
): QaAssertionResult {
  const element = findElement(observation, spec);
  switch (spec.kind) {
    case 'value_equals':
    case 'equals': {
      const expected = getExpectedValueFromActions(spec, element, actions) ?? String(spec.expected ?? '');
      return assertionFromVerification(spec, verifyValue(expected, element, 'WEBSITE_BUG'));
    }
    case 'contains':
      return assertionFromVerification(spec, verifyContains(String(spec.expected ?? ''), element, 'WEBSITE_BUG'));
    case 'value_not_default':
    case 'not_default':
      return assertionFromVerification(spec, verifyNotDefault(spec, element));
    case 'selected_equals': {
      const expected = getExpectedValueFromActions(spec, element, actions) ?? String(spec.expected ?? '');
      return assertionFromVerification(spec, verifySelected(expected, element, 'WEBSITE_BUG'));
    }
    case 'valid_future_year':
      return assertionFromVerification(spec, verifyFutureYear(element));
    case 'not_empty':
      return assertionFromVerification(spec, verifyNotEmpty(element));
    case 'changed':
      return assertionFromVerification(spec, verifyChanged(spec, element));
    case 'selected_not_default':
      return assertionFromVerification(spec, verifyNotDefault(spec, element, true));
    case 'text_includes':
      return verifyTextAssertion(spec, observation);
    case 'url_not_includes':
      return verifyUrlNotIncludesAssertion(spec, observation);
    case 'count_greater_than':
      return verifyCountGreaterThanAssertion(spec, observation);
    case 'visible':
      return verifyVisibleAssertion(spec, observation);
    case 'no_horizontal_overflow':
      return verifyNoOverflowAssertion(spec, observation);
    case 'accessibility_basic':
      return verifyAccessibilityBasicAssertion(spec, observation);
    case 'objective_verified':
      return verifyObjectiveAssertion(spec, llmReport, evidence);
    default:
      return blockedAssertion(spec, 'Unsupported assertion kind.', 'AGENT_LIMITATION');
  }
}

function missingElementResult(expected: string): QaVerificationResult {
  return {
    expected,
    actual: null,
    status: 'BLOCKED',
    rootCause: 'VERIFICATION_MAPPING_ERROR',
    message: 'Could not find the field in the final DOM observation.'
  };
}

function verifyValue(expected: string, element: FieldRegistryEntry | ObservedElement | null, blockedRootCause: QaRootCause): QaVerificationResult {
  if (!element) return missingElementResult(expected);
  const actual = 'value' in element ? String(element.value ?? (element as any).initial_value ?? '') : String((element as ObservedElement).value ?? '');
  const desc = 'label' in element ? element.label : (element as ObservedElement).description;
  return {
    expected: redactSensitiveText(expected, desc),
    actual: redactSensitiveText(actual, desc),
    status: actual === expected ? 'PASS' : 'FAIL',
    rootCause: actual === expected ? undefined : blockedRootCause
  };
}

function verifyContains(expected: string, element: FieldRegistryEntry | ObservedElement | null, mismatchRootCause: QaRootCause): QaVerificationResult {
  if (!element) return missingElementResult(expected);
  const val = 'value' in element ? String(element.value ?? (element as any).initial_value ?? '') : String((element as ObservedElement).value ?? (element as ObservedElement).text ?? '');
  const actual = val;
  const passed = normalize(actual).includes(normalize(expected));
  return {
    expected: `Contains ${expected}`,
    actual,
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : mismatchRootCause
  };
}

function verifyFutureYear(element: FieldRegistryEntry | ObservedElement | null): QaVerificationResult {
  if (!element) return missingElementResult('Future Year');
  const actual = ('value' in element ? String(element.value ?? (element as any).initial_value ?? '') : String((element as ObservedElement).value ?? (element as ObservedElement).text ?? '')).trim();
  const year = parseInt(actual, 10);
  const currentYear = new Date().getFullYear();
  const passed = !isNaN(year) && year >= currentYear;
  return {
    expected: `>= ${currentYear}`,
    actual,
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG'
  };
}

function verifyNotEmpty(element: FieldRegistryEntry | ObservedElement | null): QaVerificationResult {
  if (!element) return missingElementResult('Not Empty');
  const actual = ('value' in element ? String(element.value ?? (element as any).initial_value ?? '') : String((element as ObservedElement).value ?? (element as ObservedElement).text ?? '')).trim();
  const passed = actual.length > 0;
  return {
    expected: 'Not Empty',
    actual: actual === '' ? '<empty>' : actual,
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG'
  };
}

function verifyChanged(spec: QaAssertionSpec, element: FieldRegistryEntry | ObservedElement | null): QaVerificationResult {
  if (!element) return missingElementResult('Changed value');
  const actual = ('value' in element ? String(element.value ?? (element as any).initial_value ?? '') : String((element as ObservedElement).value ?? (element as ObservedElement).text ?? '')).trim();
  const initial = String(spec.expected ?? '').trim();
  const passed = actual !== initial;
  return {
    expected: `Not equal to ${initial || 'initial'}`,
    actual,
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG'
  };
}

function verifySelected(
  expected: string,
  element: FieldRegistryEntry | ObservedElement | null,
  mismatchRootCause: QaRootCause = 'WEBSITE_BUG'
): QaVerificationResult {
  if (!element) {
    return {
      expected,
      actual: null,
      status: 'BLOCKED',
      rootCause: 'AGENT_LIMITATION',
      message: 'Could not find the dropdown in the final DOM observation.'
    };
  }
  const selected = 'selected_value' in element && element.selected_value !== undefined ? 
    (element.selected_label ? { label: element.selected_label, value: element.selected_value || '' } : null) 
    : selectedOption(element as ObservedElement);
    
  if ('tag' in element && element.tag === 'select' && !selected) {
    return {
      expected,
      actual: 'Unknown (Options mapping failed)',
      status: 'BLOCKED',
      rootCause: 'AGENT_LIMITATION',
      message: 'Could not extract selected option mapping for verification.'
    };
  }
    
  const actual = selected ? `${selected.label} ${selected.value}`.trim() : ('value' in element ? String(element.value ?? (element as any).initial_value ?? '') : String((element as ObservedElement).value ?? (element as ObservedElement).text ?? ''));
  const expectedNormalized = normalize(expected);
  const matched = Boolean(
    selected &&
    (normalize(selected.value) === expectedNormalized || normalize(selected.label) === expectedNormalized)
  ) || normalize(actual).includes(expectedNormalized);
  return {
    expected,
    actual,
    actual_select: selected ? { value: selected.value, label: selected.label } : undefined,
    status: matched ? 'PASS' : 'FAIL',
    rootCause: matched ? undefined : mismatchRootCause
  };
}

function verifyChecked(
  expected: boolean,
  element: FieldRegistryEntry | ObservedElement | null,
  mismatchRootCause: QaRootCause = 'WEBSITE_BUG'
): QaVerificationResult {
  if (!element) {
    return {
      expected,
      actual: null,
      status: 'BLOCKED',
      rootCause: 'AGENT_LIMITATION',
      message: 'Could not find the checkbox/radio in the final DOM observation.'
    };
  }
  const actual = 'checked' in element && element.checked !== undefined ? element.checked : ('initial_value' in element ? element.initial_value === 'true' : Boolean((element as ObservedElement).checked));
  return {
    expected,
    actual,
    status: actual === expected ? 'PASS' : 'FAIL',
    rootCause: actual === expected ? undefined : mismatchRootCause
  };
}

function verifyUrl(expected: string, observation: PageObservation): QaVerificationResult {
  const actual = observation.page.url || '';
  const passed = expected ? actual.includes(expected) : Boolean(actual);
  return {
    expected,
    actual,
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG'
  };
}

function verifyText(expected: string, observation: PageObservation): QaVerificationResult {
  const passed = normalize(observation.pageText).includes(normalize(expected));
  return {
    expected,
    actual: observation.pageText.slice(0, 500),
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG'
  };
}

function verifyNotDefault(spec: QaAssertionSpec, element: FieldRegistryEntry | ObservedElement | null, selected: boolean = false): QaVerificationResult {
  if (!element) {
    return {
      expected: spec.expected ?? 'non-default value',
      actual: null,
      status: 'BLOCKED',
      rootCause: 'AGENT_LIMITATION',
      message: 'Could not find the field in the final DOM observation.'
    };
  }
  const option = selected ? ('selected_value' in element ? { label: element.selected_label, value: element.selected_value } : selectedOption(element as ObservedElement)) : null;
  const actual = String(option?.value || option?.label || ('initial_value' in element ? element.initial_value : ((element as ObservedElement).value || (element as ObservedElement).text)) || '');
  const normalized = normalize(actual);
  const defaults = spec.defaultValues || ['', 'select', 'please select'];
  const isDefault = !normalized || defaults.some((value) => normalize(value) === normalized || normalized.includes(normalize(value)));
  return {
    expected: spec.expected ?? 'non-default value',
    actual,
    status: isDefault ? 'FAIL' : 'PASS',
    rootCause: isDefault ? 'WEBSITE_BUG' : undefined
  };
}

function verifyTextAssertion(spec: QaAssertionSpec, observation: PageObservation): QaAssertionResult {
  const pageText = normalize(observation.pageText);
  const expected = String(spec.expected ?? '');
  const hints = [expected, ...(spec.textHints || [])].filter(Boolean);
  const passed = hints.some((hint) => pageText.includes(normalize(hint)));
  return {
    id: spec.id,
    description: spec.description,
    expected,
    actual: observation.pageText.slice(0, 500),
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG',
    required: spec.required,
    evidence: passed ? ['Final page text contains the expected error/content.'] : []
  };
}

function verifyUrlNotIncludesAssertion(spec: QaAssertionSpec, observation: PageObservation): QaAssertionResult {
  const expected = String(spec.expected ?? '');
  const actual = observation.page.url || '';
  const passed = expected ? !normalize(actual).includes(normalize(expected)) : true;
  return {
    id: spec.id,
    description: spec.description,
    expected: `URL does not include ${expected}`,
    actual,
    status: passed ? 'PASS' : 'FAIL',
    rootCause: passed ? undefined : 'WEBSITE_BUG',
    required: spec.required
  };
}

function verifyCountGreaterThanAssertion(spec: QaAssertionSpec, observation: PageObservation): QaAssertionResult {
  const minimum = Number(spec.expected ?? 0);
  const matches = (spec.textHints || []).filter((hint) => normalize(observation.pageText).includes(normalize(hint))).length;
  return {
    id: spec.id,
    description: spec.description,
    expected: `>${minimum}`,
    actual: matches,
    status: matches > minimum ? 'PASS' : 'BLOCKED',
    rootCause: matches > minimum ? undefined : 'AMBIGUOUS',
    required: spec.required,
    message: matches > minimum ? undefined : 'Could not prove the expected count from the final DOM text.'
  };
}

function verifyVisibleAssertion(spec: QaAssertionSpec, observation: PageObservation): QaAssertionResult {
  const element = findElement(observation, spec);
  const isVisible = element && ('visible' in element ? element.visible : true);
  const passed = Boolean(isVisible) || observation.pageText.length > 0;
  return {
    id: spec.id,
    description: spec.description,
    expected: true,
    actual: passed,
    status: passed ? 'PASS' : 'BLOCKED',
    rootCause: passed ? undefined : 'AMBIGUOUS',
    required: spec.required
  };
}

function verifyNoOverflowAssertion(spec: QaAssertionSpec, observation: PageObservation): QaAssertionResult {
  const viewport = observation.page.w || 0;
  const scrollWidth = observation.page.pw || viewport;
  const passed = viewport > 0 && scrollWidth <= viewport + 4;
  return {
    id: spec.id,
    description: spec.description,
    expected: true,
    actual: viewport > 0 ? scrollWidth <= viewport + 4 : null,
    status: passed ? 'PASS' : 'WARNING',
    rootCause: passed ? undefined : 'WEBSITE_BUG',
    required: spec.required,
    message: viewport > 0 ? undefined : 'Viewport metrics were not available.'
  };
}

function verifyAccessibilityBasicAssertion(spec: QaAssertionSpec, observation: PageObservation): QaAssertionResult {
  const hasTitle = Boolean(observation.page.title);
  const hasText = Boolean(observation.pageText.trim());
  const inputsWithoutNames = observation.availableElements.filter((element) => {
    if (!['input', 'email', 'password', 'text', 'textarea', 'checkbox', 'radio', 'select'].includes(element.type)) return false;
    return !element.description && !element.name;
  }).length;
  const passed = hasTitle && hasText && inputsWithoutNames === 0;
  return {
    id: spec.id,
    description: spec.description,
    expected: true,
    actual: passed,
    status: passed ? 'PASS' : 'WARNING',
    rootCause: passed ? undefined : 'WEBSITE_BUG',
    required: spec.required,
    message: passed ? undefined : 'Basic accessibility scan found missing title/text context or unlabeled inputs.'
  };
}

function verifyObjectiveAssertion(
  spec: QaAssertionSpec,
  llmReport: CliReport | null | undefined,
  evidence: string[]
): QaAssertionResult {
  const passed = llmReport?.result === 'PASS' && evidence.length > 0;
  return {
    id: spec.id,
    description: spec.description,
    expected: true,
    actual: passed,
    status: passed ? 'PASS' : 'BLOCKED',
    rootCause: passed ? undefined : 'AMBIGUOUS',
    required: spec.required,
    evidence,
    message: passed ? undefined : 'The final objective was not proven by a PASS report with evidence.'
  };
}

function assertionFromVerification(spec: QaAssertionSpec, verification: QaVerificationResult): QaAssertionResult {
  return {
    id: spec.id,
    description: spec.description,
    expected: verification.expected,
    actual: verification.actual,
    status: verification.status,
    rootCause: verification.rootCause,
    evidence: verification.status === 'PASS' ? ['Final DOM value matched expected state.'] : [],
    message: verification.message,
    required: spec.required
  };
}

function blockedAssertion(spec: QaAssertionSpec, message: string, rootCause: QaRootCause): QaAssertionResult {
  return {
    id: spec.id,
    description: spec.description,
    status: 'BLOCKED',
    rootCause,
    required: spec.required,
    message
  };
}

function findCurrentElement(observation: PageObservation, target: ObservedElement | null): FieldRegistryEntry | ObservedElement | null {
  if (!target) return null;
  
  if (observation.fieldRegistry) {
    const byId = observation.fieldRegistry.find(entry => entry.field_id === target.id);
    if (byId) return byId;
    
    const bySelector = observation.fieldRegistry.find(entry => entry.selector === target.selector);
    if (bySelector) return bySelector;
  }
  
  return observation.availableElements.find((element) => element.selector === target.selector) ||
    observation.availableElements.find((element) => element.name && element.name === target.name) ||
    observation.availableElements.find((element) => element.description && element.description === target.description) ||
    null;
}

function findElement(observation: PageObservation, spec: QaAssertionSpec): FieldRegistryEntry | ObservedElement | null {
  const selectors = spec.selectorHints || [];
  
  if (observation.fieldRegistry && observation.fieldRegistry.length > 0) {
    for (const selector of selectors) {
      const exact = observation.fieldRegistry.find((element) => normalize(element.selector) === normalize(selector));
      if (exact) return exact;
    }
    for (const selector of selectors) {
      const partial = observation.fieldRegistry.find((element) => normalize(element.selector).includes(normalize(selector.replace(/["']/g, ''))));
      if (partial) return partial;
    }
    const hints = spec.textHints || [];
    const byHint = observation.fieldRegistry.find((element) => {
      const haystack = normalize(`${element.label} ${element.name} ${element.selector} ${element.initial_value}`);
      return hints.some((hint) => haystack.includes(normalize(hint)));
    });
    if (byHint) return byHint;
  }

  // Fallback to availableElements
  for (const selector of selectors) {
    const exact = observation.availableElements.find((element) => normalize(element.selector) === normalize(selector));
    if (exact) return exact;
  }
  for (const selector of selectors) {
    const partial = observation.availableElements.find((element) => normalize(element.selector).includes(normalize(selector.replace(/["']/g, ''))));
    if (partial) return partial;
  }

  const hints = spec.textHints || [];
  return observation.availableElements.find((element) => {
    const haystack = normalize(`${element.description} ${element.name} ${element.selector} ${element.text} ${element.value}`);
    return hints.some((hint) => haystack.includes(normalize(hint)));
  }) ?? null;
}

function selectedOption(element: ObservedElement): { value: string; label: string } | null {
  const selected = element.options?.find((option) => option.selected);
  if (selected) return { value: selected.value, label: selected.label };
  if (element.value) {
    const byValue = element.options?.find((option) => option.value === element.value);
    if (byValue) return { value: byValue.value, label: byValue.label };
  }
  return null;
}

function targetLabel(target: FieldRegistryEntry | ObservedElement | null): string | undefined {
  if (!target) return undefined;
  if ('label' in target) return target.selector || target.label || target.field_id;
  return target.selector || target.description || target.id;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function expectedForFailedAction(action: StructuredAction): string {
  if (action.action === 'select') return 'Dropdown option selected and verified';
  if (action.action === 'type' || action.action === 'fill') return 'Field value filled and verified';
  return 'Action completed successfully';
}

function isAgentLimitation(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('unsupported action') ||
    normalized.includes('no usable selector') ||
    normalized.includes('target element is required') ||
    normalized.includes('option lookup failed') ||
    normalized.includes('no visible custom option') ||
    normalized.includes('element not found');
}

function parseExpectedBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function getExpectedValueFromActions(spec: QaAssertionSpec, element: FieldRegistryEntry | ObservedElement | null, actions: QaRunAction[]): string | undefined {
  if (!element || !('field_id' in element)) return undefined;
  
  const action = [...actions].reverse().find(a => 
    a.field_id === element.field_id && 
    ['fill', 'type', 'select', 'check', 'radio'].includes(a.action)
  );
  
  if (action && action.planned_value !== undefined && action.planned_value !== null) {
    return String(action.planned_value);
  }
  return undefined;
}

