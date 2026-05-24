import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runRoot = path.resolve("qa-runs/regression/roboform");
const resultPath = path.join(runRoot, "result.json");
const prompt = [
  "Fill every editable form field on this page with dummy test data.",
  "Use stable dummy data: Title Mr., First Name John, Middle Initial D, Last Name Doe, Full Name John D. Doe, Email testuser@example.com, Website https://example.com, User ID testuser123, fake card number 4111111111111111, CVC 123, Credit Card Type Visa (Preferred), Expiry Month 12, Expiry Year 2030, Birth Month Jan, Birth Day 15, Birth Year 1990.",
  "Fill text/password inputs and select valid non-default options for dropdowns.",
  "Use separate deterministic batches: one batch for text/password fields and a second batch for dropdown/select fields.",
  "Do not submit anything because this page has no submit button.",
  "After filling, verify from the final DOM that every planned field contains the expected value.",
  "Treat verifier/runtime errors as AgentQA infrastructure failures, not website bugs."
].join(" ");

fs.mkdirSync(runRoot, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    ...options
  });
  return result;
}

const build = run(process.execPath, ["scripts/build-cli.mjs"]);
fs.writeFileSync(path.join(runRoot, "build-cli.stdout.log"), build.stdout || "", "utf8");
fs.writeFileSync(path.join(runRoot, "build-cli.stderr.log"), build.stderr || "", "utf8");
if (build.status !== 0) {
  console.error("Failed to build local AgentQA CLI.");
  console.error(build.error?.message || build.stderr || build.stdout);
  process.exit(build.status || 1);
}

const cli = run(process.execPath, [
  "out/cli/index.js",
  "run",
  "--url",
  "https://www.roboform.com/filling-test-all-fields",
  "--prompt",
  prompt,
  "--max-steps",
  "10",
  "--max-batch-size",
  "50",
  "--output-dir",
  runRoot,
  "--json"
], { timeout: 10 * 60 * 1000 });

fs.writeFileSync(path.join(runRoot, "agentqa.stdout.json"), cli.stdout || "", "utf8");
fs.writeFileSync(path.join(runRoot, "agentqa.stderr.log"), cli.stderr || "", "utf8");

const latestResult = findLatestResultJson(runRoot);
if (!latestResult) {
  console.error("AgentQA did not produce a result.json under qa-runs/regression/roboform.");
  if (cli.status !== 0) console.error(cli.stderr || cli.stdout);
  process.exit(cli.status || 1);
}
fs.copyFileSync(latestResult, resultPath);

const assertion = run(process.execPath, ["scripts/assert-roboform-result.mjs", resultPath]);
process.stdout.write(assertion.stdout || "");
process.stderr.write(assertion.stderr || "");
if (assertion.status !== 0) process.exit(assertion.status || 1);
if (cli.status !== 0) {
  console.error("AgentQA CLI exited non-zero even though result assertions passed.");
  process.exit(cli.status || 1);
}

function findLatestResultJson(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "result.json" && full !== resultPath) {
        found.push(full);
      }
    }
  };
  visit(root);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}
