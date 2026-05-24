import { describe, expect, it } from 'vitest';
import type { QaAssertionResult, QaRunAction } from '../shared/types';
import type { PageObservation } from './harness';
import type { QaTestPlan } from './planner';
import { buildQaRunResult } from './reporter';

const basePlan: QaTestPlan = {
  testId: 'TC-UNIT-001',
  title: 'Unit QA verdict test',
  task: 'Verify unit behavior',
  acceptanceCriteria: [
    { id: 'AC-001', description: 'Required state is verified', assertionIds: ['ASSERT-001'] },
    { id: 'AC-002', description: 'Optional field state is verified', assertionIds: ['ASSERT-002'] }
  ],
  assertions: [],
  edgeCases: []
};

const observation: PageObservation = {
  taskUrl: 'https://example.test',
  page: { url: 'https://example.test', title: 'Example', w: 1365, h: 768, pw: 1365, ph: 768 },
  availableElements: [],
  interactiveElements: [],
  pageText: 'Example page',
  consoleErrors: [],
  networkErrors: []
};

function passAssertion(id: string = 'ASSERT-001'): QaAssertionResult {
  return {
    id,
    description: 'Verified expected state',
    status: 'PASS',
    expected: 'expected',
    actual: 'expected',
    required: true,
    evidence: ['DOM value matched']
  };
}

function passAction(): QaRunAction {
  return {
    action_id: 'A001',
    action: 'fill',
    target: 'input[name="email"]',
    input: 'john.doe@example.com',
    action_result: 'SUCCESS',
    verification: {
      expected: 'john.doe@example.com',
      actual: 'john.doe@example.com',
      status: 'PASS'
    },
    screenshot: 'screenshots/A001_after_fill.png',
    timestamp: '2026-05-24T00:00:00.000Z'
  };
}

function build(overrides: {
  actions?: QaRunAction[];
  assertions?: QaAssertionResult[];
  evidenceWarnings?: Array<{ message: string; artifact?: string }>;
} = {}) {
  return buildQaRunResult({
    runId: 'qa-run-unit',
    plan: basePlan,
    targetUrl: 'https://example.test',
    startedAt: '2026-05-24T00:00:00.000Z',
    endedAt: '2026-05-24T00:00:01.000Z',
    durationMs: 1000,
    actions: overrides.actions ?? [passAction()],
    assertions: overrides.assertions ?? [passAssertion()],
    observations: [observation],
    llmReport: {
      result: 'PASS',
      scenario: 'unit',
      confirmedBugs: [],
      warnings: [],
      stepsExecuted: [],
      evidence: ['verified'],
      finalUrl: 'https://example.test',
      screenshots: [],
      consoleErrors: [],
      fixRecommendations: []
    },
    evidence: ['screenshots/04_final_state.png'],
    evidenceWarnings: overrides.evidenceWarnings ?? [],
    artifacts: {
      html_report: 'report.html',
      markdown_report: 'report.md',
      json_result: 'result.json',
      screenshots_dir: 'screenshots/',
      action_trace: 'action-trace.json'
    }
  });
}

describe('QA verdict reporting', () => {
  it('returns PASS when every required assertion is verified with evidence', () => {
    const result = build();
    expect(result.status).toBe('PASS');
    expect(result.stats.assertions_passed).toBe(1);
  });

  it('returns FAIL for a verified real app behavior contradiction', () => {
    const result = build({
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'Cart contains iPhone',
        actual: 'Cart is empty',
        rootCause: 'WEBSITE_BUG'
      }]
    });
    expect(result.status).toBe('FAIL');
    expect(result.root_cause).toBe('WEBSITE_BUG');
  });

  it('returns BLOCKED for unsupported action agent limitations', () => {
    const result = build({
      actions: [{
        ...passAction(),
        action: 'select',
        action_result: 'BLOCKED',
        verification: {
          expected: 'Dropdown option selected and verified',
          actual: 'Unsupported action: select',
          status: 'BLOCKED',
          rootCause: 'AGENT_LIMITATION'
        }
      }],
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'Visa',
        actual: 'Default',
        rootCause: 'WEBSITE_BUG'
      }]
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('AGENT_LIMITATION');
  });

  it('returns BLOCKED for partial success with blocked required fields', () => {
    const result = build({
      assertions: [
        passAssertion('ASSERT-001'),
        {
          id: 'ASSERT-002',
          description: 'Card Type selected label equals Visa',
          status: 'BLOCKED',
          expected: 'Visa',
          actual: 'Default',
          rootCause: 'AGENT_LIMITATION',
          required: true
        }
      ]
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.stats.assertions_passed).toBe(1);
    expect(result.stats.assertions_blocked).toBe(1);
  });

  it('returns WARNING when assertions pass but screenshot evidence is partial', () => {
    const result = build({
      evidenceWarnings: [{ message: 'Required screenshot capture failed', artifact: 'screenshots/04_final_state.png' }]
    });
    expect(result.status).toBe('WARNING');
    expect(result.evidence_status).toBe('PARTIAL');
  });
});
