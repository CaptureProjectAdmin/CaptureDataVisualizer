"""Capture App Visualizer — FastAPI backend for Sensor Logger exports."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = BASE_DIR / "Data"
STATIC_DIR = BASE_DIR / "static"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
AUDIO_EXTENSIONS = {".m4a", ".wav", ".aac", ".ogg", ".mp3", ".flac"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

# Sensors that are better shown on a map rather than time-series charts.
MAP_SENSORS = {"Location"}

# Column groupings for multi-series charts.
AXIS_GROUPS: dict[str, list[str]] = {
    "Accelerometer": ["x", "y", "z"],
    "Gyroscope": ["x", "y", "z"],
    "Gravity": ["x", "y", "z"],
    "Magnetometer": ["x", "y", "z"],
    "MagnetometerUncalibrated": ["x", "y", "z"],
    "AccelerometerUncalibrated": ["x", "y", "z"],
    "GyroscopeUncalibrated": ["x", "y", "z"],
    "Orientation": ["roll", "pitch", "yaw"],
    "TotalAcceleration": ["x", "y", "z"],
}

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


def _sensor_name_from_csv(path: Path) -> str:
    return path.stem


def _list_sensor_csvs(data_dir: Path) -> list[Path]:
    return sorted(
        p
        for p in data_dir.glob("*.csv")
        if p.name.lower() != "metadata.csv" and p.name.lower() != "camera.csv"
    )


def _downsample_series(
    times: np.ndarray, values: dict[str, np.ndarray], max_points: int
) -> tuple[list[float], dict[str, list[float | None]]]:
    n = len(times)
    if n == 0:
        return [], {k: [] for k in values}
    if n <= max_points:
        out = {k: [None if pd.isna(v) else float(v) for v in arr] for k, arr in values.items()}
        return [float(t) for t in times], out

    idx = np.linspace(0, n - 1, max_points, dtype=int)
    out_times = [float(times[i]) for i in idx]
    out_values: dict[str, list[float | None]] = {}
    for key, arr in values.items():
        out_values[key] = [
            None if pd.isna(arr[i]) else float(arr[i]) for i in idx
        ]
    return out_times, out_values


def _load_sensor_csv(path: Path, max_points: int) -> dict[str, Any]:
    df = pd.read_csv(path)
    if "seconds_elapsed" not in df.columns:
        raise ValueError(f"{path.name} is missing seconds_elapsed")

    df = df.sort_values("seconds_elapsed").reset_index(drop=True)
    value_cols = [
        c
        for c in df.columns
        if c not in {"time", "seconds_elapsed"}
    ]

    times = df["seconds_elapsed"].to_numpy(dtype=float)
    values = {col: df[col].to_numpy(dtype=float) for col in value_cols}
    ds_times, ds_values = _downsample_series(times, values, max_points)

    groups = AXIS_GROUPS.get(path.stem)
    if groups:
        series_cols = [c for c in groups if c in value_cols]
    else:
        series_cols = value_cols

    return {
        "name": _sensor_name_from_csv(path),
        "columns": value_cols,
        "series_columns": series_cols,
        "row_count": int(len(df)),
        "time_min": float(times.min()) if len(times) else 0.0,
        "time_max": float(times.max()) if len(times) else 0.0,
        "times": ds_times,
        "series": ds_values,
    }


def _media_role_from_name(name: str) -> str | None:
    """Guess Sensor Logger media role from filename (e.g. Camera.mp4, Microphone.mp4)."""
    lower = name.lower()
    if any(token in lower for token in ("microphone", "mic_", "_mic", "audio")):
        return "audio"
    if any(token in lower for token in ("camera", "video")):
        return "video"
    return None


def _find_media_files(data_dir: Path) -> dict[str, Any]:
    media: dict[str, Any] = {
        "video": None,
        "audio": None,
        "images_dir": None,
        "shared_av": False,
    }

    mp4_files: list[tuple[str, str]] = []
    other_audio: list[str] = []

    for path in sorted(data_dir.rglob("*")):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        rel = path.relative_to(data_dir).as_posix()
        if suffix in VIDEO_EXTENSIONS:
            mp4_files.append((rel, path.name))
        elif suffix in AUDIO_EXTENSIONS:
            other_audio.append(rel)

    for rel, name in mp4_files:
        role = _media_role_from_name(name)
        if role == "video" and media["video"] is None:
            media["video"] = rel
        elif role == "audio" and media["audio"] is None:
            media["audio"] = rel

    unassigned_mp4 = [rel for rel, _ in mp4_files if rel not in {media["video"], media["audio"]}]
    if media["video"] is None and unassigned_mp4:
        media["video"] = unassigned_mp4.pop(0)
    if media["audio"] is None and unassigned_mp4:
        media["audio"] = unassigned_mp4.pop(0)

    if media["audio"] is None and other_audio:
        media["audio"] = other_audio[0]

    if media["video"] and media["audio"] == media["video"]:
        media["shared_av"] = True

    images_dir = data_dir / "images"
    if images_dir.is_dir() and any(images_dir.iterdir()):
        media["images_dir"] = "images"

    return media


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
    sensors: dict[str, Any] = {}
    duration = 0.0

    for csv_path in _list_sensor_csvs(data_dir):
        try:
            sensor = _load_sensor_csv(csv_path, max_points=max_points)
        except Exception as exc:  # noqa: BLE001 — skip malformed exports
            sensors[_sensor_name_from_csv(csv_path)] = {
                "name": _sensor_name_from_csv(csv_path),
                "error": str(exc),
            }
            continue
        sensors[sensor["name"]] = sensor
        duration = max(duration, sensor["time_max"])

    media = _find_media_files(data_dir)
    camera_frames = _load_camera_frames(data_dir)

    return {
        "data_dir": str(data_dir),
        "metadata": metadata,
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
    for name, sensor in _session["sensors"].items():
        if "error" in sensor:
            sensors_meta.append(
                {
                    "name": name,
                    "error": sensor["error"],
                    "kind": "map" if name in MAP_SENSORS else "timeseries",
                }
            )
            continue
        sensors_meta.append(
            {
                "name": name,
                "columns": sensor["series_columns"],
                "row_count": sensor["row_count"],
                "time_min": sensor["time_min"],
                "time_max": sensor["time_max"],
                "kind": "map" if name in MAP_SENSORS else "timeseries",
            }
        )

    return {
        "data_dir": _session["data_dir"],
        "metadata": _session["metadata"],
        "duration": _session["duration"],
        "sensors": sensors_meta,
        "media": _session["media"],
        "camera_frame_count": len(_session["camera_frames"]),
        "has_microphone_levels": "Microphone" in _session["sensors"],
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

    if sensor["row_count"] <= max_points:
        return {
            "name": sensor["name"],
            "columns": sensor["series_columns"],
            "times": sensor["times"],
            "series": {k: sensor["series"][k] for k in sensor["series_columns"] if k in sensor["series"]},
        }

    data_dir = Path(_session["data_dir"])
    csv_path = data_dir / f"{sensor_name}.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail=f"CSV not found for {sensor_name}")

    reloaded = _load_sensor_csv(csv_path, max_points=max_points)
    return {
        "name": reloaded["name"],
        "columns": reloaded["series_columns"],
        "times": reloaded["times"],
        "series": {
            k: reloaded["series"][k]
            for k in reloaded["series_columns"]
            if k in reloaded["series"]
        },
    }


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
