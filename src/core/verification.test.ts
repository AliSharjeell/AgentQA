import { describe, expect, it } from 'vitest';
import type { QaRunAction } from '../shared/types';
import type { PageObservation } from './harness';
import type { QaTestPlan } from './planner';
import { verifyPlanAssertions } from './verification';

const plan: QaTestPlan = {
  testId: 'TC-FORM-001',
  title: 'Verify form fields',
  task: 'Fill all fields',
  acceptanceCriteria: [],
  assertions: [],
  edgeCases: []
};

function observation(value: string = 'testuser@example.com'): PageObservation {
  return {
    taskUrl: 'https://example.test',
    page: { url: 'https://example.test' },
    availableElements: [],
    interactiveElements: [],
    pageText: '',
    consoleErrors: [],
    networkErrors: [],
    fieldRegistry: [
      {
        field_id: 'field_email_24emailadr',
        temporary_observation_id: 'elem_10',
        label: 'Email',
        selector: 'input[name="24emailadr"]',
        selector_candidates: ['input[name="24emailadr"]'],
        tag: 'input',
        type: 'email',
        name: '24emailadr',
        html_id: '',
        initial_value: '',
        value,
        label_source: 'name',
        confidence: 1,
        bbox: { x: 0, y: 0, width: 100, height: 20 },
        nearby_text: []
      },
      {
        field_id: 'field_expiry_month_42ccexp_mm',
        temporary_observation_id: 'elem_11',
        label: 'Expiry Month',
        selector: 'select[name="42ccexp_mm"]',
        selector_candidates: ['select[name="42ccexp_mm"]'],
        tag: 'select',
        type: 'select',
        name: '42ccexp_mm',
        html_id: '',
        initial_value: '1',
        value: '12',
        selected_value: '12',
        selected_label: '12',
        label_source: 'name',
        confidence: 1,
        bbox: { x: 0, y: 30, width: 100, height: 20 },
        nearby_text: []
      },
      {
        field_id: 'field_credit_card_type_40cc__type',
        temporary_observation_id: 'elem_12',
        label: 'Credit Card Type',
        selector: 'select[name="40cc__type"]',
        selector_candidates: ['select[name="40cc__type"]'],
        tag: 'select',
        type: 'select',
        name: '40cc__type',
        html_id: '',
        initial_value: '0',
        value: '9',
        selected_value: '9',
        selected_label: 'Visa (Preferred)',
        label_source: 'name',
        confidence: 1,
        bbox: { x: 0, y: 60, width: 100, height: 20 },
        nearby_text: []
      }
    ]
  };
}

describe('verifyPlanAssertions action-derived form oracle', () => {
  it('uses the planned action value for expected email assertions', () => {
    const actions: QaRunAction[] = [{
      action_id: 'A001.1',
      action: 'fill',
      field_id: 'field_email_24emailadr',
      selector: 'input[name="24emailadr"]',
      label: 'Email',
      planned_value: 'testuser@example.com',
      input: 'testuser@example.com',
      action_result: 'SUCCESS',
      timestamp: '2026-05-24T00:00:00.000Z'
    }];

    const assertions = verifyPlanAssertions({ plan, observation: observation(), actions, evidence: [], llmReport: null });
    expect(assertions[0].expected).toBe('testuser@example.com');
    expect(assertions[0].status).toBe('PASS');
  });

  it('passes select value/label assertions when actual selected value matches planned value', () => {
    const actions: QaRunAction[] = [{
      action_id: 'A002.1',
      action: 'select',
      field_id: 'field_expiry_month_42ccexp_mm',
      selector: 'select[name="42ccexp_mm"]',
      label: 'Expiry Month',
      planned_value: '12',
      input: '12',
      action_result: 'SUCCESS',
      timestamp: '2026-05-24T00:00:00.000Z'
    }];

    const assertions = verifyPlanAssertions({ plan, observation: observation(), actions, evidence: [], llmReport: null });
    expect(assertions[0].status).toBe('PASS');
    expect(assertions[0].actual).toContain('12');
  });

  it('formats select actual labels with bracketed values and compact evidence', () => {
    const actions: QaRunAction[] = [{
      action_id: 'A003.1',
      action: 'select',
      field_id: 'field_credit_card_type_40cc__type',
      selector: 'select[name="40cc__type"]',
      label: 'Credit Card Type',
      planned_value: 'Visa',
      input: 'Visa',
      action_result: 'SUCCESS',
      timestamp: '2026-05-24T00:00:00.000Z'
    }];

    const assertions = verifyPlanAssertions({ plan, observation: observation(), actions, evidence: ['old noisy evidence'], llmReport: null });
    expect(assertions[0].actual).toBe('Visa (Preferred) [value=9]');
    expect(assertions[0].selector).toBe('select[name="40cc__type"]');
    expect(assertions[0].evidence).toEqual([
      'selector: select[name="40cc__type"]',
      'screenshot: screenshots/04_final_state.png',
      'dom: dom/dom-after.json#field_credit_card_type_40cc__type'
    ]);
  });
});
