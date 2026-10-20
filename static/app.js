const SERIES_COLORS = ["#287E8F", "#15CAB6", "#F6B53D", "#EF8A5A", "#E85E76", "#696CB5"];
const THEME_KEY = "capture-app-theme";
const COLLAPSED_GROUPS_KEY = "capture-app-collapsed-groups";
const MEDIA_OPEN_KEY = "capture-app-media-open";
const ROTATION_KEY = "capture-app-video-rotations";
const MAP_TRACK_KEY = "capture-app-map-track";
const FLIP_KEY = "capture-app-video-flips";
const EYE_OVERLAY_KEY = "capture-app-eye-overlay";
const ANNOTATE_OPEN_KEY = "capture-app-annotate-open";
const SENSORS_OPEN_KEY = "capture-app-sensors-open";
const ANNOTATE_MARKS_KEY = "capture-app-annotation-marks";
const EVENT_LIST_KEY = "capture-app-event-names";
const JUMP_KEY = "capture-app-jump-seconds";
const EXPORT_OPEN_KEY = "capture-app-export-open";
const EXPORT_COLLAPSED_KEY = "capture-app-export-collapsed";
const EXPORT_CELL_CONFIRM = 2_000_000;
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
  if (state.syncChart) {
    for (const axisObj of state.syncChart.axes) {
      axisObj.stroke = axis;
      if (axisObj.grid) axisObj.grid.stroke = grid;
    }
    state.syncChart.series[1].stroke = cssVar("--accent");
    state.syncChart.redraw();
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
  mapLayers: null,
  mapMarker: null,
  locationData: null,
  mapTrack: "clean",
  mapView: null,
  mapEdit: null,
  mapDrag: null,
  mapRedraw: null,
  mapPedometer: null,
  syncingMedia: false,
  openMedia: null,
  mediaPlayers: new Map(),
  rotations: {},
  flips: {},
  collapsedGroups: new Set(),
  sensorQuery: "",
  searchCollapsed: new Set(),
  chartViews: new Map(),
  zoomAll: false,
  zoomWindow: 10,
  syncChart: null,
  syncReport: null,
  events: [],
  transcript: null,
  transcriptQuery: "",
  transcriptActive: null,
  transcriptPoll: 0,
  exportSelected: new Set(),
  exportMedia: new Set(),
  exportCollapsed: new Set(),
  exportSearchCollapsed: new Set(),
  exportQuery: "",
};

const els = {
  meta: document.getElementById("recording-meta"),
  dataPath: document.getElementById("data-path"),
  reloadBtn: document.getElementById("reload-btn"),
  sensorList: document.getElementById("sensor-list"),
  sensorSearch: document.getElementById("sensor-search"),
  mediaList: document.getElementById("media-list"),
  transcriptSearch: document.getElementById("transcript-search"),
  transcriptStatus: document.getElementById("transcript-status"),
  transcriptBody: document.getElementById("transcript-body"),
  transcriptAgain: document.getElementById("transcript-again"),
  audio: document.getElementById("audio-player"),
  audioPlaceholder: document.getElementById("audio-placeholder"),
  mapSection: document.getElementById("map-section"),
  mapLegend: document.getElementById("map-legend"),
  mapTrackRaw: document.getElementById("map-track-raw"),
  mapTrackClean: document.getElementById("map-track-clean"),
  mapTrackBoth: document.getElementById("map-track-both"),
  mapMove: document.getElementById("map-move"),
  mapRedraw: document.getElementById("map-redraw"),
  mapEdit: document.getElementById("map-edit"),
  mapEditNote: document.getElementById("map-edit-note"),
  mapEditApply: document.getElementById("map-edit-apply"),
  mapEditCancel: document.getElementById("map-edit-cancel"),
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
  annotatePrev: document.getElementById("annotate-prev"),
  annotateNext: document.getElementById("annotate-next"),
  annotatePrevLabel: document.getElementById("annotate-prev-label"),
  annotateNextLabel: document.getElementById("annotate-next-label"),
  annotateSearch: document.getElementById("annotate-search"),
  annotateSearchResults: document.getElementById("annotate-search-results"),
  jumpBack: document.getElementById("jump-back"),
  jumpForward: document.getElementById("jump-forward"),
  jumpWindow: document.getElementById("jump-window"),
  exportToggle: document.getElementById("export-toggle"),
  exportPanel: document.getElementById("export-panel"),
  exportStreams: document.getElementById("export-streams"),
  exportSearch: document.getElementById("export-search"),
  exportAll: document.getElementById("export-all"),
  exportNone: document.getElementById("export-none"),
  exportStep: document.getElementById("export-step"),
  exportStepField: document.getElementById("export-step-field"),
  exportSamplingStep: document.getElementById("export-sampling-step"),
  exportSamplingNative: document.getElementById("export-sampling-native"),
  exportLayoutCombined: document.getElementById("export-layout-combined"),
  exportLayoutSeparate: document.getElementById("export-layout-separate"),
  exportNote: document.getElementById("export-note"),
  exportFull: document.getElementById("export-full"),
  exportMedia: document.getElementById("export-media"),
  exportModeTime: document.getElementById("export-mode-time"),
  exportModeEvents: document.getElementById("export-mode-events"),
  exportTimeFields: document.getElementById("export-time-fields"),
  exportEventFields: document.getElementById("export-event-fields"),
  exportStart: document.getElementById("export-start"),
  exportEnd: document.getElementById("export-end"),
  exportStartEvent: document.getElementById("export-start-event"),
  exportEndEvent: document.getElementById("export-end-event"),
  exportStartEventBtn: document.getElementById("export-start-event-btn"),
  exportEndEventBtn: document.getElementById("export-end-event-btn"),
  exportStartEventList: document.getElementById("export-start-event-list"),
  exportEndEventList: document.getElementById("export-end-event-list"),
  exportDownload: document.getElementById("export-download"),
  exportStatus: document.getElementById("export-status"),
  syncToggle: document.getElementById("sync-toggle"),
  syncReport: document.getElementById("sync-report"),
  syncBody: document.getElementById("sync-body"),
  syncClose: document.getElementById("sync-close"),
  syncPdf: document.getElementById("sync-pdf"),
  syncMd: document.getElementById("sync-md"),
};

let exportMode = "time";
let exportSampling = "native";
let exportLayout = "combined";
let exportPickerOpen = null;

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

const PENDING_PATH_KEY = "capture-app-pending-path";

async function fetchJson(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
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
  els.meta.textContent = `${device} · ${when} ${tz} · ${formatTime(session.duration)} · ${session.sensors.length} data streams`;
  if (els.dataPath && session.data_dir) els.dataPath.value = session.data_dir;
  if (els.syncToggle) els.syncToggle.disabled = !session.data_dir;
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

function loadFlips() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FLIP_KEY) || "null");
    if (parsed && typeof parsed === "object") {
      state.flips = parsed;
      return;
    }
  } catch {
    // Ignore a damaged saved value and start with no flips.
  }
  state.flips = {};
}

function flipsFor(id) {
  const saved = state.flips[id];
  return {
    h: Boolean(saved && typeof saved === "object" && saved.h),
    v: Boolean(saved && typeof saved === "object" && saved.v),
  };
}

function saveFlips() {
  localStorage.setItem(FLIP_KEY, JSON.stringify(state.flips));
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
  const flips = flipsFor(player.id);
  player.stage.className = "video-stage";
  const transform = `rotate(${rotation}deg) scale(${flips.h ? -1 : 1}, ${flips.v ? -1 : 1})`;
  for (const element of [player.video, player.overlayCanvas]) {
    if (element) element.style.transform = transform;
  }
  if (player.rotationLabel) player.rotationLabel.textContent = `${rotation}°`;
  player.flipH?.setAttribute("aria-pressed", flips.h ? "true" : "false");
  player.flipV?.setAttribute("aria-pressed", flips.v ? "true" : "false");
}

function toggleFlip(player, axis) {
  const flips = flipsFor(player.id);
  flips[axis] = !flips[axis];
  state.flips[player.id] = flips;
  saveFlips();
  applyRotation(player);
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

function setTranscriptOpen(open) {
  ensureOpenMedia();
  if (open) state.openMedia.add("transcript");
  else state.openMedia.delete("transcript");
  localStorage.setItem(MEDIA_OPEN_KEY, JSON.stringify([...state.openMedia]));
  applyTranscriptOpen();
  const checkbox = els.mediaList?.querySelector('input[data-media-id="transcript"]');
  if (checkbox) checkbox.checked = open;
}

function applyTranscriptOpen() {
  const panel = document.getElementById("transcript-panel");
  if (!panel) return;
  panel.hidden = !state.openMedia.has("transcript");
  PanelLayout.placeTranscript();
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
  const transcriptLabel = document.createElement("label");
  transcriptLabel.className = "sensor-item";
  const transcriptBox = document.createElement("input");
  transcriptBox.type = "checkbox";
  transcriptBox.dataset.mediaId = "transcript";
  transcriptBox.checked = state.openMedia.has("transcript");
  transcriptBox.addEventListener("change", () => setTranscriptOpen(transcriptBox.checked));
  const transcriptName = document.createElement("span");
  transcriptName.textContent = "Transcript";
  transcriptLabel.append(transcriptBox, transcriptName);
  els.mediaList.append(transcriptLabel);
  applyTranscriptOpen();
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
  const flipH = document.createElement("button");
  flipH.type = "button";
  flipH.title = "Flip horizontal";
  flipH.textContent = "Flip H";
  flipH.setAttribute("aria-pressed", "false");
  const flipV = document.createElement("button");
  flipV.type = "button";
  flipV.title = "Flip vertical";
  flipV.textContent = "Flip V";
  flipV.setAttribute("aria-pressed", "false");
  rotate.append(rotateLeft, rotationLabel, rotateRight, flipH, flipV);
  header.append(toolbar, rotate);

  const stage = document.createElement("div");
  stage.className = "video-stage";
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
    flipH,
    flipV,
    overlayCanvas,
    gazeBtn,
    fixationBtn,
    showGaze: Boolean(gazeBtn?.getAttribute("aria-pressed") === "true"),
    showFixations: Boolean(fixationBtn?.getAttribute("aria-pressed") === "true"),
    overlayData: null,
  };

  rotateLeft.addEventListener("click", () => rotatePlayer(player, -90));
  rotateRight.addEventListener("click", () => rotatePlayer(player, 90));
  flipH.addEventListener("click", () => toggleFlip(player, "h"));
  flipV.addEventListener("click", () => toggleFlip(player, "v"));
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
  loadFlips();
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

const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.67 4 20.67 12 7.67 20Z"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.4" y="4" width="3.2" height="16" rx="0.5"/><rect x="13.4" y="4" width="3.2" height="16" rx="0.5"/></svg>`;

function updatePlayButtons() {
  const symbol = state.playing ? "❚❚" : "▶";
  if (els.playBtn) {
    els.playBtn.innerHTML = state.playing ? PAUSE_ICON : PLAY_ICON;
    els.playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  }
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

  const columns = (payload.columns || Object.keys(payload.series)).filter((col) => col !== "interpolated");
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
  if ((payload.series.interpolated || []).some((value) => Number(value) === 1)) {
    const note = document.createElement("p");
    note.className = "chart-note";
    note.textContent = "Open circles are interpolated samples.";
    card.append(note);
  }
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
            drawInterpolatedMarks(u, payload, columns);
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
  const columns = (payload.columns || []).filter((col) => col !== "interpolated");
  el.replaceChildren(
    ...columns.map((col, i) => {
      const span = document.createElement("span");
      span.style.color = SERIES_COLORS[i % SERIES_COLORS.length];
      if (view.hidden.has(col)) span.classList.add("is-off");
      const val = payload.series[col]?.[idx];
      const strong = document.createElement("strong");
      strong.textContent = val == null ? "—" : Number(val).toFixed(3);
      span.append(`${col}: `, strong);
      if (col === "Velocity" && Number(payload.series.interpolated?.[idx]) === 1) {
        span.append(" interpolated");
      }
      return span;
    }),
  );
}

function drawInterpolatedMarks(chart, payload, columns) {
  const flags = payload.series?.interpolated;
  const valueKey = columns.includes("Velocity") ? "Velocity" : columns[0];
  if (!flags || !valueKey || chartView(payload.id || "").hidden?.has(valueKey)) return;
  const values = payload.series[valueKey];
  if (!values) return;
  const ctx = chart.ctx;
  ctx.save();
  ctx.strokeStyle = "#c45c26";
  ctx.lineWidth = 1.5;
  const left = chart.bbox.left;
  const right = left + chart.bbox.width;
  const top = chart.bbox.top;
  const bottom = top + chart.bbox.height;
  for (let index = 0; index < payload.times.length; index += 1) {
    if (Number(flags[index]) !== 1 || !Number.isFinite(values[index])) continue;
    const x = chart.valToPos(payload.times[index], "x", true);
    const y = chart.valToPos(values[index], "y", true);
    if (x < left || x > right || y < top || y > bottom) continue;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function selectedMapSensor() {
  return (state.session?.sensors || []).find(
    (sensor) => sensor.kind === "map" && state.selected.has(sensor.id) && !sensor.error,
  );
}

const SPEED_STOPS = [
  [0, [138, 164, 168]],
  [0.5, [40, 126, 143]],
  [1, [196, 92, 38]],
];

function speedColor(speed, min, max) {
  const span = max - min;
  const unit = span <= 0 ? 0.5 : Math.min(1, Math.max(0, (speed - min) / span));
  let lower = SPEED_STOPS[0];
  let upper = SPEED_STOPS[SPEED_STOPS.length - 1];
  for (let index = 1; index < SPEED_STOPS.length; index += 1) {
    if (unit <= SPEED_STOPS[index][0]) {
      lower = SPEED_STOPS[index - 1];
      upper = SPEED_STOPS[index];
      break;
    }
  }
  const local = upper[0] === lower[0] ? 0 : (unit - lower[0]) / (upper[0] - lower[0]);
  const rgb = lower[1].map((channel, index) => Math.round(channel + (upper[1][index] - channel) * local));
  return `rgb(${rgb.join(", ")})`;
}

function bearingIcon(bearing) {
  const rotation = Number.isFinite(bearing) ? bearing : 0;
  return L.divIcon({
    className: "map-bearing-icon",
    html: `<svg class="map-bearing-arrow" viewBox="0 0 24 24" style="transform:rotate(${rotation}deg)" aria-hidden="true"><path d="M12 2.5 19 20.5 12 16.5 5 20.5Z" fill="#1c3d44" stroke="#ffffff" stroke-width="1.4"></path></svg>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function placeBearingMarker(lat, lon, bearing) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const here = [lat, lon];
  if (!state.mapMarker) {
    state.mapMarker = L.marker(here, { icon: bearingIcon(bearing), interactive: false, zIndexOffset: 1000 }).addTo(state.map);
    return;
  }
  state.mapMarker.setLatLng(here);
  state.mapMarker.setIcon(bearingIcon(bearing));
}

function renderSpeedLegend(min, max, hasInterpolated, showRecorded) {
  if (!els.mapLegend) return;
  els.mapLegend.hidden = false;
  els.mapLegend.replaceChildren();
  const top = document.createElement("span");
  top.textContent = max.toFixed(1);
  const bar = document.createElement("div");
  bar.className = "map-legend-bar";
  bar.style.background = `linear-gradient(to top, ${speedColor(min, min, max)}, ${speedColor((min + max) / 2, min, max)}, ${speedColor(max, min, max)})`;
  const bottom = document.createElement("span");
  bottom.textContent = min.toFixed(1);
  const unit = document.createElement("span");
  unit.textContent = "m/s";
  els.mapLegend.append(top, bar, bottom, unit);
  if (showRecorded) {
    const swatch = document.createElement("span");
    swatch.className = "map-legend-swatch";
    const recorded = document.createElement("span");
    recorded.className = "map-legend-note";
    recorded.textContent = "Gray line is recorded";
    els.mapLegend.append(swatch, recorded);
  }
  if (hasInterpolated && state.mapTrack !== "raw") {
    const note = document.createElement("span");
    note.className = "map-legend-note";
    note.textContent = "Dashed line is interpolated";
    els.mapLegend.append(note);
  }
  if (state.mapTrack !== "raw" && state.mapView?.samples?.some((sample) => sample.impossible)) {
    const blocked = document.createElement("span");
    blocked.className = "map-legend-note";
    blocked.textContent = "Red line jumps a building";
    els.mapLegend.append(blocked);
  }
}

function speedSegments(samples, flatColor) {
  const segments = [];
  const minSpeed = state.mapView?.minSpeed ?? 0;
  const maxSpeed = state.mapView?.maxSpeed ?? 1;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const span = maxSpeed - minSpeed;
    const unit = span <= 0 ? 0 : (sample.speed - minSpeed) / span;
    const binned = minSpeed + (Math.round(Math.min(1, Math.max(0, unit)) * 8) / 8) * span;
    const color = flatColor || speedColor(binned, minSpeed, maxSpeed);
    const interpolated = flatColor ? false : sample.interpolated || samples[index - 1].interpolated;
    const previous = segments[segments.length - 1];
    if (previous && previous.color === color && previous.interpolated === interpolated) {
      previous.points.push([sample.lat, sample.lon]);
    } else {
      segments.push({
        color,
        interpolated,
        points: [[samples[index - 1].lat, samples[index - 1].lon], [sample.lat, sample.lon]],
      });
    }
  }
  return segments;
}

function drawTrack(samples, { flatColor = "" } = {}) {
  if (!state.mapLayers || samples.length < 2) return;
  for (const segment of speedSegments(samples, flatColor)) {
    L.polyline(segment.points, {
      color: segment.color,
      weight: segment.interpolated ? 3 : 4,
      opacity: segment.interpolated ? 0.85 : 1,
      dashArray: segment.interpolated ? "2 8" : null,
    }).addTo(state.mapLayers);
  }
}

function renderMapPath({ fit = false } = {}) {
  const view = state.mapView;
  if (!state.map || !state.mapLayers || !view) return;
  state.mapLayers.clearLayers();
  const showRaw = state.mapTrack === "raw" || state.mapTrack === "both";
  const showClean = state.mapTrack !== "raw";
  const rawSamples = showRaw
    ? view.samples
        .filter((sample) => Number.isFinite(sample.rawLat) && Number.isFinite(sample.rawLon))
        .map((sample) => ({ lat: sample.rawLat, lon: sample.rawLon, speed: sample.speed, interpolated: false }))
    : [];
  const cleanSamples = showClean
    ? view.samples.map((sample) => ({
        lat: sample.lat,
        lon: sample.lon,
        speed: sample.speed,
        interpolated: sample.interpolated,
      }))
    : [];
  if (showRaw) drawTrack(rawSamples, { flatColor: state.mapTrack === "both" ? "#4a5560" : "" });
  if (showClean) drawTrack(cleanSamples);
  if (showClean) drawImpossible(view.samples);
  const boundsSource = state.mapTrack === "raw" ? rawSamples : state.mapTrack === "clean" ? cleanSamples : view.samples.flatMap((sample) => {
    const points = [[sample.lat, sample.lon]];
    if (Number.isFinite(sample.rawLat) && Number.isFinite(sample.rawLon)) points.push([sample.rawLat, sample.rawLon]);
    return points;
  });
  const boundPoints = state.mapTrack === "both"
    ? boundsSource
    : boundsSource.map((sample) => [sample.lat, sample.lon]);
  if (fit && boundPoints.length) state.map.fitBounds(boundPoints, { padding: [24, 24] });
  renderSpeedLegend(
    view.minSpeed,
    view.maxSpeed,
    view.samples.some((sample) => sample.interpolated),
    state.mapTrack === "both",
  );
  placeMapMarker();
}

function placeMapMarker() {
  if (!state.locationData) return;
  const rawLat = state.locationData.series.latitude_raw;
  const rawLon = state.locationData.series.longitude_raw;
  const useRaw = state.mapTrack === "raw" && rawLat?.length && rawLon?.length;
  const latSeries = useRaw ? rawLat : state.locationData.series.latitude;
  const lonSeries = useRaw ? rawLon : state.locationData.series.longitude;
  const bearing = state.locationData.series.bearing || [];
  const idx = nearestIndex(state.locationData.times, state.currentTime);
  placeBearingMarker(latSeries?.[idx], lonSeries?.[idx], bearing[idx]);
}

function syncMapTrackButtons() {
  const pressed = {
    raw: state.mapTrack === "raw",
    clean: state.mapTrack === "clean",
    both: state.mapTrack === "both",
  };
  els.mapTrackRaw?.setAttribute("aria-pressed", pressed.raw ? "true" : "false");
  els.mapTrackClean?.setAttribute("aria-pressed", pressed.clean ? "true" : "false");
  els.mapTrackBoth?.setAttribute("aria-pressed", pressed.both ? "true" : "false");
}

function setMapTrack(mode) {
  if (!["raw", "clean", "both"].includes(mode)) return;
  state.mapTrack = mode;
  localStorage.setItem(MAP_TRACK_KEY, mode);
  syncMapTrackButtons();
  renderMapPath({ fit: true });
}

function loadMapTrack() {
  const saved = localStorage.getItem(MAP_TRACK_KEY);
  state.mapTrack = ["raw", "clean", "both"].includes(saved) ? saved : "clean";
  syncMapTrackButtons();
}

function metersBetween(lat1, lon1, lat2, lon2) {
  const radius = 6_371_000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function stepsAt(time) {
  const pedometer = state.mapPedometer;
  const times = pedometer?.times || [];
  const steps = pedometer?.series?.steps || [];
  if (!times.length) return 0;
  if (time <= times[0]) return Number(steps[0]) || 0;
  if (time >= times[times.length - 1]) return Number(steps[times.length - 1]) || 0;
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (times[mid] <= time) low = mid;
    else high = mid;
  }
  const span = times[high] - times[low];
  const weight = span <= 0 ? 0 : (time - times[low]) / span;
  return (Number(steps[low]) || 0) + weight * ((Number(steps[high]) || 0) - (Number(steps[low]) || 0));
}

function stepsBetween(start, end) {
  return Math.max(0, stepsAt(end) - stepsAt(start));
}

function drawImpossible(samples) {
  let points = [];
  const flush = () => {
    if (points.length > 1) {
      L.polyline(points, { color: "#9b2335", weight: 5, opacity: 0.9 }).addTo(state.mapLayers);
    }
    points = [];
  };
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].impossible || samples[index - 1].impossible) {
      if (!points.length) points.push([samples[index - 1].lat, samples[index - 1].lon]);
      points.push([samples[index].lat, samples[index].lon]);
    } else flush();
  }
  flush();
}

function setMapEdit(mode) {
  finishSegmentDrag();
  clearRedrawMarkers();
  state.mapEdit = mode;
  state.mapRedraw = mode === "redraw" ? { start: null, end: null, points: [] } : null;
  els.mapMove?.setAttribute("aria-pressed", mode === "move" ? "true" : "false");
  els.mapRedraw?.setAttribute("aria-pressed", mode === "redraw" ? "true" : "false");
  els.mapSection?.classList.toggle("is-editing", Boolean(mode));
  if (els.mapEdit) els.mapEdit.hidden = !mode;
  if (els.mapEditApply) els.mapEditApply.hidden = mode !== "redraw";
  updateRedrawNote();
}

function updateRedrawNote() {
  if (els.mapEditNote) {
    if (state.mapEdit === "move") {
      els.mapEditNote.textContent = "Drag a point. That straight stretch moves with it, and the ends stay joined.";
    } else if (!state.mapRedraw) {
      els.mapEditNote.textContent = "";
    } else if (state.mapRedraw.start == null) {
      els.mapEditNote.textContent = "Click the path where the bad stretch starts.";
    } else if (state.mapRedraw.end == null) {
      els.mapEditNote.textContent = "Click the path where the bad stretch ends.";
    } else {
      const redraw = state.mapRedraw;
      const samples = state.mapView?.samples || [];
      const walked = stepsBetween(samples[redraw.start].time, samples[redraw.end].time) * (state.stepM || 0.75);
      const route = redrawRoute(redraw);
      let drawn = 0;
      for (let index = 1; index < route.length; index += 1) {
        drawn += metersBetween(route[index - 1][0], route[index - 1][1], route[index][0], route[index][1]);
      }
      els.mapEditNote.textContent = `Pedometer ${walked.toFixed(0)} m. Drawn route ${drawn.toFixed(0)} m. Click the map to add a corner.`;
    }
  }
  const redraw = state.mapRedraw;
  if (els.mapEditApply) els.mapEditApply.disabled = !(redraw && redraw.end != null && redraw.points.length >= 1);
}

function redrawRoute(redraw) {
  const samples = state.mapView.samples;
  return [
    [samples[redraw.start].lat, samples[redraw.start].lon],
    ...redraw.points.map((point) => [point.lat, point.lon]),
    [samples[redraw.end].lat, samples[redraw.end].lon],
  ];
}

function clearRedrawMarkers() {
  for (const marker of state.mapRedraw?.markers || []) state.map?.removeLayer(marker);
  if (state.mapRedraw) state.mapRedraw.markers = [];
}

function sampleNear(containerPoint, pixels) {
  if (!state.map || !state.mapView) return null;
  let best = null;
  let bestDistance = pixels;
  for (let index = 0; index < state.mapView.samples.length; index += 1) {
    const sample = state.mapView.samples[index];
    const point = state.map.latLngToContainerPoint([sample.lat, sample.lon]);
    const distance = Math.hypot(point.x - containerPoint.x, point.y - containerPoint.y);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function bindMapEdits() {
  state.map.on("mousedown", (event) => {
    if (state.mapEdit !== "move" || state.mapTrack === "raw") return;
    const hit = sampleNear(event.containerPoint, 18);
    if (hit == null) return;
    L.DomEvent.stop(event.originalEvent);
    state.map.dragging.disable();
    state.mapDrag = {
      segment: state.mapView.samples[hit].segment,
      start: event.latlng,
      base: state.mapView.samples.map((sample) => ({ lat: sample.lat, lon: sample.lon })),
    };
  });
  state.map.on("mousemove", (event) => {
    if (!state.mapDrag) return;
    shiftSegment(
      state.mapDrag.segment,
      event.latlng.lat - state.mapDrag.start.lat,
      event.latlng.lng - state.mapDrag.start.lng,
      state.mapDrag.base,
    );
    renderMapPath({ fit: false });
  });
  state.map.on("mouseup", finishSegmentDrag);
  document.addEventListener("mouseup", finishSegmentDrag);
  state.map.on("click", (event) => {
    if (state.mapEdit !== "redraw" || state.mapDrag) return;
    const hit = sampleNear(event.containerPoint, 16);
    const redraw = state.mapRedraw;
    if (!redraw) return;
    if (redraw.start == null || redraw.end == null) {
      if (hit == null) return;
      if (redraw.start == null) redraw.start = hit;
      else if (hit !== redraw.start) {
        redraw.end = Math.max(hit, redraw.start);
        redraw.start = Math.min(hit, redraw.start);
      }
      updateRedrawNote();
      return;
    }
    const marker = L.circleMarker(event.latlng, {
      radius: 6,
      color: "#9b2335",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(state.map);
    redraw.markers = redraw.markers || [];
    redraw.markers.push(marker);
    redraw.points.push({ lat: event.latlng.lat, lon: event.latlng.lng });
    updateRedrawNote();
  });
}

function shiftSegment(segment, dLat, dLon, base) {
  const members = [];
  state.mapView.samples.forEach((sample, index) => {
    if (sample.segment === segment) members.push(index);
  });
  if (members.length < 2) return;
  const first = state.mapView.samples[members[0]];
  const last = state.mapView.samples[members[members.length - 1]];
  const blend = 3;
  for (const index of members) {
    const sample = state.mapView.samples[index];
    let edge = 1;
    if (sample.time - first.time < blend) edge = Math.min(edge, (sample.time - first.time) / blend);
    if (last.time - sample.time < blend) edge = Math.min(edge, (last.time - sample.time) / blend);
    const weight = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, edge)));
    sample.lat = base[index].lat + dLat * weight;
    sample.lon = base[index].lon + dLon * weight;
  }
}

function finishSegmentDrag() {
  if (!state.mapDrag) return;
  state.map?.dragging.enable();
  const segment = state.mapDrag.segment;
  const base = state.mapDrag.base;
  state.mapDrag = null;
  let moved = false;
  for (let index = 0; index < state.mapView.samples.length; index += 1) {
    const sample = state.mapView.samples[index];
    if (sample.segment !== segment) continue;
    if (Math.abs(sample.lat - base[index].lat) + Math.abs(sample.lon - base[index].lon) < 1e-8) continue;
    sample.interpolated = true;
    sample.impossible = false;
    moved = true;
  }
  if (moved) reconcileEditedTrack();
  renderMapPath({ fit: false });
}

function pointAlong(route, distance) {
  let walked = 0;
  for (let index = 1; index < route.length; index += 1) {
    const span = metersBetween(route[index - 1][0], route[index - 1][1], route[index][0], route[index][1]);
    if (walked + span >= distance || index === route.length - 1) {
      const weight = span <= 0 ? 0 : Math.max(0, Math.min(1, (distance - walked) / span));
      return {
        lat: route[index - 1][0] + (route[index][0] - route[index - 1][0]) * weight,
        lon: route[index - 1][1] + (route[index][1] - route[index - 1][1]) * weight,
      };
    }
    walked += span;
  }
  return { lat: route[0][0], lon: route[0][1] };
}

function applyRedraw() {
  const redraw = state.mapRedraw;
  const samples = state.mapView?.samples;
  if (!redraw || redraw.start == null || redraw.end == null || redraw.points.length < 1 || !samples) return;
  const route = redrawRoute(redraw);
  let routeLength = 0;
  for (let index = 1; index < route.length; index += 1) {
    routeLength += metersBetween(route[index - 1][0], route[index - 1][1], route[index][0], route[index][1]);
  }
  const start = samples[redraw.start];
  const end = samples[redraw.end];
  const walked = stepsBetween(start.time, end.time);
  for (let index = redraw.start + 1; index < redraw.end; index += 1) {
    const fraction = walked > 0.5
      ? stepsBetween(start.time, samples[index].time) / walked
      : (samples[index].time - start.time) / Math.max(0.001, end.time - start.time);
    const placed = pointAlong(route, fraction * routeLength);
    samples[index].lat = placed.lat;
    samples[index].lon = placed.lon;
    samples[index].interpolated = true;
    samples[index].impossible = false;
  }
  const snapshot = samples.map((sample) => ({ lat: sample.lat, lon: sample.lon }));
  for (let index = redraw.start + 1; index < redraw.end; index += 1) {
    samples[index].lat = (snapshot[index - 1].lat + 2 * snapshot[index].lat + snapshot[index + 1].lat) / 4;
    samples[index].lon = (snapshot[index - 1].lon + 2 * snapshot[index].lon + snapshot[index + 1].lon) / 4;
  }
  for (const corner of redraw.points) {
    let nearest = redraw.start;
    let best = Infinity;
    for (let index = redraw.start; index <= redraw.end; index += 1) {
      const distance = metersBetween(samples[index].lat, samples[index].lon, corner.lat, corner.lon);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    }
    samples[nearest].lat = corner.lat;
    samples[nearest].lon = corner.lon;
  }
  samples[redraw.start].impossible = false;
  samples[redraw.end].impossible = false;
  reconcileEditedTrack();
  setMapEdit(null);
  renderMapPath({ fit: false });
}

function reconcileEditedTrack() {
  const samples = state.mapView?.samples || [];
  const stepM = state.stepM || 0.75;
  const hasSteps = Boolean(state.mapPedometer?.times?.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[Math.max(0, index - 1)];
    const dt = Math.max(sample.time - previous.time, 1e-3);
    const pathSpeed = index === 0 ? 0 : metersBetween(previous.lat, previous.lon, sample.lat, sample.lon) / dt;
    const pedometerSpeed = hasSteps ? (stepsBetween(sample.time - 2, sample.time + 2) * stepM) / 4 : pathSpeed;
    const inconsistent = Math.abs(pathSpeed - pedometerSpeed) > Math.max(0.45, 0.35 * Math.max(pedometerSpeed, pathSpeed));
    sample.speedAdjusted = false;
    if (inconsistent) {
      sample.speed = pedometerSpeed;
      sample.speedInterpolated = true;
      sample.speedAdjusted = true;
      if (Number.isFinite(sample.heading)) sample.bearing = ((sample.heading * 180) / Math.PI + 360) % 360;
    } else if (sample.interpolated) {
      sample.speed = pathSpeed;
      sample.speedInterpolated = true;
      sample.speedAdjusted = true;
    }
  }
  const location = state.locationData;
  const velocity = state.sensorData.get("phone.Velocity");
  for (const sample of samples) {
    if (location) {
      location.series.latitude[sample.index] = sample.lat;
      location.series.longitude[sample.index] = sample.lon;
      location.series.bearing[sample.index] = sample.bearing;
      location.series.interpolated[sample.index] = sample.interpolated ? 1 : 0;
      if (location.series.impossible) location.series.impossible[sample.index] = sample.impossible ? 1 : 0;
    }
    if (velocity && sample.speedAdjusted) {
      velocity.series.Velocity[sample.index] = sample.speed;
      velocity.series.interpolated[sample.index] = sample.speedInterpolated ? 1 : 0;
    }
  }
  const speeds = samples.map((sample) => sample.speed).filter((speed) => Number.isFinite(speed));
  if (state.mapView && speeds.length) {
    state.mapView.minSpeed = Math.min(...speeds);
    state.mapView.maxSpeed = Math.max(...speeds);
  }
  const chart = state.charts.get("phone.Velocity");
  if (velocity && chart) {
    const columns = (velocity.columns || []).filter((column) => column !== "interpolated");
    chart.setData([velocity.times, ...columns.map((column) => velocity.series[column] || [])]);
  }
}

async function setupMap() {
  const mapSensor = selectedMapSensor();
  if (!mapSensor) {
    els.mapSection.hidden = true;
    return;
  }

  const payload = await loadSensorData(mapSensor.id);
  const velocityMeta = (state.session?.sensors || []).find((sensor) => sensor.id === "phone.Velocity" && !sensor.error);
  const velocity = velocityMeta ? await loadSensorData(velocityMeta.id) : null;
  state.locationData = payload;
  els.mapSection.hidden = false;

  const lat = payload.series.latitude || [];
  const lon = payload.series.longitude || [];
  const rawLat = payload.series.latitude_raw || [];
  const rawLon = payload.series.longitude_raw || [];
  const bearing = payload.series.bearing || [];
  const flags = payload.series.interpolated || [];
  const segments = payload.series.segment || [];
  const impossible = payload.series.impossible || [];
  const headings = payload.series.heading || [];
  const speeds = velocity?.series?.Velocity || [];
  const pedometerMeta = (state.session?.sensors || []).find((sensor) => sensor.id === "phone.Pedometer" && !sensor.error);
  state.mapPedometer = pedometerMeta ? await loadSensorData(pedometerMeta.id) : null;
  state.stepM = Number(payload.step_m) || 0.75;
  const samples = [];
  for (let index = 0; index < lat.length; index += 1) {
    if (!Number.isFinite(lat[index]) || !Number.isFinite(lon[index])) continue;
    samples.push({
      index,
      time: payload.times[index],
      lat: lat[index],
      lon: lon[index],
      rawLat: Number.isFinite(rawLat[index]) ? rawLat[index] : lat[index],
      rawLon: Number.isFinite(rawLon[index]) ? rawLon[index] : lon[index],
      bearing: bearing[index],
      heading: Number(headings[index]),
      segment: Number(segments[index]) || 0,
      speed: Number.isFinite(speeds[index]) ? speeds[index] : 0,
      interpolated: Number(flags[index]) === 1,
      impossible: Number(impossible[index]) === 1,
    });
  }

  if (!samples.length) {
    els.mapSection.hidden = true;
    return;
  }

  if (!state.map) {
    state.map = L.map("map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.map);
    state.mapLayers = L.layerGroup().addTo(state.map);
    bindMapEdits();
  }
  state.mapLayers.clearLayers();
  if (state.mapMarker) {
    state.map.removeLayer(state.mapMarker);
    state.mapMarker = null;
  }

  const finiteSpeeds = samples.map((sample) => sample.speed).filter((speed) => Number.isFinite(speed));
  state.mapView = {
    samples,
    minSpeed: finiteSpeeds.length ? Math.min(...finiteSpeeds) : 0,
    maxSpeed: finiteSpeeds.length ? Math.max(...finiteSpeeds) : 1,
  };
  renderMapPath({ fit: true });
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
  if (state.syncChart && state.syncChartHost) fitChart(state.syncChart, state.syncChartHost);
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

  if (state.locationData) placeMapMarker();

  drawEyeOverlay(state.mediaPlayers.get("eye-scene"));
  syncAnnotations();
  highlightTranscript();
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

async function reloadIfAssetsChanged() {
  let payload;
  try {
    const response = await fetch("/api/asset-version", { cache: "no-store" });
    if (!response.ok) return false;
    payload = await response.json();
  } catch {
    return false;
  }
  const current = document.querySelector('meta[name="asset-version"]')?.content || "";
  if (!payload.version || payload.version === current) return false;
  const url = new URL(location.href);
  if (url.searchParams.get("v") === String(payload.version)) return false;
  url.searchParams.set("v", payload.version);
  const path = els.dataPath?.value?.trim();
  if (path) sessionStorage.setItem(PENDING_PATH_KEY, path);
  location.replace(url);
  return true;
}

function renderTranscript() {
  if (!els.transcriptBody || !els.transcriptStatus) return;
  const payload = state.transcript;
  const stateName = payload?.state || "";
  if (els.transcriptAgain) els.transcriptAgain.hidden = stateName !== "done" && stateName !== "error";
  if (stateName === "running" || stateName === "absent") {
    els.transcriptStatus.textContent = "Transcribing the microphone…";
  } else if (stateName === "error") {
    els.transcriptStatus.textContent = payload.error || "Transcription failed.";
  } else if (stateName === "unavailable") {
    els.transcriptStatus.textContent = "No microphone recording";
  } else {
    els.transcriptStatus.textContent = "";
  }
  els.transcriptBody.replaceChildren();
  const query = state.transcriptQuery.trim().toLowerCase();
  for (const line of payload?.lines || []) {
    const spoken = line.kind === "speech" ? (line.words || []).map((word) => word.text).join(" ") : "";
    if (query && !spoken.toLowerCase().includes(query)) continue;
    const row = document.createElement("div");
    row.className = "transcript-line";
    row.append(transcriptStamp(line.start), transcriptStamp(line.end));
    const words = document.createElement("span");
    words.className = "transcript-words";
    if (line.kind === "silence") {
      const silence = document.createElement("span");
      silence.className = "transcript-silence";
      silence.dataset.start = String(line.start);
      silence.dataset.end = String(line.end);
      silence.textContent = "    ";
      words.append(silence);
    } else {
      (line.words || []).forEach((word, index) => {
        if (index) words.append(document.createTextNode(" "));
        const token = document.createElement("span");
        token.className = "transcript-word";
        token.dataset.start = String(word.start);
        token.dataset.end = String(word.end);
        token.textContent = word.text;
        words.append(token);
      });
    }
    row.append(words);
    els.transcriptBody.append(row);
  }
  state.transcriptActive = null;
  highlightTranscript();
}

function transcriptStamp(time) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "transcript-stamp";
  button.dataset.time = String(time);
  button.textContent = formatStamp(time);
  button.title = "Jump to this time";
  button.addEventListener("click", () => setCurrentTime(Number(time)));
  return button;
}

function highlightTranscript() {
  if (!els.transcriptBody) return;
  const time = state.currentTime || 0;
  let active = null;
  for (const node of els.transcriptBody.querySelectorAll("[data-start]")) {
    const start = Number(node.dataset.start);
    const end = Number(node.dataset.end);
    const on = time >= start && time < end;
    node.classList.toggle("is-current", on);
    if (on) active = node;
  }
  if (active && active !== state.transcriptActive) {
    state.transcriptActive = active;
    active.scrollIntoView({ block: "nearest" });
  } else if (!active) {
    state.transcriptActive = null;
  }
}

function applyTranscript(payload) {
  const wasRunning = state.transcript?.state === "running";
  state.transcript = payload;
  renderTranscript();
  if (state.transcriptPoll) window.clearTimeout(state.transcriptPoll);
  state.transcriptPoll = 0;
  if (payload?.state === "running") {
    state.transcriptPoll = window.setTimeout(() => {
      fetchJson("/api/transcript")
        .then(applyTranscript)
        .catch((error) => {
          if (els.transcriptStatus) els.transcriptStatus.textContent = error.message;
        });
    }, 2000);
    return;
  }
  if (payload?.state === "done" && wasRunning) loadEvents().catch(() => {});
}

async function ensureTranscript() {
  if (state.transcriptPoll) window.clearTimeout(state.transcriptPoll);
  state.transcriptPoll = 0;
  const payload = await fetchJson("/api/transcript");
  if (payload.state === "absent") {
    applyTranscript(await fetchJson("/api/transcript", { method: "POST" }));
    return;
  }
  applyTranscript(payload);
}

async function loadSession(pathValue) {
  if (els.dataPath && pathValue) els.dataPath.value = pathValue;
  if (await reloadIfAssetsChanged()) return;
  closeSyncReport();
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
  refreshExportPanel(session);
  configureMedia(session);
  await refreshCharts();
  await loadEvents();
  setCurrentTime(0);
  ensureTranscript().catch((error) => {
    if (els.transcriptStatus) els.transcriptStatus.textContent = error.message;
  });
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
  const label = open ? "Hide data streams" : "Show data streams";
  els.sensorsToggle?.setAttribute("aria-label", label);
  if (els.sensorsToggle) els.sensorsToggle.title = label;
  localStorage.setItem(SENSORS_OPEN_KEY, open ? "1" : "0");
  requestAnimationFrame(resizeCharts);
}

function refreshExportPanel(session) {
  if (els.exportStart) els.exportStart.value = "0";
  const duration = Number(session?.duration) || 0;
  if (els.exportEnd) els.exportEnd.value = String(Math.round(duration * 100) / 100);
  const ids = new Set((session?.sensors || []).map((sensor) => sensor.id));
  for (const id of [...state.exportSelected]) {
    if (!ids.has(id)) state.exportSelected.delete(id);
  }
  renderExportStreams(session);
  renderExportMedia(session);
  renderExportEvents();
  updateExportDownload();
}

function renderExportMedia(session) {
  const root = els.exportMedia;
  if (!root) return;
  const items = session?.media?.items || [];
  const ids = new Set(items.map((item) => item.id));
  for (const id of [...state.exportMedia]) {
    if (!ids.has(id)) state.exportMedia.delete(id);
  }
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "sensor-empty";
    empty.textContent = "No media files in this recording.";
    root.append(empty);
    return;
  }
  for (const item of items) {
    const label = document.createElement("label");
    label.className = "sensor-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.exportMedia.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.exportMedia.add(item.id);
      else state.exportMedia.delete(item.id);
    });
    const text = document.createElement("span");
    text.textContent = item.label;
    label.append(checkbox, text);
    root.append(label);
  }
}

function loadExportCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_COLLAPSED_KEY) || "[]");
    if (!Array.isArray(saved)) return;
    state.exportCollapsed = new Set(saved.filter((item) => typeof item === "string"));
  } catch {
    state.exportCollapsed = new Set();
  }
}

function saveExportCollapsed() {
  localStorage.setItem(EXPORT_COLLAPSED_KEY, JSON.stringify([...state.exportCollapsed]));
}

function exportGroupDomId(group) {
  return `export-group-${group.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

function renderExportStreams(session) {
  const root = els.exportStreams;
  if (!root) return;
  root.replaceChildren();
  const query = (els.exportSearch?.value || "").trim().toLowerCase();
  if (query !== state.exportQuery) {
    state.exportQuery = query;
    state.exportSearchCollapsed = new Set();
  }
  const groups = [];
  let current = null;
  for (const sensor of session?.sensors || []) {
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
    empty.textContent = query ? "No matching streams" : "Load a recording to choose streams.";
    root.append(empty);
    return;
  }
  for (const group of visibleGroups) {
    const collapsed = (query ? state.exportSearchCollapsed : state.exportCollapsed).has(group.name);
    const itemsId = exportGroupDomId(group.name);
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
      const target = query ? state.exportSearchCollapsed : state.exportCollapsed;
      if (target.has(group.name)) target.delete(group.name);
      else target.add(group.name);
      if (!query) saveExportCollapsed();
      renderExportStreams(session);
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
      checkbox.checked = state.exportSelected.has(sensor.id) && !sensor.error;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.exportSelected.add(sensor.id);
        else state.exportSelected.delete(sensor.id);
        updateExportDownload();
      });
      const text = document.createElement("span");
      appendHighlighted(text, sensor.name, query);
      const meta = document.createElement("small");
      meta.textContent = sensor.error ? "error" : `${(sensor.columns || []).length} col`;
      label.append(checkbox, text, meta);
      items.append(label);
    }
    root.append(header, items);
  }
}

function renderExportEvents() {
  const pickers = [
    {
      key: "start",
      input: els.exportStartEvent,
      button: els.exportStartEventBtn,
      list: els.exportStartEventList,
      fallback: 0,
    },
    {
      key: "end",
      input: els.exportEndEvent,
      button: els.exportEndEventBtn,
      list: els.exportEndEventList,
      fallback: Math.max(state.events.length - 1, 0),
    },
  ];
  const previous = pickers.map((picker) => {
    if (!picker.input?.value || !picker.button?.textContent) return "";
    return `${picker.input.value}\n${picker.button.textContent}`;
  });
  for (const [index, picker] of pickers.entries()) {
    if (!picker.input || !picker.button || !picker.list) continue;
    picker.list.replaceChildren();
    if (!state.events.length) {
      picker.input.value = "";
      picker.button.textContent = "No events";
      picker.button.disabled = true;
      picker.list.hidden = true;
      picker.button.setAttribute("aria-expanded", "false");
      continue;
    }
    picker.button.disabled = false;
    for (const row of state.events) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.setAttribute("role", "option");
      const label = `${formatStamp(row.time)} ${row.event}`;
      const value = String(stampSeconds(row.time));
      choice.textContent = label;
      choice.dataset.value = value;
      choice.addEventListener("click", (event) => {
        event.stopPropagation();
        picker.input.value = value;
        picker.button.textContent = label;
        exportPickerOpen = null;
        renderExportEvents();
      });
      picker.list.append(choice);
    }
    const match = [...picker.list.children].findIndex(
      (choice) => `${choice.dataset.value}\n${choice.textContent}` === previous[index],
    );
    const chosen = picker.list.children[match >= 0 ? match : picker.fallback];
    picker.input.value = chosen?.dataset.value || "";
    picker.button.textContent = chosen?.textContent || "No events";
    for (const choice of picker.list.children) {
      choice.setAttribute("aria-selected", choice === chosen ? "true" : "false");
    }
    const open = exportPickerOpen === picker.key;
    picker.list.hidden = !open;
    picker.button.setAttribute("aria-expanded", open ? "true" : "false");
  }
  updateExportDownload();
}

function toggleExportPicker(key) {
  exportPickerOpen = exportPickerOpen === key ? null : key;
  renderExportEvents();
  const list = key === "start" ? els.exportStartEventList : els.exportEndEventList;
  if (exportPickerOpen === key) list?.scrollIntoView({ block: "nearest" });
}

function exportBounds() {
  const step = Number(els.exportStep?.value);
  if (exportMode === "events") {
    return {
      start: Number(els.exportStartEvent?.value),
      end: Number(els.exportEndEvent?.value),
      step,
    };
  }
  return {
    start: Number(els.exportStart?.value),
    end: Number(els.exportEnd?.value),
    step,
  };
}

function updateExportDownload() {
  const bounds = exportBounds();
  const stepOk = exportSampling === "native" || (Number.isFinite(bounds.step) && bounds.step > 0);
  const ok = state.exportSelected.size > 0
    && Number.isFinite(bounds.start)
    && Number.isFinite(bounds.end)
    && stepOk;
  if (els.exportDownload) els.exportDownload.disabled = !ok;
}

function setExportSampling(mode) {
  exportSampling = mode === "native" ? "native" : "step";
  els.exportSamplingStep?.setAttribute("aria-pressed", exportSampling === "step" ? "true" : "false");
  els.exportSamplingNative?.setAttribute("aria-pressed", exportSampling === "native" ? "true" : "false");
  if (els.exportStepField) els.exportStepField.hidden = exportSampling === "native";
  updateExportDownload();
}

function setExportLayout(mode) {
  exportLayout = mode === "separate" ? "separate" : "combined";
  els.exportLayoutCombined?.setAttribute("aria-pressed", exportLayout === "combined" ? "true" : "false");
  els.exportLayoutSeparate?.setAttribute("aria-pressed", exportLayout === "separate" ? "true" : "false");
  if (els.exportNote) {
    els.exportNote.textContent = exportLayout === "separate"
      ? "One CSV for each selected stream, downloaded together."
      : "One CSV for the selected streams. A cell stays blank when that stream has no sample on the row.";
  }
}

function setExportFull() {
  setExportMode("time");
  if (els.exportStart) els.exportStart.value = "0";
  const duration = Number(state.session?.duration) || 0;
  if (els.exportEnd) els.exportEnd.value = String(Math.round(duration * 100) / 100);
  updateExportDownload();
}

function setExportMode(mode) {
  exportMode = mode === "events" ? "events" : "time";
  els.exportModeTime?.setAttribute("aria-pressed", exportMode === "time" ? "true" : "false");
  els.exportModeEvents?.setAttribute("aria-pressed", exportMode === "events" ? "true" : "false");
  if (els.exportTimeFields) els.exportTimeFields.hidden = exportMode !== "time";
  if (els.exportEventFields) els.exportEventFields.hidden = exportMode !== "events";
  updateExportDownload();
}

function samplesInRange(sensor, start, end) {
  const count = Number(sensor?.row_count) || 0;
  const first = Number(sensor?.time_min);
  const last = Number(sensor?.time_max);
  if (!count || !Number.isFinite(first) || !Number.isFinite(last) || last <= first) return count;
  const overlap = Math.max(0, Math.min(end, last) - Math.max(start, first));
  return Math.ceil(count * Math.min(1, overlap / (last - first)));
}

function exportCellEstimate(start, end, step) {
  const span = Math.max(end, start) - Math.min(end, start);
  const stepRows = Math.floor(span / step + 1e-9) + 1;
  if (exportLayout === "separate") {
    let cells = 0;
    let rows = 0;
    let columns = 1;
    for (const id of state.exportSelected) {
      const sensor = state.session?.sensors?.find((item) => item.id === id);
      const streamColumns = Math.max((sensor?.columns || []).length, 1);
      const streamRows = exportSampling === "native"
        ? Math.max(samplesInRange(sensor, start, end), 1)
        : stepRows;
      rows += streamRows;
      columns = Math.max(columns, streamColumns + 1);
      cells += streamRows * (streamColumns + 1);
    }
    return { rows, columns, cells };
  }
  let columns = 1;
  let rows = 0;
  if (exportSampling === "native") {
    for (const id of state.exportSelected) {
      const sensor = state.session?.sensors?.find((item) => item.id === id);
      columns += Math.max((sensor?.columns || []).length, 1);
      rows += samplesInRange(sensor, start, end);
    }
    rows = Math.max(rows, 1);
  } else {
    rows = stepRows;
    for (const id of state.exportSelected) {
      const sensor = state.session?.sensors?.find((item) => item.id === id);
      columns += Math.max((sensor?.columns || []).length, 1);
    }
  }
  return { rows, columns, cells: rows * columns };
}

async function downloadExport() {
  const bounds = exportBounds();
  const native = exportSampling === "native";
  if (!native && (!Number.isFinite(bounds.step) || bounds.step <= 0)) return;
  let { start, end } = bounds;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  if (end < start) [start, end] = [end, start];
  const estimate = exportCellEstimate(start, end, bounds.step);
  if (estimate.cells > EXPORT_CELL_CONFIRM) {
    const proceed = window.confirm(
      `This export is about ${estimate.rows.toLocaleString()} rows and ${estimate.columns.toLocaleString()} columns. Download it anyway?`,
    );
    if (!proceed) return;
  }
  const media = [...state.exportMedia];
  const separate = exportLayout === "separate" && state.exportSelected.size > 1;
  if (els.exportStatus) {
    if (separate && media.length) els.exportStatus.textContent = "Building one CSV per stream and trimming media…";
    else if (separate) els.exportStatus.textContent = "Building one CSV per stream…";
    else if (media.length) els.exportStatus.textContent = "Building CSV and trimming media…";
    else els.exportStatus.textContent = "Building CSV…";
  }
  if (els.exportDownload) els.exportDownload.disabled = true;
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streams: [...state.exportSelected],
        start,
        end,
        step: native ? undefined : bounds.step,
        sampling: native ? "native" : "step",
        layout: exportLayout === "separate" ? "separate" : "combined",
        media,
      }),
    });
    if (!response.ok) {
      let message = `Export failed (${response.status})`;
      try {
        const payload = await response.json();
        if (typeof payload.detail === "string") message = payload.detail;
      } catch {
        /* keep the status message */
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
    const filename = match?.[1] || `streams_${start.toFixed(2)}_${end.toFixed(2)}.csv`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    const mediaNote = response.headers.get("X-Export-Media") === "none"
      ? " No media files were found to trim."
      : "";
    if (els.exportStatus) els.exportStatus.textContent = `Downloaded ${filename}${mediaNote}`;
  } catch (error) {
    if (els.exportStatus) els.exportStatus.textContent = error.message;
    alert(error.message);
  } finally {
    updateExportDownload();
  }
}

function setExportOpen(open) {
  document.getElementById("layout")?.classList.toggle("export-open", open);
  if (els.exportPanel) els.exportPanel.hidden = !open;
  els.exportToggle?.setAttribute("aria-pressed", open ? "true" : "false");
  els.exportToggle?.setAttribute("aria-label", open ? "Hide export panel" : "Show export panel");
  if (els.exportToggle) els.exportToggle.title = open ? "Hide export panel" : "Show export panel";
  localStorage.setItem(EXPORT_OPEN_KEY, open ? "1" : "0");
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

function annotationGroups() {
  const groups = [];
  const rows = state.events
    .map((row, index) => ({ row, index }))
    .sort((a, b) => stampSeconds(a.row.time) - stampSeconds(b.row.time) || a.index - b.index);
  for (const { row } of rows) {
    const time = stampSeconds(row.time);
    const last = groups[groups.length - 1];
    if (last && last.time === time) last.rows.push(row);
    else groups.push({ time, rows: [row] });
  }
  return groups;
}

function neighborGroups() {
  const now = stampSeconds(state.currentTime);
  let previous = null;
  let next = null;
  for (const group of annotationGroups()) {
    if (group.time < now) previous = group;
    else if (group.time > now && !next) next = group;
  }
  return { previous, next };
}

function neighborText(group) {
  if (!group) return "";
  return `${formatStamp(group.time)} ${group.rows.map((row) => row.event).join(", ")}`;
}

function setNeighbor(button, input, group) {
  if (button) button.disabled = !group;
  if (!input) return;
  const text = neighborText(group);
  input.value = text;
  input.title = text;
}

function renderAnnotationNeighbors() {
  const { previous, next } = neighborGroups();
  setNeighbor(els.annotatePrev, els.annotatePrevLabel, previous);
  setNeighbor(els.annotateNext, els.annotateNextLabel, next);
}

function jumpToNeighbor(direction) {
  const { previous, next } = neighborGroups();
  const group = direction < 0 ? previous : next;
  if (group) setCurrentTime(group.time);
}

function renderAnnotationSearch() {
  const box = els.annotateSearchResults;
  if (!box) return;
  const query = els.annotateSearch?.value.trim().toLowerCase() || "";
  box.replaceChildren();
  if (!query) return;
  const matches = [];
  for (const group of annotationGroups()) {
    for (const row of group.rows) {
      const haystack = `${row.event} ${row.description || ""}`.toLowerCase();
      if (haystack.includes(query)) matches.push(row);
    }
  }
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "annotate-empty";
    empty.textContent = "No matching events";
    box.append(empty);
    return;
  }
  for (const row of matches.slice(0, 40)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "annotate-search-hit";
    const title = document.createElement("strong");
    title.textContent = `${formatStamp(row.time)}  ${row.event}`;
    button.append(title);
    if (row.description) {
      const detail = document.createElement("small");
      detail.textContent = row.description;
      button.append(detail);
    }
    button.addEventListener("click", () => setCurrentTime(row.time));
    box.append(button);
  }
}

function jumpSeconds() {
  const value = Number(els.jumpWindow?.value);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

function updateJumpLabels() {
  const seconds = jumpSeconds();
  const label = Number.isInteger(seconds) ? String(seconds) : String(seconds);
  if (els.jumpBack) {
    const title = `Jump backward ${label} seconds`;
    els.jumpBack.title = title;
    els.jumpBack.setAttribute("aria-label", title);
  }
  if (els.jumpForward) {
    const title = `Jump forward ${label} seconds`;
    els.jumpForward.title = title;
    els.jumpForward.setAttribute("aria-label", title);
  }
}

function jumpBy(direction) {
  setCurrentTime(state.currentTime + direction * jumpSeconds());
}

function syncAnnotations(force = false) {
  const stamp = stampSeconds(state.currentTime);
  if (els.annotateStamp) els.annotateStamp.textContent = formatStamp(stamp);
  renderAnnotationNeighbors();
  if (!force && stamp === annotationStamp) return;
  annotationStamp = stamp;
  renderEventsAtStamp(stamp);
  if (force) renderAnnotationSearch();
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
  renderExportEvents();
}

async function saveEvents() {
  const payload = await fetchJson("/api/events", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: state.events }),
  });
  state.events = Array.isArray(payload.events) ? payload.events : state.events;
  renderExportEvents();
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

let syncGeneration = 0;

function syncNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatSyncClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatSyncMs(value, digits) {
  if (!Number.isFinite(value)) return "—";
  const text = Math.abs(value).toFixed(digits);
  return value < 0 ? `−${text} ms` : `${text} ms`;
}

function formatSyncRange(low, high) {
  const bound = (value) => {
    const rounded = Math.round(value);
    if (rounded < 0) return `−${Math.abs(rounded)}`;
    if (rounded > 0) return `+${rounded}`;
    return "0";
  };
  return `${bound(low)} to ${bound(high)} ms`;
}

function syncMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function syncRelation(seconds, digits) {
  const word = seconds < 0 ? "before" : "after";
  return `${Math.abs(seconds).toFixed(digits)} s ${word}`;
}

function destroySyncChart() {
  if (state.syncChart) {
    state.syncChart.destroy();
    state.syncChart = null;
  }
  state.syncChartHost = null;
}

function closeSyncReport() {
  syncGeneration += 1;
  destroySyncChart();
  state.syncReport = null;
  if (els.workspace) els.workspace.hidden = false;
  if (els.syncReport) els.syncReport.hidden = true;
  if (els.syncPdf) els.syncPdf.disabled = true;
  if (els.syncMd) els.syncMd.disabled = true;
  if (els.syncToggle) els.syncToggle.disabled = !state.session?.data_dir;
  resizeCharts();
}

function openSyncShell(message) {
  destroySyncChart();
  state.syncReport = null;
  if (els.workspace) els.workspace.hidden = true;
  if (els.syncReport) els.syncReport.hidden = false;
  if (els.syncPdf) els.syncPdf.disabled = true;
  if (els.syncMd) els.syncMd.disabled = true;
  els.syncBody?.replaceChildren(syncNode("p", null, message));
}

function buildSyncView(report) {
  const clocks = report.clocks || {};
  const emotibit = report.emotibit || {};
  const audio = report.audio || {};
  const recording = clocks.recording || "recording";
  const hasAudio = Number.isFinite(audio.offset_median_ms) && (audio.windows_kept || 0) >= 3;
  const kept = (audio.series || []).filter((row) => row.kept && Number.isFinite(row.lag_ms));
  const half = Number.isFinite(audio.peak_half_width_p95_ms)
    ? audio.peak_half_width_p95_ms
    : Number.isFinite(audio.interval_high_ms) && Number.isFinite(audio.interval_low_ms)
      ? (audio.interval_high_ms - audio.interval_low_ms) / 2
      : null;
  const emotiSpan = Number.isFinite(emotibit.window_start_phone_s) && Number.isFinite(emotibit.window_end_phone_s)
    ? `${formatSyncClock(emotibit.window_start_phone_s)}–${formatSyncClock(emotibit.window_end_phone_s)}`
    : "its sync window";
  const extraMs = Number.isFinite(emotibit.rate_error_s_per_s) && Number.isFinite(emotibit.seconds_after_last_packet)
    ? Math.abs(emotibit.rate_error_s_per_s) * emotibit.seconds_after_last_packet * 1000
    : null;
  const extraLow = extraMs == null ? null : emotibit.interval_low_ms - extraMs;
  const extraHigh = extraMs == null ? null : emotibit.interval_high_ms + extraMs;
  const span = audio.kept_span_s || [];
  const spanMinutes = span.length === 2 ? Math.max(1, Math.round((span[1] - span[0]) / 60)) : null;
  const driftMagnitude = Number.isFinite(audio.drift_across_kept_span_ms)
    ? `${Math.abs(audio.drift_across_kept_span_ms).toFixed(2)} ms`
    : "—";
  const driftLabel = spanMinutes ? `Audio drift over ${spanMinutes} min` : "Audio drift";
  const windowSeconds = Number.isFinite(emotibit.window_duration_s) ? Math.round(emotibit.window_duration_s) : null;
  const halfText = half == null ? "the measured spread" : `±${half.toFixed(1)} ms`;
  const lead = hasAudio
    ? `A sound at phone time x is in the scene-camera file at x ${audio.offset_median_ms < 0 ? "−" : "+"} ${Math.abs(audio.offset_median_ms).toFixed(1)} ms, within about ${halfText}. The scene video uses that same offset. EmotiBit was measured on a separate ${windowSeconds == null ? "window" : `${windowSeconds}-second window`} and does not share this interval.`
    : `The phone and scene audio did not produce a lag estimate. ${audio.claim || ""} EmotiBit was measured on a separate window and does not share an interval with the scene recording.`.replace(/\s+/g, " ");

  const phoneHalf = Number.isFinite(clocks.phone_quantization_half_ms) ? Math.round(clocks.phone_quantization_half_ms) : 5;
  const frameHalf = Number.isFinite(clocks.scene_frame_period_ms) ? Math.round(clocks.scene_frame_period_ms / 2) : 17;
  const frameSpreadUs = Number.isFinite(clocks.scene_frame_dt_p95_ms) && Number.isFinite(clocks.scene_frame_dt_p05_ms)
    ? (clocks.scene_frame_dt_p95_ms - clocks.scene_frame_dt_p05_ms) * 1000
    : null;
  const driftCell = hasAudio && spanMinutes
    ? `${formatSyncMs(audio.drift_across_kept_span_ms, 2).replace(" ms", "")} ms over ${spanMinutes} min`
    : "—";
  const coverage = span.length === 2 ? `${(span[0] / 60).toFixed(1)}–${(span[1] / 60).toFixed(1)} min` : "—";
  const rateClear = Number.isFinite(emotibit.rate_error_ppm)
    && Number.isFinite(emotibit.rate_error_se_ppm)
    && Math.abs(emotibit.rate_error_ppm) > 2 * Math.abs(emotibit.rate_error_se_ppm);
  const rateText = Number.isFinite(emotibit.rate_error_ppm)
    ? `${emotibit.rate_error_ppm < 0 ? "−" : ""}${Math.abs(emotibit.rate_error_ppm).toFixed(0)} ± ${Math.abs(emotibit.rate_error_se_ppm || 0).toFixed(0)} ppm`
    : "—";

  const rows = [
    ["Phone sensors, time vs elapsed", "0", `±${phoneHalf} ms`, "None", "Whole recording"],
    [
      "Scene video vs its frame clock",
      "Matched",
      `±${frameHalf} ms (${Number(clocks.scene_time_stamps || 0).toLocaleString()} stamps, ${Number(clocks.scene_video_frames || 0).toLocaleString()} pictures)`,
      frameSpreadUs != null && frameSpreadUs < 10 ? "None (about 1 µs spacing)" : "None",
      "Whole scene video",
    ],
    hasAudio
      ? ["Phone mic vs scene audio", formatSyncMs(audio.offset_median_ms, 1), half == null ? "—" : `±${half.toFixed(1)} ms`, driftCell, coverage]
      : ["Phone mic vs scene audio", "No estimate", "—", "—", "—"],
    [
      "Gaze overlay vs scene frames",
      Number.isFinite(clocks.info_json_minus_first_frame_s) ? `${clocks.info_json_minus_first_frame_s < 0 ? "−" : ""}${Math.abs(clocks.info_json_minus_first_frame_s).toFixed(2)} s` : "—",
      "Player origin",
      "Not a clock wander",
      "Whole overlay",
    ],
    [
      "EmotiBit vs host clock",
      formatSyncMs(emotibit.residual_median_ms, 1),
      Number.isFinite(emotibit.interval_low_ms) ? formatSyncRange(emotibit.interval_low_ms, emotibit.interval_high_ms) : "—",
      rateText,
      emotiSpan,
    ],
    [
      "EmotiBit after the last packet",
      "Same fit",
      extraLow == null ? "—" : `about ${formatSyncRange(extraLow, extraHigh)}`,
      "Extrapolated",
      Number.isFinite(emotibit.window_end_phone_s) ? `${formatSyncClock(emotibit.window_end_phone_s)} to end of EmotiBit` : "After the last packet",
    ],
  ];

  const pears = kept.map((row) => row.pearson).filter((value) => Number.isFinite(value));
  const lags = kept.map((row) => row.lag_ms);
  const widths = kept.map((row) => row.peak_half_width_ms).filter((value) => Number.isFinite(value));
  const typicalWidth = syncMedian(widths);
  const widest = widths.length ? Math.max(...widths) : null;
  let audioBody = audio.claim || "No audio comparison was available.";
  if (hasAudio && pears.length && lags.length && half != null && typicalWidth != null) {
    audioBody = `Each point is the peak lag of a ${audio.window_s}-second window, stepped every ${audio.hop_s} seconds. Lag is scene-file time minus phone-file time for the same sound. ${audio.windows_kept} of ${audio.windows} windows correlated (${Math.min(...pears).toFixed(2)} to ${Math.max(...pears).toFixed(2)}). Their lags span ${formatSyncMs(Math.min(...lags), 2)} to ${formatSyncMs(Math.max(...lags), 2)}. A typical peak is ±${typicalWidth.toFixed(1)} ms wide; 95% are within ±${half.toFixed(1)} ms.`;
    if (widest != null && widest > Math.max(10, (half || 0) * 4)) {
      audioBody += ` One window was ±${widest.toFixed(0)} ms wide, and its lag still landed on the same offset.`;
    }
  }
  const ahead = hasAudio ? -audio.offset_median_ms : null;
  const frameMs = Number.isFinite(clocks.scene_first_frame_offset_s) ? clocks.scene_first_frame_offset_s * 1000 : null;
  const playerNote = hasAudio && frameMs != null
    ? `The horizontal axis is minutes from the phone recording epoch. The first scene frame is ${Math.abs(frameMs).toFixed(1)} ms ${frameMs < 0 ? "before" : "after"} that epoch, which matches this audio offset to ${Math.abs(frameMs + audio.offset_median_ms).toFixed(2)} ms. The player treats file time and phone time as the same number, so at a given slider position the scene picture is ${Math.abs(ahead).toFixed(0)} ms ${ahead >= 0 ? "ahead of" : "behind"} the phone sensors.`
    : "";
  const clockNote = `Phone time and seconds_elapsed differ by at most ${Number(clocks.phone_time_vs_elapsed_max_abs_ms || 0).toFixed(4)} ms, so the phone has no separate drift. The interval inside a phone stream at this sample period is half a sample, ±${phoneHalf} ms. Scene frames are ${Number(clocks.scene_frame_period_ms || 0).toFixed(3)} ms apart${frameSpreadUs == null ? "" : `, with about ${Math.max(1, Math.round(frameSpreadUs))} µs of variation`}. The frame file has ${Number(clocks.scene_time_stamps || 0).toLocaleString()} timestamps and the video has ${Number(clocks.scene_video_frames || 0).toLocaleString()} pictures.`;
  const gazeBody = `info.json start_time is ${syncRelation(clocks.info_json_offset_s, 3)} the phone epoch and ${syncRelation(clocks.info_json_minus_first_frame_s, 2)} the first scene frame. The overlay follows that start time, so a gaze point is drawn on a different clock from the frame it belongs to. This is how the player defines time.`;
  const dropped = Array.isArray(emotibit.dropped_rtt_ms) ? emotibit.dropped_rtt_ms : [];
  const droppedMedian = syncMedian(dropped);
  const droppedSentence = dropped.length
    ? `${dropped.length} round trips of about ${(droppedMedian / 1000).toFixed(1)} s were dropped. `
    : "";
  const emotibitNote = `Twenty-five exchanges run from ${emotibit.window_start_denver || "—"} to ${emotibit.window_end_denver || "—"} Denver (phone elapsed ${Number(emotibit.window_start_phone_s || 0).toFixed(0)}–${Number(emotibit.window_end_phone_s || 0).toFixed(0)} s). ${droppedSentence}The other ${emotibit.packets_kept ?? "—"} have a median round trip of ${Number(emotibit.rtt_kept_median_ms || 0).toFixed(0)} ms. A host time of x matches the device clock within ${Number.isFinite(emotibit.interval_low_ms) ? formatSyncRange(emotibit.interval_low_ms, emotibit.interval_high_ms) : "—"} in that window. The fitted rate is ${rateText}${rateClear ? "." : ", close enough to the sync map that a rate error is not separately visible in that window."}`;
  const extraBody = extraLow == null
    ? "The packets do not support an extrapolation."
    : `The packets stop with about ${Math.round(emotibit.seconds_after_last_packet).toLocaleString()} s of EmotiBit data still ahead. Carrying the fitted rate across that gap widens the interval to about ${formatSyncRange(extraLow, extraHigh)}. That wider range was not measured.`;

  return {
    recording,
    title: `Synchronization on ${recording}`,
    lead,
    pairIntro: `An event at time x in the first stream is expected in the second at x + offset. The interval is around that, and only for the span in the last column. Phone epoch is ${clocks.phone_epoch_denver || "—"} Denver.`,
    stats: [
      { value: hasAudio ? formatSyncMs(audio.offset_median_ms, 1) : "No estimate", label: "Scene file minus phone file" },
      { value: hasAudio && half != null ? `±${half.toFixed(1)} ms` : "—", label: "Where one scene sound lands" },
      { value: hasAudio ? driftMagnitude : "—", label: driftLabel },
      {
        value: Number.isFinite(emotibit.interval_low_ms) ? formatSyncRange(emotibit.interval_low_ms, emotibit.interval_high_ms) : "—",
        label: `EmotiBit, ${emotiSpan}`,
      },
    ],
    rows,
    tones: ["ok", "info", hasAudio ? "ok" : "warn", "warn", "info", "warn"],
    audioTitle: "Phone microphone and scene audio",
    audioBody,
    playerNote,
    showChart: hasAudio,
    medianLag: hasAudio ? audio.offset_median_ms : null,
    clockNote,
    gazeTitle: "Gaze overlay uses a different origin",
    gazeBody,
    emotibitNote: emotibit.packets ? emotibitNote.replace("Twenty-five", `${emotibit.packets}`) : emotibitNote,
    extraTitle: "After the measured window this is an extrapolation",
    extraBody,
    lagRows: audio.series || [],
  };
}

function syncMarkdown(view) {
  const cell = (value) => String(value).replaceAll("|", "\\|");
  const lines = [
    `# ${view.title}`,
    "",
    view.lead,
    "",
    "## Figures",
    "",
    ...view.stats.map((stat) => `- **${stat.value}** — ${stat.label}`),
    "",
    "## Offset and interval by pair",
    "",
    view.pairIntro,
    "",
    "| Pair | Offset | Interval | Drift | Coverage |",
    "| --- | --- | --- | --- | --- |",
    ...view.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
    `## ${view.audioTitle}`,
    "",
    view.audioBody,
  ];
  if (view.playerNote) lines.push("", view.playerNote);
  if (view.lagRows.length) {
    lines.push("", "| Phone time (s) | Lag (ms) | Pearson | Kept |", "| ---: | ---: | ---: | --- |");
    for (const row of view.lagRows) {
      lines.push(`| ${row.phone_s} | ${Number(row.lag_ms).toFixed(3)} | ${row.pearson} | ${row.kept ? "yes" : "no"} |`);
    }
  }
  lines.push(
    "",
    "## Clocks already in the files",
    "",
    view.clockNote,
    "",
    `**${view.gazeTitle}.** ${view.gazeBody}`,
    "",
    "## EmotiBit sync packets",
    "",
    view.emotibitNote,
    "",
    `**${view.extraTitle}.** ${view.extraBody}`,
    "",
  );
  return lines.join("\n");
}

function renderSyncReport(report) {
  destroySyncChart();
  const view = buildSyncView(report);
  const safeName = String(view.recording).replace(/[^\w.-]+/g, "_");
  state.syncReport = { markdown: syncMarkdown(view), filename: `sync_${safeName}.md` };
  const body = els.syncBody;
  body.replaceChildren();
  body.append(syncNode("h2", null, view.title), syncNode("p", null, view.lead));
  const stats = syncNode("div", "sync-stats");
  for (const stat of view.stats) {
    const card = syncNode("div", "sync-stat");
    card.append(syncNode("strong", null, stat.value), syncNode("span", null, stat.label));
    stats.append(card);
  }
  body.append(stats, syncNode("h3", null, "Offset and interval by pair"), syncNode("p", null, view.pairIntro));
  const table = document.createElement("table");
  table.className = "sync-table";
  const head = document.createElement("tr");
  for (const label of ["Pair", "Offset", "Interval", "Drift", "Coverage"]) head.append(syncNode("th", null, label));
  const thead = document.createElement("thead");
  thead.append(head);
  const tbody = document.createElement("tbody");
  view.rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    if (view.tones[index]) tr.className = `sync-${view.tones[index]}`;
    for (const value of row) tr.append(syncNode("td", null, value));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  body.append(table, syncNode("h3", null, view.audioTitle), syncNode("p", null, view.audioBody));
  if (view.showChart) {
    const host = syncNode("div", "sync-chart");
    body.append(host);
    state.syncChartHost = host;
    mountSyncChart(host, view.lagRows, view.medianLag);
    if (view.playerNote) body.append(syncNode("p", "sync-note", view.playerNote));
  }
  body.append(syncNode("h3", null, "Clocks already in the files"), syncNode("p", null, view.clockNote));
  const gaze = syncNode("div", "sync-callout");
  gaze.append(syncNode("strong", null, view.gazeTitle), syncNode("p", null, view.gazeBody));
  body.append(gaze, syncNode("h3", null, "EmotiBit sync packets"), syncNode("p", null, view.emotibitNote));
  const extra = syncNode("div", "sync-callout");
  extra.append(syncNode("strong", null, view.extraTitle), syncNode("p", null, view.extraBody));
  body.append(extra);
  if (els.syncPdf) els.syncPdf.disabled = false;
  if (els.syncMd) els.syncMd.disabled = false;
}

function mountSyncChart(host, series, median) {
  destroySyncChart();
  state.syncChartHost = host;
  const kept = series.filter((row) => row.kept && Number.isFinite(row.lag_ms) && Number.isFinite(row.phone_s));
  if (kept.length < 3 || typeof uPlot === "undefined") return;
  const times = kept.map((row) => row.phone_s);
  const lags = kept.map((row) => row.lag_ms);
  const span = Math.max(...lags) - Math.min(...lags);
  const digits = span < 0.2 ? 3 : span < 2 ? 2 : 1;
  state.syncChart = new uPlot(
    {
      width: Math.max(320, host.clientWidth || 640),
      height: 240,
      legend: { show: false },
      cursor: { drag: { x: false, y: false, setScale: false } },
      series: [{}, { label: "Scene minus phone", stroke: cssVar("--accent"), width: 1.5 }],
      axes: [
        { ...chartAxisStyle(), values: (_chart, vals) => vals.map((value) => `${Math.round(value / 60)}`) },
        { ...chartAxisStyle(), size: 78, values: (_chart, vals) => vals.map((value) => value.toFixed(digits)) },
      ],
      scales: {
        x: { time: false },
        y: {
          range: (_chart, min, max) => {
            const pad = Math.max((max - min) * 0.35, 0.02);
            return [min - pad, max + pad];
          },
        },
      },
      hooks: {
        draw: [
          (chart) => {
            if (!Number.isFinite(median)) return;
            const y = chart.valToPos(median, "y", true);
            if (!Number.isFinite(y)) return;
            const ctx = chart.ctx;
            ctx.save();
            ctx.strokeStyle = cssVar("--muted");
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(chart.bbox.left, y);
            ctx.lineTo(chart.bbox.left + chart.bbox.width, y);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    },
    [times, lags],
    host,
  );
}

function renderSyncError(message) {
  state.syncReport = null;
  destroySyncChart();
  const text = /<html/i.test(message || "")
    ? "The sync measurement is not available. Restart the visualizer and try again."
    : (message || "Synchronization measurement failed.");
  els.syncBody?.replaceChildren(syncNode("h2", null, "Synchronization"), syncNode("p", null, text));
  if (els.syncPdf) els.syncPdf.disabled = true;
  if (els.syncMd) els.syncMd.disabled = true;
}

async function fetchSyncReport() {
  const response = await fetch("/api/sync", { method: "POST" });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : text;
    throw new Error(detail || response.statusText);
  }
  return body;
}

async function runSyncReport() {
  if (!state.session?.data_dir) return;
  const request = ++syncGeneration;
  if (els.syncToggle) els.syncToggle.disabled = true;
  openSyncShell("Measuring synchronization…");
  try {
    const report = await fetchSyncReport();
    if (request !== syncGeneration) return;
    renderSyncReport(report);
  } catch (error) {
    if (request !== syncGeneration) return;
    renderSyncError(error.message);
  } finally {
    if (request === syncGeneration && els.syncToggle) els.syncToggle.disabled = !state.session?.data_dir;
  }
}

function saveSyncMarkdown() {
  if (!state.syncReport) return;
  const blob = new Blob([state.syncReport.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = state.syncReport.filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function wireEvents() {
  els.transcriptSearch?.addEventListener("input", () => {
    state.transcriptQuery = els.transcriptSearch.value;
    renderTranscript();
  });
  els.transcriptAgain?.addEventListener("click", () => {
    fetchJson("/api/transcript", { method: "POST" })
      .then(applyTranscript)
      .catch((error) => {
        if (els.transcriptStatus) els.transcriptStatus.textContent = error.message;
      });
  });
  els.mapMove?.addEventListener("click", () => setMapEdit(state.mapEdit === "move" ? null : "move"));
  els.mapRedraw?.addEventListener("click", () => setMapEdit(state.mapEdit === "redraw" ? null : "redraw"));
  els.mapEditApply?.addEventListener("click", applyRedraw);
  els.mapEditCancel?.addEventListener("click", () => setMapEdit(null));
  els.mapTrackRaw?.addEventListener("click", () => setMapTrack("raw"));
  els.mapTrackClean?.addEventListener("click", () => setMapTrack("clean"));
  els.mapTrackBoth?.addEventListener("click", () => setMapTrack("both"));
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
  els.exportToggle?.addEventListener("click", () => {
    setExportOpen(els.exportToggle.getAttribute("aria-pressed") !== "true");
  });
  els.syncToggle?.addEventListener("click", () => {
    runSyncReport();
  });
  els.syncClose?.addEventListener("click", closeSyncReport);
  els.syncPdf?.addEventListener("click", () => window.print());
  els.syncMd?.addEventListener("click", saveSyncMarkdown);
  els.exportAll?.addEventListener("click", () => {
    for (const sensor of state.session?.sensors || []) {
      if (!sensor.error) state.exportSelected.add(sensor.id);
    }
    renderExportStreams(state.session);
    updateExportDownload();
  });
  els.exportNone?.addEventListener("click", () => {
    state.exportSelected.clear();
    renderExportStreams(state.session);
    updateExportDownload();
  });
  els.exportSamplingStep?.addEventListener("click", () => setExportSampling("step"));
  els.exportSamplingNative?.addEventListener("click", () => setExportSampling("native"));
  els.exportLayoutCombined?.addEventListener("click", () => setExportLayout("combined"));
  els.exportLayoutSeparate?.addEventListener("click", () => setExportLayout("separate"));
  els.exportFull?.addEventListener("click", setExportFull);
  els.exportModeTime?.addEventListener("click", () => setExportMode("time"));
  els.exportModeEvents?.addEventListener("click", () => setExportMode("events"));
  els.exportStartEventBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (els.exportStartEventBtn.disabled) return;
    toggleExportPicker("start");
  });
  els.exportEndEventBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (els.exportEndEventBtn.disabled) return;
    toggleExportPicker("end");
  });
  document.addEventListener("click", (event) => {
    if (!exportPickerOpen) return;
    const target = event.target;
    if (target instanceof Node && (els.exportEventFields?.contains(target))) return;
    exportPickerOpen = null;
    renderExportEvents();
  });
  els.exportSearch?.addEventListener("input", () => {
    if (state.session) renderExportStreams(state.session);
  });
  for (const input of [els.exportStep, els.exportStart, els.exportEnd, els.exportStartEvent, els.exportEndEvent]) {
    input?.addEventListener("input", updateExportDownload);
    input?.addEventListener("change", updateExportDownload);
  }
  els.exportDownload?.addEventListener("click", () => {
    downloadExport().catch((error) => alert(error.message));
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
  els.jumpBack?.addEventListener("click", () => jumpBy(-1));
  els.jumpForward?.addEventListener("click", () => jumpBy(1));
  els.jumpWindow?.addEventListener("change", () => {
    const next = Number(els.jumpWindow.value);
    if (!Number.isFinite(next) || next <= 0) els.jumpWindow.value = "10";
    localStorage.setItem(JUMP_KEY, els.jumpWindow.value);
    updateJumpLabels();
  });
  els.annotatePrev?.addEventListener("click", () => jumpToNeighbor(-1));
  els.annotateNext?.addEventListener("click", () => jumpToNeighbor(1));
  els.annotateSearch?.addEventListener("input", renderAnnotationSearch);
  els.annotateAddMark?.addEventListener("click", addAnnotationMark);
  els.annotateNewMark?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addAnnotationMark();
  });
}

async function init() {
  if (await reloadIfAssetsChanged()) return;
  syncThemeButton();
  loadCollapsedGroups();
  ensureOpenMedia();
  loadRotations();
  loadFlips();
  loadMapTrack();
  renderAnnotationMarks();
  const savedJump = Number(localStorage.getItem(JUMP_KEY));
  if (els.jumpWindow && Number.isFinite(savedJump) && savedJump > 0) els.jumpWindow.value = String(savedJump);
  updateJumpLabels();
  renderAnnotationNeighbors();
  setSensorsOpen(localStorage.getItem(SENSORS_OPEN_KEY) !== "0");
  setAnnotateOpen(localStorage.getItem(ANNOTATE_OPEN_KEY) === "1");
  setExportOpen(localStorage.getItem(EXPORT_OPEN_KEY) === "1");
  loadExportCollapsed();
  PanelLayout.init({
    workspace: els.workspace,
    layout: document.getElementById("layout"),
    resizer: document.getElementById("sidebar-resizer"),
    resetButton: document.getElementById("reset-layout"),
    onResize: resizeCharts,
  });
  wireEvents();
  const pendingPath = sessionStorage.getItem(PENDING_PATH_KEY);
  if (pendingPath) {
    sessionStorage.removeItem(PENDING_PATH_KEY);
    if (els.dataPath) els.dataPath.value = pendingPath;
    try {
      await loadSession(pendingPath);
    } catch (error) {
      alert(`Failed to load data: ${error.message}`);
    }
    return;
  }
  try {
    const session = await fetchJson("/api/session");
    state.session = session;
    state.duration = session.duration || 0;
    setDurationUi(state.duration);
    setMeta(session);
    renderMediaToggles(session.media?.items || []);
    renderSensorList(session);
    refreshExportPanel(session);
    configureMedia(session);
    await refreshCharts();
    await loadEvents();
    setCurrentTime(0);
    ensureTranscript().catch((error) => {
      if (els.transcriptStatus) els.transcriptStatus.textContent = error.message;
    });
  } catch {
    els.meta.textContent = "Write the path to a CaptureApp CSV exported data folder then click Load.";
  }
}

init();
