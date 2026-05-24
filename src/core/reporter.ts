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
  TaskStepStatus
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
}

export function buildQaRunResult(input: BuildRunResultInput): QaRunResult {
  const stats = buildStats(input.actions, input.assertions, input.observations);
  const acceptanceCriteria = buildAcceptanceCriteria(input.plan, input.assertions, stats);
  const issues = buildIssues(input.actions, input.assertions, input.evidenceWarnings, input.artifacts);
  const verdict = decideVerdict(input.llmReport, input.assertions, input.actions, input.evidenceWarnings, stats);
  const summary = buildSummary(verdict.status, input.llmReport, stats, input.assertions, input.evidenceWarnings);

  return redactValue({
    run_id: input.runId,
    test_id: input.plan.testId,
    title: input.plan.title,
    target_url: input.targetUrl,
    status: verdict.status,
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
    acceptance_criteria: acceptanceCriteria,
    issues,
    actions: input.actions,
    assertions: input.assertions,
    artifacts: input.artifacts,
    evidence_status: input.evidenceWarnings.length ? 'PARTIAL' : 'COMPLETE',
    reproducible_steps: buildReproSteps(input.actions, input.llmReport),
    recommendation: recommendationFor(verdict.rootCause, verdict.status),
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: input.durationMs,
    raw_agent_report: {
      trusted: false,
      status: input.llmReport?.result,
      reason: 'Raw agent output before verification',
      raw_data: input.llmReport || undefined
    }
  });
}

export function writeQaReportFiles(collector: EvidenceCollector, result: QaRunResult): void {
  collector.writeJson('result.json', result);
  collector.writeText('report.md', renderMarkdownReport(result));
  collector.writeText('report.html', renderHtmlReport(result));
}

export function toDesktopReport(input: {
  taskId: string;
  result: QaRunResult;
  stepEvents: Array<{ instruction: string; status: TaskStepStatus; result?: string; error?: string }>;
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
    '| ID | Expected | Actual | Status | Evidence |',
    '|---|---|---|---|---|',
    ...result.assertions.map((assertion) => {
      const evidence = assertion.evidence?.join(', ') || '';
      return `| ${assertion.id} | ${escapeMarkdown(String(assertion.expected ?? ''))} | ${escapeMarkdown(String(assertion.actual ?? ''))} | ${assertion.status} | ${escapeMarkdown(evidence)} |`;
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

function buildStats(actions: QaRunAction[], assertions: QaAssertionResult[], observations: PageObservation[]): QaRunStats {
  return {
    actions_total: actions.length,
    actions_successful: actions.filter((action) => action.action_result === 'SUCCESS').length,
    actions_failed: actions.filter((action) => action.action_result === 'FAILED' || action.action_result === 'BLOCKED').length,
    assertions_total: assertions.length,
    assertions_passed: assertions.filter((assertion) => assertion.status === 'PASS').length,
    assertions_failed: assertions.filter((assertion) => assertion.status === 'FAIL').length,
    assertions_blocked: assertions.filter((assertion) => assertion.status === 'BLOCKED').length,
    console_errors: observations.reduce((count, observation) => count + (observation.consoleErrors?.length || 0), 0),
    network_errors: observations.reduce((count, observation) => count + (observation.networkErrors?.length || 0), 0)
  };
}

function buildAcceptanceCriteria(plan: QaTestPlan, assertions: QaAssertionResult[], stats: QaRunStats): QaAcceptanceCriterion[] {
  return plan.acceptanceCriteria.map((criterion) => {
    const linked = assertions.filter((assertion) => criterion.assertionIds.includes(assertion.id));
    let status: QaVerdict;
    if (linked.length) {
      status = aggregateStatuses(linked.map((assertion) => assertion.status));
    } else if (criterion.description.toLowerCase().includes('console')) {
      status = stats.console_errors > 0 ? 'WARNING' : 'PASS';
    } else {
      status = 'PASS';
    }
    return {
      id: criterion.id,
      description: criterion.description,
      status,
      assertionIds: criterion.assertionIds
    };
  });
}

function decideVerdict(
  llmReport: CliReport | null | undefined,
  assertions: QaAssertionResult[],
  actions: QaRunAction[],
  evidenceWarnings: EvidenceWarning[],
  stats: QaRunStats
): { status: QaVerdict; rootCause: QaRootCause; severity: QaSeverity } {
  const failedAssertion = assertions.find((assertion) => assertion.required !== false && assertion.status === 'FAIL');
  if (failedAssertion) {
    return {
      status: failedAssertion.rootCause === 'WEBSITE_BUG' ? 'FAIL' : 'BLOCKED',
      rootCause: failedAssertion.rootCause || 'AMBIGUOUS',
      severity: 'HIGH'
    };
  }

  const blockedAssertion = assertions.find((assertion) => assertion.required !== false && assertion.status === 'BLOCKED');
  if (blockedAssertion) return { status: 'BLOCKED', rootCause: blockedAssertion.rootCause || 'AMBIGUOUS', severity: 'HIGH' };

  const blockedAction = actions.find((action) => action.action_result === 'BLOCKED' || action.verification?.status === 'BLOCKED');
  if (blockedAction) return { status: 'BLOCKED', rootCause: blockedAction.verification?.rootCause || 'AGENT_LIMITATION', severity: 'HIGH' };

  if (llmReport?.result === 'INFRA_FAILED') return { status: 'BLOCKED', rootCause: 'ENVIRONMENT_ISSUE', severity: 'HIGH' };

  if (assertions.some((assertion) => assertion.status === 'WARNING') || evidenceWarnings.length || stats.console_errors > 0 || stats.network_errors > 0) {
    return { status: 'WARNING', rootCause: stats.network_errors > 0 ? 'ENVIRONMENT_ISSUE' : 'AMBIGUOUS', severity: 'MEDIUM' };
  }

  return { status: 'PASS', rootCause: 'AMBIGUOUS', severity: 'INFO' };
}

function buildIssues(actions: QaRunAction[], assertions: QaAssertionResult[], evidenceWarnings: EvidenceWarning[], artifacts: QaRunResult['artifacts']): QaIssue[] {
  const issues: QaIssue[] = [];
  for (const assertion of assertions) {
    if (!['FAIL', 'BLOCKED', 'WARNING'].includes(assertion.status)) continue;
    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
      title: assertion.message || assertion.description,
      type: assertion.rootCause || (assertion.status === 'FAIL' ? 'WEBSITE_BUG' : 'AMBIGUOUS'),
      severity: assertion.status === 'WARNING' ? 'MEDIUM' : 'HIGH',
      status: assertion.status,
      expected: String(assertion.expected ?? 'Expected state verified'),
      actual: String(assertion.actual ?? assertion.message ?? 'Not verified'),
      affected_elements: [],
      evidence: {
        screenshots: assertion.evidence ? assertion.evidence.filter(e => e.endsWith('.png')) : [],
        dom_snapshot: artifacts.dom_after,
        action_trace: artifacts.action_trace
      },
      recommendation: recommendationFor(assertion.rootCause || 'AMBIGUOUS', assertion.status)
    });
  }

  for (const action of actions) {
    if (action.action_result !== 'BLOCKED' && action.verification?.status !== 'BLOCKED') continue;
    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, '0')}`,
      title: `${action.action} could not be verified`,
      type: action.verification?.rootCause || 'AGENT_LIMITATION',
      severity: 'HIGH',
      status: 'BLOCKED',
      expected: String(action.verification?.expected ?? 'Action should be supported and verifiable'),
      actual: String(action.verification?.actual ?? action.action_result),
      affected_elements: action.target ? [action.target] : [],
      evidence: {
        screenshots: action.screenshot ? [action.screenshot] : [],
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
  llmReport: CliReport | null | undefined,
  stats: QaRunStats,
  assertions: QaAssertionResult[],
  evidenceWarnings: EvidenceWarning[]
): string {
  if (status === 'PASS') {
    return `Every required assertion was verified. ${stats.assertions_passed}/${stats.assertions_total} assertions passed with evidence.`;
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

function recommendationFor(rootCause: QaRootCause, status: QaVerdict): string {
  if (status === 'PASS') return 'No action required.';
  if (rootCause === 'WEBSITE_BUG') return 'Fix the application behavior that contradicted the expected verified state, then rerun the QA test.';
  if (rootCause === 'AGENT_LIMITATION') return 'Improve automation support or selector strategy, then rerun. Do not treat the blocked run as a website bug.';
  if (rootCause === 'TEST_DATA_ISSUE') return 'Provide valid test data or credentials and rerun the scenario.';
  if (rootCause === 'ENVIRONMENT_ISSUE') return 'Stabilize the browser/network/site environment and rerun the scenario.';
  return 'Collect stronger evidence or clarify the expected result before making a pass/fail claim.';
}

function aggregateStatuses(statuses: QaVerdict[]): QaVerdict {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('WARNING')) return 'WARNING';
  if (statuses.length > 0 && statuses.every((status) => status === 'PASS')) return 'PASS';
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
