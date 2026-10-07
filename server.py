"""Capture App Visualizer — FastAPI backend for a multi-device recording folder."""

from __future__ import annotations

import csv
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import pandas as pd
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from loaders import load_sensors, ordered_sensors, reload_sensor
from loaders.common import sensor_view
from loaders.eyetracking import load_eye_overlay

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = BASE_DIR / "Data"
STATIC_DIR = BASE_DIR / "static"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}

app = FastAPI(title="Capture App Visualizer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_session: dict[str, Any] = {
    "data_dir": None,
    "metadata": {},
    "origin_s": None,
    "duration": 0.0,
    "sensors": {},
    "media": {},
    "camera_frames": [],
}


def _resolve_data_dir(path: str | None) -> Path:
    if not path:
        return DEFAULT_DATA_DIR
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = BASE_DIR / candidate
    return candidate.resolve()


def _read_metadata(data_dir: Path) -> dict[str, str]:
    meta_path = data_dir / "Metadata.csv"
    if not meta_path.exists():
        return {}
    df = pd.read_csv(meta_path, nrows=1)
    if df.empty:
        return {}
    return {str(col): str(df.iloc[0][col]) for col in df.columns}


_MEDIA_ITEMS = (
    ("phone-video", "Phone video", "video"),
    ("eye-scene", "Eye-tracker camera", "video"),
    ("eye-eyes", "Eye video", "video"),
    ("microphone", "Microphone", "audio"),
)


def _catalog_media_id(rel: str) -> str | None:
    """Map a recording file to a toggleable player. Hidden cache folders are ignored."""
    path = PurePosixPath(rel)
    if any(part.startswith(".") for part in path.parts):
        return None
    name = path.name.lower()
    parent = path.parent.name.lower()
    suffix = path.suffix.lower()
    if "neon scene camera" in name and suffix in VIDEO_EXTENSIONS:
        return "eye-scene"
    if "neon sensor module" in name and suffix in VIDEO_EXTENSIONS:
        return "eye-eyes"
    if name.startswith("microphone.") or name.startswith("microphone "):
        return "microphone"
    if suffix in VIDEO_EXTENSIONS and parent in {"camera", "_camera"}:
        return "phone-video"
    if (
        suffix in VIDEO_EXTENSIONS
        and path.parent == PurePosixPath(".")
        and name in {"camera.mp4", "video.mp4"}
    ):
        return "phone-video"
    return None


def _find_media_files(data_dir: Path) -> dict[str, Any]:
    found: dict[str, str] = {}
    for path in sorted(data_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(data_dir).as_posix()
        item_id = _catalog_media_id(rel)
        if item_id is None:
            continue
        current = found.get(item_id)
        if current is None or (item_id == "microphone" and path.name.lower() == "microphone.mp4"):
            found[item_id] = rel

    items = [
        {"id": item_id, "label": label, "kind": kind, "path": found[item_id]}
        for item_id, label, kind in _MEDIA_ITEMS
        if item_id in found
    ]
    images_dir = data_dir / "images"
    return {
        "items": items,
        "video": found.get("phone-video"),
        "audio": found.get("microphone"),
        "images_dir": "images" if images_dir.is_dir() and any(images_dir.iterdir()) else None,
        "shared_av": False,
    }


def _load_camera_frames(data_dir: Path) -> list[dict[str, Any]]:
    camera_csv = data_dir / "Camera.csv"
    if not camera_csv.exists():
        return []

    df = pd.read_csv(camera_csv)
    if "seconds_elapsed" not in df.columns:
        return []

    path_col = None
    for candidate in ("file", "filename", "path", "image", "uri"):
        if candidate in df.columns:
            path_col = candidate
            break
    if path_col is None:
        for col in df.columns:
            if col not in {"time", "seconds_elapsed"}:
                path_col = col
                break

    frames: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        file_ref = str(row[path_col]) if path_col else ""
        frames.append(
            {
                "time": float(row["seconds_elapsed"]),
                "file": file_ref.replace("\\", "/"),
            }
        )
    return frames


def load_session(data_dir: Path, max_points: int = 4000) -> dict[str, Any]:
    if not data_dir.is_dir():
        raise FileNotFoundError(f"Data directory not found: {data_dir}")

    metadata = _read_metadata(data_dir)
    sensors, origin_s = load_sensors(data_dir, metadata, max_points)
    duration = 0.0
    for sensor in sensors.values():
        if "error" in sensor:
            continue
        duration = max(duration, float(sensor.get("time_max") or 0.0))

    media = _find_media_files(data_dir)
    camera_frames = _load_camera_frames(data_dir)

    return {
        "data_dir": str(data_dir),
        "metadata": metadata,
        "origin_s": origin_s,
        "duration": duration,
        "sensors": sensors,
        "media": media,
        "camera_frames": camera_frames,
    }


@app.on_event("startup")
def startup() -> None:
    if DEFAULT_DATA_DIR.is_dir() and any(DEFAULT_DATA_DIR.iterdir()):
        _session.update(load_session(DEFAULT_DATA_DIR))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/load")
def api_load(
    data_path: str | None = Query(default=None, description="Path to Sensor Logger export folder"),
    max_points: int = Query(default=4000, ge=500, le=20000),
) -> dict[str, Any]:
    data_dir = _resolve_data_dir(data_path)
    try:
        payload = load_session(data_dir, max_points=max_points)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    _session.pop("eye_overlay", None)
    _session.update(payload)
    return _session_summary()


@app.get("/api/session")
def api_session() -> dict[str, Any]:
    if not _session.get("data_dir"):
        raise HTTPException(
            status_code=404,
            detail="No recording loaded. Place CSV files in Data/ or call POST /api/load.",
        )
    return _session_summary()


def _session_summary() -> dict[str, Any]:
    sensors_meta = []
    for sensor in ordered_sensors(_session["sensors"]):
        entry = {
            "id": sensor.get("id"),
            "name": sensor.get("name"),
            "group": sensor.get("group"),
            "kind": sensor.get("kind") or "timeseries",
        }
        if "error" in sensor:
            entry["error"] = sensor["error"]
        else:
            entry.update(
                {
                    "columns": sensor.get("series_columns") or [],
                    "row_count": sensor.get("row_count"),
                    "time_min": sensor.get("time_min"),
                    "time_max": sensor.get("time_max"),
                }
            )
        sensors_meta.append(entry)

    microphone = _session["sensors"].get("phone.Microphone")
    return {
        "data_dir": _session["data_dir"],
        "metadata": _session["metadata"],
        "time_origin_unix_s": _session.get("origin_s"),
        "duration": _session["duration"],
        "sensors": sensors_meta,
        "media": _session["media"],
        "camera_frame_count": len(_session["camera_frames"]),
        "has_microphone_levels": bool(microphone) and "error" not in microphone,
    }


@app.get("/api/sensors/{sensor_name}")
def api_sensor(
    sensor_name: str,
    max_points: int = Query(default=4000, ge=100, le=50000),
) -> dict[str, Any]:
    sensor = _session["sensors"].get(sensor_name)
    if sensor is None:
        raise HTTPException(status_code=404, detail=f"Unknown sensor: {sensor_name}")
    if "error" in sensor:
        raise HTTPException(status_code=400, detail=sensor["error"])

    stored_points = len(sensor.get("times") or [])
    if sensor.get("row_count", 0) > stored_points and max_points > stored_points:
        try:
            sensor = reload_sensor(
                sensor,
                Path(_session["data_dir"]),
                _session.get("origin_s"),
                max_points,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    return sensor_view(sensor, max_points)


@app.get("/api/sensors/{sensor_name}/value")
def api_sensor_value(
    sensor_name: str,
    t: float = Query(..., description="seconds_elapsed"),
) -> dict[str, Any]:
    sensor = _session["sensors"].get(sensor_name)
    if sensor is None or "error" in sensor:
        raise HTTPException(status_code=404, detail=f"Sensor not available: {sensor_name}")

    times = np.array(sensor["times"], dtype=float)
    if len(times) == 0:
        return {"time": t, "values": {}}

    idx = int(np.argmin(np.abs(times - t)))
    values = {
        col: sensor["series"][col][idx]
        for col in sensor["series_columns"]
        if col in sensor["series"]
    }
    return {"time": float(times[idx]), "values": values}


@app.get("/api/camera/frame")
def api_camera_frame(
    t: float = Query(..., description="seconds_elapsed"),
) -> dict[str, Any]:
    frames = _session.get("camera_frames") or []
    if not frames:
        raise HTTPException(status_code=404, detail="No Camera.csv frames available")

    best = min(frames, key=lambda f: abs(f["time"] - t))
    return best


def _events_path() -> Path:
    data_dir = _session.get("data_dir")
    if not data_dir:
        raise HTTPException(status_code=404, detail="No recording loaded.")
    root = Path(data_dir).resolve()
    path = root / "EventTable.csv"
    if path.parent != root:
        raise HTTPException(status_code=403, detail="Invalid event table path")
    return path


def _read_events() -> list[dict[str, Any]]:
    path = _events_path()
    if not path.is_file():
        return []
    events: list[dict[str, Any]] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return []
        fields = {name.strip().lower(): name for name in reader.fieldnames}
        time_key = fields.get("time") or fields.get("timestamp") or fields.get("timestamps")
        event_key = fields.get("event") or fields.get("events")
        desc_key = fields.get("description") or fields.get("descriptions")
        if not time_key or not event_key:
            return []
        for row in reader:
            try:
                time = round(float(row.get(time_key) or ""), 2)
            except ValueError:
                continue
            event = str(row.get(event_key) or "").strip()
            if not event:
                continue
            description = str(row.get(desc_key) or "").strip() if desc_key else ""
            events.append({"time": time, "event": event, "description": description})
    events.sort(key=lambda item: item["time"])
    return events


def _clean_events(rows: list[Any]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Each event must be an object.")
        try:
            time = round(float(item.get("time")), 2)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Event time must be a number.") from exc
        if time < 0:
            raise HTTPException(status_code=400, detail="Event time must be zero or greater.")
        event = str(item.get("event") or "").strip()
        if not event:
            raise HTTPException(status_code=400, detail="Event text is required.")
        if len(event) > 200:
            raise HTTPException(status_code=400, detail="Event text is too long.")
        description = str(item.get("description") or "").strip()
        if len(description) > 2000:
            raise HTTPException(status_code=400, detail="Description is too long.")
        cleaned.append({"time": time, "event": event, "description": description})
    cleaned.sort(key=lambda item: item["time"])
    return cleaned


def _write_events(events: list[dict[str, Any]]) -> None:
    path = _events_path()
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=["time", "Event", "Description"])
        writer.writeheader()
        for item in events:
            writer.writerow(
                {
                    "time": f"{item['time']:.2f}",
                    "Event": item["event"],
                    "Description": item["description"],
                }
            )


@app.get("/api/events")
def api_events() -> dict[str, Any]:
    return {"events": _read_events()}


@app.put("/api/events")
def api_save_events(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    rows = payload.get("events")
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail="Expected an events list.")
    events = _clean_events(rows)
    _write_events(events)
    return {"events": events}


@app.get("/api/eye/overlay")
def api_eye_overlay() -> dict[str, Any]:
    data_dir = _session.get("data_dir")
    if not data_dir:
        raise HTTPException(status_code=404, detail="No recording loaded.")
    overlay = _session.get("eye_overlay")
    if overlay is None:
        overlay = load_eye_overlay(Path(data_dir), _session.get("origin_s"))
        _session["eye_overlay"] = overlay
    return overlay


@app.get("/api/media/{file_path:path}")
def api_media(file_path: str) -> FileResponse:
    data_dir = Path(_session["data_dir"])
    target = (data_dir / file_path).resolve()

    try:
        target.relative_to(data_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Invalid media path") from exc

    if not target.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")

    return FileResponse(target)


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
