const SERIES_COLORS = ["#4f8cff", "#35d0ba", "#ffb347", "#ff6b8a", "#b388ff", "#7ee787"];
const DEFAULT_SELECTED = new Set([
  "Accelerometer",
  "Gyroscope",
  "Orientation",
  "Microphone",
  "Location",
  "Pedometer",
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
  media: { video: false, audio: false, cameraFrames: 0 },
  syncingMedia: false,
  videoRotation: 0,
};

const els = {
  meta: document.getElementById("recording-meta"),
  dataPath: document.getElementById("data-path"),
  reloadBtn: document.getElementById("reload-btn"),
  sensorList: document.getElementById("sensor-list"),
  mediaStatus: document.getElementById("media-status"),
  video: document.getElementById("video-player"),
  videoStage: document.getElementById("video-stage"),
  videoControls: document.getElementById("video-controls"),
  videoPlayBtn: document.getElementById("video-play-btn"),
  videoTimeline: document.getElementById("video-timeline"),
  videoCurrentTime: document.getElementById("video-current-time"),
  videoTotalTime: document.getElementById("video-total-time"),
  videoMuteBtn: document.getElementById("video-mute-btn"),
  videoVolume: document.getElementById("video-volume"),
  videoFullscreenBtn: document.getElementById("video-fullscreen-btn"),
  rotateLeft: document.getElementById("rotate-left"),
  rotateRight: document.getElementById("rotate-right"),
  rotationLabel: document.getElementById("rotation-label"),
  cameraFrame: document.getElementById("camera-frame"),
  videoPlaceholder: document.getElementById("video-placeholder"),
  audio: document.getElementById("audio-player"),
  audioPlaceholder: document.getElementById("audio-placeholder"),
  mapSection: document.getElementById("map-section"),
  chartsGrid: document.getElementById("charts-grid"),
  playBtn: document.getElementById("play-btn"),
  timeline: document.getElementById("timeline"),
  currentTime: document.getElementById("current-time"),
  totalTime: document.getElementById("total-time"),
  speed: document.getElementById("playback-speed"),
  selectAll: document.getElementById("select-all"),
  selectNone: document.getElementById("select-none"),
};

function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
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

function renderMediaStatus(session) {
  const lines = [];
  if (session.media?.video) lines.push(`Video: ${session.media.video}`);
  else lines.push("Video: not found (add Camera.mp4 or other .mp4 to Data/)");

  if (session.media?.shared_av) {
    lines.push("Audio: embedded in video file");
  } else if (session.media?.audio) {
    lines.push(`Audio: ${session.media.audio}`);
  } else {
    lines.push("Audio: not found (add Microphone.mp4, .m4a, or .wav to Data/)");
  }

  if (session.camera_frame_count) {
    lines.push(`Camera frames: ${session.camera_frame_count} (from Camera.csv)`);
  }

  if (session.has_microphone_levels) {
    lines.push("Microphone loudness available from Microphone.csv");
  }

  els.mediaStatus.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
}

function renderSensorList(session) {
  els.sensorList.innerHTML = "";
  for (const sensor of session.sensors) {
    const label = document.createElement("label");
    label.className = `sensor-item${sensor.error ? " disabled" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = Boolean(sensor.error);
    checkbox.checked = state.selected.has(sensor.name) && !sensor.error;
    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) state.selected.add(sensor.name);
      else state.selected.delete(sensor.name);
      await refreshCharts();
    });

    const name = document.createElement("span");
    name.textContent = sensor.name;

    const meta = document.createElement("small");
    if (sensor.error) meta.textContent = "error";
    else meta.textContent = sensor.kind === "map" ? "map" : `${sensor.row_count.toLocaleString()} pts`;

    label.append(checkbox, name, meta);
    els.sensorList.append(label);
  }
}

function updateTimelineUi(time) {
  const value = String(time);
  els.timeline.value = value;
  els.currentTime.textContent = formatTime(time);
  if (els.videoTimeline) {
    els.videoTimeline.value = value;
    els.videoCurrentTime.textContent = formatTime(time);
  }
}

function setDurationUi(duration) {
  const max = String(duration || 0);
  els.timeline.max = max;
  els.totalTime.textContent = formatTime(duration);
  if (els.videoTimeline) {
    els.videoTimeline.max = max;
    els.videoTotalTime.textContent = formatTime(duration);
  }
}

function updatePlayButtons() {
  const symbol = state.playing ? "❚❚" : "▶";
  els.playBtn.textContent = symbol;
  if (els.videoPlayBtn) els.videoPlayBtn.textContent = symbol;
}

function updateVideoMuteButton() {
  if (!els.videoMuteBtn) return;
  const muted = els.video.muted || els.video.volume === 0;
  els.videoMuteBtn.textContent = muted ? "🔇" : "🔊";
  els.videoMuteBtn.setAttribute("aria-label", muted ? "Unmute video" : "Mute video");
}

function setVideoControlsVisible(visible) {
  if (!els.videoControls) return;
  els.videoControls.hidden = !visible;
}

function loadSavedRotation() {
  const saved = Number(localStorage.getItem("capture-app-video-rotation") || 0);
  if ([0, 90, 180, 270].includes(saved)) state.videoRotation = saved;
}

function applyVideoRotation() {
  const rotation = state.videoRotation;
  els.videoStage.className = `video-stage rotate-${rotation}`;
  els.rotationLabel.textContent = `${rotation}°`;
  localStorage.setItem("capture-app-video-rotation", String(rotation));
}

function rotateVideo(delta) {
  state.videoRotation = (state.videoRotation + delta + 360) % 360;
  applyVideoRotation();
}

function configureMedia(session) {
  const videoPath = session.media?.video;
  const audioPath = session.media?.audio;
  const sharedAv = session.media?.shared_av;

  state.media.video = Boolean(videoPath);
  state.media.audio = Boolean(audioPath);
  state.media.sharedAv = Boolean(sharedAv);
  state.media.cameraFrames = session.camera_frame_count || 0;

  if (videoPath) {
    els.video.src = mediaUrl(videoPath);
    els.video.hidden = false;
    els.videoStage.hidden = false;
    els.videoPlaceholder.hidden = true;
    els.cameraFrame.hidden = true;
    setVideoControlsVisible(true);
    els.video.volume = Number(els.videoVolume.value || 1);
    updateVideoMuteButton();
  } else {
    els.video.removeAttribute("src");
    els.video.hidden = true;
    if (!state.media.cameraFrames) {
      els.videoStage.hidden = true;
      setVideoControlsVisible(false);
    } else {
      setVideoControlsVisible(false);
    }
    els.videoPlaceholder.hidden = state.media.cameraFrames > 0;
    els.cameraFrame.hidden = state.media.cameraFrames === 0;
  }

  applyVideoRotation();

  if (audioPath && !sharedAv) {
    els.audio.src = mediaUrl(audioPath);
    els.audio.hidden = false;
    els.audioPlaceholder.hidden = true;
  } else if (sharedAv) {
    els.audio.removeAttribute("src");
    els.audio.hidden = true;
    els.audioPlaceholder.hidden = true;
    els.audioPlaceholder.textContent = "Audio plays from the video player above";
  } else {
    els.audio.removeAttribute("src");
    els.audio.hidden = true;
    els.audioPlaceholder.hidden = false;
    els.audioPlaceholder.textContent =
      "No audio file found — loudness chart available from Microphone.csv";
  }
}

async function loadSensorData(sensorName) {
  if (state.sensorData.has(sensorName)) return state.sensorData.get(sensorName);
  const payload = await fetchJson(`/api/sensors/${encodeURIComponent(sensorName)}`);
  state.sensorData.set(sensorName, payload);
  return payload;
}

function destroyCharts() {
  for (const chart of state.charts.values()) chart.destroy();
  state.charts.clear();
  els.chartsGrid.innerHTML = "";
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

function buildChartCard(sensorName, payload) {
  const card = document.createElement("article");
  card.className = "chart-card";
  card.dataset.sensor = sensorName;

  const title = document.createElement("h3");
  title.textContent = sensorName;
  card.append(title);

  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  card.append(wrap);

  const values = document.createElement("div");
  values.className = "chart-values";
  values.id = `values-${sensorName}`;
  card.append(values);

  els.chartsGrid.append(card);

  const columns = payload.columns || Object.keys(payload.series);
  const data = [payload.times, ...columns.map((col) => payload.series[col] || [])];

  const series = columns.map((col, idx) => ({
    label: col,
    stroke: SERIES_COLORS[idx % SERIES_COLORS.length],
    width: 1.5,
  }));

  const chart = new uPlot(
    {
      width: wrap.clientWidth || 420,
      height: 220,
      series: [{}, ...series],
      axes: [
        { stroke: "#93a0bf", grid: { stroke: "#2a3555" } },
        { stroke: "#93a0bf", grid: { stroke: "#2a3555" } },
      ],
      scales: { x: { time: false } },
      hooks: {
        draw: [
          (u) => {
            const t = state.currentTime;
            const x = u.valToPos(t, "x", true);
            if (!Number.isFinite(x)) return;
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = "#ffffffaa";
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
  updateChartValues(sensorName, payload);
}

function updateChartValues(sensorName, payload) {
  const el = document.getElementById(`values-${sensorName}`);
  if (!el || !payload?.times?.length) return;
  const idx = nearestIndex(payload.times, state.currentTime);
  const parts = (payload.columns || []).map((col) => {
    const val = payload.series[col]?.[idx];
    const shown = val == null ? "—" : Number(val).toFixed(3);
    return `<span>${col}: <strong>${shown}</strong></span>`;
  });
  el.innerHTML = parts.join("");
}

async function setupMap() {
  if (!state.selected.has("Location")) {
    els.mapSection.hidden = true;
    return;
  }

  const payload = await loadSensorData("Location");
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

  state.mapTrack = L.polyline(points, { color: "#4f8cff", weight: 4 }).addTo(state.map);
  state.map.fitBounds(state.mapTrack.getBounds(), { padding: [24, 24] });

  const idx = nearestIndex(payload.times, state.currentTime);
  const markerPoint = [lat[idx], lon[idx]];
  state.mapMarker = L.circleMarker(markerPoint, {
    radius: 8,
    color: "#fff",
    weight: 2,
    fillColor: "#35d0ba",
    fillOpacity: 0.95,
  }).addTo(state.map);
}

async function refreshCharts() {
  destroyCharts();
  const chartSensors = [...state.selected].filter((name) => {
    const meta = state.session?.sensors?.find((s) => s.name === name);
    return meta && meta.kind === "timeseries" && !meta.error;
  });

  for (const sensorName of chartSensors) {
    const payload = await loadSensorData(sensorName);
    buildChartCard(sensorName, payload);
  }

  await setupMap();
  resizeCharts();
}

function resizeCharts() {
  for (const [sensorName, chart] of state.charts.entries()) {
    const card = document.querySelector(`.chart-card[data-sensor="${sensorName}"] .chart-wrap`);
    if (!card) continue;
    chart.setSize({ width: card.clientWidth, height: 220 });
  }
  state.map?.invalidateSize();
}

function setCurrentTime(t, { fromMedia = false } = {}) {
  const clamped = Math.max(0, Math.min(state.duration || 0, t));
  state.currentTime = clamped;
  updateTimelineUi(clamped);

  if (!fromMedia && state.media.video && els.video.src) {
    state.syncingMedia = true;
    if (Math.abs(els.video.currentTime - clamped) > 0.15) els.video.currentTime = clamped;
    state.syncingMedia = false;
  }

  if (!fromMedia && state.media.audio && els.audio.src && !state.media.sharedAv) {
    state.syncingMedia = true;
    if (Math.abs(els.audio.currentTime - clamped) > 0.15) els.audio.currentTime = clamped;
    state.syncingMedia = false;
  }

  for (const [sensorName, chart] of state.charts.entries()) {
    chart.redraw();
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

  updateCameraFrame(clamped);
}

async function updateCameraFrame(t) {
  if (state.media.video) return;
  if (!state.media.cameraFrames) return;

  try {
    const frame = await fetchJson(`/api/camera/frame?t=${encodeURIComponent(t)}`);
    if (!frame?.file) return;
    els.cameraFrame.hidden = false;
    els.videoPlaceholder.hidden = true;
    els.videoStage.hidden = false;
    els.cameraFrame.src = mediaUrl(frame.file);
    applyVideoRotation();
  } catch {
    // No frame near this timestamp.
  }
}

function togglePlay() {
  state.playing = !state.playing;
  updatePlayButtons();

  if (state.playing) {
    state.lastFrame = performance.now();
    if (state.media.video && els.video.src) els.video.play().catch(() => {});
    if (state.media.audio && els.audio.src && !state.media.sharedAv) {
      els.audio.play().catch(() => {});
    }
    requestAnimationFrame(tick);
  } else {
    els.video.pause();
    if (!state.media.sharedAv) els.audio.pause();
  }
}

function tick(now) {
  if (!state.playing) return;
  const speed = Number(els.speed.value || 1);
  const dt = ((now - state.lastFrame) / 1000) * speed;
  state.lastFrame = now;

  const videoDriving = state.media.video && !els.video.paused;
  const audioDriving = state.media.audio && els.audio.src && !state.media.sharedAv && !els.audio.paused;
  if (videoDriving || audioDriving) {
    const mediaTime = videoDriving ? els.video.currentTime : els.audio.currentTime;
    setCurrentTime(mediaTime, { fromMedia: true });
  } else {
    setCurrentTime(state.currentTime + dt);
    if (state.currentTime >= state.duration) {
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
  state.currentTime = 0;
  state.playing = false;
  updatePlayButtons();

  setDurationUi(state.duration);
  els.timeline.value = "0";

  setMeta(session);
  renderMediaStatus(session);
  renderSensorList(session);
  configureMedia(session);
  await refreshCharts();
  setCurrentTime(0);
}

function wireEvents() {
  els.reloadBtn.addEventListener("click", () => {
    loadSession(els.dataPath.value.trim()).catch((err) => {
      alert(`Failed to load data: ${err.message}`);
    });
  });

  els.playBtn.addEventListener("click", togglePlay);
  els.videoPlayBtn.addEventListener("click", togglePlay);

  els.videoMuteBtn.addEventListener("click", () => {
    els.video.muted = !els.video.muted;
    if (!els.video.muted && els.video.volume === 0) {
      els.video.volume = 1;
      els.videoVolume.value = "1";
    }
    updateVideoMuteButton();
  });

  els.videoVolume.addEventListener("input", () => {
    els.video.volume = Number(els.videoVolume.value);
    els.video.muted = els.video.volume === 0;
    updateVideoMuteButton();
  });

  els.videoFullscreenBtn.addEventListener("click", () => {
    const target = els.videoStage;
    if (document.fullscreenElement === target) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    target.requestFullscreen?.().catch(() => {});
  });

  document.addEventListener("fullscreenchange", () => {
    const isFullscreen = document.fullscreenElement === els.videoStage;
    els.videoFullscreenBtn.textContent = isFullscreen ? "⛶" : "⛶";
    els.videoFullscreenBtn.setAttribute(
      "aria-label",
      isFullscreen ? "Exit fullscreen" : "Fullscreen",
    );
  });

  els.timeline.addEventListener("input", () => {
    setCurrentTime(Number(els.timeline.value));
  });

  els.videoTimeline.addEventListener("input", () => {
    setCurrentTime(Number(els.videoTimeline.value));
  });

  els.selectAll.addEventListener("click", async () => {
    for (const sensor of state.session.sensors) {
      if (!sensor.error) state.selected.add(sensor.name);
    }
    renderSensorList(state.session);
    await refreshCharts();
  });

  els.selectNone.addEventListener("click", async () => {
    state.selected.clear();
    renderSensorList(state.session);
    await refreshCharts();
  });

  els.rotateLeft.addEventListener("click", () => rotateVideo(-90));
  els.rotateRight.addEventListener("click", () => rotateVideo(90));

  const syncFromMedia = (element) => {
    element.addEventListener("timeupdate", () => {
      if (state.syncingMedia) return;
      setCurrentTime(element.currentTime, { fromMedia: true });
    });
    element.addEventListener("seeked", () => {
      if (state.syncingMedia) return;
      setCurrentTime(element.currentTime, { fromMedia: true });
    });
  };

  syncFromMedia(els.video);
  syncFromMedia(els.audio);

  window.addEventListener("resize", () => resizeCharts());
}

async function init() {
  loadSavedRotation();
  applyVideoRotation();
  wireEvents();
  try {
    const session = await fetchJson("/api/session");
    state.session = session;
    state.duration = session.duration || 0;
    setDurationUi(state.duration);
    setMeta(session);
    renderMediaStatus(session);
    renderSensorList(session);
    configureMedia(session);
    await refreshCharts();
    setCurrentTime(0);
  } catch {
    els.meta.textContent = "Place Sensor Logger CSV export in Data/, then click Load.";
  }
}

init();
