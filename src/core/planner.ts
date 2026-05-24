import type { QaTemplate } from '../shared/types';
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
  templateId?: string;
  acceptanceCriteria: QaAcceptanceCriterionSpec[];
  assertions: QaAssertionSpec[];
  edgeCases: string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesPrompt(prompt: string, targetUrl: string, needles: string[]): boolean {
  const haystack = normalize(`${prompt} ${targetUrl}`);
  return needles.some((needle) => haystack.includes(normalize(needle)));
}

export function createTestPlan(input: {
  prompt: string;
  targetUrl: string;
  templateId?: string;
}): QaTestPlan {
  const template = getQaTemplate(input.templateId);
  if (template) return planForTemplate(template, input.prompt, input.targetUrl);

  if (matchesPrompt(input.prompt, input.targetUrl, ['roboform', 'all fields', 'fillable'])) {
    return fullFormPlan(input.prompt);
  }
  if (matchesPrompt(input.prompt, input.targetUrl, ['saucedemo', 'invalid credentials', 'wrong_password'])) {
    return loginNegativePlan(input.prompt);
  }
  if (matchesPrompt(input.prompt, input.targetUrl, ['add to cart', 'ecommerce', 'iphone'])) {
    return ecommercePlan(input.prompt);
  }
  if (matchesPrompt(input.prompt, input.targetUrl, ['mobile viewport', 'responsive', 'horizontal overflow'])) {
    return responsivePlan(input.prompt);
  }
  if (matchesPrompt(input.prompt, input.targetUrl, ['accessibility', 'aria', 'alt text'])) {
    return accessibilityPlan(input.prompt);
  }

  return genericPlan(input.prompt);
}

function planForTemplate(template: QaTemplate, prompt: string, targetUrl: string): QaTestPlan {
  switch (template.id) {
    case 'full-form-fill':
      return { ...fullFormPlan(prompt || template.task), templateId: template.id };
    case 'login-negative':
      return { ...loginNegativePlan(prompt || template.task), templateId: template.id };
    case 'ecommerce-add-to-cart':
      return { ...ecommercePlan(prompt || template.task), templateId: template.id };
    case 'responsive-mobile-smoke':
      return { ...responsivePlan(prompt || template.task), templateId: template.id };
    case 'accessibility-quick-check':
      return { ...accessibilityPlan(prompt || template.task), templateId: template.id };
    default:
      return { ...genericPlan(prompt || template.task || targetUrl), templateId: template.id };
  }
}

function fullFormPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [
    textValue('ASSERT-001', 'First Name value equals John', 'John', ['input[name="01___title"]', 'input[name*="fname"]', 'input[name*="first"]'], ['first name'], 'AC-001'),
    textValue('ASSERT-002', 'Last Name value equals Doe', 'Doe', ['input[name*="lname"]', 'input[name*="last"]'], ['last name'], 'AC-001'),
    textValue('ASSERT-003', 'Email value equals john.doe@example.com', 'john.doe@example.com', ['input[type="email"]', 'input[name*="email"]'], ['email'], 'AC-001'),
    selectedEquals('ASSERT-004', 'Card Type selected label equals Visa', 'Visa', ['select[name="40cc__type"]', 'select[name*="cc"][name*="type"]'], ['card type'], 'AC-003'),
    selectedNotDefault('ASSERT-005', 'Expiry Month selected value is not default', ['select[name="42ccexp_mm"]', 'select[name*="exp"][name*="mm"]'], ['expiry month', 'exp month'], 'AC-003'),
    selectedNotDefault('ASSERT-006', 'Expiry Year selected value is not expired/default', ['select[name="43ccexp_yy"]', 'select[name*="exp"][name*="yy"]'], ['expiry year', 'exp year'], 'AC-003'),
    selectedNotDefault('ASSERT-007', 'Birth Month selected value is not default', ['select[name*="birth"][name*="month"]', 'select[name*="bmonth"]'], ['birth month'], 'AC-004'),
    selectedNotDefault('ASSERT-008', 'Birth Day selected value is not default', ['select[name*="birth"][name*="day"]', 'select[name*="bday"]'], ['birth day'], 'AC-004'),
    selectedNotDefault('ASSERT-009', 'Birth Year selected value is not default', ['select[name*="birth"][name*="year"]', 'select[name*="byear"]'], ['birth year'], 'AC-004')
  ];
  return {
    testId: 'TC-FORM-001',
    title: 'Verify all required form fields are fillable',
    task,
    acceptanceCriteria: [
      criterion('AC-001', 'Text fields accept dummy data', assertions),
      { id: 'AC-002', description: 'Password field accepts dummy data', assertionIds: [] },
      criterion('AC-003', 'Select dropdowns accept valid options', assertions),
      criterion('AC-004', 'Birth date dropdowns accept valid options', assertions),
      { id: 'AC-005', description: 'No console errors during interaction', assertionIds: [] }
    ],
    assertions,
    edgeCases: ['Unsupported select action must block the run.', 'Do not mark pass unless selected values are verified.']
  };
}

function loginNegativePlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [
    {
      id: 'ASSERT-001',
      description: 'Invalid login does not reach inventory page',
      kind: 'url_not_includes',
      expected: 'inventory',
      required: true,
      acceptanceCriteriaId: 'AC-001'
    },
    {
      id: 'ASSERT-002',
      description: 'Relevant invalid credentials error is visible',
      kind: 'text_includes',
      expected: 'username and password do not match',
      required: true,
      textHints: ['invalid', 'do not match', 'epic sadface', 'credentials'],
      acceptanceCriteriaId: 'AC-002'
    }
  ];
  return {
    testId: 'TC-LOGIN-NEGATIVE-001',
    title: 'Verify invalid login is rejected with a visible error',
    task,
    acceptanceCriteria: [
      criterion('AC-001', 'Login does not succeed with invalid credentials', assertions),
      criterion('AC-002', 'A relevant error message is visible', assertions),
      { id: 'AC-003', description: 'Sensitive password is redacted from reports', assertionIds: [] }
    ],
    assertions,
    edgeCases: ['Bot protection or site outage blocks the test.', 'Invalid password must not appear in report artifacts.']
  };
}

function ecommercePlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [
    {
      id: 'ASSERT-001',
      description: 'Search results count is greater than 0',
      kind: 'count_greater_than',
      expected: 0,
      required: true,
      textHints: ['iphone'],
      acceptanceCriteriaId: 'AC-001'
    },
    {
      id: 'ASSERT-002',
      description: 'Final cart state contains selected product name',
      kind: 'text_includes',
      expected: 'iphone',
      required: true,
      textHints: ['iphone', 'cart'],
      acceptanceCriteriaId: 'AC-002'
    }
  ];
  return {
    testId: 'TC-ECOM-CART-001',
    title: 'Verify product can be added to cart',
    task,
    acceptanceCriteria: [
      criterion('AC-001', 'Search results appear', assertions),
      criterion('AC-002', 'Cart contains the selected product', assertions)
    ],
    assertions,
    edgeCases: ['Site layout changes should be reported as blocked, not website bugs.']
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
    acceptanceCriteria: [
      criterion('AC-001', 'Page has title, heading, labels, alt text, and reachable controls', assertions)
    ],
    assertions,
    edgeCases: ['Minor accessibility issues are warnings; critical blockers are failures.']
  };
}

function genericPlan(task: string): QaTestPlan {
  const assertions: QaAssertionSpec[] = [
    {
      id: 'ASSERT-001',
      description: 'User objective is verified by final DOM/page evidence',
      kind: 'objective_verified',
      expected: true,
      required: true,
      acceptanceCriteriaId: 'AC-001'
    }
  ];
  return {
    testId: 'TC-GENERIC-001',
    title: task.slice(0, 96) || 'Verify requested QA objective',
    task,
    acceptanceCriteria: [criterion('AC-001', 'Requested QA objective is completed and verified', assertions)],
    assertions,
    edgeCases: ['If the objective cannot be verified, final status is blocked.']
  };
}

function criterion(id: string, description: string, assertions: QaAssertionSpec[]): QaAcceptanceCriterionSpec {
  return {
    id,
    description,
    assertionIds: assertions.filter((assertion) => assertion.acceptanceCriteriaId === id).map((assertion) => assertion.id)
  };
}

function textValue(
  id: string,
  description: string,
  expected: string,
  selectorHints: string[],
  textHints: string[],
  acceptanceCriteriaId: string
): QaAssertionSpec {
  return {
    id,
    description,
    kind: 'equals',
    expected,
    selectorHints,
    textHints,
    required: true,
    acceptanceCriteriaId
  };
}

function selectedEquals(
  id: string,
  description: string,
  expected: string,
  selectorHints: string[],
  textHints: string[],
  acceptanceCriteriaId: string
): QaAssertionSpec {
  return {
    id,
    description,
    kind: 'equals',
    expected,
    selectorHints,
    textHints,
    required: true,
    acceptanceCriteriaId
  };
}

function selectedNotDefault(
  id: string,
  description: string,
  selectorHints: string[],
  textHints: string[],
  acceptanceCriteriaId: string
): QaAssertionSpec {
  return {
    id,
    description,
    kind: 'not_default',
    expected: 'non-default selection',
    selectorHints,
    textHints,
    defaultValues: ['', 'select', 'please select', 'month', 'day', 'year', 'mm', 'yy'],
    required: true,
    acceptanceCriteriaId
  };
}

