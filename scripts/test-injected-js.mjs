import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const outFile = path.resolve("out/test-harness/harness.mjs");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
buildSync({
  entryPoints: ["src/core/harness.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: outFile,
  external: ["electron"]
});

const { buildVerificationScript, safeJsonForInjectedJs, validateInjectedScript } = await import(pathToFileURL(outFile).href);

const registry = [{
  field_id: "field_first_name_02frstname",
  selector: "input[name=\"02frstname\"]",
  selector_candidates: ["input[name=\"02frstname\"]"],
  label: "First Name"
}];

const python = buildVerificationScript(registry);
assert.equal(python.includes("${"), false, "Generated verifier wrapper still contains an uninterpolated template placeholder.");

const assignment = python.match(/script = ("(?:\\.|[^"])*")/);
assert.ok(assignment, "Could not find embedded verifier script assignment.");
const injected = JSON.parse(assignment[1]);
assert.equal(injected.includes("${"), false, "Injected verifier JS still contains an uninterpolated template placeholder.");
assert.ok(injected.includes(`const registry = ${safeJsonForInjectedJs(registry)}`), "Verifier JS does not contain serialized registry JSON.");
validateInjectedScript(injected, "test-field-verifier");

console.log("Injected JS regression passed.");
