import { callForScript } from './api';
import type { AppSettings, QaRunResult, ValidatorReview } from '../shared/types';
import type { PageObservation } from './harness';

export interface ValidatorInput {
  settings: AppSettings;
  result: QaRunResult;
  observations: PageObservation[];
}

export async function runValidatorAudit(input: ValidatorInput): Promise<ValidatorReview> {
  const { settings, result, observations } = input;

  const prompt = `You are the AgentQA Validator LLM. Your job is to act as a QA report AUDITOR.
You are NOT the source of truth for whether the website works. The deterministic verifier is the source of truth.
Your goal is to audit the generated QA report for consistency, reasoning quality, missing evidence, wrong root-cause classification, and contradictions.

You must NOT invent new facts. You may only use the provided context to verify if the report's claims make logical sense.

==================================================
CONTEXT DATA
==================================================

QA Run Result (JSON):
${JSON.stringify(result, null, 2)}

Observations (Network/Console Errors):
${JSON.stringify(observations.map(o => ({ url: o.url, console: o.consoleErrors, network: o.networkErrors })), null, 2)}

==================================================
AUDIT RULES
==================================================
1. Check for wrong field mappings (e.g., if report says First Name actual is "Mr." but "Mr." belongs to Title).
2. Check for incorrect root causes (e.g., if a field was filled correctly but assertion failed due to our logic, it is an AGENT_LIMITATION or AMBIGUOUS, not a WEBSITE_BUG).
3. Check for contradictions between assertions and the final verdict (e.g., if final verdict is BLOCKED but the report claims everything PASSED).
4. Do not override the deterministic verifier's observation of what is currently on the screen.
5. If the verifier failed due to a genuine website bug, confirm it.

==================================================
OUTPUT SCHEMA (Strict JSON)
==================================================
{
  "verdict": "VALID_REPORT" | "REPORT_NEEDS_FIX" | "UNTRUSTWORTHY_REPORT",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "summary": "A 1-2 sentence summary of the audit.",
  "critical_findings": [
    {
      "severity": "CRITICAL" | "WARNING",
      "message": "Description of the logical flaw or missing evidence.",
      "affected_issue_id": "ISSUE-001" (optional)
    }
  ],
  "final_recommendation": "What should the human QA engineer do?"
}
`;

  try {
    const response = await callForScript(settings, prompt);
    const jsonStart = response.indexOf('{');
    const jsonEnd = response.lastIndexOf('}');
    const json = jsonStart !== -1 && jsonEnd !== -1 ? response.slice(jsonStart, jsonEnd + 1) : response;
    
    const parsed = JSON.parse(json);
    return {
      verdict: parsed.verdict || 'UNTRUSTWORTHY_REPORT',
      confidence: parsed.confidence || 'LOW',
      summary: parsed.summary || 'Failed to generate a valid summary.',
      critical_findings: parsed.critical_findings || [],
      final_recommendation: parsed.final_recommendation || 'Manual review required due to invalid validator output.'
    };
  } catch (err: any) {
    return {
      verdict: 'UNTRUSTWORTHY_REPORT',
      confidence: 'LOW',
      summary: `Validator LLM failed to process the audit: ${err.message}`,
      critical_findings: [],
      final_recommendation: 'Skip validator feedback and rely on manual review.'
    };
  }
}
