const DISPLAY_SIZE = 240;
const ANIMATION_HEADER_BYTES = 11;
const RGB565_FRAME_BYTES = DISPLAY_SIZE * DISPLAY_SIZE * 2;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const modeHelp = {
  auto: "Spotify quando estiver tocando; GIF nos outros momentos.",
  spotify: "Mantém a tela Spotify e mostra espera sem uma faixa ativa.",
  gif: "Mantém o GIF em loop e ocupa todo o display.",
};

const canvas = document.querySelector("#display");
const context = canvas.getContext("2d", { alpha: false });
const toast = document.querySelector("#toast");
let status = null;
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
  const response = await fetch(path, { cache: "no-store", ...options });
  if (!response.ok) {
    let message = `A solicitação falhou (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.message === "string") message = body.message;
    } catch {}
    throw new Error(message);
  }
  return response;
}

async function postJson(path, value) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
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
  toggle.querySelector(".sr-only").textContent = enabled ? "Desativar dados de demonstração" : "Ativar dados de demonstração";
  document.querySelector("#demo-controls").hidden = !enabled;
}

function updateStatusText() {
  if (!status) return;
  const agentDot = document.querySelector("#agent-dot");
  agentDot.classList.toggle("offline", status.snapshot.status === "unavailable");
  document.querySelector("#agent-label").textContent = status.snapshot.status === "unavailable"
    ? "Spotify indisponível"
    : status.demoEnabled ? "Agente em demonstração" : "Agente local ativo";
  document.querySelector("#device-status").textContent = status.deviceConnected ? "Conectado" : "Simulação sem dispositivo";

  const badge = document.querySelector("#spotify-badge");
  badge.textContent = status.spotifyConnected ? "Conectado" : status.spotifyConfigured ? "Aguardando conexão" : "Configure .env";
  badge.classList.toggle("connected", status.spotifyConnected);
  document.querySelector("#scene-label").textContent = status.activeScene === "spotify" ? "SPOTIFY NOW PLAYING" : "GIF FULLSCREEN";
  setDemoControls(status.demoEnabled);

  const animation = status.animation;
  document.querySelector("#upload-status").textContent = animation.available
    ? `GIF pronto · ${animation.frameCount} quadros · ${formatBytes(animation.sizeBytes)} · ${animation.sha256.slice(0, 12)}…`
    : "Nenhum GIF enviado nesta sessão.";
  document.querySelector("#upload-status").classList.remove("error");
}

function formatBytes(value) {
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshStatus() {
  try {
    const response = await request("/api/status");
    status = await response.json();
    if (status.mode !== mode) {
      mode = status.mode;
      localStorage.setItem("neonbyte-mode", mode);
      setModeButtons();
    }
    updateStatusText();
    await refreshAnimation();
    loadCover(status.snapshot.coverUrl);
  } catch (error) {
    document.querySelector("#agent-dot").classList.add("offline");
    document.querySelector("#agent-label").textContent = "Agente local indisponível";
    if (status) notify(error.message);
  }
}

async function refreshAnimation() {
  const nextHash = status?.animation?.sha256 ?? "";
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
    if (checksum !== nextHash) throw new Error("O checksum do GIF recebido não confere. Envie-o novamente.");
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
  const width = view.getUint16(5, true);
  const height = view.getUint16(7, true);
  const count = view.getUint16(9, true);
  const frameBytes = width * height * 2;
  if (magic !== "NBIF" || version !== 1 || width !== DISPLAY_SIZE || height !== DISPLAY_SIZE || count < 1 || bytes.byteLength !== ANIMATION_HEADER_BYTES + count * (2 + frameBytes)) {
    throw new Error("O formato da animação não corresponde à prévia 240 × 240.");
  }
  const frames = [];
  let offset = ANIMATION_HEADER_BYTES;
  for (let frame = 0; frame < count; frame += 1) {
    const delayMs = view.getUint16(offset, true);
    offset += 2;
    const image = context.createImageData(width, height);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const color = view.getUint16(offset + pixel * 2, true);
      const red = (color >> 11) & 31;
      const green = (color >> 5) & 63;
      const blue = color & 31;
      const target = pixel * 4;
      image.data[target] = Math.round(red * 255 / 31);
      image.data[target + 1] = Math.round(green * 255 / 63);
      image.data[target + 2] = Math.round(blue * 255 / 31);
      image.data[target + 3] = 255;
    }
    frames.push({ image, delayMs: Math.max(20, delayMs) });
    offset += frameBytes;
  }
  return frames;
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
      if (requestId === coverLoadId) notify(`A capa não pôde ser preparada: ${error.message}`);
    });
  };
  image.onerror = () => {
    if (requestId === coverLoadId) {
      coverImage = null;
      notify("Não foi possível carregar a capa do Spotify; título e progresso continuam disponíveis.");
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

function fitText(text, maxWidth) {
  let result = String(text ?? "");
  if (context.measureText(result).width <= maxWidth) return result;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
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
  context.fillText(status?.snapshot.status === "idle" ? "Nenhuma música ativa" : "Aguardando Spotify", 120, 166);
  context.fillStyle = "#9b98aa";
  context.font = "9px system-ui, sans-serif";
  context.fillText("Conecte sua conta ou ative os dados demo", 120, 183);
}

function drawSpotify(now) {
  const track = status?.snapshot.nowPlaying;
  if (!track || status.snapshot.status !== "playing") {
    drawWaiting(now);
    return;
  }
  context.fillStyle = "#090a11";
  context.fillRect(0, 0, 240, 240);
  const coverX = 64;
  const coverY = 12;
  const coverSize = 112;
  if (coverImage) {
    context.save();
    context.beginPath();
    context.roundRect(coverX, coverY, coverSize, coverSize, 7);
    context.clip();
    drawCover(context, coverImage, coverX, coverY, coverSize, coverSize);
    context.restore();
  } else {
    const fallback = context.createLinearGradient(coverX, coverY, coverX + coverSize, coverY + coverSize);
    fallback.addColorStop(0, "#ee76bd");
    fallback.addColorStop(1, "#444ec7");
    context.fillStyle = fallback;
    context.fillRect(coverX, coverY, coverSize, coverSize);
    context.fillStyle = "rgba(255,255,255,.74)";
    context.font = "bold 38px system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText("♪", 120, 89);
  }
  context.textAlign = "left";
  context.fillStyle = "#f6f3fa";
  context.font = "600 12px system-ui, sans-serif";
  context.fillText(fitText(track.title, 200), 20, 155);
  context.fillStyle = "#aaa6b8";
  context.font = "10px system-ui, sans-serif";
  context.fillText(fitText(track.artist, 200), 20, 173);
  const elapsed = track.isPlaying ? Math.max(0, now - track.sampledAtUnixMs) : 0;
  const progress = Math.min(track.durationMs, track.progressMs + elapsed);
  const progressWidth = Math.max(0, Math.min(200, progress / Math.max(1, track.durationMs) * 200));
  context.fillStyle = "#373340";
  context.fillRect(20, 197, 200, 3);
  context.fillStyle = "#b993ff";
  context.fillRect(20, 197, progressWidth, 3);
  context.fillStyle = "#aaa6b8";
  context.font = "8px ui-monospace, SFMono-Regular, monospace";
  context.fillText(formatTime(progress), 20, 216);
  context.textAlign = "right";
  context.fillText(formatTime(track.durationMs), 220, 216);
}

function formatTime(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
    context.fillText("Envie um GIF para começar", 120, 117);
    context.fillStyle = "#807a8b";
    context.font = "9px system-ui, sans-serif";
    context.fillText("A animação preencherá todo o display", 120, 136);
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
    frameIndex = -1;
    frameDeadline = 0;
  }
  if (scene === "spotify") drawSpotify(Date.now());
  else drawGif(now);
  window.requestAnimationFrame(render);
}

async function toggleDemo() {
  const enabled = !status?.demoEnabled;
  try {
    await postJson("/api/demo", { enabled });
    await refreshStatus();
    notify(enabled ? "Dados de demonstração ativados." : "Dados de demonstração desativados.");
  } catch (error) {
    notify(error.message);
  }
}

async function mockAction(action) {
  try {
    await postJson("/api/mock/playback", { action });
    document.querySelector("#demo-message").textContent = action === "offline" ? "Agente mock offline" : "Reprodução mock atualizada";
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
    label.textContent = "Esse GIF passa do limite de 8 MB. Escolha um arquivo menor.";
    label.classList.add("error");
    return;
  }
  label.textContent = "Validando e preparando a prévia…";
  label.classList.remove("error");
  try {
    const response = await request("/api/animation", {
      method: "POST",
      headers: { "Content-Type": "image/gif" },
      body: file,
    });
    const result = await response.json();
    await refreshStatus();
    await chooseMode("gif");
    notify(`GIF preparado: ${result.frameCount} quadros em 240 × 240.`);
  } catch (error) {
    label.textContent = error.message;
    label.classList.add("error");
  }
}

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
if (connected) notify("Spotify conectado. O estado de reprodução será atualizado aqui.");
if (oauthError) notify("A autorização Spotify não foi concluída. Confira a configuração e tente novamente.");
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
    document.querySelector("#agent-label").textContent = "Agente local indisponível";
    notify(error.message);
  }
}

void initialize();
window.setInterval(() => void refreshStatus(), 1000);
window.requestAnimationFrame(render);
