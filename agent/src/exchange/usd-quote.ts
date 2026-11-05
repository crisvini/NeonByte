import { performance } from "node:perf_hooks";

export const USD_QUOTE_ENDPOINT = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
export const USD_QUOTE_POLL_INTERVAL_MS = 5 * 60_000;
const USD_QUOTE_TRANSIENT_RETRY_MS = 30_000;
export const USD_QUOTE_TTL_MS = 15 * 60_000;
export const USD_QUOTE_REQUEST_TIMEOUT_MS = 5_000;
export const USD_QUOTE_RESPONSE_LIMIT_BYTES = 8 * 1024;
export const USD_STATE_TRANSPORT_BUDGET_MS = 1_000;
export const USD_STATE_BODY_LIMIT_BYTES = 128;
export const USD_PRICE_CENTS_MAX = 99_999_999;
export const USD_CHANGE_BASIS_POINTS_MAX = 999_999_999;
const MIN_SOURCE_TIMESTAMP_UNIX_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface UsdDeviceState {
  enabled: boolean;
  priceCents: number;
  changeBasisPoints: number;
  validForMs: number;
}

export interface UsdQuote {
  priceCents: number;
  changeBasisPoints: number;
  sourceTimestampUnixMs: number;
}

export interface UsdQuoteView {
  enabled: boolean;
  quote: UsdQuote | null;
  validForMs: number;
}

export function isValidUsdDeviceState(value: unknown): value is UsdDeviceState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).length !== 4 || typeof state["enabled"] !== "boolean" ||
      !Number.isSafeInteger(state["priceCents"]) || Number(state["priceCents"]) < 0 ||
      Number(state["priceCents"]) > USD_PRICE_CENTS_MAX ||
      !Number.isSafeInteger(state["changeBasisPoints"]) ||
      Math.abs(Number(state["changeBasisPoints"])) > USD_CHANGE_BASIS_POINTS_MAX ||
      !Number.isSafeInteger(state["validForMs"]) || Number(state["validForMs"]) < 0 || Number(state["validForMs"]) > USD_QUOTE_TTL_MS) return false;
  if (state["enabled"] === false) {
    return state["priceCents"] === 0 && state["changeBasisPoints"] === 0 && state["validForMs"] === 0;
  }
  if (state["priceCents"] === 0) return state["changeBasisPoints"] === 0 && state["validForMs"] === 0;
  return Number(state["validForMs"]) > 0;
}

export interface UsdQuoteServiceOptions {
  fetch?: typeof fetch;
  clock?: {
    unixMs(): number;
    monotonicMs(): number;
  };
  timers?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

interface CachedQuote extends UsdQuote {
  expiresAtUnixMs: number;
  expiresAtMonotonicMs: number;
}

class QuoteProviderError extends Error {
  constructor(readonly retryAfterMs: number) { super("The exchange-rate provider request failed."); }
}

function defaultTimers(): NonNullable<UsdQuoteServiceOptions["timers"]> {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

function retryAfterDelay(value: string | null, nowUnixMs: number): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : null;
  if (seconds !== null && Number.isSafeInteger(seconds)) {
    return Math.min(seconds * 1000, MAX_TIMER_DELAY_MS);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - nowUnixMs), MAX_TIMER_DELAY_MS) : 0;
}

function decimalToScaledInteger(value: unknown, scale: number, maxAbsoluteValue: number): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const negative = match[1] === "-";
  const whole = BigInt(match[2]!);
  const fractionalDigits = match[3] ?? "";
  const cents = BigInt(scale);
  let magnitude = whole * cents;
  const fraction = (fractionalDigits + "0".repeat(String(scale).length - 1)).slice(0, String(scale).length - 1);
  if (fraction) magnitude += BigInt(fraction);
  if (fractionalDigits.length >= String(scale).length && fractionalDigits[String(scale).length - 1]! >= "5") magnitude += 1n;
  if (magnitude > BigInt(maxAbsoluteValue)) return null;
  const result = Number(magnitude) * (negative ? -1 : 1);
  return Object.is(result, -0) ? 0 : result;
}

function parseProviderQuote(value: unknown, nowUnixMs: number): UsdQuote | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const pair = root["USDBRL"];
  if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return null;
  const item = pair as Record<string, unknown>;
  if (item["code"] !== "USD" || item["codein"] !== "BRL" || typeof item["timestamp"] !== "string" ||
      !/^\d{1,13}$/.test(item["timestamp"])) return null;
  const timestampSeconds = Number(item["timestamp"]);
  const sourceTimestampUnixMs = timestampSeconds * 1000;
  if (!Number.isSafeInteger(sourceTimestampUnixMs) || sourceTimestampUnixMs < MIN_SOURCE_TIMESTAMP_UNIX_MS ||
      sourceTimestampUnixMs > nowUnixMs + MAX_FUTURE_TIMESTAMP_SKEW_MS) return null;

  const priceCents = decimalToScaledInteger(item["bid"], 100, USD_PRICE_CENTS_MAX);
  const changeBasisPoints = decimalToScaledInteger(item["pctChange"], 100, USD_CHANGE_BASIS_POINTS_MAX);
  if (priceCents === null || priceCents <= 0 || changeBasisPoints === null) return null;
  return { priceCents, changeBasisPoints, sourceTimestampUnixMs };
}

async function readProviderBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("The exchange-rate provider returned no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      receivedBytes += result.value.byteLength;
      if (receivedBytes > USD_QUOTE_RESPONSE_LIMIT_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("The exchange-rate response exceeded its size limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class UsdQuoteService {
  private readonly fetchQuote: typeof fetch;
  private readonly unixNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly timers: NonNullable<UsdQuoteServiceOptions["timers"]>;
  private enabled = false;
  private stopped = false;
  private generation = 0;
  private cachedQuote: CachedQuote | null = null;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private retryAfterMs = 0;
  private transientFailure = false;

  constructor(options: UsdQuoteServiceOptions = {}) {
    this.fetchQuote = options.fetch ?? fetch;
    this.unixNow = options.clock?.unixMs ?? Date.now;
    this.monotonicNow = options.clock?.monotonicMs ?? (() => performance.now());
    this.timers = options.timers ?? defaultTimers();
  }

  get view(): UsdQuoteView {
    const validForMs = this.enabled ? this.remainingValidityMs() : 0;
    const quote = validForMs > 0 && this.cachedQuote
      ? { priceCents: this.cachedQuote.priceCents, changeBasisPoints: this.cachedQuote.changeBasisPoints,
          sourceTimestampUnixMs: this.cachedQuote.sourceTimestampUnixMs }
      : null;
    return { enabled: this.enabled, quote, validForMs };
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.stopped || this.enabled === enabled) return enabled ? this.inFlight ?? Promise.resolve() : Promise.resolve();
    this.enabled = enabled;
    this.generation += 1;
    const generation = this.generation;
    this.clearTimer();
    if (!enabled) {
      this.activeController?.abort();
      return Promise.resolve();
    }
    return this.startWhenAvailable(generation);
  }

  deviceState(transportBudgetMs = USD_STATE_TRANSPORT_BUDGET_MS): UsdDeviceState {
    if (!Number.isSafeInteger(transportBudgetMs) || transportBudgetMs < 0) {
      throw new Error("The USD transport budget must be a nonnegative safe integer.");
    }
    if (!this.enabled) return { enabled: false, priceCents: 0, changeBasisPoints: 0, validForMs: 0 };
    const remainingMs = this.remainingValidityMs() - transportBudgetMs;
    if (!this.cachedQuote || remainingMs <= 0) {
      return { enabled: true, priceCents: 0, changeBasisPoints: 0, validForMs: 0 };
    }
    return { enabled: true, priceCents: this.cachedQuote.priceCents,
      changeBasisPoints: this.cachedQuote.changeBasisPoints, validForMs: Math.min(900_000, Math.floor(remainingMs)) };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.enabled = false;
    this.generation += 1;
    this.clearTimer();
    this.activeController?.abort();
  }

  private remainingValidityMs(): number {
    if (!this.cachedQuote) return 0;
    return Math.max(0, Math.floor(Math.min(
      this.cachedQuote.expiresAtUnixMs - this.unixNow(),
      this.cachedQuote.expiresAtMonotonicMs - this.monotonicNow(),
    )));
  }

  private startWhenAvailable(generation: number): Promise<void> {
    const inFlight = this.inFlight;
    if (inFlight) {
      return inFlight.then(() => this.enabled && !this.stopped && this.generation === generation
        ? this.startFetch(generation)
        : undefined);
    }
    return this.startFetch(generation);
  }

  private startFetch(generation: number): Promise<void> {
    if (!this.enabled || this.stopped || generation !== this.generation) return Promise.resolve();
    const controller = new AbortController();
    this.activeController = controller;
    this.transientFailure = false;
    let request!: Promise<void>;
    request = this.fetchAndStore(controller, generation)
      .catch(() => undefined)
      .finally(() => {
        if (this.activeController === controller) this.activeController = null;
        if (this.inFlight === request) this.inFlight = null;
        if (this.enabled && !this.stopped && generation === this.generation) {
          const intervalMs = this.transientFailure && this.remainingValidityMs() <= 0
            ? USD_QUOTE_TRANSIENT_RETRY_MS : USD_QUOTE_POLL_INTERVAL_MS;
          const delayMs = Math.min(Math.max(intervalMs, this.retryAfterMs), MAX_TIMER_DELAY_MS);
          this.retryAfterMs = 0;
          this.timer = this.timers.setTimeout(() => {
            this.timer = null;
            void this.startFetch(generation);
          }, delayMs);
        }
      });
    this.inFlight = request;
    return request;
  }

  private async fetchAndStore(controller: AbortController, generation: number): Promise<void> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(USD_QUOTE_REQUEST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await this.fetchQuote(USD_QUOTE_ENDPOINT, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch {
      this.transientFailure = true;
      return;
    }
    if (response.status !== 200) {
      this.transientFailure = response.status >= 500;
      this.retryAfterMs = response.status === 429
        ? retryAfterDelay(response.headers.get("retry-after"), this.unixNow())
        : 0;
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await readProviderBody(response)) as unknown; }
    catch { return; }
    const quote = parseProviderQuote(parsed, this.unixNow());
    if (!quote || !this.enabled || this.stopped || generation !== this.generation) return;
    if (this.cachedQuote && quote.sourceTimestampUnixMs <= this.cachedQuote.sourceTimestampUnixMs) return;
    const expiresAtUnixMs = quote.sourceTimestampUnixMs + USD_QUOTE_TTL_MS;
    const remainingMs = Math.max(0, expiresAtUnixMs - this.unixNow());
    this.cachedQuote = { ...quote, expiresAtUnixMs,
      expiresAtMonotonicMs: this.monotonicNow() + remainingMs };
    this.retryAfterMs = 0;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
