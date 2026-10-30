const DISPLAY_SIZE = 240;
const ANIMATION_HEADER_BYTES = 11;
const RGB565_FRAME_BYTES = DISPLAY_SIZE * DISPLAY_SIZE * 2;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const modeHelp = {
  auto: "Spotify while playing; GIF otherwise.",
  spotify: "Keeps the Spotify screen active and shows a waiting state when no track is playing.",
  gif: "Keeps the GIF looping across the full display.",
};
const spotifyStateLabels = {
  unconfigured: "Not configured",
  checking: "Checking",
  authentication_required: "Reconnect required",
  rate_limited: "Rate limited",
  offline: "Offline · retrying",
  api_error: "Unavailable",
  stale: "Status delayed",
  connected: "Connected",
};

const canvas = document.querySelector("#display");
const context = canvas.getContext("2d", { alpha: false });
const toast = document.querySelector("#toast");
let status = null;
let firmwareUpdate = null;
let firmwareStatusPending = false;
let statusPending = false;
let agentOfflineNotified = false;
let localAgentAvailable = false;
let otaActionPending = false;
let otaActionError = null;
let mode = "auto";
let modePending = false;
let preparedGifPreview = false;
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
    button.disabled = modePending || otaMutationLocked();
  });
  document.querySelector("#mode-help").textContent = modeHelp[mode];
  if (modePending) {
    document.querySelector("#mode-sync").textContent = "Applying your selection to the device…";
  } else {
    const message = status?.modeControl?.message ?? "Mode status is unavailable.";
    const deviceMode = status?.device?.mode;
    const reportLabel = status?.device?.connection === "connected" ? "Device" : "Last device report";
    document.querySelector("#mode-sync").textContent = deviceMode
      ? `${reportLabel}: ${deviceMode.toUpperCase()} · selected: ${mode.toUpperCase()}. ${message}` : message;
  }
}

async function chooseMode(nextMode) {
  if (!["auto", "spotify", "gif"].includes(nextMode) || nextMode === mode || modePending || otaMutationLocked()) return;
  modePending = true;
  setModeButtons();
  try {
    await postJson("/api/mode", { mode: nextMode });
    mode = nextMode;
    preparedGifPreview = false;
    await refreshStatus();
  } catch (error) {
    notify(error.message);
  } finally {
    modePending = false;
    setModeButtons();
  }
}

function updateLamp(element, state) {
  element.classList.toggle("connected", state === "connected");
  element.classList.toggle("waiting", state === "waiting");
  element.classList.toggle("offline", state === "offline");
}

function updateStatusText() {
  const agentDot = document.querySelector("#agent-dot");
  agentDot.classList.toggle("offline", !localAgentAvailable);
  document.querySelector("#agent-label").textContent = localAgentAvailable ? "Local agent active" : "Local agent unavailable";
  document.querySelector("#agent-lamp").classList.toggle("connected", localAgentAvailable);
  document.querySelector("#agent-lamp").classList.toggle("offline", !localAgentAvailable);
  document.querySelector("#agent-summary").textContent = localAgentAvailable ? "Running" : "Unavailable";
  if (!status) return;

  const device = status.device;
  const deviceLabels = { disabled: "Disabled", connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected · retrying" };
  document.querySelector("#device-status").textContent = deviceLabels[device.connection] ?? "Unavailable";
  updateLamp(document.querySelector("#device-lamp"), device.connection === "connected" ? "connected" : device.connection === "connecting" ? "waiting" : "offline");
  document.querySelector("#device-config-status").textContent = device.paired
    ? "Pairing credentials are stored in the Windows credential manager."
    : "Pairing credentials required. Use the foreground configure-device command.";
  const form = document.querySelector("#device-form");
  if (!form.contains(document.activeElement)) {
    document.querySelector("#device-address").value = device.address;
    document.querySelector("#device-enabled").checked = device.enabled;
  }

  const spotifyState = status.spotifyState ?? "api_error";
  const badge = document.querySelector("#spotify-badge");
  badge.textContent = spotifyStateLabels[spotifyState] ?? "Unavailable";
  updateLamp(document.querySelector("#spotify-lamp"), spotifyState === "connected" ? "connected" : spotifyState === "checking" ? "waiting" : "offline");
  const spotifyDetail = {
    unconfigured: "Spotify is not configured for this agent. Add its app settings to enable account connection.",
    checking: "Checking the latest playback state…",
    authentication_required: "Spotify authorization is missing or expired. Reconnect the account to resume playback updates.",
    rate_limited: "Spotify has limited requests. The agent will retry after the allowed wait.",
    offline: "Spotify could not be reached. The agent will retry without changing the selected display mode.",
    api_error: "Spotify playback is unavailable. Check the account and local connection.",
    stale: "The last Spotify update is old. Waiting for a fresh response.",
    connected: status.snapshot.status === "playing" ? "Spotify is connected and playback is active."
      : status.snapshot.status === "paused" ? "Spotify is connected and playback is paused."
        : "Spotify is connected. No track is currently playing.",
  };
  document.querySelector("#spotify-detail").textContent = spotifyDetail[spotifyState] ?? "Spotify playback is unavailable.";
  document.querySelector("#connect-spotify").disabled = !status.spotifyConfigured || Boolean(status.spotifyAuthorizing) || otaMutationLocked();
  document.querySelector("#connect-spotify").textContent = status.spotifyAuthorizing ? "Waiting for Spotify authorization…"
    : spotifyState === "unconfigured" ? "Configure Spotify first" : spotifyState === "connected" ? "Reconnect Spotify" : "Connect Spotify";
  const scene = preparedGifPreview && status.animation.available ? "local-gif-preview" : status.activeScene;
  document.querySelector("#scene-label").textContent = scene === "local-gif-preview" ? "LOCAL GIF PREVIEW"
    : scene === "spotify" ? "SPOTIFY DISPLAY" : scene === "gif" ? "GIF DISPLAY" : "WAITING FOR MODE";
  const track = spotifyState === "connected" ? status.snapshot.nowPlaying : null;
  document.querySelector("#playback-state").textContent = spotifyState !== "connected" ? "SPOTIFY STATUS"
    : status.snapshot.status === "playing" ? "NOW PLAYING" : status.snapshot.status === "paused" ? "PAUSED" : "PLAYBACK";
  document.querySelector("#now-playing-title").textContent = track?.title ?? (spotifyState === "connected" ? "No active track" : badge.textContent);
  document.querySelector("#now-playing-artist").textContent = track?.artist ?? (spotifyState === "connected" ? "Play a track to see its title and artist." : spotifyDetail[spotifyState]);
  setModeButtons();

  const animation = status.animation;
  const compressionText = animation.compressionPercent >= 0
    ? `${animation.compressionPercent.toFixed(1)}% smaller`
    : `${Math.abs(animation.compressionPercent).toFixed(1)}% larger`;
  document.querySelector("#upload-status").textContent = animation.available
    ? `${animation.width} × ${animation.height} px · ${animation.frameCount} frames · ${animation.durationMs} ms · ${formatBytes(animation.sizeBytes)} converted (${compressionText}) · SHA-256 ${animation.sha256.slice(0, 12)}…`
    : "No GIF is prepared for this session.";
  const transfer = device.animation;
  if (animation.available && transfer && transfer.state !== "none") {
    document.querySelector("#upload-status").textContent += ` · ${transfer.message}${transfer.freeStorageBytes === null ? "" : ` Device reported ${formatBytes(transfer.freeStorageBytes)} free after removal.`}`;
  }
  const activeTransfer = transfer && ["removing", "uploading", "validating"].includes(transfer.state);
  const previewButton = document.querySelector("#preview-animation");
  previewButton.hidden = !animation.available;
  previewButton.textContent = preparedGifPreview ? "Return to device mode preview" : "Preview prepared GIF here";
  previewButton.setAttribute("aria-pressed", String(preparedGifPreview));
  previewButton.disabled = otaMutationLocked() || Boolean(activeTransfer);
  document.querySelector("#prepared-gif-note").hidden = !preparedGifPreview;
  const replace = document.querySelector("#replace-animation");
  replace.hidden = !animation.available || activeTransfer || transfer?.state === "complete";
  replace.textContent = transfer?.previousAnimation === "removed" || transfer?.previousAnimation === "unknown"
    ? `Send converted animation again · ${formatBytes(animation.sizeBytes)}` : `Replace current animation · ${formatBytes(animation.sizeBytes)}`;
  replace.disabled = !device.enabled || !device.paired;
  const cancel = document.querySelector("#cancel-animation");
  cancel.hidden = !activeTransfer;
  document.querySelector("#gif-file").disabled = Boolean(activeTransfer);
  document.querySelector("#upload-status").classList.toggle("error", transfer?.state === "failed" || transfer?.state === "cancelled");
  setOtaMutationLock();
}

function otaMutationLocked() {
  if (!firmwareUpdate) return false;
  return ["ready", "preflight", "pausing", "uploading", "waitingForReboot", "reconnecting", "verifying", "outcomeUnknown", "verificationFailed", "verified", "experimentallyVerified"].includes(firmwareUpdate.state) ||
    (firmwareUpdate.putAttempted && !["started", "manuallyReconciled"].includes(firmwareUpdate.state));
}

function setOtaMutationLock() {
  const locked = otaMutationLocked() || modePending;
  document.querySelectorAll("#device-form input, #device-form button, [data-mode], #gif-file, #preview-animation, #replace-animation, #cancel-animation").forEach((element) => {
    element.disabled = locked;
  });
  setModeButtons();
  document.querySelector("#connect-spotify").disabled = locked || !status?.spotifyConfigured || Boolean(status?.spotifyAuthorizing);
  const device = status?.device;
  const animation = device?.animation;
  document.querySelector("#replace-animation").disabled = locked || !device?.enabled || !device?.paired ||
    Boolean(animation && ["removing", "uploading", "validating"].includes(animation.state));
  document.querySelector("#cancel-animation").disabled = locked ||
    !Boolean(animation && ["removing", "uploading", "validating"].includes(animation.state));
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
  verify.hidden = !firmwareUpdate.putAttempted || ["verified", "experimentallyVerified", "started", "manuallyReconciled"].includes(state);
  verify.disabled = pending;
  const reconcile = document.querySelector("#ota-reconcile");
  reconcile.hidden = !firmwareUpdate.recoverableAttempt;
  reconcile.disabled = pending;
  document.querySelector("#ota-run").hidden = !["verified", "experimentallyVerified"].includes(state);
  document.querySelector("#ota-run").textContent = firmwareUpdate.purpose === "experimental-test"
    ? "Start experimental application" : "Start application";
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
      ? `${candidate.purpose === "experimental-test" ? "EXPERIMENTAL TEST · " : ""}${candidate.fileName} · ${formatBytes(candidate.byteLength)} · SHA-256 ${candidate.sha256} · build ${candidate.expectedBuildId} · device ${candidate.deviceId} · profile ${candidate.profile} · source ${candidate.sourceRevision} · ${candidate.target.flashMode.toUpperCase()} ${candidate.target.flashFrequencyMHz} MHz / ${formatBytes(candidate.target.flashBytes)} flash · FS ${candidate.linkedRegions.filesystemStart}–${candidate.linkedRegions.filesystemEnd}, EEPROM ${candidate.linkedRegions.eepromStart}`
      : "";
    document.querySelector("#ota-status").textContent = otaActionError || (state === "uploading"
      ? `${firmwareUpdate.message} ${formatBytes(firmwareUpdate.bytesSent)} of ${formatBytes(firmwareUpdate.totalBytes)} handed to the transport.`
      : firmwareUpdate.message);
    const progress = document.querySelector("#ota-progress");
    progress.hidden = !firmwareUpdate.putAttempted || !["uploading", "waitingForReboot", "reconnecting", "verifying", "outcomeUnknown", "verificationFailed", "verified", "experimentallyVerified", "started"].includes(state);
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
    localAgentAvailable = true;
    mode = status.mode;
    updateStatusText();
    await refreshFirmwareStatus();
    await refreshAnimation();
    loadCover(status.spotifyState === "connected" && status.snapshot.status === "playing" ? status.snapshot.coverUrl : null);
    agentOfflineNotified = false;
  } catch (error) {
    localAgentAvailable = false;
    loadCover(null);
    document.querySelector("#agent-dot").classList.add("offline");
    document.querySelector("#agent-label").textContent = "Local agent unavailable";
    document.querySelector("#agent-lamp").classList.add("offline");
    document.querySelector("#agent-summary").textContent = "Unavailable";
    document.querySelector("#scene-label").textContent = "AGENT OFFLINE";
    document.querySelector("#playback-state").textContent = "AGENT STATUS";
    document.querySelector("#now-playing-title").textContent = "Local agent unavailable";
    document.querySelector("#now-playing-artist").textContent = "Current playback data cannot be read.";
    document.querySelector("#spotify-badge").textContent = "Status unavailable";
    document.querySelector("#spotify-detail").textContent = "The local agent status could not be read. Spotify connection and playback are unknown.";
    document.querySelector("#spotify-lamp").classList.add("offline");
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
  gradient.addColorStop(0, "#281226");
  gradient.addColorStop(1, "#10141d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 240, 240);
  context.fillStyle = "rgba(255,74,171,.12)";
  context.beginPath();
  context.arc(120, 91, 47, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgba(109,235,242,.78)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(120, 91, 31, now / 2000, now / 2000 + Math.PI * 1.55);
  context.stroke();
  context.fillStyle = "#fff0f8";
  context.textAlign = "center";
  context.font = "600 13px system-ui, sans-serif";
  const waitingMessages = {
    unconfigured: ["Spotify not configured", "Add Spotify app settings"],
    checking: ["Checking Spotify", "Waiting for first update"],
    authentication_required: ["Reconnect Spotify", "Authorization required"],
    rate_limited: ["Spotify is waiting", "Retrying after request limit"],
    offline: ["Spotify offline", "Waiting to reconnect"],
    api_error: ["Spotify unavailable", "Check account or connection"],
    stale: ["Status is delayed", "Waiting for a fresh update"],
    connected: ["No active track", "Play a track to see it here"],
  };
  const [title, detail] = status?.spotifyState === "connected" && status.snapshot.status === "paused"
    ? ["Playback paused", "Resume to show the current track"]
    : waitingMessages[status?.spotifyState] ?? ["Spotify unavailable", "Waiting for a real playback update"];
  context.fillText(title, 120, 166);
  context.fillStyle = "#c5a8bc";
  context.font = "9px system-ui, sans-serif";
  context.fillText(detail, 120, 183);
}

const SPOTIFY_TITLE_Y = 190;
const SPOTIFY_ARTIST_Y = 211;
const SPOTIFY_LINE_HEIGHT = 20;
const SPOTIFY_TEXT_X = 8;
const SPOTIFY_TEXT_VIEWPORT_WIDTH = 224;
const SPOTIFY_MARQUEE_START_DELAY_MS = 1500;
const SPOTIFY_MARQUEE_INTERVAL_MS = 40;
const SPOTIFY_MARQUEE_STEP_PIXELS = 1;
const SPOTIFY_TITLE_FONT = "600 16px system-ui, sans-serif";
const SPOTIFY_ARTIST_FONT = "16px system-ui, sans-serif";

function createSpotifyMarquee() {
  return { text: "", width: 0, letterSpacing: 0, offset: 0, lastStepAt: 0, reverse: false };
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
  context.letterSpacing = "0px";
  const cells = [...marquee.text].length;
  marquee.width = cells * 12;
  marquee.letterSpacing = cells ? (marquee.width - context.measureText(marquee.text).width) / cells : 0;
  marquee.offset = 0;
  marquee.lastStepAt = now;
  marquee.reverse = false;
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
  context.letterSpacing = `${marquee.letterSpacing}px`;
  const x = SPOTIFY_TEXT_X - marquee.offset;
  if (marquee.text && x < 240 && x + marquee.width > 0) context.fillText(marquee.text, x, y);
  context.restore();
}

function advanceSpotifyMarquee(marquee, y, color, font, now) {
  const end = Math.max(0, marquee.width - SPOTIFY_TEXT_VIEWPORT_WIDTH);
  if (!end) return false;
  const atEnd = marquee.offset === 0 || marquee.offset === end;
  const interval = atEnd ? SPOTIFY_MARQUEE_START_DELAY_MS : SPOTIFY_MARQUEE_INTERVAL_MS;
  if (now - marquee.lastStepAt < interval) return false;
  marquee.offset = marquee.reverse
    ? Math.max(0, marquee.offset - SPOTIFY_MARQUEE_STEP_PIXELS)
    : Math.min(end, marquee.offset + SPOTIFY_MARQUEE_STEP_PIXELS);
  if (marquee.offset === end) marquee.reverse = true;
  else if (marquee.offset === 0) marquee.reverse = false;
  marquee.lastStepAt = now;
  drawSpotifyMarquee(marquee, y, color, font, true);
  return true;
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
  if (coverChanged) {
    spotifyTitleMarquee.lastStepAt = now;
    spotifyArtistMarquee.lastStepAt = now;
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
    gradient.addColorStop(0, "rgba(255,74,171,.22)");
    gradient.addColorStop(1, "rgba(8,12,18,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 240, 240);
    context.fillStyle = "#fff0f8";
    context.textAlign = "center";
    context.font = "600 12px system-ui, sans-serif";
    context.fillText("No GIF prepared", 120, 117);
    context.fillStyle = "#c5a8bc";
    context.font = "9px system-ui, sans-serif";
    context.fillText("Choose a GIF in the panel", 120, 136);
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
  if (!localAgentAvailable) {
    if (previousScene !== "local-agent-offline") {
      previousScene = "local-agent-offline";
      context.fillStyle = "#100914";
      context.fillRect(0, 0, DISPLAY_SIZE, DISPLAY_SIZE);
    }
    context.fillStyle = "#ff9bce";
    context.textAlign = "center";
    context.font = "700 13px system-ui, sans-serif";
    context.fillText("LOCAL AGENT OFFLINE", 120, 113);
    context.fillStyle = "#c5a8bc";
    context.font = "9px system-ui, sans-serif";
    context.fillText("Waiting for a fresh status", 120, 132);
    window.requestAnimationFrame(render);
    return;
  }
  const scene = preparedGifPreview && status?.animation?.available ? "gif" : status?.activeScene ?? "gif";
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
  label.textContent = "Converting GIF and preparing a separate preview…";
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
    notify(`GIF prepared for local preview: ${formatBytes(result.sizeBytes)}, ${result.frameCount} frames, ${result.durationMs} ms. Device mode and animation are unchanged.`);
  } catch (error) {
    label.textContent = error.message;
    label.classList.add("error");
  }
}

async function replaceAnimation() {
  if (!status?.animation?.available) return;
  const { sizeBytes, frameCount, durationMs } = status.animation;
  const message = `Replace the device animation with the converted NBIF v2 file (${formatBytes(sizeBytes)}, ${frameCount} frames, ${durationMs} ms)?\n\nThe clock will remove its current animation before transfer. If transfer is cancelled or fails, the old animation will not be preserved.`;
  if (!window.confirm(message)) return;
  const button = document.querySelector("#replace-animation");
  button.disabled = true;
  try {
    await request("/api/animation/replace", { method: "POST" });
    await refreshStatus();
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

async function cancelAnimationTransfer() {
  const button = document.querySelector("#cancel-animation");
  button.disabled = true;
  try {
    await request("/api/animation/cancel", { method: "POST" });
    await refreshStatus();
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

document.querySelector("#device-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const address = document.querySelector("#device-address").value.trim();
    await postJson("/api/device", {
      address: /^\d+\.\d+\.\d+\.\d+$/.test(address) ? `http://${address}` : address,
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
  const experimental = candidate.purpose === "experimental-test";
  const prompt = experimental
    ? `Authorize ONE EXPERIMENTAL TEST upload of build ${candidate.expectedBuildId} (${formatBytes(candidate.byteLength)}, SHA-256 ${candidate.sha256}) from source ${candidate.sourceRevision} to device ${candidate.deviceId}, profile ${candidate.profile}? Declared target: ${candidate.target.flashMode.toUpperCase()}, ${candidate.target.flashFrequencyMHz} MHz, ${formatBytes(candidate.target.flashBytes)} flash; filesystem ${candidate.linkedRegions.filesystemStart}–${candidate.linkedRegions.filesystemEnd}, EEPROM ${candidate.linkedRegions.eepromStart}. This will pause the application if it is running. Locally checked image integrity, identity and declared flash layout passed; live resource floors, physical flash compatibility, full backup and independent Wi-Fi recovery remain unapproved. Production approval remains pending. Continue only with separate explicit authorization for this experiment.`
    : `Install build ${candidate.expectedBuildId} (${formatBytes(candidate.byteLength)}, SHA-256 ${candidate.sha256}) on device ${candidate.deviceId}? The application will pause and the image will be sent once.`;
  const accepted = window.confirm(prompt);
  if (!accepted) return;
  await runOtaAction(() => postJson("/api/ota/confirm", { candidateId: candidate.id, ...(experimental ? { experimentalTestConfirmed: true } : {}) }, 150_000));
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
  const experimental = firmwareUpdate?.purpose === "experimental-test";
  const prompt = experimental
    ? "Start this experimentally verified application now? Experimental maintenance observations are not production approval; hardware homologation remains pending."
    : "Start the verified application now?";
  if (!window.confirm(prompt)) return;
  await runOtaAction(() => request("/api/ota/run", { method: "POST", timeoutMs: 30_000 }));
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => void chooseMode(button.dataset.mode));
});
document.querySelector("#connect-spotify").addEventListener("click", () => void connectSpotify());
document.querySelector("#preview-animation").addEventListener("click", () => {
  preparedGifPreview = !preparedGifPreview;
  updateStatusText();
});
document.querySelector("#replace-animation").addEventListener("click", () => void replaceAnimation());
document.querySelector("#cancel-animation").addEventListener("click", () => void cancelAnimationTransfer());
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
  try {
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
