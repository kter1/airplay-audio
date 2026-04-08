const IPV4_SEGMENT_COUNT = 4;

export function parseIpv4(ip) {
  if (typeof ip !== "string") {
    return null;
  }

  const candidate = ip.trim();
  const segments = candidate.split(".");
  if (segments.length !== IPV4_SEGMENT_COUNT) {
    return null;
  }

  const octets = [];
  for (const segment of segments) {
    if (!/^\d{1,3}$/.test(segment)) {
      return null;
    }

    if (segment.length > 1 && segment.startsWith("0")) {
      return null;
    }

    const value = Number(segment);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    octets.push(value);
  }

  return octets;
}

export function isPrivateIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== IPV4_SEGMENT_COUNT) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function validateReceiverIp(receiverIp) {
  const octets = parseIpv4(receiverIp);
  if (!octets) {
    return { valid: false, reason: "receiverIp must be a valid IPv4 address" };
  }

  if (!isPrivateIpv4(octets)) {
    return {
      valid: false,
      reason: "receiverIp must be in a private LAN range (10.x, 172.16-31.x, or 192.168.x)"
    };
  }

  return { valid: true, normalized: octets.join(".") };
}

export function ensureJsonRequest(contentTypeHeader) {
  if (typeof contentTypeHeader !== "string") {
    return false;
  }

  return contentTypeHeader.toLowerCase().includes("application/json");
}

export function isLoopbackAddress(address) {
  if (typeof address !== "string") {
    return false;
  }

  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

export function validateSessionToken(token) {
  return typeof token === "string" && /^[a-f0-9]{48}$/.test(token);
}

export function validateSessionId(sessionId) {
  return typeof sessionId === "string" && /^[a-f0-9]{24}$/.test(sessionId);
}
