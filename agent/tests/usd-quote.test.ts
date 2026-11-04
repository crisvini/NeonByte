import assert from "node:assert/strict";
import test from "node:test";
import { UsdQuoteService, USD_QUOTE_ENDPOINT, USD_QUOTE_POLL_INTERVAL_MS,
  USD_QUOTE_TTL_MS, type UsdQuoteServiceOptions } from "../src/exchange/usd-quote.js";

class ManualTimers {
  private nextId = 0;
  private readonly callbacks = new Map<number, { callback: () => void; delayMs: number }>();

  readonly setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = ++this.nextId;
    this.callbacks.set(id, { callback, delayMs });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.callbacks.delete(handle);
  };

  get delays(): number[] { return [...this.callbacks.values()].map(({ delayMs }) => delayMs); }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
    assert.ok(entry, "a USD quote timer should be scheduled");
    this.callbacks.delete(entry[0]);
    entry[1].callback();
  }
}

function responseFor(nowUnixMs: number, values: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    USDBRL: {
      code: "USD",
      codein: "BRL",
      bid: "5.254",
      pctChange: "-0.415",
      timestamp: String(Math.floor(nowUnixMs / 1000)),
      ...values,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function createService(fetchQuote: typeof fetch, timers = new ManualTimers()) {
  let nowUnixMs = Date.UTC(2026, 10, 4, 12);
  let nowMonotonicMs = 10_000;
  const options: UsdQuoteServiceOptions = {
    fetch: fetchQuote,
    clock: { unixMs: () => nowUnixMs, monotonicMs: () => nowMonotonicMs },
    timers,
  };
  return {
    service: new UsdQuoteService(options),
    timers,
    setTime(unixMs: number, monotonicMs: number) { nowUnixMs = unixMs; nowMonotonicMs = monotonicMs; },
    get nowUnixMs() { return nowUnixMs; },
    get nowMonotonicMs() { return nowMonotonicMs; },
  };
}

test("fetches only the fixed AwesomeAPI pair and normalizes price and change to cents and basis points", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const harness = createService(async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return responseFor(harness.nowUnixMs);
  });

  await harness.service.setEnabled(true);

  assert.equal(requestedUrl, USD_QUOTE_ENDPOINT);
  assert.equal(requestedInit?.method, "GET");
  assert.equal(requestedInit?.redirect, "error");
  assert.equal(harness.service.view.quote?.priceCents, 525);
  assert.equal(harness.service.view.quote?.changeBasisPoints, -42);
  assert.equal(harness.service.deviceState(1000).validForMs, USD_QUOTE_TTL_MS - 1000);
  assert.equal(harness.timers.delays[0], USD_QUOTE_POLL_INTERVAL_MS);
});

test("repeated source timestamps keep their original expiration", async () => {
  const harness = createService(async () => responseFor(Date.UTC(2026, 10, 4, 12) - 120_000));
  await harness.service.setEnabled(true);
  const originalValidity = harness.service.deviceState(0).validForMs;
  assert.equal(originalValidity, USD_QUOTE_TTL_MS - 120_000);

  harness.setTime(harness.nowUnixMs + 5 * 60_000, harness.nowMonotonicMs + 5 * 60_000);
  harness.timers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(harness.service.deviceState(0).validForMs, originalValidity - 5 * 60_000);
});

test("the monotonic deadline prevents a backward wall-clock adjustment from extending a quote", async () => {
  const harness = createService(async () => responseFor(harness.nowUnixMs));
  await harness.service.setEnabled(true);
  harness.setTime(harness.nowUnixMs - 10 * 60_000, harness.nowMonotonicMs + 10 * 60_000);
  assert.equal(harness.service.deviceState(0).validForMs, USD_QUOTE_TTL_MS - 10 * 60_000);

  harness.setTime(harness.nowUnixMs - 10 * 60_000, harness.nowMonotonicMs + USD_QUOTE_TTL_MS);
  assert.equal(harness.service.view.quote, null);
});

test("rejects provider responses whose received body exceeds 8 KiB", async () => {
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8193));
      controller.close();
    },
  }), { status: 200 });
  const harness = createService(async () => oversized);

  await harness.service.setEnabled(true);

  assert.equal(harness.service.view.quote, null);
  assert.deepEqual(harness.service.deviceState(), {
    enabled: true, priceCents: 0, changeBasisPoints: 0, validForMs: 0,
  });
});

test("rounds complete decimals consistently and normalizes negative zero", async () => {
  const harness = createService(async () => responseFor(harness.nowUnixMs, {
    bid: "5.255", pctChange: "-0.004",
  }));
  await harness.service.setEnabled(true);
  assert.equal(harness.service.view.quote?.priceCents, 526);
  assert.equal(harness.service.view.quote?.changeBasisPoints, 0);

  const midpoint = createService(async () => responseFor(midpoint.nowUnixMs, {
    bid: "5.25", pctChange: "-0.015",
  }));
  await midpoint.service.setEnabled(true);
  assert.equal(midpoint.service.view.quote?.changeBasisPoints, -2);
});

test("rejects malformed provider data, out-of-range values, and timestamps outside the accepted window", async () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const invalidValues: Array<Record<string, unknown>> = [
    { code: "EUR" },
    { codein: "USD" },
    { timestamp: String(Math.floor((now + 61_000) / 1000)) },
    { timestamp: "946684799" },
    { bid: "0" },
    { bid: "1e3" },
    { bid: "999999999999999999999999" },
    { pctChange: "10000000" },
  ];
  for (const values of invalidValues) {
    const harness = createService(async () => responseFor(now, values));
    await harness.service.setEnabled(true);
    assert.equal(harness.service.view.quote, null, JSON.stringify(values));
  }

  for (const body of ["{", "null", "[]"]) {
    const harness = createService(async () => new Response(body, { status: 200 }));
    await harness.service.setEnabled(true);
    assert.equal(harness.service.view.quote, null, body);
  }
});

test("network and ordinary HTTP errors leave polling on its normal bounded interval", async () => {
  for (const fetchQuote of [
    async () => { throw new TypeError("network unavailable"); },
    async () => new Response("{}", { status: 503 }),
  ] as Array<typeof fetch>) {
    const harness = createService(fetchQuote);
    await harness.service.setEnabled(true);
    assert.equal(harness.service.view.quote, null);
    assert.deepEqual(harness.timers.delays, [USD_QUOTE_POLL_INTERVAL_MS]);
  }
});

test("disabling aborts an outstanding request and ignores its late response", async () => {
  let resolveFetch!: (response: Response) => void;
  const requestState: { signal: AbortSignal | null } = { signal: null };
  const harness = createService((_input, init) => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
    requestState.signal = init?.signal as AbortSignal;
  }));
  const pending = harness.service.setEnabled(true);
  const duplicate = harness.service.setEnabled(true);
  await harness.service.setEnabled(false);

  assert.equal(requestState.signal?.aborted, true);
  resolveFetch(responseFor(harness.nowUnixMs));
  await Promise.all([pending, duplicate]);
  assert.equal(harness.service.view.enabled, false);
  assert.equal(harness.service.view.quote, null);
  assert.deepEqual(harness.timers.delays, []);
});

test("a rate-limit Retry-After delays the next request without a retry loop", async () => {
  const harness = createService(async () => new Response("{}", {
    status: 429,
    headers: { "Retry-After": "600" },
  }));

  await harness.service.setEnabled(true);

  assert.deepEqual(harness.timers.delays, [600_000]);
});

