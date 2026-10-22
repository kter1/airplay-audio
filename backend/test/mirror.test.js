import assert from "node:assert/strict";
import test from "node:test";
import { buildSenderArgs, validPin } from "../src/mirror-engine.js";
test("sender requests H264 at 24 fps", () => {
  const args=buildSenderArgs("192.168.1.25");
  assert.deepEqual(args.slice(0,2),["-target","192.168.1.25"]);
  assert.ok(args.includes("h264"));
  assert.ok(args.includes("24"));
  assert.ok(!args.includes("-pair"));
});
test("pairing control", () => {
  assert.ok(buildSenderArgs("192.168.1.25",{pairing:true}).includes("-pair"));
  assert.equal(validPin("1234"),true);
  assert.equal(validPin(""),true);
  assert.equal(validPin("; rm -rf /"),false);
  assert.equal(validPin("x".repeat(200)),false);
});
