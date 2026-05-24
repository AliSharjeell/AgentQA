import { describe, expect, it } from 'vitest';
import type { QaRunAction } from '../shared/types';
import type { ObservedElement, PageObservation } from './harness';
import { detectTaskIntent, detectGoalCompletion, resolveInitialObservationReadiness } from './intent';
import { createTestPlan } from './planner';
import { verifyPlanAssertions } from './verification';

function element(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    id: overrides.id || 'elem_0',
    type: overrides.type || 'link',
    description: overrides.description || 'Support',
    tag: overrides.tag || 'a',
    selector: overrides.selector || 'a[href="/support"]',
    href: overrides.href || '/support',
    x: overrides.x ?? 100,
    y: overrides.y ?? 50,
    visible: overrides.visible ?? true,
    disabled: overrides.disabled ?? false,
    ...overrides
  };
}

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  const elementRegistry = overrides.elementRegistry || overrides.availableElements || [];
  return {
    taskUrl: 'https://example.test',
    page: { url: 'https://example.test', title: 'Example', ...(overrides.page || {}) },
    elementRegistry,
    availableElements: overrides.availableElements || elementRegistry,
    interactiveElements: overrides.interactiveElements || elementRegistry,
    fieldRegistry: overrides.fieldRegistry || [],
    pageText: overrides.pageText || '',
    consoleErrors: [],
    networkErrors: [],
    ...overrides
  };
}

function successAction(action: string, label: string, input?: string): QaRunAction {
  return {
    action_id: 'A001',
    action,
    target: label,
    label,
    input,
    planned_value: input,
    action_result: 'SUCCESS',
    verification: { expected: 'Action completed', actual: 'Action completed', status: 'PASS' },
    timestamp: '2026-05-24T00:00:00.000Z'
  };
}

describe('general QA agent behavior', () => {
  it('continues when FieldRegistry is empty but links exist', () => {
    const readiness = resolveInitialObservationReadiness(
      'go to the support page',
      observation({ elementRegistry: [element()] })
    );

    expect(readiness.status).toBe('continue');
  });

  it('blocks a form-only task with no fields as NO_FIELDS_FOUND', () => {
    const plan = createTestPlan({ prompt: 'fill all fields', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({ elementRegistry: [element()] }),
      actions: [],
      evidence: [],
      llmReport: null
    });

    expect(plan.taskIntent).toBe('FORM_INTERACTION');
    expect(assertions[0].status).toBe('BLOCKED');
    expect(assertions[0].rootCause).toBe('NO_FIELDS_FOUND');
  });

  it('verifies a navigation task from URL/title/page evidence', () => {
    const plan = createTestPlan({ prompt: 'go to the support page', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({
        page: { url: 'https://example.test/support', title: 'Support' },
        pageText: 'Support Contact documentation and help center'
      }),
      actions: [successAction('click', 'Support')],
      evidence: ['Final URL: https://example.test/support'],
      llmReport: null
    });

    expect(plan.taskIntent).toBe('NAVIGATION');
    expect(assertions[0].status).toBe('PASS');
  });

  it('verifies a search task from query/result evidence', () => {
    const plan = createTestPlan({ prompt: 'search for iPhone', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({
        page: { url: 'https://example.test/search?q=iPhone', title: 'Search results' },
        pageText: 'Search results for iPhone. Showing 3 matching items.'
      }),
      actions: [successAction('fill', 'Search', 'iPhone'), successAction('press_key', 'Search', 'Enter')],
      evidence: ['Search results for iPhone'],
      llmReport: null
    });

    expect(plan.taskIntent).toBe('SEARCH_OR_DISCOVERY');
    expect(assertions[0].status).toBe('PASS');
  });

  it('answers a discovery probe when the requested capability is absent', () => {
    const plan = createTestPlan({ prompt: 'can u see if x auth is integrated in the site', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({
        pageText: 'Log in to your account Continue with Google Continue with GitHub Continue with Apple Continue with email Community X / Twitter',
        elementRegistry: [
          element({ id: 'google', type: 'button', tag: 'button', description: 'Continue with Google', text: 'Continue with Google' }),
          element({ id: 'github', type: 'button', tag: 'button', description: 'Continue with GitHub', text: 'Continue with GitHub' }),
          element({ id: 'apple', type: 'button', tag: 'button', description: 'Continue with Apple', text: 'Continue with Apple' }),
          element({ id: 'email', type: 'button', tag: 'button', description: 'Continue with email', text: 'Continue with email' })
        ]
      }),
      actions: [successAction('click', 'Log in')],
      evidence: ['Login modal was checked.'],
      llmReport: {
        result: 'PASS',
        scenario: 'can u see if x auth is integrated in the site',
        confirmedBugs: [],
        warnings: [],
        stepsExecuted: ['Opened login modal and checked auth choices'],
        evidence: ['Visible auth choices are Continue with Google, Continue with GitHub, Continue with Apple, and Continue with email. No X/Twitter auth option is present.'],
        probeFinding: {
          target: 'x auth',
          outcome: 'ABSENT',
          scope: 'login modal',
          observedMatches: [],
          observedAlternatives: ['Google', 'GitHub', 'Apple', 'email'],
          evidence: ['Login modal lists Google, GitHub, Apple, and email, with no X/Twitter option.'],
          summary: 'X/Twitter auth was not observed in the login modal.'
        },
        finalUrl: 'https://example.test',
        screenshots: [],
        consoleErrors: [],
        fixRecommendations: []
      }
    });

    expect(plan.taskIntent).toBe('DISCOVERY_PROBE');
    expect(assertions[0].status).toBe('PASS');
    expect(assertions[0].actual).toContain('not observed');
    expect(assertions[0].message).toContain('X/Twitter auth was not observed');
  });

  it('answers a discovery probe when the requested capability is present', () => {
    const plan = createTestPlan({ prompt: 'check whether dark mode is available', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({
        pageText: 'Settings Appearance Dark mode',
        elementRegistry: [element({ id: 'dark-mode', type: 'button', tag: 'button', description: 'Dark mode', text: 'Dark mode' })]
      }),
      actions: [],
      evidence: [],
      llmReport: null
    });

    expect(plan.taskIntent).toBe('DISCOVERY_PROBE');
    expect(assertions[0].status).toBe('PASS');
    expect(assertions[0].actual).toContain('observed');
  });

  it('blocks a discovery probe when neither presence nor absence is proven', () => {
    const plan = createTestPlan({ prompt: 'does this support CSV export', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({ pageText: 'Dashboard Home Reports' }),
      actions: [],
      evidence: [],
      llmReport: null
    });

    expect(plan.taskIntent).toBe('DISCOVERY_PROBE');
    expect(assertions[0].status).toBe('BLOCKED');
    expect(assertions[0].rootCause).toBe('GOAL_NOT_REACHED');
  });

  it('fails an explicit expectation when the requested capability is absent', () => {
    const plan = createTestPlan({ prompt: 'ensure CSV export is available', targetUrl: 'https://example.test' });
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({ pageText: 'Export as PDF' }),
      actions: [successAction('click', 'Export')],
      evidence: ['Export menu checked.'],
      llmReport: {
        result: 'PASS',
        scenario: 'ensure CSV export is available',
        confirmedBugs: [],
        warnings: [],
        stepsExecuted: ['Opened export menu'],
        evidence: ['Export menu contains PDF only. CSV export is not present.'],
        probeFinding: {
          target: 'csv export',
          outcome: 'ABSENT',
          scope: 'export menu',
          observedMatches: [],
          observedAlternatives: ['PDF'],
          evidence: ['Export menu contains PDF only.'],
          summary: 'CSV export was not observed in the export menu.'
        },
        finalUrl: 'https://example.test',
        screenshots: [],
        consoleErrors: [],
        fixRecommendations: []
      }
    });

    expect(plan.taskIntent).toBe('DISCOVERY_PROBE');
    expect(assertions[0].status).toBe('FAIL');
    expect(assertions[0].rootCause).toBe('WEBSITE_BUG');
  });

  it('verifies a cart-like local fixture from final cart state', () => {
    const completion = detectGoalCompletion({
      task: 'add product to cart',
      intent: 'TRANSACTION_OR_CART',
      observation: observation({
        page: { url: 'https://example.test/cart', title: 'Cart' },
        pageText: 'Cart 1 item added. Widget quantity 1. Checkout available.'
      }),
      actions: [successAction('click', 'Add product')],
      evidence: ['Cart 1 item added']
    });

    expect(completion.status).toBe('PASS');
  });

  it('verifies a form fixture using FieldRegistry values', () => {
    const plan = createTestPlan({ prompt: 'fill all fields', targetUrl: 'https://example.test/form' });
    const fieldRegistry = [{
      field_id: 'field_email',
      temporary_observation_id: 'elem_email',
      label: 'Email',
      selector: '#email',
      selector_candidates: ['#email'],
      tag: 'input',
      type: 'email',
      name: 'email',
      html_id: 'email',
      initial_value: '',
      value: 'test@example.com',
      label_source: 'label-for' as const,
      confidence: 1,
      bbox: { x: 0, y: 0, width: 100, height: 20 },
      nearby_text: []
    }];
    const assertions = verifyPlanAssertions({
      plan,
      observation: observation({ fieldRegistry }),
      actions: [{
        ...successAction('fill', 'Email', 'test@example.com'),
        field_id: 'field_email',
        temporary_observation_id: 'elem_email',
        selector: '#email'
      }],
      evidence: [],
      llmReport: null
    });

    expect(assertions[0].status).toBe('PASS');
  });

  it('does not field-block a mixed flow before fields appear', () => {
    const prompt = 'search product, open it, fill a contact form';
    const intent = detectTaskIntent(prompt);
    const readiness = resolveInitialObservationReadiness(
      prompt,
      observation({ elementRegistry: [element({ description: 'Search', type: 'button', tag: 'button', selector: '#search' })] }),
      intent
    );

    expect(intent.requiresFieldsAtStart).toBe(false);
    expect(intent.intent).toBe('GENERAL_TASK');
    expect(readiness.status).toBe('continue');
  });
});
