import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(".");
const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean);

const bannedPatterns = [
  { label: "static operator token", regex: /\boperator-token-dev\b/i },
  { label: "static agent token", regex: /\bagent-token-dev\b/i },
  { label: "static postgres password", regex: /\biisl_dev\b/i },
  { label: "unsafe host bind", regex: /\bAPI_HOST=0\.0\.0\.0\b/ },
  { label: "unsafe postgres fallback", regex: /\bPOSTGRES_PASSWORD:-iisl_dev\b/ }
];

const textExtensions = new Set([
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".html",
  ".yml",
  ".yaml",
  ".txt"
]);

const findings = [];

for (const relativePath of trackedFiles) {
  if (relativePath.startsWith("scripts/")) {
    continue;
  }
  const extension = path.extname(relativePath);
  if (!textExtensions.has(extension)) {
    continue;
  }

  const absolutePath = path.join(repoRoot, relativePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  for (const pattern of bannedPatterns) {
    if (pattern.regex.test(content)) {
      findings.push({ path: relativePath, label: pattern.label });
    }
  }
}

if (findings.length > 0) {
  console.error("Secret/banned literal scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding.path}: ${finding.label}`);
  }
  process.exit(1);
}

console.log("Secret scan passed.");
