import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const scenarioId = process.argv[2] || "local-form";
const scenarios = {
  "local-form": {
    dir: "local-form",
    prompt: "Fill every editable form field with dummy test data. Select valid non-default dropdown options. Do not submit. Verify final DOM values match planned values.",
    expected: ["PASS", "PASS_WITH_WARNINGS"],
    localFixture: "tests/fixtures/form-fill.html"
  },
  "saucedemo-login-negative": {
    dir: "saucedemo-login-negative",
    url: "https://www.saucedemo.com/",
    prompt: "Try logging in with username invalid_user and password wrong_password. Verify login is rejected and a visible relevant error message is shown. Do not expose the password in the report.",
    expected: ["PASS", "PASS_WITH_WARNINGS"]
  },
  "ecommerce-add-to-cart": {
    dir: "ecommerce-add-to-cart",
    url: "https://ecommerce-playground.lambdatest.io/",
    prompt: "Search for iPhone, open a product, add it to cart, and verify the cart contains the selected product. If the site is unavailable or blocks automation, report BLOCKED without WEBSITE_BUG.",
    expected: ["PASS", "PASS_WITH_WARNINGS", "BLOCKED"]
  }
};

const scenario = scenarios[scenarioId];
if (!scenario) {
  console.error(`Unknown scenario '${scenarioId}'. Available: ${Object.keys(scenarios).join(", ")}`);
  process.exit(1);
}

let server;
let url = scenario.url;
if (scenario.localFixture) {
  const filePath = path.resolve(scenario.localFixture);
  const port = await getFreePort();
  const serverCode = `
    const fs = require('node:fs');
    const http = require('node:http');
    const port = Number(process.argv[1]);
    const file = process.argv[2];
    const html = fs.readFileSync(file);
    http.createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }).listen(port, '127.0.0.1', () => console.log('ready'));
  `;
  server = spawn(process.execPath, ["-e", serverCode, String(port), filePath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local fixture server did not start.")), 5000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`Local fixture server exited early with code ${code}`)));
  });
  url = `http://127.0.0.1:${port}/`;
}

const runRoot = path.resolve("qa-runs/regression", scenario.dir);
fs.mkdirSync(runRoot, { recursive: true });
const build = spawnSync(process.execPath, ["scripts/build-cli.mjs"], { cwd: process.cwd(), encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.error?.message || build.stderr || build.stdout);
  server?.kill();
  process.exit(build.status || 1);
}

const cli = spawnSync(process.execPath, [
  "out/cli/index.js",
  "run",
  "--url",
  url,
  "--prompt",
  scenario.prompt,
  "--max-steps",
  "10",
  "--max-batch-size",
  "50",
  "--output-dir",
  runRoot,
  "--json"
], { cwd: process.cwd(), encoding: "utf8", timeout: 10 * 60 * 1000 });

fs.writeFileSync(path.join(runRoot, "agentqa.stdout.json"), cli.stdout || "", "utf8");
fs.writeFileSync(path.join(runRoot, "agentqa.stderr.log"), cli.stderr || "", "utf8");
const resultFile = findLatestResultJson(runRoot);
if (!resultFile) {
  console.error(`No result.json produced for ${scenarioId}.`);
  console.error(cli.stderr || cli.stdout);
  server?.kill();
  process.exit(cli.status || 1);
}

const canonical = path.join(runRoot, "result.json");
fs.copyFileSync(resultFile, canonical);
const result = JSON.parse(fs.readFileSync(canonical, "utf8"));
const failures = [];
if (!scenario.expected.includes(result.status)) failures.push(`Expected ${scenario.expected.join("/")} got ${result.status}`);
if (JSON.stringify(result).includes("${JSON.stringify(registry)}") || JSON.stringify(result).includes("${")) failures.push("Uninterpolated injected JS placeholder found.");
if ((result.issues || []).some((issue) => issue.type === "VERIFIER_RUNTIME_ERROR")) failures.push("Verifier runtime error issue found.");
if (scenarioId !== "ecommerce-add-to-cart" && (result.issues || []).some((issue) => issue.type === "WEBSITE_BUG")) failures.push("Unexpected WEBSITE_BUG issue found.");
if (result.status === "BLOCKED" && result.root_cause === "WEBSITE_BUG") failures.push("Blocked run must not use WEBSITE_BUG root cause.");

server?.kill();
if (failures.length) {
  console.error(`${scenarioId} regression failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`${scenarioId} regression passed.`);

function findLatestResultJson(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "result.json" && full !== path.join(root, "result.json")) found.push(full);
    }
  };
  visit(root);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate local fixture port."));
      });
    });
  });
}
