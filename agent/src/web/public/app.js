const DISPLAY_SIZE = 240;
const ANIMATION_HEADER_BYTES = 11;
const RGB565_FRAME_BYTES = DISPLAY_SIZE * DISPLAY_SIZE * 2;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const modeHelp = {
  auto: "Spotify while playing; GIF otherwise.",
  spotify: "Keeps the Spotify screen active and shows a waiting state when no track is playing.",
  gif: "Keeps the GIF looping across the full display.",
};

const canvas = document.querySelector("#display");
const context = canvas.getContext("2d", { alpha: false });
const toast = document.querySelector("#toast");
let status = null;
let firmwareUpdate = null;
let firmwareStatusPending = false;
let statusPending = false;
let agentOfflineNotified = false;
let otaActionPending = false;
let otaActionError = null;
let mode = "auto";
let animationFrames = [];
let animationSha256 = "";
let currentCoverUrl = "";
let coverImage = null;
let coverLoadId = 0;
let frameIndex = -1;
let frameDeadline = 0;
let previousScene = "";
let toastTimer = 0;

function notify(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3600);
}

async function request(path, options = {}) {
  const { timeoutMs = 15_000, ...fetchOptions } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(path, { cache: "no-store", ...fetchOptions, signal });
    if (!response.ok) {
      let message = `The request failed (${response.status}).`;
      try {
        const body = await response.json();
        if (typeof body.message === "string") message = body.message;
      } catch {}
      throw new Error(message);
    }
    return response;
  } catch (error) {
    if (signal.aborted) throw new Error("The local request timed out. Check the update status before another action.");
    throw error;
  }
}

async function postJson(path, value, timeoutMs = 15_000) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    timeoutMs,
  });
}

function setModeButtons() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  document.querySelector("#mode-help").textContent = modeHelp[mode];
}

async function chooseMode(nextMode) {
  if (!["auto", "spotify", "gif"].includes(nextMode)) return;
  mode = nextMode;
  localStorage.setItem("neonbyte-mode", mode);
  setModeButtons();
  try {
    await postJson("/api/mode", { mode });
    await refreshStatus();
  } catch (error) {
    notify(error.message);
  }
}

function setDemoControls(enabled) {
  const toggle = document.querySelector("#demo-toggle");
  toggle.setAttribute("aria-pressed", String(enabled));
  toggle.querySelector(".sr-only").textContent = enabled ? "Disable demo data" : "Enable demo data";
  document.querySelector("#demo-controls").hidden = !enabled;
}

function updateStatusText() {
  if (!status) return;
  const agentDot = document.querySelector("#agent-dot");
  agentDot.classList.toggle("offline", status.snapshot.status === "unavailable");
  document.querySelector("#agent-label").textContent = status.snapshot.status === "unavailable"
    ? "Spotify unavailable"
    : status.demoEnabled ? "Agent demo mode" : "Local agent active";
  const device = status.device;
  const labels = { disabled: "Device disabled", connecting: "Connecting", connected: "Connected", disconnected: "Disconnected; retrying" };
  document.querySelector("#device-status").textContent = labels[device.connection] ?? "Device unavailable";
  document.querySelector("#device-config-status").textContent = device.paired
    ? "Pairing credentials are stored in the Windows credential manager."
    : "Pairing credentials required. Use the foreground configure-device command.";
  const form = document.querySelector("#device-form");
  if (!form.contains(document.activeElement)) {
    document.querySelector("#device-address").value = device.address;
    document.querySelector("#device-enabled").checked = device.enabled;
  }

  const badge = document.querySelector("#spotify-badge");
  badge.textContent = status.spotifyConnected ? "Connected" : status.spotifyConfigured ? "Waiting for connection" : "Configure .env";
  badge.classList.toggle("connected", status.spotifyConnected);
  document.querySelector("#scene-label").textContent = status.activeScene === "spotify" ? "SPOTIFY NOW PLAYING" : "GIF FULLSCREEN";
  setDemoControls(status.demoEnabled);

  const animation = status.animation;
  const compressionText = animation.compressionPercent >= 0
    ? `${animation.compressionPercent.toFixed(1)}% smaller`
    : `${Math.abs(animation.compressionPercent).toFixed(1)}% larger`;
  document.querySelector("#upload-status").textContent = animation.available
    ? `Original ${formatBytes(animation.originalSizeBytes)} · converted ${formatBytes(animation.sizeBytes)} (${compressionText}) · ${animation.frameCount} frames · ${animation.sha256.slice(0, 12)}…`
    : "No GIF uploaded in this session.";
  const transfer = device.animation;
  if (animation.available && transfer && transfer.state !== "none") {
    const messages = { queued: "Queued for device", uploading: "Uploading to device", retrying: "Device transfer failed; retrying", blocked: "Converted animation does not fit in device storage. Choose fewer frames; the installed GIF is preserved.", complete: "Installed on device" };
    document.querySelector("#upload-status").textContent += ` · ${messages[transfer.state]}${transfer.attempts ? ` (attempt ${transfer.attempts})` : ""}`;
  }
  document.querySelector("#upload-status").classList.toggle("error", transfer?.state === "blocked");
  setOtaMutationLock();
}

function otaMutationLocked() {
  if (!firmwareUpdate) return false;
  return ["ready", "preflight", "pausing", "uploading", "waitingForReboot", "reconnecting", "verifying", "outcomeUnknown", "verificationFailed", "verified"].includes(firmwareUpdate.state) ||
    (firmwareUpdate.putAttempted && !["started", "manuallyReconciled"].includes(firmwareUpdate.state));
}

function setOtaMutationLock() {
  const locked = otaMutationLocked();
  document.querySelectorAll("#device-form input, #device-form button, [data-mode], #demo-toggle, [data-action], #gif-file").forEach((element) => {
    element.disabled = locked;
  });
}

function updateOtaControls() {
  if (!firmwareUpdate) return;
  const state = firmwareUpdate.state;
  const pending = otaActionPending || ["preparing", "preflight", "pausing", "uploading", "reconnecting", "verifying", "reconciling"].includes(state);
  const candidate = firmwareUpdate.candidate;
  document.querySelector("#ota-prepare").disabled = pending || (firmwareUpdate.putAttempted && !["started", "manuallyReconciled"].includes(state));
  const confirm = document.querySelector("#ota-confirm");
  confirm.hidden = state !== "ready" || !candidate;
  confirm.disabled = pending;
  const verify = document.querySelector("#ota-verify");
  verify.hidden = !firmwareUpdate.putAttempted || ["verified", "started", "manuallyReconciled"].includes(state);
  verify.disabled = pending;
  const reconcile = document.querySelector("#ota-reconcile");
  reconcile.hidden = !firmwareUpdate.recoverableAttempt;
  reconcile.disabled = pending;
  document.querySelector("#ota-run").hidden = state !== "verified";
  document.querySelector("#ota-run").disabled = pending;
  document.querySelector("#ota-address-save").disabled = pending;
}

async function refreshFirmwareStatus() {
  if (firmwareStatusPending) return;
  firmwareStatusPending = true;
  try {
    const response = await request("/api/ota/status");
    firmwareUpdate = await response.json();
    const state = firmwareUpdate.state;
    const candidate = firmwareUpdate.candidate;
    const candidateBox = document.querySelector("#ota-candidate");
    candidateBox.hidden = !candidate;
    candidateBox.textContent = candidate
      ? `${candidate.fileName} · ${formatBytes(candidate.byteLength)} · SHA-256 ${candidate.sha256} · build ${candidate.expectedBuildId} · device ${candidate.deviceId}`
      : "";
    document.querySelector("#ota-status").textContent = otaActionError || (state === "uploading"
      ? `${firmwareUpdate.message} ${formatBytes(firmwareUpdate.bytesSent)} of ${formatBytes(firmwareUpdate.totalBytes)} handed to the transport.`
      : firmwareUpdate.message);
    const progress = document.querySelector("#ota-progress");
    progress.hidden = !firmwareUpdate.putAttempted || !["uploading", "waitingForReboot", "reconnecting", "verifying", "outcomeUnknown", "verificationFailed", "verified", "started"].includes(state);
    progress.max = 1;
    progress.value = firmwareUpdate.totalBytes ? Math.min(1, firmwareUpdate.bytesSent / firmwareUpdate.totalBytes) : 0;
    updateOtaControls();
    const addressPanel = document.querySelector("#ota-address-panel");
    addressPanel.hidden = !firmwareUpdate.effectiveAddress || ["started", "manuallyReconciled"].includes(state);
    if (!addressPanel.contains(document.activeElement)) document.querySelector("#ota-address").value = firmwareUpdate.effectiveAddress;
    setOtaMutationLock();
  } catch (error) {
    document.querySelector("#ota-status").textContent = otaActionError || `Dashboard firmware status is unavailable: ${error.message}`;
    updateOtaControls();
  } finally { firmwareStatusPending = false; }
}

function formatBytes(value) {
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshStatus() {
  if (statusPending) return;
  statusPending = true;
  try {
    const response = await request("/api/status");
    status = await response.json();
    if (status.mode !== mode) {
      mode = status.mode;
      localStorage.setItem("neonbyte-mode", mode);
      setModeButtons();
    }
    updateStatusText();
    await refreshFirmwareStatus();
    await refreshAnimation();
    loadCover(status.snapshot.coverUrl);
    agentOfflineNotified = false;
  } catch (error) {
    document.querySelector("#agent-dot").classList.add("offline");
    document.querySelector("#agent-label").textContent = "Local agent unavailable";
    if (status && !agentOfflineNotified) { notify(error.message); agentOfflineNotified = true; }
  } finally { statusPending = false; }
}

async function refreshAnimation() {
  const nextHash = status?.animation?.previewSha256 ?? "";
  if (nextHash === animationSha256) return;
  animationSha256 = nextHash;
  animationFrames = [];
  frameIndex = -1;
  if (!nextHash) return;
  try {
    const response = await request("/api/animation");
    const bytes = await response.arrayBuffer();
    const calculated = await crypto.subtle.digest("SHA-256", bytes);
    const checksum = [...new Uint8Array(calculated)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (checksum !== nextHash) throw new Error("The received GIF checksum does not match. Upload it again.");
    animationFrames = decodeAnimation(bytes);
  } catch (error) {
    animationSha256 = "";
    notify(error.message);
  }
}

function decodeAnimation(bytes) {
  const view = new DataView(bytes);
  const magic = new TextDecoder().decode(new Uint8Array(bytes, 0, 4));
  const version = view.getUint8(4);
  if (magic !== "NBIF") throw new Error("The animation format does not match the 240 × 240 preview.");
  if (version === 2) return decodeAnimationV2(bytes, view);
  if (version !== 1) throw new Error("The animation format does not match the 240 × 240 preview.");
  const width = view.getUint16(5, true);
  const height = view.getUint16(7, true);
  const count = view.getUint16(9, true);
  const frameBytes = width * height * 2;
  if (width !== DISPLAY_SIZE || height !== DISPLAY_SIZE || count < 1 || bytes.byteLength !== ANIMATION_HEADER_BYTES + count * (2 + frameBytes)) {
    throw new Error("The animation format does not match the 240 × 240 preview.");
  }
  const frames = [];
  let offset = ANIMATION_HEADER_BYTES;
  for (let frame = 0; frame < count; frame += 1) {
    const delayMs = view.getUint16(offset, true);
    offset += 2;
    const pixels = new Uint16Array(width * height);
    for (let pixel = 0; pixel < width * height; pixel += 1) pixels[pixel] = view.getUint16(offset + pixel * 2, true);
    frames.push({ image: animationImage(pixels, width, height), delayMs: Math.max(20, delayMs) });
    offset += frameBytes;
  }
  return frames;
}

function animationImage(pixels, width, height) {
  const image = context.createImageData(width, height);
  for (let pixel = 0; pixel < pixels.length; pixel += 1) {
    const color = pixels[pixel];
    const target = pixel * 4;
    image.data[target] = Math.round(((color >> 11) & 31) * 255 / 31);
    image.data[target + 1] = Math.round(((color >> 5) & 63) * 255 / 63);
    image.data[target + 2] = Math.round((color & 31) * 255 / 31);
    image.data[target + 3] = 255;
  }
  return image;
}

function decodeAnimationV2(bytes, view) {
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const frameCount = view.getUint16(10, true);
  const durationMs = view.getUint32(12, true);
  const fileBytes = view.getUint32(16, true);
  if (view.getUint8(5) !== 0 || view.getUint32(20, true) !== 0 || width !== DISPLAY_SIZE || height !== DISPLAY_SIZE ||
      frameCount < 1 || frameCount > 60 || fileBytes > 2359296 || fileBytes !== bytes.byteLength ||
      bytes.byteLength < 24 + frameCount * 20 || durationMs > 30000) {
    throw new Error("The NBIF v2 animation header is invalid.");
  }
  let recordOffset = 24 + frameCount * 20;
  let summedDuration = 0;
  const entries = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = 24 + frame * 20;
    const entry = {
      recordOffset: view.getUint32(offset, true),
      recordBytes: view.getUint32(offset + 4, true),
      delayMs: view.getUint16(offset + 8, true),
      kind: view.getUint8(offset + 10),
      indexBits: view.getUint8(offset + 11),
      paletteCount: view.getUint16(offset + 12, true),
      rowCount: view.getUint16(offset + 14, true),
    };
    if (view.getUint32(offset + 16, true) !== 0 || entry.recordOffset !== recordOffset ||
        entry.recordOffset > fileBytes || entry.recordBytes > fileBytes - entry.recordOffset ||
        entry.delayMs < 20 || entry.kind > 2 || (frame === 0 && entry.kind !== 0)) {
      throw new Error("The NBIF v2 frame directory is invalid.");
    }
    if (entry.kind === 2) {
      if (entry.recordBytes !== 0 || entry.rowCount !== 0 || entry.paletteCount !== 0 || entry.indexBits !== 0) {
        throw new Error("The NBIF v2 hold frame is invalid.");
      }
    } else if (entry.rowCount < 1 || entry.rowCount > height || entry.paletteCount > 256 ||
        (entry.paletteCount === 0 && entry.indexBits !== 0) ||
        (entry.paletteCount > 0 && entry.indexBits !== (entry.paletteCount <= 2 ? 1 : entry.paletteCount <= 4 ? 2 : entry.paletteCount <= 16 ? 4 : 8)) ||
        entry.recordBytes < entry.paletteCount * 2 + entry.rowCount * 6 ||
        (entry.kind === 0 && entry.rowCount !== height)) {
      throw new Error("The NBIF v2 frame directory is invalid.");
    }
    recordOffset += entry.recordBytes;
    summedDuration += entry.delayMs;
    entries.push(entry);
  }
  if (recordOffset !== fileBytes || summedDuration !== durationMs) throw new Error("The NBIF v2 animation length or duration is invalid.");

  const frames = [];
  let previousPixels = null;
  for (const entry of entries) {
    let pixels;
    if (entry.kind === 2) {
      if (!previousPixels) throw new Error("The NBIF v2 animation starts without a keyframe.");
      pixels = new Uint16Array(previousPixels);
    } else {
      const palette = [];
      const paletteSet = new Set();
      let cursor = entry.recordOffset;
      for (let index = 0; index < entry.paletteCount; index += 1) {
        const color = view.getUint16(cursor + index * 2, true);
        if (paletteSet.has(color)) throw new Error("The NBIF v2 palette contains duplicate colors.");
        paletteSet.add(color);
        palette.push(color);
      }
      cursor += entry.paletteCount * 2;
      if (entry.kind === 0) pixels = new Uint16Array(width * height);
      else {
        if (!previousPixels) throw new Error("The NBIF v2 animation starts without a keyframe.");
        pixels = new Uint16Array(previousPixels);
      }
      let previousY = -1;
      for (let rowIndex = 0; rowIndex < entry.rowCount; rowIndex += 1) {
        const recordEnd = entry.recordOffset + entry.recordBytes;
        if (cursor + 6 > recordEnd) throw new Error("The NBIF v2 row header is truncated.");
        const y = view.getUint8(cursor);
        const x = view.getUint8(cursor + 1);
        const spanWidth = view.getUint8(cursor + 2);
        const codec = view.getUint8(cursor + 3);
        const encodedBytes = view.getUint16(cursor + 4, true);
        cursor += 6;
        if (y >= height || y <= previousY || spanWidth < 1 || spanWidth > width || x + spanWidth > width ||
            encodedBytes > 480 || cursor + encodedBytes > recordEnd ||
            (entry.kind === 0 && (x !== 0 || spanWidth !== width || y !== rowIndex))) {
          throw new Error("The NBIF v2 row bounds are invalid.");
        }
        const values = decodeAnimationRow(view, cursor, cursor + encodedBytes, spanWidth, codec, palette, entry.indexBits);
        pixels.set(values, y * width + x);
        cursor += encodedBytes;
        previousY = y;
      }
      if (cursor !== entry.recordOffset + entry.recordBytes) throw new Error("The NBIF v2 frame record has trailing data.");
    }
    previousPixels = pixels;
    frames.push({ image: animationImage(pixels, width, height), delayMs: entry.delayMs });
  }
  return frames;
}

function decodeAnimationRow(view, start, end, width, codec, palette, indexBits) {
  const pixels = new Uint16Array(width);
  if (codec === 0) {
    if (end - start !== width * 2) throw new Error("The NBIF v2 raw row length is invalid.");
    for (let index = 0; index < width; index += 1) pixels[index] = view.getUint16(start + index * 2, true);
    return pixels;
  }
  if (codec === 2) {
    if (palette.length === 0 || indexBits === 0 || end - start !== Math.ceil(width * indexBits / 8)) {
      throw new Error("The NBIF v2 packed row length is invalid.");
    }
    let bitOffset = 0;
    for (let index = 0; index < width; index += 1) {
      let paletteIndex = 0;
      for (let bit = 0; bit < indexBits; bit += 1) {
        paletteIndex = (paletteIndex << 1) | ((view.getUint8(start + (bitOffset >> 3)) >> (7 - (bitOffset & 7))) & 1);
        bitOffset += 1;
      }
      if (paletteIndex >= palette.length) throw new Error("The NBIF v2 row uses an invalid palette index.");
      pixels[index] = palette[paletteIndex];
    }
    const paddingBits = (end - start) * 8 - width * indexBits;
    if (paddingBits && (view.getUint8(end - 1) & ((1 << paddingBits) - 1))) throw new Error("The NBIF v2 packed row padding is invalid.");
    return pixels;
  }
  if (codec !== 1 && codec !== 3) throw new Error("The NBIF v2 row codec is unsupported.");
  const indexed = codec === 3;
  if (indexed && palette.length === 0) throw new Error("The NBIF v2 indexed row has no palette.");
  let input = start;
  let output = 0;
  while (input < end) {
    const control = view.getUint8(input++);
    const count = (control & 0x7f) + 1;
    if (output + count > width) throw new Error("The NBIF v2 run exceeds its row span.");
    if (control & 0x80) {
      const valueBytes = indexed ? 1 : 2;
      if (input + valueBytes > end) throw new Error("The NBIF v2 repeated run is truncated.");
      const value = indexed ? view.getUint8(input) : view.getUint16(input, true);
      input += valueBytes;
      const color = indexed ? palette[value] : value;
      if (color === undefined) throw new Error("The NBIF v2 row uses an invalid palette index.");
      pixels.fill(color, output, output + count);
      output += count;
    } else {
      const valueBytes = indexed ? 1 : 2;
      if (input + count * valueBytes > end) throw new Error("The NBIF v2 literal run is truncated.");
      for (let item = 0; item < count; item += 1) {
        const value = indexed ? view.getUint8(input) : view.getUint16(input, true);
        input += valueBytes;
        const color = indexed ? palette[value] : value;
        if (color === undefined) throw new Error("The NBIF v2 row uses an invalid palette index.");
        pixels[output++] = color;
      }
    }
  }
  if (output !== width) throw new Error("The NBIF v2 row does not fill its span.");
  return pixels;
}

function loadCover(url) {
  if (url === currentCoverUrl) return;
  currentCoverUrl = url ?? "";
  coverImage = null;
  const requestId = ++coverLoadId;
  if (!currentCoverUrl) return;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    if (requestId !== coverLoadId) return;
    coverImage = image;
    convertCover(image).catch((error) => {
      if (requestId === coverLoadId) notify(`The cover could not be prepared: ${error.message}`);
    });
  };
  image.onerror = () => {
    if (requestId === coverLoadId) {
      coverImage = null;
      notify("Unable to load the Spotify cover; the title and artist remain available.");
    }
  };
  image.src = currentCoverUrl.startsWith("/") ? currentCoverUrl : "/api/cover/source";
}

async function convertCover(image) {
  const temporary = document.createElement("canvas");
  temporary.width = DISPLAY_SIZE;
  temporary.height = DISPLAY_SIZE;
  const coverContext = temporary.getContext("2d", { willReadFrequently: true });
  drawCover(coverContext, image, 0, 0, DISPLAY_SIZE, DISPLAY_SIZE);
  const pixels = coverContext.getImageData(0, 0, DISPLAY_SIZE, DISPLAY_SIZE).data;
  await request("/api/cover", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.neonbyte.rgba; width=240; height=240" },
    body: pixels.buffer,
  });
}

function drawCover(target, image, x, y, width, height) {
  const sourceScale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / sourceScale;
  const sourceHeight = height / sourceScale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  target.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawWaiting(now) {
  const gradient = context.createLinearGradient(0, 0, 240, 240);
  gradient.addColorStop(0, "#1c1529");
  gradient.addColorStop(1, "#071c21");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 240, 240);
  context.fillStyle = "rgba(182,140,255,.12)";
  context.beginPath();
  context.arc(120, 91, 47, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgba(199,255,235,.78)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(120, 91, 31, now / 2000, now / 2000 + Math.PI * 1.55);
  context.stroke();
  context.fillStyle = "#f5f1ff";
  context.textAlign = "center";
  context.font = "600 13px system-ui, sans-serif";
  context.fillText(status?.snapshot.status === "idle" ? "No active track" : "Waiting for Spotify", 120, 166);
  context.fillStyle = "#9b98aa";
  context.font = "9px system-ui, sans-serif";
  context.fillText("Connect Spotify or enable demo data", 120, 183);
}

const SPOTIFY_TITLE_Y = 190;
const SPOTIFY_ARTIST_Y = 211;
const SPOTIFY_LINE_HEIGHT = 20;
const SPOTIFY_TEXT_X = 8;
const SPOTIFY_TEXT_VIEWPORT_WIDTH = 224;
const SPOTIFY_TEXT_GAP = 24;
const SPOTIFY_MARQUEE_START_DELAY_MS = 1500;
const SPOTIFY_MARQUEE_INTERVAL_MS = 125;
const SPOTIFY_MARQUEE_STEP_PIXELS = 3;
const SPOTIFY_TITLE_FONT = "600 16px system-ui, sans-serif";
const SPOTIFY_ARTIST_FONT = "16px system-ui, sans-serif";

function createSpotifyMarquee() {
  return { text: "", width: 0, offset: 0, phaseStartedAt: 0, lastStepAt: 0, scrolls: false, scrolling: false };
}

let spotifyTitleMarquee = createSpotifyMarquee();
let spotifyArtistMarquee = createSpotifyMarquee();
let spotifySceneActive = false;
let previousSpotifyTrackId = "";
let previousSpotifyTitle = "";
let previousSpotifyArtist = "";
let previousSpotifyCoverLoadId = -1;
let previousSpotifyCoverPresent = false;

function resetSpotifyMarquee(marquee, value, font, now) {
  marquee.text = String(value ?? "");
  context.font = font;
  marquee.width = context.measureText(marquee.text).width;
  marquee.offset = 0;
  marquee.phaseStartedAt = now;
  marquee.lastStepAt = now;
  marquee.scrolls = marquee.width > SPOTIFY_TEXT_VIEWPORT_WIDTH;
  marquee.scrolling = false;
}

function drawSpotifyMarquee(marquee, y, color, font, clear) {
  context.save();
  context.beginPath();
  context.rect(0, y, 240, SPOTIFY_LINE_HEIGHT);
  context.clip();
  if (clear) {
    context.fillStyle = "#000000";
    context.fillRect(0, y, 240, SPOTIFY_LINE_HEIGHT);
  }
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = color;
  context.font = font;
  const x = SPOTIFY_TEXT_X - marquee.offset;
  if (marquee.text && x < 240 && x + marquee.width > 0) context.fillText(marquee.text, x, y);
  const repeatedX = x + marquee.width + SPOTIFY_TEXT_GAP;
  if (marquee.scrolls && repeatedX < 240 && repeatedX + marquee.width > 0) {
    context.fillText(marquee.text, repeatedX, y);
  }
  context.restore();
}

function advanceSpotifyMarquee(marquee, y, color, font, now) {
  if (!marquee.scrolls) return;
  if (!marquee.scrolling) {
    if (now - marquee.phaseStartedAt < SPOTIFY_MARQUEE_START_DELAY_MS) return;
    marquee.scrolling = true;
    marquee.lastStepAt = now;
    return;
  }
  const elapsed = now - marquee.lastStepAt;
  if (elapsed < SPOTIFY_MARQUEE_INTERVAL_MS) return;
  const steps = Math.floor(elapsed / SPOTIFY_MARQUEE_INTERVAL_MS);
  marquee.lastStepAt += steps * SPOTIFY_MARQUEE_INTERVAL_MS;
  const nextOffset = marquee.offset + steps * SPOTIFY_MARQUEE_STEP_PIXELS;
  if (nextOffset >= marquee.width + SPOTIFY_TEXT_GAP) {
    marquee.offset = 0;
    marquee.scrolling = false;
    marquee.phaseStartedAt = now;
  } else {
    marquee.offset = nextOffset;
  }
  drawSpotifyMarquee(marquee, y, color, font, true);
}

function drawSpotify(now) {
  const track = status?.snapshot.nowPlaying;
  if (!track || status.snapshot.status !== "playing") {
    spotifySceneActive = false;
    drawWaiting(now);
    return;
  }
  const trackId = String(track.trackId ?? "");
  const title = String(track.title ?? "");
  const artist = String(track.artist ?? "");
  const trackChanged = !spotifySceneActive || trackId !== previousSpotifyTrackId;
  const titleChanged = trackChanged || title !== previousSpotifyTitle;
  const artistChanged = trackChanged || artist !== previousSpotifyArtist;
  const coverChanged = coverLoadId !== previousSpotifyCoverLoadId || Boolean(coverImage) !== previousSpotifyCoverPresent;

  if (trackChanged) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, 240, 240);
    if (coverImage) drawCover(context, coverImage, 32, 4, 176, 176);
  } else if (coverChanged) {
    if (coverImage) drawCover(context, coverImage, 32, 4, 176, 176);
    else {
      context.fillStyle = "#000000";
      context.fillRect(32, 4, 176, 176);
    }
  }
  if (titleChanged) {
    resetSpotifyMarquee(spotifyTitleMarquee, title, SPOTIFY_TITLE_FONT, now);
    drawSpotifyMarquee(spotifyTitleMarquee, SPOTIFY_TITLE_Y, "#ffffff", SPOTIFY_TITLE_FONT, !trackChanged);
  }
  if (artistChanged) {
    resetSpotifyMarquee(spotifyArtistMarquee, artist, SPOTIFY_ARTIST_FONT, now);
    drawSpotifyMarquee(spotifyArtistMarquee, SPOTIFY_ARTIST_Y, "#9c9e9c", SPOTIFY_ARTIST_FONT, !trackChanged);
  }
  previousSpotifyTrackId = trackId;
  previousSpotifyTitle = title;
  previousSpotifyArtist = artist;
  previousSpotifyCoverLoadId = coverLoadId;
  previousSpotifyCoverPresent = Boolean(coverImage);
  spotifySceneActive = true;

  advanceSpotifyMarquee(spotifyTitleMarquee, SPOTIFY_TITLE_Y, "#ffffff", SPOTIFY_TITLE_FONT, now);
  advanceSpotifyMarquee(spotifyArtistMarquee, SPOTIFY_ARTIST_Y, "#9c9e9c", SPOTIFY_ARTIST_FONT, now);
}

function drawGif(now) {
  if (animationFrames.length === 0) {
    context.fillStyle = "#080c12";
    context.fillRect(0, 0, 240, 240);
    const gradient = context.createRadialGradient(120, 110, 4, 120, 120, 150);
    gradient.addColorStop(0, "rgba(164,111,238,.24)");
    gradient.addColorStop(1, "rgba(8,12,18,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 240, 240);
    context.fillStyle = "#c6c0d1";
    context.textAlign = "center";
    context.font = "600 12px system-ui, sans-serif";
    context.fillText("Upload a GIF to get started", 120, 117);
    context.fillStyle = "#807a8b";
    context.font = "9px system-ui, sans-serif";
    context.fillText("The animation will fill the entire display", 120, 136);
    return;
  }
  if (frameIndex < 0 || now >= frameDeadline) {
    frameIndex = (frameIndex + 1) % animationFrames.length;
    const frame = animationFrames[frameIndex];
    context.putImageData(frame.image, 0, 0);
    frameDeadline = now + frame.delayMs;
  }
}

function render(now) {
  const scene = status?.activeScene ?? "gif";
  if (scene !== previousScene) {
    previousScene = scene;
    if (scene !== "spotify") spotifySceneActive = false;
    frameIndex = -1;
    frameDeadline = 0;
  }
  if (scene === "spotify") drawSpotify(now);
  else drawGif(now);
  window.requestAnimationFrame(render);
}

async function toggleDemo() {
  const enabled = !status?.demoEnabled;
  try {
    await postJson("/api/demo", { enabled });
    await refreshStatus();
    notify(enabled ? "Demo data enabled." : "Demo data disabled.");
  } catch (error) {
    notify(error.message);
  }
}

async function mockAction(action) {
  try {
    await postJson("/api/mock/playback", { action });
    document.querySelector("#demo-message").textContent = action === "offline" ? "Mock agent offline" : "Mock playback updated";
    await refreshStatus();
  } catch (error) {
    notify(error.message);
  }
}

async function connectSpotify() {
  const button = document.querySelector("#connect-spotify");
  button.disabled = true;
  try {
    const response = await postJson("/api/auth/connect", {});
    const { url } = await response.json();
    window.location.assign(url);
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

async function uploadGif(file) {
  const label = document.querySelector("#upload-status");
  if (!file) return;
  if (file.size > MAX_GIF_BYTES) {
    label.textContent = "The original GIF exceeds the Windows agent's 8 MB (8 MiB) input limit. Choose a smaller original file.";
    label.classList.add("error");
    return;
  }
  label.textContent = "Validating and preparing the preview…";
  label.classList.remove("error");
  try {
    const response = await request("/api/animation", {
      method: "POST",
      headers: { "Content-Type": "image/gif" },
      body: file,
      timeoutMs: 120_000,
    });
    const result = await response.json();
    await refreshStatus();
    await chooseMode("gif");
    notify(`GIF ready: ${result.frameCount} frames at 240 × 240.`);
  } catch (error) {
    label.textContent = error.message;
    label.classList.add("error");
  }
}

document.querySelector("#device-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await postJson("/api/device", {
      address: document.querySelector("#device-address").value,
      enabled: document.querySelector("#device-enabled").checked,
    });
    await refreshStatus();
    notify("Device settings saved.");
  } catch (error) { notify(error.message); }
});

async function runOtaAction(action) {
  if (otaActionPending) return false;
  otaActionPending = true;
  otaActionError = null;
  document.querySelectorAll("#ota-prepare, #ota-confirm, #ota-verify, #ota-reconcile, #ota-address-save, #ota-run")
    .forEach((button) => { button.disabled = true; });
  try {
    await action();
    return true;
  } catch (error) {
    otaActionError = error.message;
    notify(error.message);
    return false;
  } finally {
    otaActionPending = false;
    updateOtaControls();
    await refreshFirmwareStatus();
    if (otaActionError) document.querySelector("#ota-status").textContent = otaActionError;
  }
}

document.querySelector("#ota-prepare").addEventListener("click", async () => {
  await runOtaAction(() => request("/api/ota/prepare", { method: "POST", timeoutMs: 30_000 }));
});

document.querySelector("#ota-confirm").addEventListener("click", async () => {
  if (otaActionPending) return;
  const candidate = firmwareUpdate?.candidate;
  if (!candidate) return;
  const accepted = window.confirm(`Install build ${candidate.expectedBuildId} (${formatBytes(candidate.byteLength)}, SHA-256 ${candidate.sha256}) on device ${candidate.deviceId}? The application will pause and the image will be sent once.`);
  if (!accepted) return;
  await runOtaAction(() => postJson("/api/ota/confirm", { candidateId: candidate.id }, 150_000));
});

document.querySelector("#ota-verify").addEventListener("click", async () => {
  document.querySelector("#ota-status").textContent = "Reconnecting and checking the device for up to two minutes…";
  await runOtaAction(() => request("/api/ota/verify", { method: "POST", timeoutMs: 140_000 }));
});

document.querySelector("#ota-reconcile").addEventListener("click", async () => {
  if (otaActionPending) return;
  const attempt = firmwareUpdate?.recoverableAttempt;
  if (!attempt) return;
  const accepted = window.confirm(`Reconcile running build ${attempt.expectedBuildId} on device ${attempt.deviceId}? Two authenticated observations will be required. This does not verify the previous OTA or send firmware.`);
  if (!accepted) return;
  await runOtaAction(() => postJson("/api/ota/reconcile", { expectedBuildId: attempt.expectedBuildId, confirmed: true }, 40_000));
});

document.querySelector("#ota-address-save").addEventListener("click", async () => {
  if (await runOtaAction(() => postJson("/api/ota/address", { address: document.querySelector("#ota-address").value }, 30_000))) {
    notify("The maintenance address was verified and saved.");
  }
});

document.querySelector("#ota-run").addEventListener("click", async () => {
  if (otaActionPending) return;
  if (!window.confirm("Start the verified application now?")) return;
  await runOtaAction(() => request("/api/ota/run", { method: "POST", timeoutMs: 30_000 }));
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => void chooseMode(button.dataset.mode));
});
document.querySelector("#connect-spotify").addEventListener("click", () => void connectSpotify());
document.querySelector("#demo-toggle").addEventListener("click", () => void toggleDemo());
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => void mockAction(button.dataset.action));
});
document.querySelector("#gif-file").addEventListener("change", (event) => {
  void uploadGif(event.target.files?.[0]);
  event.target.value = "";
});

const connected = new URLSearchParams(window.location.search).get("connected");
const oauthError = new URLSearchParams(window.location.search).get("error");
if (connected) notify("Spotify connected. Playback status will update here.");
if (oauthError) notify("Spotify authorization was not completed. Check the configuration and try again.");
if (connected || oauthError) window.history.replaceState({}, "", "/");

async function initialize() {
  const savedMode = localStorage.getItem("neonbyte-mode");
  try {
    const response = await request("/api/status");
    status = await response.json();
    mode = ["auto", "spotify", "gif"].includes(savedMode) ? savedMode : status.mode;
    localStorage.setItem("neonbyte-mode", mode);
    setModeButtons();
    if (mode !== status.mode) await postJson("/api/mode", { mode });
    await refreshStatus();
  } catch (error) {
    document.querySelector("#agent-dot").classList.add("offline");
    document.querySelector("#agent-label").textContent = "Local agent unavailable";
    notify(error.message);
  }
}

void initialize();
window.setInterval(() => void refreshStatus(), 1000);
window.requestAnimationFrame(render);
