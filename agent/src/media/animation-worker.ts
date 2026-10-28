import { Worker } from "node:worker_threads";
import type { AnimationAsset } from "./animation.js";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const CONVERSION_DEADLINE_MS = 10_000;

interface WorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Job {
  input: Uint8Array;
  resolve(value: AnimationAsset): void;
  reject(error: Error): void;
  signal: AbortSignal | undefined;
  timer: NodeJS.Timeout;
  worker: Worker | undefined;
  settled: boolean;
  abortListener?: () => void;
}

let active: Job | null = null;
let pending: Job | null = null;

function settle(job: Job, error?: Error, asset?: AnimationAsset): void {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  if (job.abortListener) job.signal?.removeEventListener("abort", job.abortListener);
  if (active === job) active = null;
  if (pending === job) pending = null;
  if (error) job.reject(error);
  else job.resolve(asset!);
  const worker = job.worker;
  job.worker = undefined;
  void worker?.terminate().finally(startNext);
  if (!worker) startNext();
}

function startNext(): void {
  if (active || !pending) return;
  const job = pending;
  pending = null;
  if (job.settled) return startNext();
  if (job.signal?.aborted) {
    settle(job, new Error("Animation conversion was cancelled."));
    return;
  }
  active = job;
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workerUrl = new URL(`./animation-worker-entry.${extension}`, import.meta.url);
  const worker = new Worker(extension === "ts"
    ? `import("tsx/esm/api").then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`
    : workerUrl, {
    ...(extension === "ts" ? { eval: true } : {}),
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  job.worker = worker;
  worker.once("message", (message: { type?: string; message?: string; asset?: Omit<AnimationAsset, "bytes"> & { bytes: Uint8Array } }) => {
    if (message.type === "success" && message.asset?.bytes instanceof Uint8Array) {
      settle(job, undefined, { ...message.asset, bytes: Buffer.from(message.asset.bytes) });
    } else {
      settle(job, new Error(typeof message.message === "string" ? message.message : "Invalid or unsupported GIF."));
    }
  });
  worker.once("error", () => settle(job, new Error("Animation conversion worker failed.")));
  worker.once("exit", (code) => {
    if (!job.settled && code !== 0) settle(job, new Error("Animation conversion worker stopped unexpectedly."));
  });
  const input = job.input;
  worker.postMessage({ input }, [input.buffer as ArrayBuffer]);
}

export function convertGifToAnimationV2InWorker(input: Uint8Array, options: WorkerOptions = {}): Promise<AnimationAsset> {
  if (input.byteLength > MAX_UPLOAD_BYTES) return Promise.reject(new Error(`The GIF exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`));
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    return Promise.reject(new Error("The animation conversion deadline must be a positive number of milliseconds."));
  }
  if (options.signal?.aborted) return Promise.reject(new Error("Animation conversion was cancelled."));
  if (active && pending) return Promise.reject(new Error("Animation conversion is busy; one request is already pending."));

  return new Promise<AnimationAsset>((resolve, reject) => {
    const job: Job = {
      input: new Uint8Array(input),
      resolve,
      reject,
      signal: options.signal,
      worker: undefined,
      timer: setTimeout(() => settle(job, new Error("Animation conversion exceeded its deadline (10-second limit).")),
        options.timeoutMs ?? CONVERSION_DEADLINE_MS),
      settled: false,
    };
    job.abortListener = () => settle(job, new Error("Animation conversion was cancelled."));
    options.signal?.addEventListener("abort", job.abortListener, { once: true });
    if (active) pending = job;
    else {
      pending = job;
      startNext();
    }
  });
}
