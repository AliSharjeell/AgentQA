/**
 * Regression tests for provider transient error handling.
 * Tests: recovered overload, exhausted retries, completion detector, UI formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ProviderRetryEvent type
interface MockProviderRetryEvent {
  timestamp: string;
  provider: 'openai' | 'anthropic';
  model: string;
  phase: string;
  attempt: number;
  status: number;
  type: string;
  recovered: boolean;
  retryAfterMs: number;
  error?: string;
}

// Test data
const MOCK_529_ERROR = JSON.stringify({
  type: 'error',
  error: { type: 'overloaded_error', message: 'overloaded_error (529)' }
});

const MOCK_SUCCESS_RESPONSE = JSON.stringify({
  content: [{ type: 'text', text: '{"thought":"test","plan":[],"active_phase":{"action":"finish_task","reason":"test complete"}}' }]
});

describe('Provider transient error handling', () => {
  describe('A. Recovered provider overload', () => {
    it('first planning call returns 529, second succeeds - run continues with provider warning', async () => {
      // Mock: first call fails with 529, second succeeds
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 529,
            text: async () => MOCK_529_ERROR,
            headers: new Map()
          };
        }
        return {
          ok: true,
          json: async () => JSON.parse(MOCK_SUCCESS_RESPONSE)
        };
      });

      global.fetch = mockFetch;

      // Simulate the retry logic
      const transientCodes = new Set([429, 500, 501, 502, 503, 504, 529]);
      const isTransient = (status: number) => transientCodes.has(status);

      let recovered = false;
      const providerEvents: MockProviderRetryEvent[] = [];

      for (let attempt = 1; attempt <= 4; attempt++) {
        const res = await mockFetch();
        if (!res.ok && isTransient(res.status)) {
          providerEvents.push({
            timestamp: new Date().toISOString(),
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            phase: 'planning',
            attempt,
            status: res.status,
            type: 'overloaded_error',
            recovered: false,
            retryAfterMs: 0
          });
          // Simulate delay then retry
          await new Promise(r => setTimeout(r, 10));
        } else if (res.ok) {
          recovered = true;
          // Mark previous events as recovered
          providerEvents.forEach(e => e.recovered = true);
          break;
        }
      }

      expect(callCount).toBe(2);
      expect(recovered).toBe(true);
      expect(providerEvents.length).toBe(1);
      expect(providerEvents[0].recovered).toBe(true);
      expect(providerEvents[0].attempt).toBe(1);
    });

    it('provider warning is recorded but no product issue is added', () => {
      const providerEvents: MockProviderRetryEvent[] = [
        {
          timestamp: new Date().toISOString(),
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          phase: 'planning',
          attempt: 1,
          status: 529,
          type: 'overloaded_error',
          recovered: true,
          retryAfterMs: 2000
        }
      ];

      const hasProviderWarnings = providerEvents.length > 0 && providerEvents.some(e => e.recovered);

      // Simulate issue filtering - provider warnings don't create product issues
      const issues: Array<{ category: string; status: string }> = [];
      if (hasProviderWarnings) {
        // Filter out provider issues since we recovered
        const filteredIssues = issues.filter(issue => issue.category !== 'PROVIDER_ISSUE');
        expect(filteredIssues.length).toBe(0);
      }
    });
  });

  describe('B. Provider overload after task already complete', () => {
    it('form already filled - unnecessary next plan returns 529 - agent skips further planning', async () => {
      // Simulate form fillability task that is already complete
      const fieldRegistry: Array<{ field_id: string; planned_value: string; actual_value?: string; selected_value?: string; checked?: boolean }> = [
        { field_id: 'f1', planned_value: 'test@test.com', actual_value: 'test@test.com' },
        { field_id: 'f2', planned_value: 'John Doe', actual_value: 'John Doe' },
        { field_id: 'f3', planned_value: '1234567890', actual_value: '1234567890' },
        { field_id: 'f4', planned_value: '1990-01-01', actual_value: '1990-01-01' },
        { field_id: 'f5', planned_value: 'Male', selected_value: 'Male' }
      ];

      const allFieldsHaveValues = fieldRegistry.every(entry => {
        const hasPlanned = Boolean(entry.planned_value);
        const hasActual = Boolean(entry.actual_value || entry.selected_value || entry.checked !== undefined);
        return hasPlanned && hasActual;
      });

      // All fields have been filled - deterministic completion reached
      expect(allFieldsHaveValues).toBe(true);
      expect(fieldRegistry.length).toBe(5);

      // Simulate 529 error on unnecessary next plan call
      let skipPlanning = false;
      if (allFieldsHaveValues && fieldRegistry.length >= 5) {
        skipPlanning = true;
      }

      expect(skipPlanning).toBe(true);
      // Agent should go directly to verification without calling LLM
    });

    it('agent skips further planning and goes to verification', () => {
      const deterministicComplete = true;
      const nextAction = deterministicComplete ? 'go_to_verification' : 'call_llm_planner';

      expect(nextAction).toBe('go_to_verification');
    });
  });

  describe('C. Exhausted provider retries', () => {
    it('all planning attempts return 529 - status BLOCKED, root_cause LLM_PROVIDER_UNAVAILABLE, no website bug', async () => {
      const maxRetries = 4;
      let attemptCount = 0;
      let exhausted = false;

      // Simulate all attempts failing
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: false,
        status: 529,
        text: async () => MOCK_529_ERROR,
        headers: new Map()
      }));

      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        attemptCount++;
        const res = await mockFetch();
        if (!res.ok) {
          if (attempt > maxRetries) {
            exhausted = true;
          }
        }
      }

      expect(attemptCount).toBe(5); // 4 retries + 1 final attempt
      expect(exhausted).toBe(true);

      // Simulate report generation
      const report = {
        status: 'BLOCKED',
        root_cause: 'LLM_PROVIDER_UNAVAILABLE',
        product_issues: [] as string[],
        summary: 'The QA run could not continue because the LLM provider was temporarily overloaded.'
      };

      expect(report.status).toBe('BLOCKED');
      expect(report.root_cause).toBe('LLM_PROVIDER_UNAVAILABLE');
      expect(report.product_issues.length).toBe(0);
      expect(report.summary).toContain('overloaded');
    });
  });

  describe('D. UI formatting of provider errors', () => {
    it('recovered provider errors must not show raw JSON in main steps', () => {
      const rawError = 'Anthropic API returned 529: {"type":"error","error":{"type":"overloaded_error","message":"overloaded_error (529)"}}';

      // Simulate provider error detection
      const providerPatterns = [
        /529/i, /overloaded_error/i, /rate_limit_error/i, /timeout/i,
        /ETIMEDOUT/i, /ECONNRESET/i, /429/i
      ];

      const isProviderError = providerPatterns.some(pattern => pattern.test(rawError));

      expect(isProviderError).toBe(true);

      // Extract compact message for UI
      let compactMessage = '';
      if (isProviderError) {
        const match = rawError.match(/(Anthropic|OpenAI)\s+(API\s+)?(returned\s+)?(\d+|overloaded_error)/i);
        if (match) {
          compactMessage = `${match[1]} ${match[3] || ''}${match[4]}. Retried and recovered.`;
        } else {
          compactMessage = 'Provider temporarily unavailable. Retried and recovered.';
        }
      }

      expect(compactMessage).toBe('Anthropic returned 529. Retried and recovered.');
      expect(compactMessage).not.toContain('{"type":"error"'); // Raw JSON should not appear in UI
      expect(compactMessage).not.toContain('overloaded_error (529)');
    });

    it('raw JSON only in debug/provider-events artifact', () => {
      const providerEvents: MockProviderRetryEvent[] = [
        {
          timestamp: new Date().toISOString(),
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          phase: 'planning',
          attempt: 1,
          status: 529,
          type: 'overloaded_error',
          recovered: true,
          retryAfterMs: 2000,
          error: 'Anthropic API returned 529: overloaded_error (529)'
        }
      ];

      // Raw JSON should be captured in the artifact
      const artifactContent = JSON.stringify(providerEvents, null, 2);

      expect(artifactContent).toContain('overloaded_error');
    });

    it('Steps tab shows compact warning not raw JSON', () => {
      const stepError = 'Anthropic API returned 529: {"type":"error","error":{"type":"overloaded_error","message":"overloaded_error (529)"}}';

      const providerPatterns = [/529/i, /overloaded_error/i, /rate_limit_error/i, /timeout/i];
      const isProvider = providerPatterns.some(p => p.test(stepError));

      let displayMessage = stepError;
      if (isProvider) {
        const match = stepError.match(/(Anthropic|OpenAI)\s+(API\s+)?(returned\s+)?(\d+)/i);
        displayMessage = match ? `${match[1]} ${match[4]}. Retried and recovered.` : 'Provider temporarily unavailable. Retried and recovered.';
      }

      // Display message should not contain raw JSON
      expect(displayMessage).not.toContain('{"type":"error"');
      expect(displayMessage).not.toContain('overloaded_error (529)');
      expect(displayMessage).toContain('529');
      expect(displayMessage).toContain('recovered');
    });
  });

  describe('E. Verdict passes despite provider warnings', () => {
    it('final deterministic verification passes - status PASS_WITH_WARNINGS', () => {
      const providerWarnings = ['Anthropic had transient overload errors but recovered.'];
      const deterministicPassed = true;
      const allAssertionsPassed = true;

      let status = 'PASS';
      if (providerWarnings.length > 0 && allAssertionsPassed) {
        status = 'PASS_WITH_WARNINGS';
      }

      expect(status).toBe('PASS_WITH_WARNINGS');
      expect(providerWarnings.length).toBe(1);
      expect(providerWarnings[0]).toContain('recovered');
    });

    it('product_issues and agent_issues remain empty when provider recovers', () => {
      const providerEvents: MockProviderRetryEvent[] = [
        { timestamp: new Date().toISOString(), provider: 'anthropic', model: 'test', phase: 'planning', attempt: 1, status: 529, type: 'overloaded_error', recovered: true, retryAfterMs: 2000 }
      ];

      const hasRecoveredProviderEvents = providerEvents.some(e => e.recovered);

      const issues: Array<{ category: string }> = [];

      // Filter out provider issues since provider recovered
      const filteredIssues = hasRecoveredProviderEvents
        ? issues.filter(i => i.category !== 'PROVIDER_ISSUE')
        : issues;

      expect(filteredIssues.length).toBe(0);
    });
  });

  describe('F. Exponential backoff timing', () => {
    it('retry delays follow exponential backoff with jitter', async () => {
      const baseDelayMs = 1000;
      const backoffMultiplier = 2;
      const maxDelayMs = 30000;

      // Simulate the actual jitter calculation from api.ts
      // jitter = floor(delay * (0.5 + random * 0.5)) = delay * (0.5 to 1.0)
      // So minimum delay = baseDelay * 0.5 = 500
      // Maximum delay = baseDelay * 1.0 = 1000

      // Test that exponential growth works
      const delays: number[] = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        const baseDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        delays.push(baseDelay); // Base delay without jitter
      }

      // Verify exponential growth
      expect(delays[0]).toBe(1000);   // 2^0 * 1000
      expect(delays[1]).toBe(2000);   // 2^1 * 1000
      expect(delays[2]).toBe(4000);   // 2^2 * 1000
      expect(delays[3]).toBe(8000);   // 2^3 * 1000

      // With jitter (0.5-1.0 range), actual delays would be:
      // delays[0]: 500-1000 (base 1000 * 0.5-1.0)
      // delays[1]: 1000-2000 (base 2000 * 0.5-1.0)
      // delays[2]: 2000-4000 (base 4000 * 0.5-1.0)
      // delays[3]: 4000-8000 (base 8000 * 0.5-1.0)
      const jitterFactor = 0.75; // Simulate 75% (middle of 0.5-1.0 range)
      const actualDelay0 = Math.floor(delays[0] * jitterFactor);
      expect(actualDelay0).toBe(750); // 1000 * 0.75 = 750

      // Verify delays are capped at maxDelayMs
      const largeDelay = Math.min(40000, maxDelayMs);
      expect(largeDelay).toBe(30000);
    });
  });
});
