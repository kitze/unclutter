import assert from "node:assert/strict";
import test from "node:test";
import {
  ENDPOINT,
  TYPESAFE_ENDPOINT,
  evaluate,
  evaluationCall,
  evaluationRequest,
  LAYA_CUTOFF,
  rulesFromAnswers,
} from "../lib/jev";
import type { Snapshot } from "../lib/model";
import { isConfigured, layaEndpoint, resolveProvider, smokeCredentials } from "../lib/providers";

const snapshot: Snapshot = {
  url: "https://example.com/article?token=private",
  context: { key: "synthetic", kind: "article", label: "article", origin: "https://example.com" },
  candidates: [
    {
      id: "e0",
      selector: "div.ad-banner",
      tag: "div",
      signals: "advertisement",
      text: "Advertisement",
      position: "static",
      count: 1,
    },
  ],
};
const result = (confidence = 0.95, probability = 0.96) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 100, output_tokens: 20 },
  answers: {
    e0: {
      type: "choice",
      choice: "ad",
      confidence,
      probabilities: {
        ad: probability,
        keep: 1 - probability,
        cookie: 0,
        promotion: 0,
        newsletter: 0,
        social: 0,
        uncertain: 0,
      },
    },
  },
});

test("TypeSafe construction uses System One, Bearer and jev-latest only", () => {
  const call = evaluationCall(snapshot, "synthetic-test-key", "typesafe");
  assert.equal(call.url, TYPESAFE_ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, {
    Authorization: "Bearer synthetic-test-key",
    "Content-Type": "application/json",
  });
  const body = JSON.parse(String(call.init.body));
  assert.deepEqual(body, { ...evaluationRequest(snapshot), model: "jev-latest" });
  assert.ok(!String(call.init.body).includes("token=private"));
  assert.ok(!String(call.init.body).includes("synthetic-test-key"));
  assert.ok(call.init.signal instanceof AbortSignal);
});

test("Gateway construction retains v4 headers, default route and no TypeSafe model field", () => {
  const call = evaluationCall(snapshot, "synthetic-test-key");
  assert.equal(call.url, ENDPOINT);
  assert.deepEqual(call.init.headers, {
    Authorization: "Bearer synthetic-test-key",
    "Content-Type": "application/json",
    "ai-gateway-protocol-version": "0.0.1",
    "ai-gateway-auth-method": "api-key",
    "ai-evaluation-model-specification-version": "4",
    "ai-model-id": "typesafe-ai/jev",
  });
  assert.deepEqual(JSON.parse(String(call.init.body)), evaluationRequest(snapshot));
  assert.equal(JSON.parse(String(call.init.body)).model, undefined);
});

test("stored provider resolution defaults missing/unknown values to Gateway", () => {
  for (const input of [undefined, null, "unknown", "", {}, 1, "vercel"])
    assert.equal(resolveProvider(input), "vercel");
  assert.equal(resolveProvider("typesafe"), "typesafe");
});

test("TypeSafe response ignores top-level metadata and enforces BOTH supplied confidence gates", () => {
  assert.equal(rulesFromAnswers(result(), snapshot.candidates).length, 1);
  assert.equal(rulesFromAnswers(result(0.9, 0.9), snapshot.candidates).length, 1);
  assert.deepEqual(rulesFromAnswers(result(0.89, 0.99), snapshot.candidates), []);
  assert.deepEqual(rulesFromAnswers(result(0.99, 0.89), snapshot.candidates), []);
  for (const confidence of [NaN, Infinity, -0.1, 1.1])
    assert.throws(() => rulesFromAnswers(result(confidence), snapshot.candidates));
  const noConfidence = {
    answers: { e0: { type: "choice", choice: "ad", probabilities: { ad: 0.99 } } },
  };
  assert.equal(rulesFromAnswers(noConfidence, snapshot.candidates).length, 1);
});

test("evaluate actually POSTs to TypeSafe and parses Choice payload into rules", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-test-key");
    assert.equal(new Headers(init.headers).has("ai-model-id"), false);
    assert.equal(JSON.parse(String(init.body)).model, "jev-latest");
    return Response.json(result());
  });
  assert.deepEqual(await evaluate(snapshot, "synthetic-test-key", "typesafe"), [
    { selector: "div.ad-banner", category: "ad", enabled: true },
  ]);
  assert.equal(fetch.mock.calls.length, 1);
});

test("HTTP errors are provider aware and never echo response bodies or keys", async (t) => {
  let status = 401;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("private upstream response", { status }),
  );
  for (const provider of ["typesafe", "vercel"] as const) {
    for (status of [401, 403, 429, 500]) {
      const advice =
        status === 429
          ? "Rate limited. Try again later."
          : status === 500
            ? "Try again later."
            : provider === "typesafe"
              ? "Check your TypeSafe API key."
              : status === 401
                ? "Check your Gateway API key."
                : "Check Gateway credits and model access.";
      await assert.rejects(evaluate(snapshot, "synthetic-test-key", provider), {
        message: `Jev request failed: HTTP ${status}. ${advice}`,
      });
    }
  }
});

test("smoke credentials support direct aliases and reject mixed provider families", () => {
  assert.deepEqual(smokeCredentials({ JEV_KEY: " synthetic-test-key " }), {
    provider: "typesafe",
    key: "synthetic-test-key",
  });
  assert.deepEqual(smokeCredentials({ TYPESAFE_API_KEY: "synthetic-test-key" }), {
    provider: "typesafe",
    key: "synthetic-test-key",
  });
  assert.deepEqual(smokeCredentials({ AI_GATEWAY_API_KEY: "synthetic-test-key" }), {
    provider: "vercel",
    key: "synthetic-test-key",
  });
  assert.throws(
    () =>
      smokeCredentials({ JEV_KEY: "synthetic-test-key", AI_GATEWAY_API_KEY: "synthetic-test-key" }),
    /Set only one/,
  );
  assert.throws(
    () => smokeCredentials({ JEV_KEY: "first-test-value", TYPESAFE_API_KEY: "second-test-value" }),
    /differ/,
  );
  assert.throws(() => smokeCredentials({}), /Set JEV_KEY/);
});

test("Laya URLs normalize to System One and reject credentials or other schemes", () => {
  for (const input of [
    "http://localhost:8000",
    "http://localhost:8000/",
    "http://localhost:8000/v1/systemone",
    " http://localhost:8000/?x=1#y ",
  ])
    assert.equal(layaEndpoint(input), "http://localhost:8000/v1/systemone");
  assert.equal(layaEndpoint("https://ai.lan/laya/"), "https://ai.lan/laya/v1/systemone");
  assert.throws(() => layaEndpoint("ftp://localhost:8000"), /http/);
  assert.throws(() => layaEndpoint("http://user:pw@localhost:8000"), /key field/);
  assert.throws(() => layaEndpoint("localhost:8000"));
});

test("Laya needs a server URL, not a key", () => {
  assert.equal(resolveProvider("laya"), "laya");
  const laya = { provider: "laya" as const, apiKey: "", endpoint: "http://localhost:8000" };
  assert.equal(isConfigured(laya), true);
  assert.equal(isConfigured({ ...laya, endpoint: "" }), false);
  assert.equal(isConfigured({ ...laya, provider: "vercel" }), false);
  assert.deepEqual(smokeCredentials({ LAYA_URL: "http://localhost:8000" }), {
    provider: "laya",
    key: "",
    endpoint: "http://localhost:8000",
  });
});

test("Laya cutoff uses calibrated probability and ignores Jev-style confidence", () => {
  assert.equal(rulesFromAnswers(result(0.1, 0.6), snapshot.candidates, LAYA_CUTOFF).length, 1);
  assert.deepEqual(rulesFromAnswers(result(0.99, 0.59), snapshot.candidates, LAYA_CUTOFF), []);
  assert.deepEqual(rulesFromAnswers(result(0.1, 0.6), snapshot.candidates), []);
});

const layaSnapshot: Snapshot = {
  ...snapshot,
  candidates: [
    snapshot.candidates[0]!,
    { ...snapshot.candidates[0]!, id: "e1", selector: "nav.site", signals: "nav", text: "Home" },
  ],
};

test("Laya sends one element per request, without a key unless one is saved", async (t) => {
  const bodies: { state: { element: { signals: string } }; questions: object }[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(url, "http://localhost:8000/v1/systemone");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, undefined);
    bodies.push(body);
    const [id] = Object.keys(body.questions);
    const choice = id === "e0" ? "ad" : "keep";
    return Response.json({
      answers: {
        [id!]: { type: "choice", choice, confidence: 0.2, probabilities: { [choice]: 0.7 } },
      },
    });
  });
  assert.deepEqual(await evaluate(layaSnapshot, "", "laya", "http://localhost:8000"), [
    { selector: "div.ad-banner", category: "ad", enabled: true },
  ]);
  assert.equal(fetch.mock.calls.length, 2);
  for (const body of bodies) {
    assert.equal(Object.keys(body.questions).length, 1);
    assert.equal(JSON.stringify(body).includes("example.com"), false);
  }
  assert.deepEqual(bodies.map((b) => b.state.element.signals).sort(), ["advertisement", "nav"]);

  fetch.mock.mockImplementation(async (_url: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-test-key");
    const [id] = Object.keys(JSON.parse(String(init.body)).questions);
    return Response.json({ answers: { [id!]: { type: "choice", choice: "keep" } } });
  });
  assert.deepEqual(
    await evaluate(layaSnapshot, "synthetic-test-key", "laya", "http://localhost:8000"),
    [],
  );
});

test("Laya failures name the server problem and keep existing rules", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("private", { status: 401 }));
  await assert.rejects(evaluate(layaSnapshot, "", "laya", "http://localhost:8000"), {
    message: "Laya request failed: HTTP 401. Check your Laya server key.",
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(evaluate(layaSnapshot, "", "laya", "http://localhost:8000"), {
    message: "Could not reach the Laya server at http://localhost:8000.",
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {} }));
  await assert.rejects(evaluate(layaSnapshot, "", "laya", "http://localhost:8000"), /incomplete/);
});
