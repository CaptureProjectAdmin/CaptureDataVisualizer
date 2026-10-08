const SERIES_COLORS = ["#287E8F", "#15CAB6", "#F6B53D", "#EF8A5A", "#E85E76", "#696CB5"];
const THEME_KEY = "capture-app-theme";
const COLLAPSED_GROUPS_KEY = "capture-app-collapsed-groups";
const MEDIA_OPEN_KEY = "capture-app-media-open";
const ROTATION_KEY = "capture-app-video-rotations";
const EYE_OVERLAY_KEY = "capture-app-eye-overlay";
const ANNOTATE_OPEN_KEY = "capture-app-annotate-open";
const SENSORS_OPEN_KEY = "capture-app-sensors-open";
const ANNOTATE_MARKS_KEY = "capture-app-annotation-marks";
const EVENT_LIST_KEY = "capture-app-event-names";
const DEFAULT_MARKS = [
  "Walk Begin",
  "Walk End",
  "Doorway Begin",
  "Doorway End",
  "Talk Begin",
  "Talk End",
  "Lost Begin",
  "Lost End",
  "Sit Begin",
  "Sit End",
  "Turn Begin",
  "Turn End",
];
const DEFAULT_OPEN_MEDIA = ["phone-video", "microphone"];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartAxisStyle() {
  return { stroke: cssVar("--chart-axis"), grid: { stroke: cssVar("--chart-grid") } };
}

function syncThemeButton() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const light = document.documentElement.dataset.theme !== "dark";
  const label = light ? "Light theme" : "Dark theme";
  button.setAttribute("aria-checked", light ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.title = light ? "Switch to dark theme" : "Switch to light theme";
}

function paintThemedCharts() {
  const axis = cssVar("--chart-axis");
  const grid = cssVar("--chart-grid");
  for (const chart of state.charts.values()) {
    for (const axisObj of chart.axes) {
      axisObj.stroke = axis;
      if (axisObj.grid) axisObj.grid.stroke = grid;
    }
    chart.redraw();
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  syncThemeButton();
  paintThemedCharts();
}
const DEFAULT_SELECTED = new Set([
  "phone.Accelerometer",
  "phone.Gyroscope",
  "phone.Orientation",
  "phone.Microphone",
  "phone.Location",
  "phone.Pedometer",
]);

const state = {
  session: null,
  sensorData: new Map(),
  selected: new Set(DEFAULT_SELECTED),
  charts: new Map(),
  duration: 0,
  currentTime: 0,
  playing: false,
  lastFrame: 0,
  map: null,
  mapTrack: null,
  mapMarker: null,
  locationData: null,
  syncingMedia: false,
  openMedia: null,
  mediaPlayers: new Map(),
  rotations: {},
  collapsedGroups: new Set(),
  sensorQuery: "",
  searchCollapsed: new Set(),
  chartViews: new Map(),
  zoomAll: false,
  zoomWindow: 10,
  events: [],
};

const els = {
  meta: document.getElementById("recording-meta"),
  dataPath: document.getElementById("data-path"),
  reloadBtn: document.getElementById("reload-btn"),
  sensorList: document.getElementById("sensor-list"),
  sensorSearch: document.getElementById("sensor-search"),
  mediaList: document.getElementById("media-list"),
  audio: document.getElementById("audio-player"),
  audioPlaceholder: document.getElementById("audio-placeholder"),
  mapSection: document.getElementById("map-section"),
  workspace: document.getElementById("workspace"),
  playBtn: document.getElementById("play-btn"),
  timeline: document.getElementById("timeline"),
  currentTime: document.getElementById("current-time"),
  totalTime: document.getElementById("total-time"),
  speed: document.getElementById("playback-speed"),
  zoomAll: document.getElementById("zoom-all"),
  zoomWindow: document.getElementById("zoom-window"),
  selectAll: document.getElementById("select-all"),
  selectNone: document.getElementById("select-none"),
  sensorsToggle: document.getElementById("sensors-toggle"),
  annotateToggle: document.getElementById("annotate-toggle"),
  annotatePanel: document.getElementById("annotate-panel"),
  annotateMarks: document.getElementById("annotate-marks"),
  annotateNewMark: document.getElementById("annotate-new-mark"),
  annotateAddMark: document.getElementById("annotate-add-mark"),
  annotateEvent: document.getElementById("annotate-event"),
  annotateDescription: document.getElementById("annotate-description"),
  annotateAssign: document.getElementById("annotate-assign"),
  annotateStamp: document.getElementById("annotate-stamp"),
  annotateCurrent: document.getElementById("annotate-current"),
  annotateExport: document.getElementById("annotate-export"),
  annotateImport: document.getElementById("annotate-import"),
  annotateImportFile: document.getElementById("annotate-import-file"),
};

let annotationStamp = null;
let annotationFilled = null;

function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function stampSeconds(seconds) {
  return Math.round((Number(seconds) || 0) * 100) / 100;
}

function formatStamp(seconds) {
  const rounded = Math.max(0, stampSeconds(seconds));
  const mins = Math.floor(rounded / 60);
  const secs = rounded - mins * 60;
  const whole = Math.floor(secs + 1e-9);
  const frac = Math.round((secs - whole) * 100);
  return `${mins}:${String(whole).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
}

function mediaUrl(relativePath) {
  return `/api/media/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText);
  }
  return response.json();
}

function setMeta(session) {
  const md = session.metadata || {};
  const device = md["device name"] || "Unknown device";
  const when = md["recording time"] || "";
  const tz = md["recording timezone"] || "";
  els.meta.textContent = `${device} · ${when} ${tz} · ${formatTime(session.duration)} · ${session.sensors.length} sensors`;
}

function ensureOpenMedia() {
  if (state.openMedia) return;
  try {
    const saved = JSON.parse(localStorage.getItem(MEDIA_OPEN_KEY) || "null");
    if (Array.isArray(saved)) {
      state.openMedia = new Set(saved.filter((id) => typeof id === "string"));
      return;
    }
  } catch {
    // Fall through to the default open set.
  }
  state.openMedia = new Set(DEFAULT_OPEN_MEDIA);
}

function loadRotations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROTATION_KEY) || "null");
    if (parsed && typeof parsed === "object") {
      state.rotations = parsed;
      return;
    }
  } catch {
    // Fall through to the single-video rotation saved by older builds.
  }
  const legacy = Number(localStorage.getItem("capture-app-video-rotation") || 0);
  state.rotations = { "phone-video": [0, 90, 180, 270].includes(legacy) ? legacy : 0 };
}

function rotationFor(id) {
  const value = Number(state.rotations[id] || 0);
  return [0, 90, 180, 270].includes(value) ? value : 0;
}

function playerElement(player) {
  return player?.video || player?.audio || null;
}

function openMediaElements() {
  const elements = [];
  for (const player of state.mediaPlayers.values()) {
    if (player.panel?.hidden) continue;
    const element = playerElement(player);
    if (element?.dataset.mediaPath) elements.push(element);
  }
  return elements;
}

function bindMediaClock(element) {
  if (!element || element.dataset.clockBound === "1") return;
  element.dataset.clockBound = "1";
  const report = () => {
    if (state.syncingMedia) return;
    setCurrentTime(element.currentTime, { source: element });
  };
  element.addEventListener("timeupdate", report);
  element.addEventListener("seeked", report);
}

function updateMuteButton(player) {
  if (!player.muteBtn || !player.video) return;
  const muted = player.video.muted || player.video.volume === 0;
  player.muteBtn.textContent = muted ? "🔇" : "🔊";
  player.muteBtn.setAttribute("aria-label", muted ? "Unmute video" : "Mute video");
}

function applyRotation(player) {
  if (!player.stage) return;
  const rotation = rotationFor(player.id);
  player.stage.className = `video-stage rotate-${rotation}`;
  if (player.rotationLabel) player.rotationLabel.textContent = `${rotation}°`;
}

function rotatePlayer(player, delta) {
  const next = (rotationFor(player.id) + delta + 360) % 360;
  state.rotations[player.id] = next;
  localStorage.setItem(ROTATION_KEY, JSON.stringify(state.rotations));
  applyRotation(player);
}

function ensureSource(player) {
  const element = playerElement(player);
  if (!element || !player.path || element.dataset.mediaPath === player.path) return;
  element.dataset.mediaPath = player.path;
  element.preload = "metadata";
  element.src = mediaUrl(player.path);
  element.addEventListener(
    "loadedmetadata",
    () => {
      if (player.panel?.hidden) return;
      if (Math.abs(element.currentTime - state.currentTime) > 0.15) {
        state.syncingMedia = true;
        try {
          element.currentTime = state.currentTime;
        } catch {
          // Metadata can arrive before the element accepts a seek.
        }
        state.syncingMedia = false;
      }
      if (state.playing) element.play().catch(() => {});
    },
    { once: true },
  );
  if (player.video) {
    player.video.hidden = false;
    if (player.stage) player.stage.hidden = false;
    if (player.placeholder) player.placeholder.hidden = true;
    if (player.controls) player.controls.hidden = false;
    player.video.volume = Number(player.volume?.value || 1);
    updateMuteButton(player);
    applyRotation(player);
  } else if (player.audio) {
    player.audio.hidden = false;
    if (player.placeholder) player.placeholder.hidden = true;
  }
}

function applyMediaOpen(id, open) {
  const player = state.mediaPlayers.get(id);
  if (!player) return;
  player.panel.hidden = !open;
  const element = playerElement(player);
  if (!open) {
    element?.pause();
    return;
  }
  ensureSource(player);
  if (element && state.currentTime > 0 && Math.abs(element.currentTime - state.currentTime) > 0.15) {
    state.syncingMedia = true;
    element.currentTime = state.currentTime;
    state.syncingMedia = false;
  }
  if (state.playing) element?.play().catch(() => {});
  if (id === "eye-scene") drawEyeOverlay(player);
}

function setMediaOpen(id, open) {
  ensureOpenMedia();
  if (open) state.openMedia.add(id);
  else state.openMedia.delete(id);
  localStorage.setItem(MEDIA_OPEN_KEY, JSON.stringify([...state.openMedia]));
  applyMediaOpen(id, open);
  const checkbox = els.mediaList?.querySelector(`input[data-media-id="${CSS.escape(id)}"]`);
  if (checkbox) checkbox.checked = open;
}

function renderMediaToggles(items) {
  ensureOpenMedia();
  if (!els.mediaList) return;
  els.mediaList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "media-status";
    empty.textContent = "No media files found in this recording";
    els.mediaList.append(empty);
    return;
  }
  for (const item of items) {
    const label = document.createElement("label");
    label.className = "sensor-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.mediaId = item.id;
    checkbox.checked = state.openMedia.has(item.id);
    checkbox.addEventListener("change", () => setMediaOpen(item.id, checkbox.checked));
    const name = document.createElement("span");
    name.textContent = item.label;
    name.title = item.path;
    label.append(checkbox, name);
    els.mediaList.append(label);
  }
}

function loadEyeOverlayToggles() {
  try {
    const saved = JSON.parse(localStorage.getItem(EYE_OVERLAY_KEY) || "null");
    if (saved && typeof saved === "object") {
      return { gaze: Boolean(saved.gaze), fixations: Boolean(saved.fixations) };
    }
  } catch {
    // Use the defaults below.
  }
  return { gaze: false, fixations: false };
}

function saveEyeOverlayToggles(player) {
  localStorage.setItem(
    EYE_OVERLAY_KEY,
    JSON.stringify({ gaze: player.showGaze, fixations: player.showFixations }),
  );
}

function overlayToggle(label, pressed, mark, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "overlay-toggle";
  button.title = title;
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  button.setAttribute("aria-label", title);
  const text = document.createElement("span");
  text.textContent = label;
  button.append(mark, text);
  return button;
}

function plusMark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", "overlay-mark");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7 1.5v11M1.5 7h11");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#ff2d2d");
  path.setAttribute("stroke-width", "2.2");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

function circleMark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", "overlay-mark");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "7");
  circle.setAttribute("cy", "7");
  circle.setAttribute("r", "4.5");
  circle.setAttribute("fill", "none");
  circle.setAttribute("stroke", "#22c55e");
  circle.setAttribute("stroke-width", "2.2");
  svg.append(circle);
  return svg;
}

let eyeOverlayPromise = null;

function ensureEyeOverlay(player) {
  if (player.overlayData) return Promise.resolve(player.overlayData);
  if (!eyeOverlayPromise) {
    eyeOverlayPromise = fetchJson("/api/eye/overlay")
      .then((data) => {
        for (const candidate of state.mediaPlayers.values()) {
          if (candidate.overlayCanvas) candidate.overlayData = data;
        }
        return data;
      })
      .catch((error) => {
        eyeOverlayPromise = null;
        throw error;
      });
  }
  return eyeOverlayPromise.then((data) => {
    player.overlayData = data;
    return data;
  });
}

function toggleEyeOverlay(player, kind) {
  if (kind === "gaze") player.showGaze = !player.showGaze;
  else player.showFixations = !player.showFixations;
  player.gazeBtn?.setAttribute("aria-pressed", player.showGaze ? "true" : "false");
  player.fixationBtn?.setAttribute("aria-pressed", player.showFixations ? "true" : "false");
  saveEyeOverlayToggles(player);
  if ((player.showGaze || player.showFixations) && !player.overlayData) {
    ensureEyeOverlay(player)
      .then(() => drawEyeOverlay(player))
      .catch(() => {
        if (kind === "gaze") player.showGaze = false;
        else player.showFixations = false;
        player.gazeBtn?.setAttribute("aria-pressed", player.showGaze ? "true" : "false");
        player.fixationBtn?.setAttribute("aria-pressed", player.showFixations ? "true" : "false");
        saveEyeOverlayToggles(player);
      });
    return;
  }
  drawEyeOverlay(player);
}

function sampleIndex(times, t, maxGap) {
  if (!times?.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  if (t < times[0] - maxGap || t > times[hi] + maxGap) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) best = lo - 1;
  return Math.abs(times[best] - t) <= maxGap ? best : -1;
}

function fixationIndex(fixations, t) {
  const starts = fixations?.start;
  if (!starts?.length) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0 || t > fixations.end[found]) return -1;
  return found;
}

function drawEyeOverlay(player) {
  const canvas = player?.overlayCanvas;
  if (!canvas) return;
  const active = player.showGaze || player.showFixations;
  canvas.hidden = !active;
  if (!active || player.panel?.hidden) return;
  if (!player.overlayData) {
    if (player.overlayError) return;
    ensureEyeOverlay(player)
      .then(() => drawEyeOverlay(player))
      .catch(() => {
        player.overlayError = true;
      });
    return;
  }
  const data = player.overlayData;
  const video = player.video;
  const width = video?.videoWidth || data?.width || 0;
  const height = video?.videoHeight || data?.height || 0;
  if (!data || width < 2 || height < 2) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const sx = width / (data.width || width);
  const sy = height / (data.height || height);
  const elapsed = state.currentTime + (Number(data.video_time_origin) || 0);
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
  ctx.shadowBlur = 6;
  if (player.showFixations) {
    const index = fixationIndex(data.fixations, elapsed);
    if (index >= 0) {
      const x = data.fixations.x[index] * sx;
      const y = data.fixations.y[index] * sy;
      ctx.beginPath();
      ctx.arc(x, y, 34, 0, Math.PI * 2);
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 6;
      ctx.stroke();
    }
  }
  if (player.showGaze) {
    const index = sampleIndex(data.gaze?.times, elapsed, 0.05);
    if (index >= 0) {
      const x = data.gaze.x[index] * sx;
      const y = data.gaze.y[index] * sy;
      const arm = 22;
      ctx.beginPath();
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
      ctx.strokeStyle = "#ff2d2d";
      ctx.lineWidth = 6;
      ctx.stroke();
    }
  }
}

function createVideoPanel(item) {
  const panel = document.createElement("section");
  panel.className = "workspace-panel video-card";
  panel.dataset.panel = `video:${item.id}`;
  panel.hidden = true;

  const header = document.createElement("div");
  header.className = "video-card-header";
  const toolbar = document.createElement("div");
  toolbar.className = "panel-toolbar";
  const title = document.createElement("div");
  title.className = "card-label";
  title.textContent = item.label;
  toolbar.append(title);
  let gazeBtn = null;
  let fixationBtn = null;
  let overlayCanvas = null;
  if (item.id === "eye-scene") {
    const saved = loadEyeOverlayToggles();
    const toggles = document.createElement("div");
    toggles.className = "overlay-toggles";
    gazeBtn = overlayToggle("Gaze", saved.gaze, plusMark(), "Show gaze on the eye-tracker camera");
    fixationBtn = overlayToggle(
      "Fixations",
      saved.fixations,
      circleMark(),
      "Show fixations on the eye-tracker camera",
    );
    toggles.append(gazeBtn, fixationBtn);
    toolbar.append(toggles);
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.className = "gaze-overlay";
    overlayCanvas.hidden = !(saved.gaze || saved.fixations);
  }

  const rotate = document.createElement("div");
  rotate.className = "video-rotate-controls";
  const rotateLeft = document.createElement("button");
  rotateLeft.type = "button";
  rotateLeft.title = "Rotate 90° counter-clockwise";
  rotateLeft.textContent = "↺ 90°";
  const rotationLabel = document.createElement("span");
  rotationLabel.className = "rotation-label";
  const rotateRight = document.createElement("button");
  rotateRight.type = "button";
  rotateRight.title = "Rotate 90° clockwise";
  rotateRight.textContent = "↻ 90°";
  rotate.append(rotateLeft, rotationLabel, rotateRight);
  header.append(toolbar, rotate);

  const stage = document.createElement("div");
  stage.className = "video-stage rotate-0";
  const video = document.createElement("video");
  video.className = "video-player";
  video.playsInline = true;
  stage.append(video);
  if (overlayCanvas) stage.append(overlayCanvas);

  const controls = document.createElement("div");
  controls.className = "video-controls";
  controls.hidden = true;
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.textContent = "▶";
  playBtn.setAttribute("aria-label", "Play video");
  const readout = document.createElement("span");
  readout.className = "video-time-readout";
  const currentTime = document.createElement("span");
  currentTime.textContent = "0:00";
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "/";
  const totalTime = document.createElement("span");
  totalTime.textContent = formatTime(state.duration);
  readout.append(currentTime, sep, totalTime);
  const timeline = document.createElement("input");
  timeline.className = "video-timeline";
  timeline.type = "range";
  timeline.min = "0";
  timeline.max = String(state.duration || 0);
  timeline.value = String(state.currentTime || 0);
  timeline.step = "0.01";
  timeline.setAttribute("aria-label", `${item.label} position`);
  const volumeGroup = document.createElement("div");
  volumeGroup.className = "video-volume-group";
  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.textContent = "🔊";
  muteBtn.setAttribute("aria-label", "Mute video");
  const volume = document.createElement("input");
  volume.className = "video-volume";
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.05";
  volume.value = "1";
  volume.setAttribute("aria-label", `${item.label} volume`);
  volumeGroup.append(muteBtn, volume);
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.type = "button";
  fullscreenBtn.textContent = "⛶";
  fullscreenBtn.setAttribute("aria-label", "Fullscreen");
  controls.append(playBtn, readout, timeline, volumeGroup, fullscreenBtn);

  const placeholder = document.createElement("div");
  placeholder.className = "placeholder";
  placeholder.textContent = "No video file found in export";

  panel.append(header, stage, controls, placeholder);

  const player = {
    id: item.id,
    kind: "video",
    path: item.path,
    panel,
    video,
    stage,
    controls,
    placeholder,
    playBtn,
    timeline,
    currentTime,
    totalTime,
    muteBtn,
    volume,
    fullscreenBtn,
    rotationLabel,
    overlayCanvas,
    gazeBtn,
    fixationBtn,
    showGaze: Boolean(gazeBtn?.getAttribute("aria-pressed") === "true"),
    showFixations: Boolean(fixationBtn?.getAttribute("aria-pressed") === "true"),
    overlayData: null,
  };

  rotateLeft.addEventListener("click", () => rotatePlayer(player, -90));
  rotateRight.addEventListener("click", () => rotatePlayer(player, 90));
  playBtn.addEventListener("click", togglePlay);
  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) {
      video.volume = 1;
      volume.value = "1";
    }
    updateMuteButton(player);
  });
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    updateMuteButton(player);
  });
  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === stage) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    stage.requestFullscreen?.().catch(() => {});
  });
  timeline.addEventListener("input", () => setCurrentTime(Number(timeline.value)));
  gazeBtn?.addEventListener("click", () => toggleEyeOverlay(player, "gaze"));
  fixationBtn?.addEventListener("click", () => toggleEyeOverlay(player, "fixations"));
  video.addEventListener("loadedmetadata", () => drawEyeOverlay(player));
  bindMediaClock(video);
  applyRotation(player);
  return player;
}

function registerAudio(item) {
  const panel = document.querySelector('.workspace-panel[data-panel="audio"]');
  if (!panel) return;
  const label = panel.querySelector(".card-label");
  if (label) label.textContent = item.label;
  state.mediaPlayers.set(item.id, {
    id: item.id,
    kind: "audio",
    path: item.path,
    panel,
    audio: els.audio,
    placeholder: els.audioPlaceholder,
  });
  bindMediaClock(els.audio);
}

function configureMedia(session) {
  ensureOpenMedia();
  loadRotations();
  els.workspace?.querySelectorAll(":scope > .video-card").forEach((panel) => panel.remove());
  state.mediaPlayers.clear();

  const items = session.media?.items || [];
  for (const item of items) {
    if (item.kind === "video") {
      const player = createVideoPanel(item);
      state.mediaPlayers.set(item.id, player);
      if (els.mapSection) els.workspace.insertBefore(player.panel, els.mapSection);
      else els.workspace.append(player.panel);
      PanelLayout.decorate(player.panel);
    } else if (item.kind === "audio") {
      registerAudio(item);
    }
  }

  const audioPanel = document.querySelector('.workspace-panel[data-panel="audio"]');
  if (audioPanel && !items.some((item) => item.kind === "audio")) audioPanel.hidden = true;

  for (const item of items) applyMediaOpen(item.id, state.openMedia.has(item.id));
  renderMediaToggles(items);
  updatePlayButtons();
  setDurationUi(state.duration);
}

function loadCollapsedGroups() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || "[]");
    if (Array.isArray(saved)) {
      state.collapsedGroups = new Set(saved.filter((group) => typeof group === "string"));
    }
  } catch {
    state.collapsedGroups = new Set();
  }
}

function saveCollapsedGroups() {
  localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...state.collapsedGroups]));
}

function sensorQuery() {
  return (els.sensorSearch?.value || "").trim().toLowerCase();
}

function groupDomId(group) {
  return `sensor-group-${group.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

function appendHighlighted(parent, text, query) {
  if (!query) {
    parent.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let start = 0;
  let index = lower.indexOf(query);
  if (index < 0) {
    parent.textContent = text;
    return;
  }
  while (index >= 0) {
    if (index > start) parent.append(document.createTextNode(text.slice(start, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + query.length);
    parent.append(mark);
    start = index + query.length;
    index = lower.indexOf(query, start);
  }
  if (start < text.length) parent.append(document.createTextNode(text.slice(start)));
}

function renderSensorList(session) {
  els.sensorList.innerHTML = "";
  const query = sensorQuery();
  if (query !== state.sensorQuery) {
    state.sensorQuery = query;
    state.searchCollapsed = new Set();
  }
  const groups = [];
  let current = null;
  for (const sensor of session.sensors) {
    const group = sensor.group || "Phone";
    if (!current || current.name !== group) {
      current = { name: group, sensors: [] };
      groups.push(current);
    }
    if (!query || sensor.name.toLowerCase().includes(query)) current.sensors.push(sensor);
  }

  const visibleGroups = groups.filter((group) => group.sensors.length > 0);
  if (!visibleGroups.length) {
    const empty = document.createElement("p");
    empty.className = "sensor-empty";
    empty.textContent = query ? "No matching sensors" : "No sensors in this recording";
    els.sensorList.append(empty);
    return;
  }

  for (const group of visibleGroups) {
    const collapsed = (query ? state.searchCollapsed : state.collapsedGroups).has(group.name);
    const itemsId = groupDomId(group.name);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "sensor-group-title";
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    header.setAttribute("aria-controls", itemsId);

    const chevron = document.createElement("span");
    chevron.className = "sensor-group-chevron";
    chevron.setAttribute("aria-hidden", "true");

    const title = document.createElement("span");
    title.textContent = group.name;

    const count = document.createElement("small");
    count.textContent = String(group.sensors.length);

    header.append(chevron, title, count);
    header.addEventListener("click", () => {
      const target = query ? state.searchCollapsed : state.collapsedGroups;
      if (target.has(group.name)) target.delete(group.name);
      else target.add(group.name);
      if (!query) saveCollapsedGroups();
      renderSensorList(session);
    });

    const items = document.createElement("div");
    items.className = "sensor-group-items";
    items.id = itemsId;
    items.hidden = collapsed;

    for (const sensor of group.sensors) {
      const label = document.createElement("label");
      label.className = `sensor-item${sensor.error ? " disabled" : ""}`;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.disabled = Boolean(sensor.error);
      checkbox.checked = state.selected.has(sensor.id) && !sensor.error;
      checkbox.addEventListener("change", async () => {
        if (checkbox.checked) state.selected.add(sensor.id);
        else state.selected.delete(sensor.id);
        await refreshCharts();
      });

      const name = document.createElement("span");
      appendHighlighted(name, sensor.name, query);

      const meta = document.createElement("small");
      if (sensor.error) meta.textContent = "error";
      else meta.textContent = sensor.kind === "map" ? "map" : `${sensor.row_count.toLocaleString()} pts`;

      label.append(checkbox, name, meta);
      items.append(label);
    }

    els.sensorList.append(header, items);
  }
}

function updateTimelineUi(time) {
  const value = String(time);
  els.timeline.value = value;
  els.currentTime.textContent = formatTime(time);
  for (const player of state.mediaPlayers.values()) {
    if (!player.timeline) continue;
    player.timeline.value = value;
    if (player.currentTime) player.currentTime.textContent = formatTime(time);
  }
}

function setDurationUi(duration) {
  const max = String(duration || 0);
  els.timeline.max = max;
  els.totalTime.textContent = formatTime(duration);
  for (const player of state.mediaPlayers.values()) {
    if (!player.timeline) continue;
    player.timeline.max = max;
    if (player.totalTime) player.totalTime.textContent = formatTime(duration);
  }
}

function updatePlayButtons() {
  const symbol = state.playing ? "❚❚" : "▶";
  els.playBtn.textContent = symbol;
  for (const player of state.mediaPlayers.values()) {
    if (!player.playBtn) continue;
    player.playBtn.textContent = symbol;
    player.playBtn.setAttribute("aria-label", state.playing ? "Pause video" : "Play video");
  }
}

async function loadSensorData(sensorName) {
  if (state.sensorData.has(sensorName)) return state.sensorData.get(sensorName);
  const payload = await fetchJson(`/api/sensors/${encodeURIComponent(sensorName)}`);
  state.sensorData.set(sensorName, payload);
  return payload;
}

const chartObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const sensor = entry.target.closest(".chart-card")?.dataset.sensor;
    const chart = sensor ? state.charts.get(sensor) : null;
    if (!chart) continue;
    fitChart(chart, entry.target);
  }
  state.map?.invalidateSize();
});

function chartView(sensorName) {
  let view = state.chartViews.get(sensorName);
  if (!view) {
    view = { zoom: state.zoomAll, window: state.zoomWindow, hidden: new Set() };
    state.chartViews.set(sensorName, view);
  }
  return view;
}

function applySharedZoom() {
  for (const view of state.chartViews.values()) {
    view.zoom = state.zoomAll;
    view.window = state.zoomWindow;
  }
  for (const [sensorName, chart] of state.charts.entries()) {
    applyXRange(chart, chartView(sensorName));
  }
  if (els.zoomAll) els.zoomAll.setAttribute("aria-pressed", state.zoomAll ? "true" : "false");
  if (els.zoomWindow && document.activeElement !== els.zoomWindow) {
    els.zoomWindow.value = String(state.zoomWindow);
  }
  for (const card of els.workspace.querySelectorAll(":scope > .chart-card")) {
    card.querySelector(".chart-zoom")?.setAttribute("aria-pressed", state.zoomAll ? "true" : "false");
    const input = card.querySelector(".chart-window input");
    if (input) input.value = String(state.zoomWindow);
  }
}

function xRangeFor(view) {
  const duration = state.duration || 0;
  if (!view?.zoom) return { min: 0, max: duration };
  const span = Math.max(0.1, Number(view.window) || 10);
  if (duration <= span) return { min: 0, max: Math.max(duration, span) };
  let min = state.currentTime - span / 2;
  let max = min + span;
  if (min < 0) {
    min = 0;
    max = span;
  } else if (max > duration) {
    max = duration;
    min = duration - span;
  }
  return { min, max };
}

function yRange(_chart, dataMin, dataMax) {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [-1, 1];
  if (dataMin === dataMax) {
    const pad = Math.abs(dataMin) * 0.1 || 1;
    return [dataMin - pad, dataMax + pad];
  }
  const pad = (dataMax - dataMin) * 0.08;
  return [dataMin - pad, dataMax + pad];
}

function applyXRange(chart, view) {
  const range = xRangeFor(view);
  const scale = chart.scales.x;
  if (
    scale &&
    Number.isFinite(scale.min) &&
    Number.isFinite(scale.max) &&
    Math.abs(scale.min - range.min) < 1e-4 &&
    Math.abs(scale.max - range.max) < 1e-4
  ) {
    return false;
  }
  chart.setScale("x", range);
  return true;
}

function fitChart(chart, stage) {
  if (!chart || !stage) return;
  const width = Math.max(1, Math.floor(stage.clientWidth));
  const height = Math.max(1, Math.floor(stage.clientHeight));
  if (chart.width === width && chart.height === height) return;
  chart.setSize({ width, height });
}

function destroyCharts() {
  for (const chart of state.charts.values()) chart.destroy();
  state.charts.clear();
  els.workspace.querySelectorAll(":scope > .chart-card .chart-stage").forEach((stage) => {
    chartObserver.unobserve(stage);
  });
  els.workspace.querySelectorAll(":scope > .chart-card").forEach((card) => card.remove());
}

function valueElementId(sensorId) {
  return `values-${String(sensorId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function nearestIndex(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

function iconButton(className, label, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chart-icon-btn ${className}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  return button;
}

function buildChartCard(sensorName, payload) {
  const view = chartView(sensorName);
  const card = document.createElement("article");
  card.className = "workspace-panel chart-card";
  card.dataset.panel = `chart:${sensorName}`;
  card.dataset.sensor = sensorName;

  const toolbar = document.createElement("div");
  toolbar.className = "panel-toolbar";

  const title = document.createElement("h3");
  title.textContent = payload.group ? `${payload.group} · ${payload.name}` : payload.name || sensorName;

  const actions = document.createElement("div");
  actions.className = "chart-actions";

  const zoomBtn = iconButton(
    "chart-zoom",
    "Zoom around the playhead",
    '<circle cx="10.5" cy="10.5" r="5.5"></circle><path d="M15 15.5 20 20.5M10.5 8.2v4.6M8.2 10.5h4.6"></path>',
  );
  zoomBtn.setAttribute("aria-pressed", view.zoom ? "true" : "false");

  const windowLabel = document.createElement("label");
  windowLabel.className = "chart-window";
  const windowInput = document.createElement("input");
  windowInput.type = "number";
  windowInput.min = "0.1";
  windowInput.step = "0.5";
  windowInput.value = String(view.window);
  windowInput.setAttribute("aria-label", "Zoom window in seconds");
  const windowUnit = document.createElement("span");
  windowUnit.textContent = "s";
  windowLabel.append(windowInput, windowUnit);

  const fitBtn = iconButton(
    "chart-fit",
    "Fit panel to window width",
    '<path d="M4 7H2v10h2M20 7h2v10h-2M8 12H16M8 12l2.2-2.2M8 12l2.2 2.2M16 12l-2.2-2.2M16 12l-2.2 2.2"></path>',
  );

  actions.append(zoomBtn, windowLabel, fitBtn);
  toolbar.append(title, actions);

  const columns = payload.columns || Object.keys(payload.series);
  const toggles = document.createElement("div");
  toggles.className = "series-toggles";
  columns.forEach((col, idx) => {
    const color = SERIES_COLORS[idx % SERIES_COLORS.length];
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "series-toggle";
    toggle.style.setProperty("--swatch", color);
    toggle.setAttribute("aria-pressed", view.hidden.has(col) ? "false" : "true");
    toggle.title = view.hidden.has(col) ? `Show ${col}` : `Hide ${col}`;
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = col;
    toggle.append(swatch, name);
    toggle.addEventListener("click", () => {
      const chart = state.charts.get(sensorName);
      const on = view.hidden.has(col);
      if (on) view.hidden.delete(col);
      else view.hidden.add(col);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      toggle.title = on ? `Hide ${col}` : `Show ${col}`;
      chart?.setSeries(idx + 1, { show: on });
      updateChartValues(sensorName, payload);
    });
    toggles.append(toggle);
  });

  const stage = document.createElement("div");
  stage.className = "chart-stage";
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  stage.append(wrap);

  const values = document.createElement("div");
  values.className = "chart-values";
  values.id = valueElementId(sensorName);

  card.append(toolbar, toggles, stage, values);
  els.workspace.append(card);
  PanelLayout.decorate(card);

  zoomBtn.addEventListener("click", () => {
    view.zoom = !view.zoom;
    zoomBtn.setAttribute("aria-pressed", view.zoom ? "true" : "false");
    const chart = state.charts.get(sensorName);
    if (chart) applyXRange(chart, view);
  });
  windowInput.addEventListener("change", () => {
    const next = Number(windowInput.value);
    if (!Number.isFinite(next) || next <= 0) {
      windowInput.value = String(view.window);
      return;
    }
    view.window = next;
    if (!view.zoom) return;
    const chart = state.charts.get(sensorName);
    if (chart) applyXRange(chart, view);
  });
  fitBtn.addEventListener("click", () => {
    PanelLayout.setWidth(card, els.workspace.clientWidth);
  });

  const data = [payload.times, ...columns.map((col) => payload.series[col] || [])];
  const series = columns.map((col, idx) => ({
    label: col,
    stroke: SERIES_COLORS[idx % SERIES_COLORS.length],
    width: 1.5,
    show: !view.hidden.has(col),
  }));
  const size = {
    width: Math.max(1, stage.clientWidth || 420),
    height: Math.max(1, stage.clientHeight || 160),
  };

  const chart = new uPlot(
    {
      ...size,
      legend: { show: false },
      cursor: { drag: { x: false, y: false, setScale: false } },
      series: [{}, ...series],
      axes: [chartAxisStyle(), chartAxisStyle()],
      scales: {
        x: { time: false, ...xRangeFor(view) },
        y: { auto: true, range: yRange },
      },
      hooks: {
        draw: [
          (u) => {
            const x = u.valToPos(state.currentTime, "x", true);
            if (!Number.isFinite(x)) return;
            const left = u.bbox.left;
            const right = u.bbox.left + u.bbox.width;
            if (x < left - 1 || x > right + 1) return;
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = cssVar("--text");
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, u.bbox.top);
            ctx.lineTo(x, u.bbox.top + u.bbox.height);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    },
    data,
    wrap,
  );

  state.charts.set(sensorName, chart);
  chartObserver.observe(stage);
  fitChart(chart, stage);
  updateChartValues(sensorName, payload);
}

function updateChartValues(sensorName, payload) {
  const el = document.getElementById(valueElementId(sensorName));
  if (!el || !payload?.times?.length) return;
  const view = chartView(sensorName);
  const idx = nearestIndex(payload.times, state.currentTime);
  const columns = payload.columns || [];
  el.replaceChildren(
    ...columns.map((col, i) => {
      const span = document.createElement("span");
      span.style.color = SERIES_COLORS[i % SERIES_COLORS.length];
      if (view.hidden.has(col)) span.classList.add("is-off");
      const val = payload.series[col]?.[idx];
      const strong = document.createElement("strong");
      strong.textContent = val == null ? "—" : Number(val).toFixed(3);
      span.append(`${col}: `, strong);
      return span;
    }),
  );
}

function selectedMapSensor() {
  return (state.session?.sensors || []).find(
    (sensor) => sensor.kind === "map" && state.selected.has(sensor.id) && !sensor.error,
  );
}

async function setupMap() {
  const mapSensor = selectedMapSensor();
  if (!mapSensor) {
    els.mapSection.hidden = true;
    return;
  }

  const payload = await loadSensorData(mapSensor.id);
  state.locationData = payload;
  els.mapSection.hidden = false;

  const lat = payload.series.latitude || [];
  const lon = payload.series.longitude || [];
  const points = lat
    .map((la, i) => [la, lon[i]])
    .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));

  if (!points.length) {
    els.mapSection.hidden = true;
    return;
  }

  if (!state.map) {
    state.map = L.map("map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.map);
  }

  if (state.mapTrack) state.map.removeLayer(state.mapTrack);
  if (state.mapMarker) state.map.removeLayer(state.mapMarker);

  state.mapTrack = L.polyline(points, { color: SERIES_COLORS[0], weight: 4 }).addTo(state.map);
  state.map.fitBounds(state.mapTrack.getBounds(), { padding: [24, 24] });

  const idx = nearestIndex(payload.times, state.currentTime);
  const markerPoint = [lat[idx], lon[idx]];
  state.mapMarker = L.circleMarker(markerPoint, {
    radius: 8,
    color: "#f8faf7",
    weight: 2,
    fillColor: SERIES_COLORS[1],
    fillOpacity: 0.95,
  }).addTo(state.map);
}

async function refreshCharts() {
  destroyCharts();
  const chartSensors = [...state.selected].filter((id) => {
    const meta = state.session?.sensors?.find((sensor) => sensor.id === id);
    return meta && meta.kind === "timeseries" && !meta.error;
  });

  for (const sensorName of chartSensors) {
    const payload = await loadSensorData(sensorName);
    buildChartCard(sensorName, payload);
  }

  await setupMap();
  PanelLayout.applyOrder();
  resizeCharts();
}

function resizeCharts() {
  for (const [sensorName, chart] of state.charts.entries()) {
    const stage = document.querySelector(
      `.chart-card[data-sensor="${CSS.escape(sensorName)}"] .chart-stage`,
    );
    fitChart(chart, stage);
  }
  state.map?.invalidateSize();
}

function setCurrentTime(t, { source = null } = {}) {
  const clamped = Math.max(0, Math.min(state.duration || 0, t));
  state.currentTime = clamped;
  updateTimelineUi(clamped);

  state.syncingMedia = true;
  for (const element of openMediaElements()) {
    if (element === source || element.readyState < 1) continue;
    if (Math.abs(element.currentTime - clamped) > 0.15) {
      try {
        element.currentTime = clamped;
      } catch {
        // Ignore seeks that arrive before the media element is ready.
      }
    }
  }
  state.syncingMedia = false;

  for (const [sensorName, chart] of state.charts.entries()) {
    const view = state.chartViews.get(sensorName);
    if (!(view?.zoom && applyXRange(chart, view))) chart.redraw();
    updateChartValues(sensorName, state.sensorData.get(sensorName));
  }

  if (state.locationData) {
    const lat = state.locationData.series.latitude || [];
    const lon = state.locationData.series.longitude || [];
    const idx = nearestIndex(state.locationData.times, clamped);
    if (state.mapMarker && Number.isFinite(lat[idx]) && Number.isFinite(lon[idx])) {
      state.mapMarker.setLatLng([lat[idx], lon[idx]]);
    }
  }

  drawEyeOverlay(state.mediaPlayers.get("eye-scene"));
  syncAnnotations();
}

function togglePlay() {
  state.playing = !state.playing;
  updatePlayButtons();

  if (state.playing) {
    state.lastFrame = performance.now();
    for (const element of openMediaElements()) element.play().catch(() => {});
    requestAnimationFrame(tick);
  } else {
    for (const player of state.mediaPlayers.values()) playerElement(player)?.pause();
  }
}

function tick(now) {
  if (!state.playing) return;
  const speed = Number(els.speed.value || 1);
  const dt = ((now - state.lastFrame) / 1000) * speed;
  state.lastFrame = now;

  const driver = openMediaElements().find((element) => !element.paused && !element.ended);
  if (driver) {
    setCurrentTime(driver.currentTime, { source: driver });
  } else {
    setCurrentTime(state.currentTime + dt);
    if (state.duration > 0 && state.currentTime >= state.duration) {
      state.playing = false;
      updatePlayButtons();
      return;
    }
  }

  requestAnimationFrame(tick);
}

async function loadSession(pathValue) {
  const params = new URLSearchParams();
  if (pathValue) params.set("data_path", pathValue);

  const session = await fetchJson(`/api/load?${params.toString()}`, { method: "POST" });
  state.session = session;
  state.duration = session.duration || 0;
  state.sensorData.clear();
  state.chartViews.clear();
  state.currentTime = 0;
  state.playing = false;
  updatePlayButtons();

  setDurationUi(state.duration);
  els.timeline.value = "0";

  setMeta(session);
  renderMediaToggles(session.media?.items || []);
  renderSensorList(session);
  configureMedia(session);
  await refreshCharts();
  await loadEvents();
  setCurrentTime(0);
}

function loadCustomMarks() {
  try {
    const saved = JSON.parse(localStorage.getItem(ANNOTATE_MARKS_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter((mark) => typeof mark === "string" && mark.trim());
  } catch {
    return [];
  }
}

function saveCustomMarks(marks) {
  localStorage.setItem(ANNOTATE_MARKS_KEY, JSON.stringify(marks));
}

function currentEventNames() {
  const saved = localStorage.getItem(EVENT_LIST_KEY);
  if (saved != null) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        return parsed.map((mark) => String(mark).trim()).filter(Boolean);
      }
    } catch {
      // Fall through to the built-in list.
    }
  }
  const custom = loadCustomMarks().filter(
    (mark) => !DEFAULT_MARKS.some((item) => item.toLowerCase() === mark.toLowerCase()),
  );
  return [...DEFAULT_MARKS, ...custom];
}

function saveEventNames(names) {
  localStorage.setItem(EVENT_LIST_KEY, JSON.stringify(names));
}

function renderAnnotationMarks() {
  if (!els.annotateMarks) return;
  const defaults = new Set(DEFAULT_MARKS.map((mark) => mark.toLowerCase()));
  els.annotateMarks.replaceChildren();
  for (const mark of currentEventNames()) {
    els.annotateMarks.append(annotationMarkButton(mark, !defaults.has(mark.toLowerCase())));
  }
}

function annotationMarkButton(mark, removable) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "annotate-mark";
  button.textContent = mark;
  button.title = `Use ${mark}`;
  button.addEventListener("click", () => {
    if (!els.annotateEvent) return;
    els.annotateEvent.value = mark;
    els.annotateEvent.focus();
  });
  if (!removable) return button;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "annotate-mark-remove";
  remove.textContent = "×";
  remove.title = `Remove ${mark}`;
  remove.setAttribute("aria-label", `Remove mark ${mark}`);
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    const next = currentEventNames().filter((item) => item.toLowerCase() !== mark.toLowerCase());
    saveEventNames(next);
    renderAnnotationMarks();
  });
  const wrap = document.createElement("span");
  wrap.className = "annotate-mark";
  button.className = "";
  button.style.border = "none";
  button.style.background = "transparent";
  button.style.padding = "0";
  button.style.color = "inherit";
  button.style.cursor = "pointer";
  button.style.font = "inherit";
  wrap.append(button, remove);
  return wrap;
}

function setAnnotateOpen(open) {
  document.getElementById("layout")?.classList.toggle("annotate-open", open);
  if (els.annotatePanel) els.annotatePanel.hidden = !open;
  els.annotateToggle?.setAttribute("aria-pressed", open ? "true" : "false");
  els.annotateToggle?.setAttribute("aria-label", open ? "Hide annotation panel" : "Show annotation panel");
  if (els.annotateToggle) els.annotateToggle.title = open ? "Hide annotation panel" : "Show annotation panel";
  localStorage.setItem(ANNOTATE_OPEN_KEY, open ? "1" : "0");
  if (open) syncAnnotations(true);
  requestAnimationFrame(resizeCharts);
}

function setSensorsOpen(open) {
  document.getElementById("layout")?.classList.toggle("sensors-closed", !open);
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebar-resizer");
  if (sidebar) sidebar.hidden = !open;
  if (resizer) resizer.hidden = !open;
  els.sensorsToggle?.setAttribute("aria-pressed", open ? "true" : "false");
  const label = open ? "Hide sensors panel" : "Show sensors panel";
  els.sensorsToggle?.setAttribute("aria-label", label);
  if (els.sensorsToggle) els.sensorsToggle.title = label;
  localStorage.setItem(SENSORS_OPEN_KEY, open ? "1" : "0");
  requestAnimationFrame(resizeCharts);
}

function eventsAtStamp(stamp) {
  return state.events.filter((row) => stampSeconds(row.time) === stamp);
}

function renderEventsAtStamp(stamp) {
  if (!els.annotateCurrent) return;
  const rows = eventsAtStamp(stamp);
  els.annotateCurrent.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "annotate-empty";
    empty.textContent = "No events at this time";
    els.annotateCurrent.append(empty);
  } else {
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "annotate-row";
      const load = document.createElement("button");
      load.type = "button";
      load.className = "annotate-row-load";
      const title = document.createElement("strong");
      title.textContent = row.event;
      load.append(title);
      if (row.description) {
        const detail = document.createElement("small");
        detail.textContent = row.description;
        load.append(detail);
      }
      load.addEventListener("click", () => {
        if (els.annotateEvent) els.annotateEvent.value = row.event;
        if (els.annotateDescription) els.annotateDescription.value = row.description;
        annotationFilled = { event: row.event, description: row.description };
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "annotate-row-remove";
      remove.textContent = "×";
      remove.title = "Remove event";
      remove.setAttribute("aria-label", `Remove ${row.event}`);
      remove.addEventListener("click", () => removeEvent(row));
      item.append(load, remove);
      els.annotateCurrent.append(item);
    }
  }

  const typing =
    document.activeElement === els.annotateEvent || document.activeElement === els.annotateDescription;
  if (typing) return;
  if (rows.length) {
    const last = rows[rows.length - 1];
    if (els.annotateEvent) els.annotateEvent.value = last.event;
    if (els.annotateDescription) els.annotateDescription.value = last.description;
    annotationFilled = { event: last.event, description: last.description };
    return;
  }
  if (
    annotationFilled &&
    els.annotateEvent?.value === annotationFilled.event &&
    els.annotateDescription?.value === annotationFilled.description
  ) {
    els.annotateEvent.value = "";
    els.annotateDescription.value = "";
    annotationFilled = null;
  }
}

function syncAnnotations(force = false) {
  const stamp = stampSeconds(state.currentTime);
  if (els.annotateStamp) els.annotateStamp.textContent = formatStamp(stamp);
  if (!force && stamp === annotationStamp) return;
  annotationStamp = stamp;
  renderEventsAtStamp(stamp);
}

async function loadEvents() {
  try {
    const payload = await fetchJson("/api/events");
    state.events = Array.isArray(payload.events) ? payload.events : [];
  } catch {
    state.events = [];
  }
  annotationStamp = null;
  syncAnnotations(true);
}

async function saveEvents() {
  const payload = await fetchJson("/api/events", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: state.events }),
  });
  state.events = Array.isArray(payload.events) ? payload.events : state.events;
}

async function assignEvent() {
  const event = els.annotateEvent?.value.trim() || "";
  if (!event) {
    els.annotateEvent?.focus();
    return;
  }
  const description = els.annotateDescription?.value.trim() || "";
  const time = stampSeconds(state.currentTime);
  const duplicate = state.events.some(
    (row) => stampSeconds(row.time) === time && row.event === event && row.description === description,
  );
  if (duplicate) {
    syncAnnotations(true);
    return;
  }
  const previous = state.events.slice();
  state.events.push({ time, event, description });
  try {
    await saveEvents();
  } catch (error) {
    state.events = previous;
    alert(`Could not save EventTable.csv: ${error.message}`);
    return;
  }
  annotationFilled = { event, description };
  syncAnnotations(true);
}

async function removeEvent(row) {
  const previous = state.events.slice();
  state.events = state.events.filter((item) => item !== row);
  if (state.events.length === previous.length) {
    state.events = previous.filter(
      (item) =>
        !(
          stampSeconds(item.time) === stampSeconds(row.time) &&
          item.event === row.event &&
          item.description === row.description
        ),
    );
  }
  try {
    await saveEvents();
  } catch (error) {
    state.events = previous;
    alert(`Could not update EventTable.csv: ${error.message}`);
    return;
  }
  syncAnnotations(true);
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportEventNames() {
  const names = currentEventNames();
  downloadTextFile("events.txt", names.length ? `${names.join("\n")}\n` : "");
}

function parseEventNameText(text) {
  const names = [];
  const seen = new Set();
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const name = lines[index].trim();
    if (!name) continue;
    if (name.length > 200) throw new Error(`Line ${index + 1} is too long.`);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

async function importEventNames(file) {
  const text = await file.text();
  let names;
  try {
    names = parseEventNameText(text);
  } catch (error) {
    alert(error.message);
    return;
  }
  if (!names.length) {
    alert("That file has no events.");
    return;
  }
  if (currentEventNames().length && !window.confirm("Replace the current events with this file?")) return;
  saveEventNames(names);
  renderAnnotationMarks();
}

function addAnnotationMark() {
  const mark = els.annotateNewMark?.value.trim() || "";
  if (!mark) return;
  const known = currentEventNames();
  if (known.some((item) => item.toLowerCase() === mark.toLowerCase())) {
    if (els.annotateEvent) els.annotateEvent.value = mark;
    els.annotateNewMark.value = "";
    return;
  }
  saveEventNames([...known, mark]);
  els.annotateNewMark.value = "";
  renderAnnotationMarks();
  if (els.annotateEvent) els.annotateEvent.value = mark;
}

function wireEvents() {
  els.reloadBtn.addEventListener("click", () => {
    loadSession(els.dataPath.value.trim()).catch((err) => {
      alert(`Failed to load data: ${err.message}`);
    });
  });

  els.playBtn.addEventListener("click", togglePlay);

  document.addEventListener("fullscreenchange", () => {
    for (const player of state.mediaPlayers.values()) {
      if (!player.fullscreenBtn || !player.stage) continue;
      const on = document.fullscreenElement === player.stage;
      player.fullscreenBtn.setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
    }
  });

  els.timeline.addEventListener("input", () => {
    setCurrentTime(Number(els.timeline.value));
  });

  els.selectAll.addEventListener("click", async () => {
    for (const sensor of state.session.sensors) {
      if (!sensor.error) state.selected.add(sensor.id);
    }
    renderSensorList(state.session);
    await refreshCharts();
  });

  els.selectNone.addEventListener("click", async () => {
    state.selected.clear();
    renderSensorList(state.session);
    await refreshCharts();
  });

  els.sensorSearch?.addEventListener("input", () => {
    if (state.session) renderSensorList(state.session);
  });

  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  window.addEventListener("resize", () => resizeCharts());

  els.zoomAll?.addEventListener("click", () => {
    state.zoomAll = !state.zoomAll;
    applySharedZoom();
  });
  els.zoomWindow?.addEventListener("change", () => {
    const next = Number(els.zoomWindow.value);
    if (!Number.isFinite(next) || next <= 0) {
      els.zoomWindow.value = String(state.zoomWindow);
      return;
    }
    state.zoomWindow = next;
    applySharedZoom();
  });

  els.sensorsToggle?.addEventListener("click", () => {
    setSensorsOpen(els.sensorsToggle.getAttribute("aria-pressed") !== "true");
  });
  els.annotateToggle?.addEventListener("click", () => {
    setAnnotateOpen(els.annotateToggle.getAttribute("aria-pressed") !== "true");
  });
  els.annotateAssign?.addEventListener("click", () => {
    assignEvent().catch((error) => alert(`Could not save EventTable.csv: ${error.message}`));
  });
  els.annotateEvent?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    assignEvent().catch((err) => alert(`Could not save EventTable.csv: ${err.message}`));
  });
  els.annotateExport?.addEventListener("click", exportEventNames);
  els.annotateImport?.addEventListener("click", () => els.annotateImportFile?.click());
  els.annotateImportFile?.addEventListener("change", () => {
    const file = els.annotateImportFile.files?.[0];
    els.annotateImportFile.value = "";
    if (!file) return;
    importEventNames(file).catch((error) => alert(`Could not import events: ${error.message}`));
  });
  els.annotateAddMark?.addEventListener("click", addAnnotationMark);
  els.annotateNewMark?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addAnnotationMark();
  });
}

async function init() {
  syncThemeButton();
  loadCollapsedGroups();
  ensureOpenMedia();
  loadRotations();
  renderAnnotationMarks();
  setSensorsOpen(localStorage.getItem(SENSORS_OPEN_KEY) !== "0");
  setAnnotateOpen(localStorage.getItem(ANNOTATE_OPEN_KEY) === "1");
  PanelLayout.init({
    workspace: els.workspace,
    layout: document.getElementById("layout"),
    resizer: document.getElementById("sidebar-resizer"),
    resetButton: document.getElementById("reset-layout"),
    onResize: resizeCharts,
  });
  wireEvents();
  try {
    const session = await fetchJson("/api/session");
    state.session = session;
    state.duration = session.duration || 0;
    setDurationUi(state.duration);
    setMeta(session);
    renderMediaToggles(session.media?.items || []);
    renderSensorList(session);
    configureMedia(session);
    await refreshCharts();
    await loadEvents();
    setCurrentTime(0);
  } catch {
    els.meta.textContent = "Place Sensor Logger CSV export in Data/, then click Load.";
  }
}

init();
