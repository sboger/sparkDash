/**
 * Unit tests for mlx_vlm server detection (`python -m mlx_vlm server`, Apple
 * Silicon) and its JSON /metrics. Fixture shape captured from minim6
 * (Mac mini M6, gemma4-e4b-4bit on :8888); trimmed to the fields the probe reads.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
}

const MLX_METRICS = {
  latest: {
    timestamp_unix: 1791925749.2,
    endpoint: "/chat/completions",
    model: "/Users/s/models/gemma4-e4b-4bit",
    prompt_tokens: 2140,
    completion_tokens: 259,
    prefill_tok_s: 2321.71,
    ttft_s: 0.97,
    decode_tok_s: 30.06,
    peak_memory_gb: 16.83,
    finish_reason: "stop",
  },
  summary: {
    uptime_s: 4691.8,
    requests_started: 68,
    requests_completed: 40,
    in_flight: 0,
    prompt_tokens_total: 309215,
    completion_tokens_total: 8334,
    avg_decode_tok_s: 19.85,
  },
  server: {
    loaded_model: "/Users/s/models/gemma4-e4b-4bit",
    loaded_context_size: 131072,
    continuous_batching_enabled: true,
    request_queue_depth: 0,
  },
};

const OPENAI_MODELS = {
  object: "list",
  data: [{ id: "/Users/s/models/gemma4-e4b-4bit", object: "model", loaded: true }],
};

test("_detectServerType: mlx_vlm JSON /metrics → mlxvlm (not vllm)", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.223" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(OPENAI_MODELS);
    if (u.endsWith("/metrics")) return jsonRes(MLX_METRICS);
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "mlxvlm");
});

test("_metricsLookLikeMlxVlm requires the summary+server contract (LM Studio cannot misfire)", () => {
  assert.equal(LlmProbe._metricsLookLikeMlxVlm(MLX_METRICS), true);
  assert.equal(LlmProbe._metricsLookLikeMlxVlm({ error: "not found" }), false);
  assert.equal(LlmProbe._metricsLookLikeMlxVlm({ summary: {} }), false);
  assert.equal(LlmProbe._metricsLookLikeMlxVlm(null), false);
  // vLLM-shaped Prometheus text would come through as a parsed object? No — it
  // only ever arrives parsed; a random JSON body without the fields is rejected.
  assert.equal(LlmProbe._metricsLookLikeMlxVlm({ data: [] }), false);
});

test("probe: mlx_vlm counter diffs give decode/prefill tok/s, context and slots", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.223" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(OPENAI_MODELS);
    if (u.endsWith("/metrics")) return jsonRes(MLX_METRICS);
    return notFound();
  };
  const first = await probe.probe(); // primes the counters
  assert.equal(first.backend, "mlxvlm");
  assert.equal(first.generationTps, 0);
  assert.equal(first.contextLength, 131072);

  // A request finished between polls: +500 completion tokens, +2000 prompt tokens in 2 s.
  const busy = structuredClone(MLX_METRICS);
  busy.summary.completion_tokens_total = 8834;
  busy.summary.prompt_tokens_total = 311215;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(OPENAI_MODELS);
    if (u.endsWith("/metrics")) return jsonRes(busy);
    return notFound();
  };
  // Prime the counters, then simulate a 2 s poll gap (production polls are
  // seconds apart; two back-to-back probes land in the same millisecond).
  probe.lastProbeTime = Date.now() - 2000;
  const second = await probe.probe();
  assert.equal(second.generationTps, 250); // 500 / 2 s
  assert.equal(second.prefillTps, 1000); // 2000 / 2 s
  assert.equal(second.totalOutputTokens, 8834);
  assert.equal(second.totalPromptTokens, 311215);
});

test("probe: an in-flight mlx_vlm generation holds the last measured decode rate", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.223" }, 8888);
  probe.backendType = "mlxvlm";
  const busy = structuredClone(MLX_METRICS);
  busy.summary.in_flight = 1; // tokens not counted until the request finishes
  busy.latest.decode_tok_s = 29.9;
  busy.latest.prefill_tok_s = 2600;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(OPENAI_MODELS);
    if (u.endsWith("/metrics")) return jsonRes(busy);
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.requestsRunning, 1);
  assert.equal(snap.decodeActive, true);
  assert.equal(snap.generationTps, 29.9);
  assert.equal(snap.prefillTps, 2600);
});

test("probe: idle mlx_vlm shows no rates even when an old decode_tok_s is on record", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.223" }, 8888);
  probe.backendType = "mlxvlm";
  const idle = structuredClone(MLX_METRICS); // in_flight 0, no counter movement
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(OPENAI_MODELS);
    if (u.endsWith("/metrics")) return jsonRes(idle);
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.requestsRunning, 0);
  assert.equal(snap.decodeActive, false);
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
});

test("probe: a Prometheus-text /metrics on an unclassified server is still vllm, never mlxvlm", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.9" }, 8888);
  const prom = '# TYPE vllm:generation_tokens_total counter\nvllm:generation_tokens_total 123';
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(OPENAI_MODELS);
    if (u.endsWith("/metrics")) return { ok: true, status: 200, text: async () => prom, json: async () => ({}) };
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "vllm");
});
