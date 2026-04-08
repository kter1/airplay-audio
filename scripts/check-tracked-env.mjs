import { execFileSync } from "node:child_process";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean);

const blockedPatterns = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\..+/,
  /(^|\/)[^/]+\.env$/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.direnv(\/|$)/
];

const violations = trackedFiles.filter((filePath) =>
  blockedPatterns.some((pattern) => pattern.test(filePath))
);

if (violations.length > 0) {
  console.error("Tracked env-like files are blocked:");
  for (const filePath of violations) {
    console.error(`- ${filePath}`);
  }
  process.exit(1);
}

console.log("Tracked env-file check passed.");
