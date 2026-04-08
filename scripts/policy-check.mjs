import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(".");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean);

const sourceCandidates = trackedFiles.filter((filePath) =>
  [".js", ".mjs", ".html", ".json"].includes(path.extname(filePath))
);

const sourceViolations = [];
for (const relativePath of sourceCandidates) {
  if (relativePath.startsWith("scripts/")) {
    continue;
  }
  const absolutePath = path.join(repoRoot, relativePath);
  const content = fs.readFileSync(absolutePath, "utf8");

  if (/\.innerHTML\s*=/.test(content)) {
    sourceViolations.push(`${relativePath}: disallowed innerHTML assignment`);
  }
  if (/\bexec\s*\(/.test(content)) {
    sourceViolations.push(`${relativePath}: disallowed child_process.exec usage`);
  }
  if (/spawn\s*\([^)]*\{[\s\S]*?\bshell\s*:\s*true[\s\S]*?\}/m.test(content)) {
    sourceViolations.push(`${relativePath}: disallowed spawn with shell=true`);
  }
  if (/\b0\.0\.0\.0\b/.test(content)) {
    sourceViolations.push(`${relativePath}: disallowed 0.0.0.0 bind literal`);
  }
}

if (sourceViolations.length > 0) {
  fail(`Policy scan failed:\\n${sourceViolations.map((item) => `- ${item}`).join("\n")}`);
}

const manifestPath = path.join(repoRoot, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const hostPermissions = manifest.host_permissions ?? [];
const expectedHostPermissions = ["http://127.0.0.1:8090/*"];
if (JSON.stringify(hostPermissions) !== JSON.stringify(expectedHostPermissions)) {
  fail(
    `manifest host_permissions must be exactly ${JSON.stringify(expectedHostPermissions)}, got ${JSON.stringify(hostPermissions)}`
  );
}

const permissions = manifest.permissions ?? [];
const expectedPermissions = ["storage", "tabCapture"];
if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
  fail(
    `manifest permissions must be exactly ${JSON.stringify(expectedPermissions)}, got ${JSON.stringify(permissions)}`
  );
}

const popupContent = fs.readFileSync(path.join(repoRoot, "popup.js"), "utf8");
if (!/const BACKEND_URL = "http:\/\/127\.0\.0\.1:8090";/.test(popupContent)) {
  fail("popup.js must pin BACKEND_URL to http://127.0.0.1:8090");
}

const backendConfig = fs.readFileSync(path.join(repoRoot, "backend/src/config.js"), "utf8");
if (!/export const LOOPBACK_HOST = "127\.0\.0\.1";/.test(backendConfig)) {
  fail("backend must enforce LOOPBACK_HOST as 127.0.0.1");
}

console.log("Policy scan passed.");
