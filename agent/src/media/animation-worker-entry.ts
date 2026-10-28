import { parentPort } from "node:worker_threads";
import { convertGifToAnimationV2 } from "./animation.js";

if (!parentPort) throw new Error("Animation conversion worker requires a parent thread.");

parentPort.once("message", (message: { input?: Uint8Array }) => {
  try {
    if (!(message.input instanceof Uint8Array)) throw new Error("The GIF input is invalid.");
    const asset = convertGifToAnimationV2(message.input);
    parentPort!.postMessage({
      type: "success",
      asset: { ...asset, bytes: asset.bytes },
    }, [asset.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid or unsupported GIF.";
    parentPort!.postMessage({ type: "failure", message });
  }
});
