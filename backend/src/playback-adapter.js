const PLAYBACK_TIMEOUT_MS = 1_500;

function buildStrategies(receiverIp, hlsUrl) {
  return [
    {
      name: "modern-http",
      endpoint: `http://${receiverIp}:7000/play`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: hlsUrl })
    },
    {
      name: "legacy-http",
      endpoint: `http://${receiverIp}:7100/legacy/play?url=${encodeURIComponent(hlsUrl)}`,
      method: "GET"
    }
  ];
}

async function callStrategy(strategy, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYBACK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(strategy.endpoint, {
      method: strategy.method,
      headers: strategy.headers,
      body: strategy.body,
      signal: controller.signal
    });
    return {
      strategy: strategy.name,
      endpoint: strategy.endpoint,
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    logger.warn(
      { event: "playback-strategy-error", strategy: strategy.name, error: String(error) },
      "playback initiation strategy failed"
    );
    return {
      strategy: strategy.name,
      endpoint: strategy.endpoint,
      ok: false,
      status: null,
      error: String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function initiatePlayback({ receiverIp, hlsUrl, logger }) {
  const results = [];
  for (const strategy of buildStrategies(receiverIp, hlsUrl)) {
    const outcome = await callStrategy(strategy, logger);
    results.push(outcome);
    if (outcome.ok) {
      return {
        selectedStrategy: strategy.name,
        initiated: true,
        attempts: results
      };
    }
  }

  return {
    selectedStrategy: null,
    initiated: false,
    attempts: results
  };
}
