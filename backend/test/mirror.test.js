import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { buildSenderArgs, validPin } from "../src/mirror-engine.js";

test("sender uses H.264 and controlled bitrate", () => {
  const args=buildSenderArgs("192.168.1.25");
  assert.deepEqual(args.slice(0,2), ["-target","192.168.1.25"]);
  assert.ok(args.includes("h264"));
  assert.ok(args.includes("24"));
  assert.ok(!args.includes("-pair"));
});
test("pairing rejects invalid inputs", () => {
  assert.ok(buildSenderArgs("192.168.1.25",{pairing:true}).includes("-pair"));
  assert.equal(validPin("1234"),true);
  assert.equal(validPin(""),true);
  assert.equal(validPin(";${HOME}"),false);
  assert.equal(validPin("x".repeat(200)),false);
});
test("desktop capture uses real persistent extension tab", () => {
  const manifest=JSON.parse(fs.readFileSync(new URL("../../manifest.json",import.meta.url),"utf8"));
  assert.ok(manifest.permissions.includes("desktopCapture"));
  assert.ok(!manifest.permissions.includes("offscreen"));
  assert.equal(manifest.action.default_popup,"popup.html");
  const capture=fs.readFileSync(new URL("../../capture.js",import.meta.url),"utf8");
  assert.ok(capture.includes("chrome.desktopCapture.chooseDesktopMedia"));
  assert.ok(capture.includes("navigator.mediaDevices.getUserMedia"));
  assert.ok(capture.includes('new URL("/mirror/stream",BASE)'));
});
