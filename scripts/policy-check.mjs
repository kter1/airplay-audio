import { execFileSync } from "node:child_process";
import fs from "node:fs";
const files = execFileSync("git",["ls-files"],{encoding:"utf8"}).trim().split("\n");
for (const file of files) {
  if (!/\.(js|mjs|html|json)$/.test(file) || file.startsWith("scripts/")) continue;
  const content = fs.readFileSync(file,"utf8");
  if (/\.innerHTML\s*=/.test(content)) throw new Error(file+": unsafe innerHTML");
  if (/\bexec\s*\(/.test(content)) throw new Error(file+": shell exec");
  if (/spawn\s*\([^)]*\{[\s\S]*?\bshell\s*:\s*true/m.test(content)) throw new Error(file+": shell=true");
}
const manifest = JSON.parse(fs.readFileSync("manifest.json","utf8"));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://127.0.0.1:8090/*"])) throw new Error("Only loopback host permitted");
if (JSON.stringify(manifest.permissions) !== JSON.stringify(["storage","desktopCapture"])) throw new Error("Unexpected extension permissions");
const config = fs.readFileSync("backend/src/config.js","utf8");
if (!config.includes('export const LOOPBACK_HOST = "127.0.0.1";')) throw new Error("Backend not restricted to loopback");
console.log("Policy scan passed");