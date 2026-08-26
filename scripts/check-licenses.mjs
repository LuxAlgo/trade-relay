import { execSync } from "node:child_process";

/*
  Dependency license gate. Fails the build if anything in the lockfile-deep
  dependency tree carries a license outside the allowlist. Copyleft or
  source-available licenses (GPL, AGPL, LGPL, SSPL, BUSL, Commons Clause)
  are not rationalized here: replace the dependency or take it to review.
*/

const ALLOW = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "0BSD",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

const expressionAllowed = (expression) => {
  if (ALLOW.has(expression)) return true;
  // Tolerate simple SPDX expressions: every referenced license must be allowed.
  const parts = expression
    .replaceAll("(", " ")
    .replaceAll(")", " ")
    .split(/\s+(?:OR|AND)\s+|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => ALLOW.has(part));
};

const raw = execSync("pnpm licenses list --json", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const byLicense = JSON.parse(raw);

const violations = [];
for (const [license, packages] of Object.entries(byLicense)) {
  if (!expressionAllowed(license)) {
    violations.push({ license, packages: packages.map((pkg) => pkg.name) });
  }
}

if (violations.length > 0) {
  console.error("License gate FAILED. Disallowed licenses in the dependency tree:\n");
  for (const violation of violations) {
    console.error(`  ${violation.license}: ${violation.packages.join(", ")}`);
  }
  console.error("\nReplace the dependency, or take it to LuxAlgo review. Do not extend the allowlist casually.");
  process.exit(1);
}

console.log(`License gate passed: ${Object.keys(byLicense).length} license group(s), all allowed.`);
