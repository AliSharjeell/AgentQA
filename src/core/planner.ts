import type { QaTaskIntent, QaTemplate } from '../shared/types';
import { detectTaskIntent } from './intent';
import { getQaTemplate } from './templates';

export type QaAssertionKind =
  | 'value_equals'
  | 'value_not_default'
  | 'selected_equals'
  | 'selected_not_default'
  | 'text_includes'
  | 'url_not_includes'
  | 'count_greater_than'
  | 'visible'
  | 'no_horizontal_overflow'
  | 'accessibility_basic'
  | 'objective_verified'
  | 'equals'
  | 'contains'
  | 'not_default'
  | 'valid_future_year'
  | 'not_empty'
  | 'changed';

export interface QaAssertionSpec {
  id: string;
  description: string;
  kind: QaAssertionKind;
  required: boolean;
  expected?: string | number | boolean;
  selectorHints?: string[];
  textHints?: string[];
  defaultValues?: string[];
  acceptanceCriteriaId: string;
}

export interface QaAcceptanceCriterionSpec {
  id: string;
  description: string;
  assertionIds: string[];
}

export interface QaTestPlan {
  testId: string;
  title: string;
  task: string;
  taskIntent: QaTaskIntent;
  templateId?: string;
  acceptanceCriteria: QaAcceptanceCriterionSpec[];
  assertions: QaAssertionSpec[];
  edgeCases: string[];
}

export function createTestPlan(input: {
  prompt: string;
  targetUrl: string;
  templateId?: string;
}): QaTestPlan {
  const template = getQaTemplate(input.templateId);
  if (template) return planForTemplate(template, input.prompt, input.targetUrl);

  const intent = detectTaskIntent(input.prompt).intent;
  if (intent === 'FORM_INTERACTION') return formInteractionPlan(input.prompt);
  if (intent === 'AUTH_FLOW') return authFlowPlan(input.prompt);
  if (intent === 'SEARCH_OR_DISCOVERY') return searchDiscoveryPlan(input.prompt);
  if (intent === 'NAVIGATION') return navigationPlan(input.prompt);
  if (intent === 'TRANSACTION_OR_CART') return transactionPlan(input.prompt);
  if (intent === 'SETTINGS_CHANGE') return settingsPlan(input.prompt);
  if (intent === 'CONTENT_VERIFICATION') return contentPlan(input.prompt);

  const promptText = input.prompt.toLowerCase();
  if (/\bmobile\b|\bresponsive\b|\bhorizontal overflow\b/.test(promptText)) {
    return responsivePlan(input.prompt);
  }
  if (/\baccessibility\b|\baria\b|\balt text\b/.test(promptText)) {
    return accessibilityPlan(input.prompt);
  }

  return genericPlan(input.prompt);
}

function planForTemplate(template: QaTemplate, prompt: string, targetUrl: string): QaTestPlan {
  switch (template.id) {
    case 'full-form-fill':
      return { ...formInteractionPlan(prompt || template.task), templateId: template.id };
    case 'auth-negative':
      return { ...authFlowPlan(prompt || template.task), templateId: template.id };
    case 'transaction-cart':
      return { ...transactionPlan(prompt || template.task), templateId: template.id };
    case 'responsive-mobile-smoke':
      return { ...responsivePlan(prompt || template.task), templateId: template.id };
    case 'accessibility-quick-check':
      return { ...accessibilityPlan(prompt || template.task), templateId: template.id };
    default:
      return { ...genericPlan(prompt || template.task || targetUrl), templateId: template.id };
  }
}

function formInteractionPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested form interaction is verified from final editable-control state', task, 'AC-001')];
  return {
    testId: 'TC-FORM-001',
    title: 'Verify requested form interaction',
    task,
    taskIntent: 'FORM_INTERACTION',
    acceptanceCriteria: [
      criterion('AC-001', 'Editable controls required by the task are discovered, changed, and verified', assertions),
      { id: 'AC-002', description: 'No console errors during interaction', assertionIds: [] }
    ],
    assertions,
    edgeCases: ['If no editable controls exist for a form-only task, block with NO_FIELDS_FOUND.', 'Do not mark pass unless field values are verified.']
  };
}

function authFlowPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested authentication outcome is verified', task, 'AC-001')];
  return {
    testId: 'TC-AUTH-001',
    title: 'Verify requested authentication flow',
    task,
    taskIntent: 'AUTH_FLOW',
    acceptanceCriteria: [
      criterion('AC-001', 'Final auth state or expected auth message is visible', assertions),
      { id: 'AC-002', description: 'Sensitive values are redacted from reports', assertionIds: [] }
    ],
    assertions,
    edgeCases: ['Missing credentials or blocked auth widgets are blocked outcomes, not product bugs by default.']
  };
}

function searchDiscoveryPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested search or discovery result is verified', task, 'AC-001')];
  return {
    testId: 'TC-SEARCH-001',
    title: 'Verify requested search or discovery flow',
    task,
    taskIntent: 'SEARCH_OR_DISCOVERY',
    acceptanceCriteria: [
      criterion('AC-001', 'Results or requested discovered content are visible', assertions)
    ],
    assertions,
    edgeCases: ['If search controls are absent, use navigation links before reporting a blocked run.']
  };
}

function navigationPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested navigation target is verified', task, 'AC-001')];
  return {
    testId: 'TC-NAVIGATION-001',
    title: 'Verify requested navigation',
    task,
    taskIntent: 'NAVIGATION',
    acceptanceCriteria: [criterion('AC-001', 'URL, title, heading, selected state, or page text proves the target was reached', assertions)],
    assertions,
    edgeCases: ['If the link/menu is missing, report REQUIRED_AFFORDANCE_NOT_FOUND rather than a website bug.']
  };
}

function transactionPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested cart or transaction state is verified', task, 'AC-001')];
  return {
    testId: 'TC-TRANSACTION-001',
    title: 'Verify requested cart or transaction flow',
    task,
    taskIntent: 'TRANSACTION_OR_CART',
    acceptanceCriteria: [criterion('AC-001', 'Final page state reflects the requested item or transaction result', assertions)],
    assertions,
    edgeCases: ['Choose options from observed DOM only; missing required options are blocked outcomes unless product behavior is proven wrong.']
  };
}

function settingsPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested setting change is verified', task, 'AC-001')];
  return {
    testId: 'TC-SETTINGS-001',
    title: 'Verify requested setting change',
    task,
    taskIntent: 'SETTINGS_CHANGE',
    acceptanceCriteria: [criterion('AC-001', 'Final DOM/page state shows the requested setting value', assertions)],
    assertions,
    edgeCases: ['Disabled or missing settings controls are blocked outcomes.']
  };
}

function contentPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'Requested content is visible', task, 'AC-001')];
  return {
    testId: 'TC-CONTENT-001',
    title: 'Verify requested content',
    task,
    taskIntent: 'CONTENT_VERIFICATION',
    acceptanceCriteria: [criterion('AC-001', 'Requested text, image, component, or heading is visible in the final state', assertions)],
    assertions,
    edgeCases: ['Visual-only issues require screenshot evidence.']
  };
}

function responsivePlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [
    {
      id: 'ASSERT-001',
      description: 'No horizontal overflow on checked viewport',
      kind: 'no_horizontal_overflow',
      expected: true,
      required: true,
      acceptanceCriteriaId: 'AC-001'
    },
    {
      id: 'ASSERT-002',
      description: 'Primary heading is visible',
      kind: 'visible',
      required: true,
      textHints: ['h1', 'heading'],
      acceptanceCriteriaId: 'AC-002'
    }
  ];
  return {
    testId: 'TC-RESPONSIVE-001',
    title: 'Verify desktop and mobile homepage usability',
    task,
    taskIntent: 'CONTENT_VERIFICATION',
    acceptanceCriteria: [
      criterion('AC-001', 'No horizontal overflow', assertions),
      criterion('AC-002', 'Primary content and CTA are usable', assertions)
    ],
    assertions,
    edgeCases: ['Mobile menu can be opened before CTA verification.']
  };
}

function accessibilityPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [
    {
      id: 'ASSERT-001',
      description: 'Basic accessibility checks do not find critical issues',
      kind: 'accessibility_basic',
      expected: true,
      required: true,
      acceptanceCriteriaId: 'AC-001'
    }
  ];
  return {
    testId: 'TC-A11Y-001',
    title: 'Verify basic accessibility requirements',
    task,
    taskIntent: 'CONTENT_VERIFICATION',
    acceptanceCriteria: [
      criterion('AC-001', 'Page has title, heading, labels, alt text, and reachable controls', assertions)
    ],
    assertions,
    edgeCases: ['Minor accessibility issues are warnings; critical blockers are failures.']
  };
}

function genericPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [objectiveAssertion('ASSERT-001', 'User objective is verified by final DOM/page evidence', task, 'AC-001')];
  return {
    testId: 'TC-GENERIC-001',
    title: task.slice(0, 96) || 'Verify requested QA objective',
    task,
    taskIntent: 'GENERAL_TASK',
    acceptanceCriteria: [criterion('AC-001', 'Requested QA objective is completed and verified', assertions)],
    assertions,
    edgeCases: ['If the objective cannot be verified, final status is blocked.']
  };
}

function objectiveAssertion(id: string, description: string, expected: string, acceptanceCriteriaId: string): QaAssertionSpec {
  return {
    id,
    description,
    kind: 'objective_verified',
    expected,
    required: true,
    acceptanceCriteriaId
  };
}

function criterion(id: string, description: string, assertions: QaAssertionSpec[]): QaAcceptanceCriterionSpec {
  return {
    id,
    description,
    assertionIds: assertions.filter((assertion) => assertion.acceptanceCriteriaId === id).map((assertion) => assertion.id)
  };
}
