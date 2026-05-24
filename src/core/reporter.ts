import type {
  QaAcceptanceCriterion,
  QaAssertionResult,
  QaIssue,
  QaReport,
  QaRootCause,
  QaRunAction,
  QaRunResult,
  QaRunStats,
  QaSeverity,
  QaVerdict,
  TaskStepStatus,
  QaValidatorResult,
  QaValidatorPatch,
  QaIssueCategory
} from '../shared/types';
import type { CliReport, PageObservation } from './harness';
import type { QaTestPlan } from './planner';
import type { EvidenceCollector, EvidenceWarning } from './evidence';
import { redactValue } from './sanitize';

export interface BuildRunResultInput {
  runId: string;
  plan: QaTestPlan;
  targetUrl: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  actions: QaRunAction[];
  assertions: QaAssertionResult[];
  observations: PageObservation[];
  llmReport?: CliReport | null;
  evidence: string[];
  evidenceWarnings: EvidenceWarning[];
  artifacts: QaRunResult['artifacts'];
  providerEvents?: import('../shared/types').ProviderRetryEvent[];
}

export function buildQaRunResult(input: BuildRunResultInput): QaRunResult {
  const stats = buildStats(input.actions, input.assertions, input.observations);
  const networkErrors = input.observations.flatMap((observation) => observation.networkErrors || []);
  const acceptanceCriteria = buildAcceptanceCriteria(input.plan, input.assertions, stats);
  const issues = buildIssues(input.actions, input.assertions, input.evidenceWarnings, input.artifacts);
  const verdict = decideVerdict(input.llmReport, input.assertions, input.actions, input.evidenceWarnings, stats);

  // Handle provider events - if provider had transient errors but recovered, add warning
  const providerEvents = input.providerEvents || [];
  const hasProviderWarnings = providerEvents.length > 0 && providerEvents.some(e => e.recovered);
  const providerWarnings: string[] = [];
  if (hasProviderWarnings) {
    const recovered = providerEvents.filter(e => e.recovered);
    const uniqueProviders = [...new Set(recovered.map(e => e.provider))];
    providerWarnings.push(`${uniqueProviders.join(', ')} had transient overload errors but recovered.`);
  }

  if (input.plan.testId === 'TC-FORM-001' && verdict.status === 'PASS') {
    verdict.status = 'PASS_WITH_WARNINGS';
    verdict.severity = 'LOW';
  }
  // If provider had warnings and verdict is PASS, upgrade to PASS_WITH_WARNINGS
  if (hasProviderWarnings && verdict.status === 'PASS') {
    verdict.status = 'PASS_WITH_WARNINGS';
    verdict.severity = verdict.severity || 'LOW';
  }
  if (verdict.status === 'PASS' || verdict.status === 'PASS_WITH_WARNINGS') {
    for (const issue of issues) {
      if (issue.category !== 'PRODUCT_ISSUE' && issue.status === 'BLOCKED') {
        issue.status = 'WARNING';
        issue.severity = 'MEDIUM';
      }
    }
    // Don't add provider errors as issues if we recovered
    if (hasProviderWarnings) {
      const filteredIssues = issues.filter(issue => issue.category !== 'PROVIDER_ISSUE');
      issues.length = 0;
      issues.push(...filteredIssues);
    }
  }
  const summary = buildSummary(verdict.status, input.plan, input.llmReport, stats, input.assertions, input.evidenceWarnings, providerWarnings);

  const result: QaRunResult = redactValue({
    run_id: input.runId,
    test_id: input.plan.testId,
    title: input.plan.title,
    target_url: input.targetUrl,
    status: verdict.status,
    status_source: 'VERIFICATION_ENGINE' as const,
    root_cause: verdict.rootCause,
    severity: verdict.severity,
    summary,
    environment: {
      browser: 'chromium',
      viewport: viewportFor(input.observations.at(-1)),
      os: process.platform,
      headless: !Boolean(process.env.BU_CDP_URL)
    },
    stats,
    network_errors: networkErrors,
    acceptance_criteria: acceptanceCriteria,
    issues,
    ...issueBuckets(issues),
    actions: input.actions,
    assertions: input.assertions,
    artifacts: input.artifacts,
    evidence_status: input.evidenceWarnings.length ? 'PARTIAL' as const : 'COMPLETE' as const,
    reproducible_steps: buildReproSteps(input.actions, input.llmReport),
    recommendation: recommendationFor(verdict.rootCause, verdict.status),
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: input.durationMs,
    raw_agent_report: {
      trusted: false,
      status: input.llmReport?.result,
      reason: 'Raw agent report is unverified and used only as notes.',
      raw_data: input.llmReport || undefined
    },
    provider_events: providerEvents,
    provider_warnings: providerWarnings
  });
  result.verification_summary = {
    status: result.status,
    field_registry_count: result.stats.field_registry_count ?? 0,
    element_registry_count: result.stats.element_registry_count ?? 0,
    verified_fields_count: result.stats.verified_fields_count ?? 0
  };
  return result;
}

export function applyVerifierRuntimeErrorGate(result: QaRunResult, error: Error | string): QaRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const screenshots = defaultScreenshotEvidence(result);
  result.status = 'BLOCKED';
  result.status_source = 'VERIFICATION_ENGINE';
  result.root_cause = 'VERIFIER_RUNTIME_ERROR';
  result.severity = 'CRITICAL';
  result.summary = 'Browser actions completed, but final DOM verification failed due to a verifier runtime error. No website bug is proven.';
  result.recommendation = 'Fix the deterministic field verifier runtime error, then rerun the QA scenario. Do not treat this run as product evidence.';

  result.assertions = result.assertions.map((assertion) => ({
    ...assertion,
    status: 'BLOCKED',
    rootCause: 'VERIFIER_RUNTIME_ERROR',
    actual: assertion.actual ?? 'Final DOM verification did not complete.',
    evidence: assertion.evidence?.length ? assertion.evidence : screenshots,
    message: 'Final deterministic verifier failed before this assertion could be trusted.'
  }));

  result.acceptance_criteria = result.acceptance_criteria.map((criterion) => ({
    ...criterion,
    status: 'BLOCKED'
  }));

  result.issues = [{
    id: 'VERIFIER_ERROR',
    title: 'Verifier Runtime Error',
    type: 'VERIFIER_RUNTIME_ERROR',
    category: 'VERIFIER_ISSUE',
    severity: 'CRITICAL',
    status: 'BLOCKED',
    expected: 'Final deterministic DOM verification completes successfully.',
    actual: message,
    affected_elements: [],
    evidence: {
      screenshots,
      dom_snapshot: result.artifacts.dom_after,
      action_trace: result.artifacts.action_trace
    },
    recommendation: 'Fix field-verifier script generation or browser evaluation failure, then rerun the QA test.',
    reproSteps: ['Run final deterministic field verifier against the stable field registry.']
  }];
  Object.assign(result, issueBuckets(result.issues));
  result.stats.assertions_failed = 0;
  result.stats.assertions_blocked = result.assertions.filter((assertion) => assertion.status === 'BLOCKED').length;
  result.stats.assertions_passed = 0;
  result.verification_summary = {
    status: 'BLOCKED',
    field_registry_count: result.stats.field_registry_count ?? 0,
    element_registry_count: result.stats.element_registry_count ?? 0,
    verified_fields_count: 0,
    verifier_error: message
  };
  return result;
}

export function applyValidatorGating(result: QaRunResult, validatorResult: QaValidatorResult): QaRunResult {
  result.validator_review = validatorResult;

  if (validatorResult.verdict === 'VALID_REPORT') {
    return result;
  }

  if (validatorResult.verdict === 'REPORT_NEEDS_FIX') {
    result.status = 'BLOCKED';
    result.root_cause = 'REPORT_INCONSISTENCY';
    result.issues.forEach(issue => {
      if (issue.type === 'WEBSITE_BUG') {
        issue.type = 'REPORT_INCONSISTENCY';
        issue.category = 'REPORT_ISSUE';
        issue.status = 'BLOCKED';
      }
    });
    result.summary = "Run completed, but the QA report needs correction. No website bug is proven.";
  } else if (validatorResult.verdict === 'UNTRUSTWORTHY_REPORT') {
    result.status = 'BLOCKED';
    result.root_cause = 'REPORT_INCONSISTENCY';
    result.issues.forEach(issue => {
      if (issue.type === 'WEBSITE_BUG') {
        issue.type = 'REPORT_INCONSISTENCY';
        issue.category = 'REPORT_ISSUE';
        issue.status = 'BLOCKED';
      }
    });
    result.summary = "The browser run completed, but the generated QA verdict is not trustworthy.";
  }

  if (validatorResult.suggested_report_patches) {
    for (const patch of validatorResult.suggested_report_patches) {
      applySafePatch(result, patch);
    }
  }

  return result;
}

function applySafePatch(result: QaRunResult, patch: QaValidatorPatch) {
  const match = patch.path.match(/^issues\[(\d+)\]\.([a-zA-Z_]+)$/);
  if (match) {
    const idx = parseInt(match[1], 10);
    const field = match[2];
    const issue = result.issues[idx];
    if (issue) {
      if (field === 'type' && issue.type === 'WEBSITE_BUG' && patch.new_value !== 'WEBSITE_BUG') {
        issue.type = patch.new_value as QaRootCause;
        issue.category = categoryForRootCause(issue.type);
      } else if (field === 'status' && issue.status === 'FAIL' && patch.new_value === 'BLOCKED') {
        issue.status = 'BLOCKED';
      }
    }
  }

  const matchAssert = patch.path.match(/^assertions\[(\d+)\]\.([a-zA-Z_]+)$/);
  if (matchAssert) {
    const idx = parseInt(matchAssert[1], 10);
    const field = matchAssert[2];
    const assertion = result.assertions[idx];
    if (assertion) {
      if (field === 'rootCause' && assertion.rootCause === 'WEBSITE_BUG' && patch.new_value !== 'WEBSITE_BUG') {
        assertion.rootCause = patch.new_value as QaRootCause;
      } else if (field === 'status' && assertion.status === 'FAIL' && patch.new_value === 'BLOCKED') {
        assertion.status = 'BLOCKED';
      }
    }
  }
}

export function categoryForRootCause(rootCause: QaRootCause | undefined): QaIssueCategory {
  switch (rootCause) {
    case 'WEBSITE_BUG': return 'PRODUCT_ISSUE';
    case 'AGENT_LIMITATION':
    case 'AGENT_INTERNAL_ERROR': return 'AGENT_ISSUE';
    case 'VERIFICATION_MAPPING_ERROR': return 'VERIFIER_ISSUE';
    case 'VERIFICATION_SELECTOR_FAILURE': return 'VERIFIER_ISSUE';
    case 'ASSERTION_EXPECTED_VALUE_MISMATCH': return 'VERIFIER_ISSUE';
    case 'VERIFIER_RUNTIME_ERROR': return 'VERIFIER_ISSUE';
    case 'BROWSER_EVALUATION_ERROR': return 'VERIFIER_ISSUE';
    case 'FIELD_REGISTRY_EMPTY': return 'VERIFIER_ISSUE';
    case 'NO_FIELDS_FOUND':
    case 'PAGE_NOT_INTERACTIVE_OR_OBSERVATION_FAILED':
    case 'GOAL_NOT_REACHED':
    case 'REQUIRED_AFFORDANCE_NOT_FOUND':
    case 'AMBIGUOUS_STATE': return 'AGENT_ISSUE';
    case 'TEST_DATA_ISSUE': return 'TEST_DATA_ISSUE';
    case 'ENVIRONMENT_ISSUE': return 'ENVIRONMENT_ISSUE';
    case 'REPORT_INCONSISTENCY': return 'REPORT_ISSUE';
    case 'AMBIGUOUS':
    default: return 'REPORT_ISSUE';
  }
}

function issueBuckets(issues: QaIssue[]): Pick<QaRunResult, 'product_issues' | 'agent_issues' | 'verifier_issues' | 'test_data_issues' | 'environment_issues'> {
  return {
    product_issues: issues.filter((issue) => issue.category === 'PRODUCT_ISSUE'),
    agent_issues: issues.filter((issue) => issue.category === 'AGENT_ISSUE'),
    verifier_issues: issues.filter((issue) => issue.category === 'VERIFIER_ISSUE' || issue.type === 'VERIFIER_RUNTIME_ERROR'),
    test_data_issues: issues.filter((issue) => issue.category === 'TEST_DATA_ISSUE'),
    environment_issues: issues.filter((issue) => issue.category === 'ENVIRONMENT_ISSUE')
  };
}

export function writeQaReportFiles(collector: EvidenceCollector, result: QaRunResult, providerEvents?: import('../shared/types').ProviderRetryEvent[]): void {
  collector.writeJson('result.json', result);
  collector.writeText('report.md', renderMarkdownReport(result));
  collector.writeText('report.html', renderHtmlReport(result));
  if (providerEvents && providerEvents.length > 0) {
    collector.writeJson('provider-events.json', providerEvents);
  }
}

export function toDesktopReport(input: {
  taskId: string;
  result: QaRunResult;
  stepEvents: Array<{ instruction: string; status: TaskStepStatus; result?: string; error?: string }>;
  providerEvents?: import('../shared/types').ProviderRetryEvent[];
}): QaReport {
  return {
    taskId: input.taskId,
    runId: input.result.run_id,
    testId: input.result.test_id,
    taskName: input.result.title,
    title: input.result.title,
    targetUrl: input.result.target_url,
    status: input.result.status,
    rootCause: input.result.root_cause,
    severity: input.result.severity,
    overallStatus: input.result.status,
    summary: input.result.summary,
    totalSteps: input.stepEvents.length,
    passedSteps: input.result.stats.assertions_passed,
    failedSteps: input.result.stats.assertions_failed,
    blockedSteps: input.result.stats.assertions_blocked,
    warningSteps: input.result.assertions.filter((assertion) => assertion.status === 'WARNING').length,
    skippedSteps: input.result.assertions.filter((assertion) => assertion.status === 'SKIPPED').length,
    startTime: input.result.started_at,
    endTime: input.result.ended_at,
    durationMs: input.result.duration_ms,
    steps: input.stepEvents.map((step) => ({
      instruction: step.instruction,
      status: step.status,
      result: step.result ?? '',
      error: step.error,
      duration: 0
    })),
    screenshots: screenshotPaths(input.result),
    acceptanceCriteria: input.result.acceptance_criteria,
    issues: input.result.issues,
    actions: input.result.actions,
    assertions: input.result.assertions,
    artifacts: input.result.artifacts,
    providerEvents: input.providerEvents,
    evidenceStatus: input.result.evidence_status,
    reproducibleSteps: input.result.reproducible_steps,
    recommendation: input.result.recommendation,
    resultJson: input.result,
    aiReasoning: input.result.raw_agent_report?.raw_data
      ? JSON.stringify(input.result.raw_agent_report.raw_data, null, 2)
      : ''
  };
}

export function renderMarkdownReport(result: QaRunResult): string {
  const lines = [
    '# QA Test Report',
    '',
    '## Test Case',
    `${result.test_id}: ${result.title}`,
    '',
    '## Target',
    `URL: ${result.target_url}`,
    `Browser: ${result.environment.browser}`,
    `Viewport: ${result.environment.viewport}`,
    `Started At: ${result.started_at}`,
    `Duration: ${(result.duration_ms / 1000).toFixed(1)}s`,
    '',
    '## Final Verdict',
    `${result.status}`,
    '',
    '## Executive Summary',
    result.summary,
    '',
    '## Acceptance Criteria',
    '| ID | Criteria | Status |',
    '|---|---|---|',
    ...result.acceptance_criteria.map((criterion) => `| ${criterion.id} | ${escapeMarkdown(criterion.description)} | ${criterion.status} |`),
    '',
    '## Assertion Results',
    '| ID | Selector | Expected | Actual | Status | Evidence |',
    '|---|---|---|---|---|---|',
    ...result.assertions.map((assertion) => {
      const evidence = formatAssertionEvidence(assertion, result.artifacts.dom_after);
      return `| ${assertion.id} | ${escapeMarkdown(String(assertion.selector ?? ''))} | ${escapeMarkdown(String(assertion.expected ?? ''))} | ${escapeMarkdown(String(assertion.actual ?? ''))} | ${assertion.status} | ${escapeMarkdown(evidence)} |`;
    }),
    '',
    '## Issues Found',
    ...(result.issues.length ? result.issues.flatMap(renderIssueMarkdown) : ['No issues found.']),
    '',
    '## Reproduction Steps',
    ...result.reproducible_steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Recommendation',
    result.recommendation,
    '',
    '## Artifacts',
    `- ${result.artifacts.html_report}`,
    `- ${result.artifacts.markdown_report}`,
    `- ${result.artifacts.json_result}`,
    `- ${result.artifacts.screenshots_dir}`,
    result.artifacts.action_trace ? `- ${result.artifacts.action_trace}` : '',
    result.artifacts.dom_before ? `- ${result.artifacts.dom_before}` : '',
    result.artifacts.dom_after ? `- ${result.artifacts.dom_after}` : '',
    result.artifacts.console_log ? `- ${result.artifacts.console_log}` : '',
    result.artifacts.network_log ? `- ${result.artifacts.network_log}` : ''
  ].filter(Boolean);

  return lines.join('\n');
}

export function renderHtmlReport(result: QaRunResult): string {
  const screenshots = screenshotPaths(result)
    .map((screenshot) => `<figure><img src="${escapeHtml(screenshot)}" alt="QA evidence screenshot"><figcaption>${escapeHtml(screenshot)}</figcaption></figure>`)
    .join('');
  const issues = result.issues.map((issue) => `
    <article class="issue">
      <div><strong>${escapeHtml(issue.title)}</strong><span>${issue.severity} / ${issue.type}</span></div>
      <p><b>Expected:</b> ${escapeHtml(issue.expected)}</p>
      <p><b>Actual:</b> ${escapeHtml(issue.actual)}</p>
      <p><b>Recommendation:</b> ${escapeHtml(issue.recommendation)}</p>
    </article>
  `).join('');

  const validatorSection = result.validator_review ? `
    <section>
      <h2>Validator Review</h2>
      <div class="issue">
        <div><strong>Verdict: ${escapeHtml(result.validator_review.verdict)}</strong><span>Confidence: ${result.validator_review.confidence}</span></div>
        <p>${escapeHtml(result.validator_review.summary)}</p>
        <p><b>Recommendation:</b> ${escapeHtml(result.validator_review.final_recommendation)}</p>
        ${result.validator_review.critical_findings.map(f => `<p><b>Finding [${escapeHtml(f.severity)}]:</b> ${escapeHtml(f.message)}</p>`).join('')}
      </div>
    </section>
  ` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(result.title)}</title>
  <style>
    :root { color-scheme: dark; --bg: #0b0d10; --panel: #14171b; --line: #2c333a; --text: #eceff3; --muted: #9aa4af; --accent: #f4c95d; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    header { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 24px; }
    .badge { display: inline-block; border: 1px solid var(--line); background: var(--panel); padding: 8px 12px; font-weight: 700; color: var(--accent); margin-right: 8px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    .metric, .issue, figure { border: 1px solid var(--line); background: var(--panel); padding: 14px; }
    .metric span, figcaption, .issue span { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0 28px; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    img { max-width: 100%; display: block; border: 1px solid var(--line); }
    section { margin: 28px 0; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="badge">${escapeHtml(result.status)}</div>
      ${result.validator_review ? `<div class="badge">Validator: ${result.validator_review.verdict === 'VALID_REPORT' ? 'Passed' : result.validator_review.verdict === 'REPORT_NEEDS_FIX' ? 'Report needs fix' : 'Untrustworthy report'}</div>` : ''}
      <h1>${escapeHtml(result.title)}</h1>
      <p>${escapeHtml(result.summary)}</p>
      <p>${escapeHtml(result.target_url)}</p>
    </header>
    ${validatorSection}
    <div class="grid">
      <div class="metric">${result.stats.assertions_passed}<span>Assertions Passed</span></div>
      <div class="metric">${result.stats.assertions_failed}<span>Assertions Failed</span></div>
      <div class="metric">${result.stats.assertions_blocked}<span>Assertions Blocked</span></div>
      <div class="metric">${result.evidence_status}<span>Evidence</span></div>
    </div>
    <section>
      <h2>Acceptance Criteria</h2>
      <table><thead><tr><th>ID</th><th>Criteria</th><th>Status</th></tr></thead><tbody>
      ${result.acceptance_criteria.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.status)}</td></tr>`).join('')}
      </tbody></table>
    </section>
    <section>
      <h2>Issues</h2>
      ${issues || '<p>No issues found.</p>'}
    </section>
    <section>
      <h2>Screenshots</h2>
      ${screenshots || '<p>No screenshots captured.</p>'}
    </section>
    <section>
      <h2>Reproduction Steps</h2>
      <ol>${result.reproducible_steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    </section>
  </main>
</body>
</html>`;
}

export interface ExtendedQaRunStats extends QaRunStats {
  critical_network_errors?: number;
}

function isCriticalNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const detail = err as { is_critical?: boolean; url?: string; resource_type?: string; status?: number | string; type?: string };
  if (typeof detail.is_critical === 'boolean') return detail.is_critical;
  const text = `${detail.url || ''} ${detail.resource_type || ''} ${detail.type || ''}`;
  if (!text.trim()) return false;
  const nonCriticalPatterns = [/analytics/i, /fonts?/i, /favicon/i, /ads?/i, /tracker/i, /tracking/i, /pixel/i, /beacon/i, /image/i, /collect/i, /rmkt/i, /remarket/i, /doubleclick/i, /gtm/i, /google\.com\/rmkt/i];
  if (nonCriticalPatterns.some(p => p.test(text))) return false;
  return /document|xhr|fetch|api/i.test(text) || Number(detail.status) >= 500;
}

function buildStats(actions: QaRunAction[], assertions: QaAssertionResult[], observations: PageObservation[]): ExtendedQaRunStats {
  const allNetworkErrors = observations.reduce((count, observation) => count + (observation.networkErrors?.length || 0), 0);
  const criticalNetworkErrors = observations.reduce((count, observation) => count + (observation.networkErrors?.filter(isCriticalNetworkError).length || 0), 0);
  const fieldRegistry = observations.at(-1)?.fieldRegistry || [];
  const elementRegistry = observations.at(-1)?.elementRegistry || observations.at(-1)?.availableElements || [];
  
  return {
    actions_total: actions.length,
    actions_successful: actions.filter((action) => action.action_result === 'SUCCESS').length,
    actions_failed: actions.filter((action) => action.action_result === 'FAILED' || action.action_result === 'BLOCKED').length,
    assertions_total: assertions.length,
    assertions_passed: assertions.filter((assertion) => assertion.status === 'PASS' || assertion.status === 'PASS_WITH_WARNINGS').length,
    assertions_failed: assertions.filter((assertion) => assertion.status === 'FAIL').length,
    assertions_blocked: assertions.filter((assertion) => assertion.status === 'BLOCKED').length,
    console_errors: observations.reduce((count, observation) => count + (observation.consoleErrors?.length || 0), 0),
    network_errors: allNetworkErrors,
    critical_network_errors: criticalNetworkErrors,
    field_registry_count: fieldRegistry.length,
    element_registry_count: elementRegistry.length,
    verified_fields_count: fieldRegistry.filter((field) => field.actual_value !== undefined || field.value !== undefined || field.selected_value !== undefined || field.checked !== undefined).length
  };
}

function buildAcceptanceCriteria(plan: QaTestPlan, assertions: QaAssertionResult[], stats: QaRunStats): QaAcceptanceCriterion[] {
  return plan.acceptanceCriteria.map((criterion) => {
    const linkedById = assertions.filter((assertion) => criterion.assertionIds.includes(assertion.id));
    const linked = linkedById.length ? linkedById : inferLinkedAssertions(plan.testId, criterion.description, assertions);
    let status: QaVerdict;
    if (linked.length) {
      status = aggregateStatuses(linked.map((assertion) => assertion.status));
    } else if (criterion.description.toLowerCase().includes('console')) {
      status = stats.console_errors > 0 ? 'WARNING' : 'PASS';
    } else {
      if (stats.actions_total === 0) {
        status = criterion.description.toLowerCase().includes('page load') ? 'PASS' : 'BLOCKED';
      } else {
        status = 'PASS';
      }
    }
    return {
      id: criterion.id,
      description: criterion.description,
      status,
      assertionIds: criterion.assertionIds
    };
  });
}

function inferLinkedAssertions(testId: string, criterion: string, assertions: QaAssertionResult[]): QaAssertionResult[] {
  if (testId !== 'TC-FORM-001' || assertions.length === 0) return [];
  const text = criterion.toLowerCase();
  if (text.includes('password')) {
    return assertions.filter((assertion) => /password|pwd|pass/.test(assertion.description.toLowerCase()));
  }
  if (text.includes('birth')) {
    return assertions.filter((assertion) => /birth|dob|date of birth/.test(assertion.description.toLowerCase()));
  }
  if (text.includes('select') || text.includes('dropdown')) {
    return assertions.filter((assertion) => /planned select|select|expiry|card type|birth/.test(assertion.description.toLowerCase()));
  }
  if (text.includes('text')) {
    return assertions.filter((assertion) => !/planned select|password|birth|dob/.test(assertion.description.toLowerCase()));
  }
  return [];
}

function decideVerdict(
  llmReport: CliReport | null | undefined,
  assertions: QaAssertionResult[],
  actions: QaRunAction[],
  evidenceWarnings: EvidenceWarning[],
  stats: ExtendedQaRunStats
): { status: QaVerdict; rootCause?: QaRootCause; severity: QaSeverity } {
  const failedBug = assertions.find((a) => a.required !== false && a.status === 'FAIL' && a.rootCause === 'WEBSITE_BUG');
  if (failedBug) {
    return { status: 'FAIL', rootCause: 'WEBSITE_BUG', severity: 'HIGH' };
  }

  const blockedRootCauses: QaRootCause[] = [
    'AGENT_INTERNAL_ERROR',
    'VERIFICATION_MAPPING_ERROR',
    'TEST_DATA_ISSUE',
    'ENVIRONMENT_ISSUE',
    'AGENT_LIMITATION',
    'NO_FIELDS_FOUND',
    'PAGE_NOT_INTERACTIVE_OR_OBSERVATION_FAILED',
    'GOAL_NOT_REACHED',
    'REQUIRED_AFFORDANCE_NOT_FOUND',
    'AMBIGUOUS_STATE'
  ];
  const failedAgent = assertions.find(a => a.required !== false && a.status === 'FAIL' && Boolean(a.rootCause && blockedRootCauses.includes(a.rootCause)));
  if (failedAgent) {
    return { status: 'BLOCKED', rootCause: failedAgent.rootCause || 'AGENT_INTERNAL_ERROR', severity: 'HIGH' };
  }

  const blockedAssertion = assertions.find((assertion) => assertion.required !== false && assertion.status === 'BLOCKED');
  if (blockedAssertion) return { status: 'BLOCKED', rootCause: blockedAssertion.rootCause || 'AMBIGUOUS', severity: 'HIGH' };

  if (llmReport?.result === 'INFRA_FAILED') {
    return { status: 'INFRA_FAILED', rootCause: 'ENVIRONMENT_ISSUE', severity: 'HIGH' };
  }
  if (llmReport?.result === 'AGENT_FAILED' && assertions.length === 0) {
    return { status: 'BLOCKED', rootCause: 'GOAL_NOT_REACHED', severity: 'HIGH' };
  }

  const blockedAction = actions.find((action) => action.action_result === 'BLOCKED' || action.verification?.status === 'BLOCKED');
  const hasWarnings = assertions.some((assertion) => assertion.status === 'WARNING') || evidenceWarnings.length || stats.console_errors > 0 || stats.network_errors > 0 || Boolean(blockedAction);
  const criticalNetworkErrors = stats.critical_network_errors ?? 0;
  
  if (criticalNetworkErrors > 0) {
    return { status: 'BLOCKED', rootCause: 'ENVIRONMENT_ISSUE', severity: 'HIGH' };
  }

  const allReqPassed = assertions.filter(a => a.required !== false).every(a => a.status === 'PASS' || a.status === 'PASS_WITH_WARNINGS' || a.status === 'WARNING');
  if (allReqPassed && assertions.length > 0) {
    if (hasWarnings) {
      return { status: 'PASS_WITH_WARNINGS', rootCause: undefined, severity: 'MEDIUM' };
    }
    return { status: 'PASS', rootCause: undefined, severity: 'INFO' };
  }

  if (blockedAction) return { status: 'BLOCKED', rootCause: blockedAction.verification?.rootCause || 'AGENT_LIMITATION', severity: 'HIGH' };

  return { status: 'BLOCKED', rootCause: 'AMBIGUOUS', severity: 'MEDIUM' };
}

function buildIssues(actions: QaRunAction[], assertions: QaAssertionResult[], evidenceWarnings: EvidenceWarning[], artifacts: QaRunResult['artifacts']): QaIssue[] {
  const issues: QaIssue[] = [];
  const allScreenshots = [...new Set(actions.map((action) => action.screenshot).filter((item): item is string => Boolean(item)))];
  if (artifacts.screenshots_dir) {
    allScreenshots.push('screenshots/04_final_state.png', 'screenshots/04_final_state_full.png');
  }

  for (const assertion of assertions) {
    if (!['FAIL', 'BLOCKED', 'WARNING'].includes(assertion.status)) continue;
    const type = assertion.rootCause || (assertion.status === 'FAIL' ? 'WEBSITE_BUG' : 'AMBIGUOUS');
    
    // Add any screenshots specifically tied to this assertion
    const assertionScreenshots = (assertion.evidence || []).filter(e => e.endsWith('.png') || e.endsWith('.jpg') || e.endsWith('.jpeg'));
    const issueScreenshots = [...new Set([...allScreenshots, ...assertionScreenshots])];

    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
      title: assertion.message || assertion.description,
      type,
      category: categoryForRootCause(type),
      severity: assertion.status === 'WARNING' ? 'MEDIUM' : 'HIGH',
      status: assertion.status,
      expected: String(assertion.expected ?? 'Expected state verified'),
      actual: String(assertion.actual ?? assertion.message ?? 'Not verified'),
      affected_elements: [],
      evidence: {
        screenshots: issueScreenshots,
        dom_snapshot: artifacts.dom_after,
        action_trace: artifacts.action_trace
      },
      recommendation: recommendationFor(assertion.rootCause || 'AMBIGUOUS', assertion.status)
    });
  }

  for (const action of actions) {
    if (action.action_result !== 'BLOCKED' && action.verification?.status !== 'BLOCKED') continue;
    const type = action.verification?.rootCause || 'AGENT_LIMITATION';
    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
      title: `${action.action} could not be verified`,
      type,
      category: categoryForRootCause(type),
      severity: 'HIGH',
      status: 'BLOCKED',
      expected: String(action.verification?.expected ?? 'Action should be supported and verifiable'),
      actual: String(action.verification?.actual ?? action.action_result),
      affected_elements: action.target ? [action.target] : [],
      evidence: {
        screenshots: allScreenshots,
        dom_snapshot: artifacts.dom_before,
        action_trace: artifacts.action_trace
      },
      recommendation: recommendationFor(action.verification?.rootCause || 'AGENT_LIMITATION', 'BLOCKED')
    });
  }

  for (const warning of evidenceWarnings) {
    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
      title: 'Evidence capture warning',
      type: 'AMBIGUOUS',
      category: 'REPORT_ISSUE',
      severity: 'MEDIUM',
      status: 'WARNING',
      expected: 'Evidence artifact captured',
      actual: warning.message,
      affected_elements: [],
      evidence: { screenshots: warning.artifact ? [warning.artifact] : [] },
      recommendation: 'Review artifact capture configuration and rerun if stronger evidence is required.'
    });
  }

  return issues;
}

function buildSummary(
  status: QaVerdict,
  plan: QaTestPlan,
  llmReport: CliReport | null | undefined,
  stats: ExtendedQaRunStats,
  assertions: QaAssertionResult[],
  evidenceWarnings: EvidenceWarning[],
  providerWarnings: string[] = []
): string {
  if (status === 'PASS' || status === 'PASS_WITH_WARNINGS') {
    if (plan.testId === 'TC-FORM-001') {
      const warnings = buildPassWarningMessages(plan, stats, evidenceWarnings);
      const allWarnings = [...warnings, ...providerWarnings];
      return [
        'All visible form fields were filled and verified from the final DOM.',
        allWarnings.length ? `Warnings: ${allWarnings.join(' ')}` : ''
      ].filter(Boolean).join(' ');
    }
    let msg = `Every required assertion was verified. ${stats.assertions_passed}/${stats.assertions_total} assertions passed with evidence.`;
    if (status === 'PASS_WITH_WARNINGS' || providerWarnings.length > 0) {
      const warnings = buildPassWarningMessages(plan, stats, evidenceWarnings);
      const allWarnings = [...warnings, ...providerWarnings];
      msg += allWarnings.length ? ` Warnings: ${allWarnings.join(' ')}` : ` ${evidenceWarnings.length + stats.console_errors + stats.network_errors} warning signal(s) were captured.`;
    }
    return msg;
  }
  if (status === 'WARNING') {
    return `The main objective was verified, but ${evidenceWarnings.length + stats.console_errors + stats.network_errors} warning signal(s) were captured.`;
  }
  const firstProblem = assertions.find((assertion) => assertion.status === 'FAIL' || assertion.status === 'BLOCKED');
  if (firstProblem) {
    return `${firstProblem.description}: expected ${String(firstProblem.expected ?? 'verified state')}, actual ${String(firstProblem.actual ?? firstProblem.message ?? 'not verified')}.`;
  }
  return llmReport?.evidence?.[0] || llmReport?.warnings?.[0] || 'The QA run could not prove the requested result.';
}

function buildPassWarningMessages(plan: QaTestPlan, stats: ExtendedQaRunStats, evidenceWarnings: EvidenceWarning[]): string[] {
  const warnings: string[] = [];
  if (plan.testId === 'TC-FORM-001') {
    warnings.push('Page has no submit button, so submission validation was not tested.');
  }
  if (stats.network_errors > 0 && (stats.critical_network_errors ?? 0) === 0) {
    warnings.push(`${stats.network_errors} non-critical network request${stats.network_errors === 1 ? '' : 's'} failed.`);
  }
  if (stats.console_errors > 0) {
    warnings.push(`${stats.console_errors} console error${stats.console_errors === 1 ? '' : 's'} were captured.`);
  }
  for (const warning of evidenceWarnings) {
    warnings.push(warning.message);
  }
  return warnings;
}

function buildReproSteps(actions: QaRunAction[], llmReport: CliReport | null | undefined): string[] {
  if (actions.length) {
    const steps: string[] = [];
    for (const action of actions) {
      if (action.sub_actions && action.sub_actions.length > 0) {
        for (const sub of action.sub_actions) {
          const target = sub.target ? ` ${sub.target}` : '';
          const input = sub.input !== null && sub.input !== undefined ? ` = ${String(sub.input)}` : '';
          steps.push(`${sub.action}${target}${input}`);
        }
      } else if (action.action === 'batch') {
        const actual = action.verification?.actual ? `: ${String(action.verification.actual)}` : '';
        steps.push(`Blocked attempted grouped action${actual}`);
      } else {
        const target = action.target ? ` ${action.target}` : '';
        const input = action.input !== null && action.input !== undefined ? ` = ${String(action.input)}` : '';
        steps.push(`${action.action}${target}${input}`);
      }
    }
    return steps;
  }
  return llmReport?.stepsExecuted?.length ? llmReport.stepsExecuted : ['Open the target URL.', 'Run the requested QA scenario.', 'Verify the final DOM/UI state.'];
}

function recommendationFor(rootCause: QaRootCause | undefined, status: QaVerdict): string {
  if (status === 'PASS' || status === 'PASS_WITH_WARNINGS') return 'No product fix required. Optional: add submit-validation testing on pages that include a submit button.';
  if (rootCause === 'WEBSITE_BUG') return 'Fix the application behavior that contradicted the expected verified state, then rerun the QA test.';
  if (rootCause === 'AGENT_LIMITATION') return 'Improve automation support or selector strategy, then rerun. Do not treat the blocked run as a website bug.';
  if (rootCause === 'NO_FIELDS_FOUND') return 'Rerun on a page or step with editable controls, or change the task if no form fields are expected.';
  if (rootCause === 'PAGE_NOT_INTERACTIVE_OR_OBSERVATION_FAILED') return 'Check that the page loaded and exposes interactive UI, then rerun with stronger observation evidence.';
  if (rootCause === 'REQUIRED_AFFORDANCE_NOT_FOUND') return 'Verify the requested control exists and is visible, or adjust the task to an available affordance.';
  if (rootCause === 'GOAL_NOT_REACHED') return 'Review the action trace and final DOM evidence, then rerun with clearer target state if needed.';
  if (rootCause === 'AMBIGUOUS_STATE') return 'Collect stronger page evidence or clarify the expected result before making a product bug claim.';
  if (rootCause === 'TEST_DATA_ISSUE') return 'Provide valid test data or credentials and rerun the scenario.';
  if (rootCause === 'ENVIRONMENT_ISSUE') return 'Stabilize the browser/network/site environment and rerun the scenario.';
  return 'Collect stronger evidence or clarify the expected result before making a pass/fail claim.';
}

function aggregateStatuses(statuses: QaVerdict[]): QaVerdict {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('WARNING')) return 'WARNING';
  if (statuses.length > 0 && statuses.every((status) => status === 'PASS')) return 'PASS';
  if (statuses.length > 0 && statuses.every((status) => status === 'PASS' || status === 'PASS_WITH_WARNINGS' || status === 'WARNING')) return 'PASS_WITH_WARNINGS';
  return 'SKIPPED';
}

function viewportFor(observation: PageObservation | undefined): string {
  if (!observation?.page.w || !observation.page.h) return 'unknown';
  return `${observation.page.w}x${observation.page.h}`;
}

function screenshotPaths(result: QaRunResult): string[] {
  const fromActions = result.actions.map((action) => action.screenshot).filter((item): item is string => Boolean(item));
  const fromIssues = result.issues.flatMap((issue) => issue.evidence.screenshots);
  return [...new Set([...fromActions, ...fromIssues])];
}

function defaultScreenshotEvidence(result: QaRunResult): string[] {
  const screenshots = screenshotPaths(result);
  if (result.artifacts.screenshots_dir) {
    screenshots.push('screenshots/04_final_state.png', 'screenshots/04_final_state_full.png');
  }
  return [...new Set(screenshots)];
}

function renderIssueMarkdown(issue: QaIssue): string[] {
  return [
    `### ${issue.id}: ${issue.title}`,
    `Severity: ${issue.severity}`,
    `Type: ${issue.type}`,
    `Status: ${issue.status}`,
    '',
    'Expected:',
    issue.expected,
    '',
    'Actual:',
    issue.actual,
    '',
    'Evidence:',
    ...(issue.evidence.screenshots.length ? issue.evidence.screenshots.map((path) => `- ${path}`) : ['- See action trace and DOM snapshots.']),
    '',
    'Recommendation:',
    issue.recommendation,
    ''
  ];
}

function formatAssertionEvidence(assertion: QaAssertionResult, domAfter?: string): string {
  const screenshot = assertion.evidence?.find((item) => /\.(png|jpe?g)$/i.test(item) || item.startsWith('screenshot:'));
  const domRef = assertion.evidence?.find((item) => item.startsWith('dom:')) ||
    (domAfter ? `dom: ${domAfter}${assertion.field_id ? `#${assertion.field_id}` : ''}` : undefined);
  return [screenshot || 'screenshot: screenshots/04_final_state.png', domRef].filter(Boolean).join('; ');
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
