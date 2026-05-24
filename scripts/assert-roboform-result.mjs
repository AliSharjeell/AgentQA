import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/assert-roboform-result.mjs <result.json>");
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(file, "utf8"));
const failures = [];
const fail = (message) => failures.push(message);
const textOf = (obj) => JSON.stringify(obj);
const issues = result.issues || [];
const assertions = result.assertions || [];
const actions = flattenActions(result.actions || []);

function flattenActions(items) {
  return items.flatMap((item) => item.sub_actions?.length ? flattenActions(item.sub_actions) : [item]);
}

if (!["PASS", "PASS_WITH_WARNINGS"].includes(result.status)) {
  fail(`Expected PASS/PASS_WITH_WARNINGS, got ${result.status}`);
}

const badRootCauses = [
  "WEBSITE_BUG",
  "VERIFIER_RUNTIME_ERROR",
  "BROWSER_EVALUATION_ERROR",
  "INFRA_FAILED",
  "REPORT_INCONSISTENCY",
  "VERIFICATION_MAPPING_ERROR",
  "AGENT_LIMITATION"
];
if (badRootCauses.includes(result.root_cause)) {
  fail(`Unexpected root_cause: ${result.root_cause}`);
}

if (textOf(result).includes("${JSON.stringify(registry)}") || textOf(result).includes("${")) {
  fail("Injected JS still contains an uninterpolated template placeholder.");
}

for (const issue of issues) {
  if (issue.type === "VERIFIER_RUNTIME_ERROR") fail("Verifier runtime error exists in issues.");
  if (issue.type === "WEBSITE_BUG" || issue.category === "PRODUCT_ISSUE") {
    fail(`Unexpected product bug issue: ${issue.id || issue.title}`);
  }
  if (issue.evidence && Array.isArray(issue.evidence.screenshots) && issue.evidence.screenshots.length === 0) {
    fail(`Issue ${issue.id || issue.title} has an empty screenshot evidence array.`);
  }
}

if ((result.stats?.actions_total || 0) < 2) fail("Expected at least 2 actions/batches to run.");
if ((result.stats?.actions_successful || 0) < 2) fail("Expected at least 2 successful actions/batches.");
if (!actions.some((action) => ["fill", "type"].includes(action.action))) fail("Expected at least one fill/type sub-action.");
if (!actions.some((action) => action.action === "select")) fail("Expected at least one select/dropdown sub-action.");

const registryCount =
  result.stats?.field_registry_count ??
  result.field_registry_count ??
  result.fieldRegistry?.length ??
  0;
if (registryCount < 35) fail(`Expected at least 35 fields in field registry, got ${registryCount}`);

const verifiedCount =
  result.stats?.verified_fields_count ??
  result.verification_summary?.verified_fields_count ??
  0;
if (verifiedCount < 35) fail(`Expected at least 35 verified fields, got ${verifiedCount}`);

if (result.final_verification?.status && result.final_verification.status !== "PASS") {
  fail(`Expected final_verification.status PASS, got ${result.final_verification.status}`);
}
if (result.verification_summary?.status && !["PASS", "PASS_WITH_WARNINGS"].includes(result.verification_summary.status)) {
  fail(`Expected verification_summary.status PASS/PASS_WITH_WARNINGS, got ${result.verification_summary.status}`);
}

for (const action of actions.filter((item) => ["fill", "type", "select", "check", "uncheck", "radio"].includes(item.action))) {
  if (!action.field_id) fail(`Interacted action missing field_id: ${action.action} ${action.selector || action.target || ""}`);
  if (/^elem_\d+$/.test(String(action.field_id || ""))) fail(`field_id must not be temporary ${action.field_id}`);
  if (!action.selector) fail(`Interacted action missing selector: ${action.field_id || action.target}`);
  if (!action.label) fail(`Interacted action missing label: ${action.field_id || action.selector}`);
  if (action.planned_value === undefined && action.input === undefined) fail(`Interacted action missing planned value: ${action.field_id || action.selector}`);
  if (action.post_action_actual_value === undefined && action.final_actual_value === undefined) {
    fail(`Interacted action missing post/final actual value: ${action.field_id || action.selector}`);
  }
  if (action.action_result === "SUCCESS" && action.final_verification?.status === "BLOCKED") {
    fail(`Action ${action.action_id} succeeded but final verification is blocked.`);
  }
}

function findAssertion(labelPart) {
  const wanted = String(labelPart).toLowerCase().replace(/[^a-z0-9]/g, "");
  return assertions.find((a) =>
    `${a.description || ""} ${a.label || ""} ${a.field_id || ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .includes(wanted)
  );
}

function requirePass(label, expectedContains) {
  const assertion = findAssertion(label);
  if (!assertion) {
    fail(`Missing assertion for ${label}`);
    return;
  }
  if (assertion.status !== "PASS") fail(`${label} assertion should PASS, got ${assertion.status}`);
  const actualText = JSON.stringify(assertion.actual ?? assertion.actual_value ?? assertion);
  if (expectedContains && !actualText.toLowerCase().includes(String(expectedContains).toLowerCase())) {
    fail(`${label} actual does not include ${expectedContains}. Actual: ${actualText}`);
  }
}

requirePass("First Name", "John");
requirePass("Last Name", "Doe");
requirePass("Email", "@");
requirePass("Credit Card Type", "Visa");
requirePass("Expiry Month", "12");
requirePass("Expiry Year", "2030");
requirePass("Birth Month", "Jan");
requirePass("Birth Day", "15");
requirePass("Birth Year", "1990");

for (const ac of result.acceptance_criteria || []) {
  if (!["PASS", "PASS_WITH_WARNINGS", "WARNING"].includes(ac.status)) {
    fail(`Acceptance criteria ${ac.id} should PASS/WARNING, got ${ac.status}`);
  }
}

for (const err of result.network_errors || []) {
  for (const key of ["url", "method", "resource_type", "is_critical", "reason"]) {
    if (!(key in err)) fail(`Network error missing ${key}: ${JSON.stringify(err)}`);
  }
}
if ((result.stats?.critical_network_errors || 0) > 0) {
  fail(`Expected no critical network errors, got ${result.stats.critical_network_errors}`);
}

const steps = result.reproducible_steps || [];
if (steps.some((step) => /^batch$/i.test(String(step).trim()) || String(step).includes("details unavailable"))) {
  fail("Reproduction steps still contain raw batch placeholders.");
}
if (result.summary && result.summary.includes("First Name value equals")) {
  fail("Summary still starts from a field mismatch instead of final QA result.");
}
if (/Fix the application behavior/i.test(result.recommendation || "") && !issues.some((issue) => issue.type === "WEBSITE_BUG")) {
  fail("Recommendation says to fix application behavior without a proven WEBSITE_BUG.");
}

if (failures.length) {
  console.error("RoboForm regression failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("RoboForm regression passed.");
