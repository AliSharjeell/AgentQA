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
