"""Capture App Visualizer — FastAPI backend for a multi-device recording folder."""

from __future__ import annotations

import csv
import io
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import pandas as pd
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from loaders import load_sensors, ordered_sensors, reload_sensor
from loaders.common import sensor_view
from loaders.eyetracking import load_eye_overlay
from sync_accuracy import evaluate

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


_EXPORT_MAX_ROWS = 500_000
_EXPORT_MAX_CELLS = 8_000_000


def _step_decimals(step: float) -> int:
    text = f"{step:.8f}".rstrip("0")
    if "." not in text:
        return 0
    return min(8, len(text.split(".", 1)[1]))


def _to_float_array(values: list[Any]) -> np.ndarray:
    out = np.empty(len(values), dtype=float)
    for index, value in enumerate(values):
        try:
            number = float(value)
        except (TypeError, ValueError):
            out[index] = np.nan
            continue
        out[index] = number if np.isfinite(number) else np.nan
    return out


def _sample_tolerance(times: np.ndarray, step: float) -> float:
    if times.size < 2:
        return step
    gaps = np.diff(times)
    gaps = gaps[np.isfinite(gaps) & (gaps > 0)]
    median = float(np.median(gaps)) if gaps.size else step
    return max(1.5 * median, step)


def _asof_column(grid: np.ndarray, times: np.ndarray, values: np.ndarray, step: float) -> np.ndarray:
    out = np.full(grid.shape, np.nan)
    finite = np.isfinite(times) & np.isfinite(values)
    times = times[finite]
    values = values[finite]
    if times.size == 0:
        return out
    order = np.argsort(times, kind="mergesort")
    times = times[order]
    values = values[order]
    index = np.searchsorted(times, grid, side="right") - 1
    valid = index >= 0
    if not np.any(valid):
        return out
    chosen = index[valid]
    gaps = grid[valid] - times[chosen]
    keep = gaps <= _sample_tolerance(times, step) + 1e-9
    targets = np.flatnonzero(valid)[keep]
    out[targets] = values[chosen][keep]
    return out


def _export_header(group: str, name: str, column: str, used: set[str]) -> str:
    label = f"{group} / {name} / {column}".replace("\n", " ").replace("\r", " ")
    unique = label
    suffix = 2
    while unique in used:
        unique = f"{label} ({suffix})"
        suffix += 1
    used.add(unique)
    return unique


def _load_export_sensor(sensor: dict[str, Any]) -> dict[str, Any]:
    limit = int(sensor.get("row_count") or 0)
    if limit < 1:
        limit = 5_000_000
    return reload_sensor(
        sensor,
        Path(_session["data_dir"]),
        _session.get("origin_s"),
        limit,
    )


def _export_columns(stream_ids: list[str], grid: np.ndarray, step: float) -> list[tuple[str, np.ndarray]]:
    sensors = _session["sensors"]
    columns: list[tuple[str, np.ndarray]] = []
    used: set[str] = {"time_s"}
    for stream_id in stream_ids:
        sensor = sensors.get(stream_id)
        if sensor is None:
            raise HTTPException(status_code=404, detail=f"Unknown data stream: {stream_id}")
        if "error" in sensor:
            raise HTTPException(status_code=400, detail=f"{sensor.get('name') or stream_id} cannot be exported.")
        try:
            full = _load_export_sensor(sensor)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        times = np.asarray(full.get("times") or [], dtype=float)
        series = full.get("series") or {}
        names = list(full.get("series_columns") or series.keys())
        if not names:
            raise HTTPException(status_code=400, detail=f"{sensor.get('name') or stream_id} has no columns.")
        group = str(full.get("group") or sensor.get("group") or "")
        name = str(full.get("name") or sensor.get("name") or stream_id)
        for column in names:
            raw = series.get(column) or []
            if len(raw) != len(times):
                raise HTTPException(
                    status_code=400,
                    detail=f"{name} column {column} does not match its time axis.",
                )
            filled = _asof_column(grid, times, _to_float_array(raw), step)
            columns.append((_export_header(group, name, column, used), filled))
    return columns


def _iter_export_csv(grid: np.ndarray, columns: list[tuple[str, np.ndarray]], decimals: int):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["time_s", *[header for header, _ in columns]])
    arrays = [values for _, values in columns]

    def flush() -> str:
        text = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        return text

    yield flush()
    for index, time in enumerate(grid):
        row = [f"{float(time):.{decimals}f}"]
        for values in arrays:
            number = float(values[index])
            row.append("" if not np.isfinite(number) else f"{number:.10g}")
        writer.writerow(row)
        if index % 250 == 249:
            yield flush()
    leftover = buffer.getvalue()
    if leftover:
        yield leftover


def _write_export_csv(path: Path, grid: np.ndarray, columns: list[tuple[str, np.ndarray]], decimals: int) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        for chunk in _iter_export_csv(grid, columns, decimals):
            handle.write(chunk)


def _parse_export_range(payload: dict[str, Any]) -> tuple[float, float]:
    try:
        start = float(payload.get("start"))
        end = float(payload.get("end"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Start and end must be numbers.") from exc
    if not np.isfinite(start) or not np.isfinite(end):
        raise HTTPException(status_code=400, detail="Start and end must be finite numbers.")
    if end < start:
        start, end = end, start
    return start, end


def _require_export_sensor(stream_id: str) -> dict[str, Any]:
    sensor = _session["sensors"].get(stream_id)
    if sensor is None:
        raise HTTPException(status_code=404, detail=f"Unknown data stream: {stream_id}")
    if "error" in sensor:
        raise HTTPException(status_code=400, detail=f"{sensor.get('name') or stream_id} cannot be exported.")
    return sensor


def _window_mask(times: np.ndarray, start: float, end: float) -> np.ndarray:
    return np.isfinite(times) & (times >= start - 1e-9) & (times <= end + 1e-9)


def _place_native(grid: np.ndarray, times: np.ndarray, values: np.ndarray) -> np.ndarray:
    out = np.full(grid.shape, np.nan)
    if times.size == 0 or grid.size == 0:
        return out
    index = np.searchsorted(grid, times)
    keep = index < grid.size
    index = index[keep]
    times = times[keep]
    values = values[keep]
    keep = grid[index] == times
    out[index[keep]] = values[keep]
    return out


def _native_columns(stream_ids: list[str], start: float, end: float) -> tuple[np.ndarray, list[tuple[str, np.ndarray]]]:
    pieces: list[tuple[str, str, np.ndarray, list[tuple[str, np.ndarray]]]] = []
    used: set[str] = {"time_s"}
    sample_count = 0
    column_count = 0
    for stream_id in stream_ids:
        sensor = _require_export_sensor(stream_id)
        try:
            full = _load_export_sensor(sensor)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        times = np.asarray(full.get("times") or [], dtype=float)
        series = full.get("series") or {}
        names = list(full.get("series_columns") or series.keys())
        if not names:
            raise HTTPException(status_code=400, detail=f"{sensor.get('name') or stream_id} has no columns.")
        mask = _window_mask(times, start, end)
        kept: list[tuple[str, np.ndarray]] = []
        for column in names:
            raw = _to_float_array(series.get(column) or [])
            if len(raw) != len(times):
                label = sensor.get("name") or stream_id
                raise HTTPException(status_code=400, detail=f"{label} column {column} does not match its time axis.")
            kept.append((column, raw[mask]))
        window_times = times[mask]
        sample_count += int(window_times.size)
        column_count += len(kept)
        if sample_count > _EXPORT_MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail="That range includes too many samples. Choose a shorter interval or fewer streams.",
            )
        if sample_count * max(column_count, 1) > _EXPORT_MAX_CELLS:
            raise HTTPException(
                status_code=400,
                detail="That export is too large. Choose a shorter interval or fewer streams.",
            )
        group = str(full.get("group") or sensor.get("group") or "")
        name = str(full.get("name") or sensor.get("name") or stream_id)
        pieces.append((group, name, window_times, kept))

    if sample_count == 0:
        columns = [
            (_export_header(group, name, column, used), np.zeros(0))
            for group, name, _, kept in pieces
            for column, _ in kept
        ]
        return np.zeros(0), columns

    grid = np.unique(np.concatenate([times for _, _, times, _ in pieces if times.size]))
    aligned = [
        (_export_header(group, name, column, used), _place_native(grid, times, values))
        for group, name, times, kept in pieces
        for column, values in kept
    ]
    return grid, aligned


def _step_columns(stream_ids: list[str], start: float, end: float, step: float) -> tuple[np.ndarray, list[tuple[str, np.ndarray]], int]:
    if not np.isfinite(step) or step <= 0:
        raise HTTPException(status_code=400, detail="Step must be greater than zero.")
    row_count = int(np.floor((end - start) / step + 1e-9)) + 1
    if row_count < 1:
        row_count = 1
    if row_count > _EXPORT_MAX_ROWS:
        raise HTTPException(status_code=400, detail="That range and step would create too many rows. Use a larger step.")
    grid = start + np.arange(row_count, dtype=float) * step
    grid = grid[grid <= end + step * 1e-6]
    column_count = 0
    for stream_id in stream_ids:
        sensor = _session["sensors"].get(stream_id)
        if sensor is None or "error" in sensor:
            continue
        column_count += len(sensor.get("series_columns") or []) or 1
    if len(grid) * max(column_count, 1) > _EXPORT_MAX_CELLS:
        raise HTTPException(status_code=400, detail="That export is too large. Choose fewer streams or a larger step.")
    return grid, _export_columns(stream_ids, grid, step), _step_decimals(step)


def _media_export_items() -> list[dict[str, Any]]:
    media = _session.get("media") or {}
    items = media.get("items") or []
    return [item for item in items if isinstance(item, dict) and item.get("path")]


def _selected_media_items(media_ids: Any) -> list[dict[str, Any]]:
    if not isinstance(media_ids, list):
        return []
    wanted = {item for item in media_ids if isinstance(item, str) and item}
    if not wanted:
        return []
    return [item for item in _media_export_items() if item.get("id") in wanted]


def _trim_media_files(dest_dir: Path, start: float, end: float, items: list[dict[str, Any]]) -> list[Path]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(status_code=400, detail="ffmpeg was not found, so media files cannot be trimmed.")
    data_dir = Path(_session["data_dir"])
    duration = max(end - start, 0.001)
    written: list[Path] = []
    used: set[str] = set()
    for item in items:
        src = (data_dir / str(item["path"])).resolve()
        try:
            src.relative_to(data_dir.resolve())
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Invalid media path") from exc
        if not src.is_file():
            continue
        filename = src.name
        if filename in used:
            filename = f"{item.get('id') or 'media'}_{filename}"
        used.add(filename)
        dst = dest_dir / filename
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(src),
            "-t",
            f"{duration:.3f}",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(dst),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=600, check=False)
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=400, detail=f"Trimming {item.get('label') or filename} took too long.") from exc
        if result.returncode != 0 or not dst.is_file():
            detail = (result.stderr or result.stdout or "ffmpeg failed").strip().splitlines()
            message = detail[-1] if detail else "ffmpeg failed"
            label = item.get("label") or filename
            raise HTTPException(status_code=400, detail=f"Could not trim {label}: {message}")
        written.append(dst)
    return written


def _export_zip(
    csv_name: str,
    grid: np.ndarray,
    columns: list[tuple[str, np.ndarray]],
    decimals: int,
    start: float,
    end: float,
    items: list[dict[str, Any]],
) -> FileResponse:
    tmp = tempfile.TemporaryDirectory(prefix="capture-export-")
    try:
        root = Path(tmp.name)
        csv_path = root / csv_name
        _write_export_csv(csv_path, grid, columns, decimals)
        media_dir = root / "trimmed"
        media_dir.mkdir()
        trimmed = _trim_media_files(media_dir, start, end, items)
        zip_name = f"streams_{start:.2f}_{end:.2f}.zip"
        zip_path = root / zip_name
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.write(csv_path, csv_name, compress_type=zipfile.ZIP_DEFLATED)
            for path in trimmed:
                archive.write(path, f"media/{path.name}", compress_type=zipfile.ZIP_STORED)
    except Exception:
        tmp.cleanup()
        raise
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=zip_path.name,
        background=BackgroundTask(tmp.cleanup),
    )


@app.post("/api/export", response_model=None)
def api_export(payload: dict[str, Any] = Body(...)) -> StreamingResponse | FileResponse:
    if not _session.get("data_dir"):
        raise HTTPException(status_code=404, detail="No recording loaded.")
    stream_ids = payload.get("streams")
    if not isinstance(stream_ids, list) or not stream_ids or not all(isinstance(item, str) and item for item in stream_ids):
        raise HTTPException(status_code=400, detail="Choose at least one data stream.")
    sampling = payload.get("sampling") or "step"
    if sampling not in {"step", "native"}:
        raise HTTPException(status_code=400, detail="Choose step or original rate sampling.")
    start, end = _parse_export_range(payload)
    if sampling == "native":
        grid, columns = _native_columns(stream_ids, start, end)
        decimals = 6
    else:
        try:
            step = float(payload.get("step"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Step must be a number.") from exc
        grid, columns, decimals = _step_columns(stream_ids, start, end, step)
    filename = f"streams_{start:.2f}_{end:.2f}.csv"
    requested_media = payload.get("media")
    media_items = _selected_media_items(requested_media)
    if media_items:
        return _export_zip(filename, grid, columns, decimals, start, end, media_items)
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if isinstance(requested_media, list) and any(isinstance(item, str) and item for item in requested_media):
        headers["X-Export-Media"] = "none"
    return StreamingResponse(
        _iter_export_csv(grid, columns, decimals),
        media_type="text/csv; charset=utf-8",
        headers=headers,
    )


@app.post("/api/sync")
def api_sync() -> dict[str, Any]:
    data_dir = _session.get("data_dir")
    if not data_dir:
        raise HTTPException(status_code=404, detail="No recording loaded.")
    try:
        return evaluate(Path(data_dir))
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc) or "Synchronization measurement failed.") from exc


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
