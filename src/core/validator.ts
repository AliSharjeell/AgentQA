import { callForScript } from './api';
import type { AppSettings, QaRunResult, ValidatorReview } from '../shared/types';
import type { PageObservation } from './harness';
import { splitSafe } from './chunker';

export interface ValidatorInput {
  settings: AppSettings;
  result: QaRunResult;
  observations: PageObservation[];
}

export async function runValidatorAudit(input: ValidatorInput): Promise<ValidatorReview> {
  const { settings, result, observations } = input;
  const compactResult = compactResultForValidator(result);
  const compactObservations = observations.map((o) => ({
    url: o.page.url || o.taskUrl,
    title: o.page.title,
    console: o.consoleErrors,
    network: o.networkErrors,
    compactFinalState: o.compactFinalState
  }));
  const resultJson = splitSafe(JSON.stringify(compactResult, null, 2), 60000).join('\n\n--- chunk ---\n\n');
  const observationsJson = splitSafe(JSON.stringify(compactObservations, null, 2), 30000).join('\n\n--- chunk ---\n\n');

  const prompt = `You are the AgentQA Validator LLM. Your job is to act as a QA report AUDITOR.
You are NOT the source of truth for whether the website works. The deterministic verifier is the source of truth.
Your goal is to audit the generated QA report for consistency, reasoning quality, missing evidence, wrong root-cause classification, and contradictions.

You must NOT invent new facts. You may only use the provided context to verify if the report's claims make logical sense.

==================================================
CONTEXT DATA
==================================================

QA Run Result (JSON):
${resultJson}

Observations (Network/Console Errors):
${observationsJson}

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
  "can_show_to_user": true | false,
  "summary": "A 1-2 sentence summary of the audit.",
  "critical_findings": [
    {
      "type": "FIELD_MAPPING_ERROR" | "VERDICT_CONFLICT" | "WRONG_ROOT_CAUSE" | "EXPECTED_VALUE_MISMATCH" | "EVIDENCE_MISSING" | "ASSERTION_LOGIC_ERROR" | "REPORT_QUALITY_ISSUE",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
      "message": "Description of the logical flaw or missing evidence.",
      "affected_report_paths": ["issues[0].status", "assertions[1].rootCause"],
      "recommended_fix": "Description of how to fix this issue in the report"
    }
  ],
  "suggested_report_patches": [
    {
      "path": "issues[0].type",
      "old_value": "WEBSITE_BUG",
      "new_value": "VERIFICATION_MAPPING_ERROR",
      "reason": "Explain why this change is correct"
    }
  ],
  "final_recommendation": "SHOW" | "REGENERATE_REPORT" | "RERUN_TEST" | "NEED_HUMAN_REVIEW"
}
`;

  try {
    const responseText = await callForScript(settings, prompt);
    let json = responseText;
    const start = responseText.indexOf('{');
    if (start !== -1) {
      let braces = 0;
      let end = start;
      for (let i = start; i < responseText.length; i++) {
        if (responseText[i] === '{') braces++;
        if (responseText[i] === '}') braces--;
        if (braces === 0) {
          end = i;
          break;
        }
      }
      if (end > start) {
        json = responseText.substring(start, end + 1);
      }
    }
    
    const parsed = JSON.parse(json);
    return {
      verdict: parsed.verdict || 'UNTRUSTWORTHY_REPORT',
      confidence: parsed.confidence || 'LOW',
      can_show_to_user: parsed.can_show_to_user ?? false,
      summary: parsed.summary || 'Failed to generate a valid summary.',
      critical_findings: parsed.critical_findings || [],
      suggested_report_patches: parsed.suggested_report_patches || [],
      final_recommendation: parsed.final_recommendation || 'NEED_HUMAN_REVIEW'
    };
  } catch (err: any) {
    return {
      verdict: 'UNTRUSTWORTHY_REPORT',
      confidence: 'LOW',
      can_show_to_user: false,
      summary: `Validator LLM failed to process the audit: ${err.message}`,
      critical_findings: [],
      suggested_report_patches: [],
      final_recommendation: 'NEED_HUMAN_REVIEW'
    };
  }
}

function compactResultForValidator(result: QaRunResult): Partial<QaRunResult> {
  return {
    run_id: result.run_id,
    test_id: result.test_id,
    title: result.title,
    target_url: result.target_url,
    status: result.status,
    root_cause: result.root_cause,
    severity: result.severity,
    summary: result.summary,
    stats: result.stats,
    acceptance_criteria: result.acceptance_criteria,
    objective_milestones: result.objective_milestones,
    probe_finding: result.probe_finding,
    compact_final_state: result.compact_final_state,
    issues: result.issues,
    assertions: result.assertions,
    actions: result.actions.slice(-80),
    evidence_status: result.evidence_status,
    reproducible_steps: result.reproducible_steps,
    recommendation: result.recommendation,
    verification_summary: result.verification_summary,
    provider_warnings: result.provider_warnings
  };
}
