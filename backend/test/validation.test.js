import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureJsonRequest,
  isLoopbackAddress,
  parseIpv4,
  validateReceiverIp,
  validateSessionId,
  validateSessionToken
} from "../src/validation.js";

test("parseIpv4 returns octets for valid IPv4", () => {
  assert.deepEqual(parseIpv4("192.168.1.12"), [192, 168, 1, 12]);
});

test("validateReceiverIp rejects public IPv4", () => {
  const result = validateReceiverIp("8.8.8.8");
  assert.equal(result.valid, false);
});

test("validateReceiverIp accepts RFC1918 IPv4", () => {
  const result = validateReceiverIp("10.24.11.7");
  assert.equal(result.valid, true);
  assert.equal(result.normalized, "10.24.11.7");
});

test("ensureJsonRequest enforces JSON content type", () => {
  assert.equal(ensureJsonRequest("application/json"), true);
  assert.equal(ensureJsonRequest("text/plain"), false);
});

test("loopback validation handles IPv4 and IPv6 loopback", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
});

test("session token and id validators enforce expected shape", () => {
  assert.equal(validateSessionId("a".repeat(24)), true);
  assert.equal(validateSessionId("A".repeat(24)), false);
  assert.equal(validateSessionToken("b".repeat(48)), true);
  assert.equal(validateSessionToken("1".repeat(47)), false);
});
