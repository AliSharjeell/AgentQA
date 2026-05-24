import { describe, expect, it } from 'vitest';
import type { QaAssertionResult, QaRunAction } from '../shared/types';
import type { PageObservation } from './harness';
import type { QaTestPlan } from './planner';
import { applyValidatorGating, applyVerifierRuntimeErrorGate, buildQaRunResult } from './reporter';
import type { QaValidatorResult } from '../shared/types';

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
      action_trace: 'action-trace.json',
      dom_after: 'dom-after.json'
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
        rootCause: 'AGENT_LIMITATION'
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

  it('returns PASS_WITH_WARNINGS when assertions pass but screenshot evidence is partial', () => {
    const result = build({
      evidenceWarnings: [{ message: 'Required screenshot capture failed', artifact: 'screenshots/04_final_state.png' }]
    });
    expect(result.status).toBe('PASS_WITH_WARNINGS');
    expect(result.evidence_status).toBe('PARTIAL');
  });

  // Bug Fix 1: The final normalized report says BLOCKED, but raw _report.result says PASS.
  it('does not return BLOCKED if raw report is PASS and assertions passed', () => {
    const result = build();
    expect(result.status).toBe('PASS');
  });

  // Bug Fix 2 & 3: Field mapping errors should be BLOCKED, not FAIL/WEBSITE_BUG.
  it('returns BLOCKED for VERIFICATION_MAPPING_ERROR', () => {
    const result = build({
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'John',
        actual: 'Mr.',
        rootCause: 'VERIFICATION_MAPPING_ERROR'
      }]
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('VERIFICATION_MAPPING_ERROR');
  });

  // Bug Fix 4: Last Name could not be found but form was filled.
  it('returns BLOCKED for AGENT_LIMITATION on failed assertion', () => {
    const result = build({
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'Doe',
        actual: 'Could not be found',
        rootCause: 'AGENT_LIMITATION'
      }]
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('AGENT_LIMITATION');
  });

  // Bug Fix 7: Issue evidence screenshots are empty even though screenshots exist.
  it('attaches screenshots and artifacts to issues properly', () => {
    const result = build({
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'Visa',
        actual: 'Default',
        rootCause: 'WEBSITE_BUG',
        evidence: ['screenshots/error1.png', 'text data'] // should filter for .png
      }]
    });
    expect(result.issues[0].evidence.screenshots).toContain('screenshots/error1.png');
    expect(result.issues[0].evidence.screenshots).not.toContain('text data');
    expect(result.issues[0].evidence.dom_snapshot).toBe('dom-after.json');
    expect(result.issues[0].evidence.action_trace).toBe('action-trace.json');
  });

  // Bug Fix 8: Reproduction steps are truncated batch actions.
  it('expands batch actions into individual reproduction steps', () => {
    const result = build({
      actions: [{
        ...passAction(),
        action: 'batch',
        sub_actions: [
          { ...passAction(), action: 'type', target: '#name', input: 'Jane' },
          { ...passAction(), action: 'click', target: '#submit', input: undefined }
        ]
      }]
    });
    expect(result.reproducible_steps).toEqual(['type #name = Jane', 'click #submit']);
  });

  // Bug Fix 9: Network errors cause warnings, not BLOCKED/FAIL.
  it('returns PASS_WITH_WARNINGS for non-critical network errors when everything else passes', () => {
    const obsWithNetworkError = { ...observation, networkErrors: ['Failed to fetch analytics.js'] };
    const result = buildQaRunResult({
      runId: 'qa-run-unit',
      plan: basePlan,
      targetUrl: 'https://example.test',
      startedAt: '2026-05-24T00:00:00.000Z',
      endedAt: '2026-05-24T00:00:01.000Z',
      durationMs: 1000,
      actions: [passAction()],
      assertions: [passAssertion()],
      observations: [obsWithNetworkError],
      llmReport: null,
      evidence: [],
      evidenceWarnings: [],
      artifacts: { html_report: '', markdown_report: '', json_result: '', screenshots_dir: '' }
    });
    expect(result.status).toBe('PASS_WITH_WARNINGS');
    expect(result.root_cause).toBeUndefined();
  });

  // Bug Fix 10: AI reasoning tab says [object Object]
  it('includes raw_agent_report with raw_data object', () => {
    const result = build();
    expect(result.raw_agent_report).toBeDefined();
    expect(result.raw_agent_report?.trusted).toBe(false);
    expect(result.raw_agent_report?.raw_data).toEqual(expect.objectContaining({ result: 'PASS' }));
  });

  it('gates verifier runtime errors so no WEBSITE_BUG issues or failed assertions remain', () => {
    const result = build({
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'John',
        actual: '',
        rootCause: 'WEBSITE_BUG'
      }]
    });

    applyVerifierRuntimeErrorGate(result, new Error('Injected JS syntax error in field-verifier: Unexpected token "{"'));

    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('VERIFIER_RUNTIME_ERROR');
    expect(result.issues.some((issue) => issue.type === 'WEBSITE_BUG')).toBe(false);
    expect(result.product_issues).toEqual([]);
    expect(result.stats.assertions_failed).toBe(0);
    expect(result.assertions.every((assertion) => assertion.status === 'BLOCKED')).toBe(true);
    expect(result.summary).toContain('final DOM verification failed');
  });
});

describe('Validator LLM Gating', () => {
  it('leaves a VALID_REPORT untouched', () => {
    const result = build();
    const validatorResult: QaValidatorResult = {
      verdict: 'VALID_REPORT',
      confidence: 'HIGH',
      can_show_to_user: true,
      summary: 'Looks good.',
      critical_findings: [],
      suggested_report_patches: [],
      final_recommendation: 'SHOW'
    };
    const gated = applyValidatorGating(result, validatorResult);
    expect(gated.status).toBe('PASS');
    expect(gated.root_cause).toBeUndefined();
  });

  it('blocks a REPORT_NEEDS_FIX and turns WEBSITE_BUG issues into REPORT_INCONSISTENCY', () => {
    const result = build({
      assertions: [{
        ...passAssertion(),
        status: 'FAIL',
        expected: 'Cart contains iPhone',
        actual: 'Cart is empty',
        rootCause: 'WEBSITE_BUG'
      }]
    });
    
    // Original result before gating should be FAIL with WEBSITE_BUG
    expect(result.status).toBe('FAIL');
    expect(result.root_cause).toBe('WEBSITE_BUG');
    
    const validatorResult: QaValidatorResult = {
      verdict: 'REPORT_NEEDS_FIX',
      confidence: 'HIGH',
      can_show_to_user: false,
      summary: 'The agent hallucinates cart state.',
      critical_findings: [],
      suggested_report_patches: [],
      final_recommendation: 'NEED_HUMAN_REVIEW'
    };
    
    const gated = applyValidatorGating(result, validatorResult);
    expect(gated.status).toBe('BLOCKED');
    expect(gated.root_cause).toBe('REPORT_INCONSISTENCY');
    expect(gated.issues[0].type).toBe('REPORT_INCONSISTENCY');
  });

  it('blocks an UNTRUSTWORTHY_REPORT and changes summary', () => {
    const result = build();
    const validatorResult: QaValidatorResult = {
      verdict: 'UNTRUSTWORTHY_REPORT',
      confidence: 'LOW',
      can_show_to_user: false,
      summary: 'Failed to process.',
      critical_findings: [],
      suggested_report_patches: [],
      final_recommendation: 'NEED_HUMAN_REVIEW'
    };
    const gated = applyValidatorGating(result, validatorResult);
    expect(gated.status).toBe('BLOCKED');
    expect(gated.root_cause).toBe('REPORT_INCONSISTENCY');
    expect(gated.summary).toContain('not trustworthy');
  });
});
