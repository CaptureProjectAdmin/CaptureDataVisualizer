"""Pupil Labs Neon recordings in an EyeTracking folder.

Continuous streams are raw arrays described by a sibling `.dtype` file and
timed by an int64 nanosecond `.time` file. Blink and fixation records carry
their own start and end timestamps.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import numpy as np

from loaders.common import GROUP_EYE, build_sensor, error_sensor, find_child_dir

FOLDER_NAMES = ("EyeTracking", "_EyeTracking", "Eye-Tracking")


def load_eye_sensors(
    data_dir: Path, origin_s: float | None, max_points: int
) -> dict[str, dict[str, Any]]:
    folder = find_child_dir(data_dir, FOLDER_NAMES)
    if folder is None:
        return {}
    try:
        return _load_folder(folder, origin_s, max_points)
    except Exception as exc:  # noqa: BLE001 — phone and EmotiBit data still load
        sensor_id = "eye._load"
        return {sensor_id: error_sensor(sensor_id, "Eye-tracking", GROUP_EYE, str(exc))}


# Neon scene-camera frames are 1600×1200, and gaze x/y are in those pixels.
SCENE_WIDTH = 1600
SCENE_HEIGHT = 1200
# 200 Hz gaze is denser than the video. Keep about 50 samples per second.
_GAZE_STRIDE = 4


def load_eye_overlay(data_dir: Path, origin_s: float | None) -> dict[str, Any]:
    """Gaze and fixation positions for the scene-camera video overlay."""
    empty: dict[str, Any] = {
        "width": SCENE_WIDTH,
        "height": SCENE_HEIGHT,
        "video_time_origin": 0.0,
        "gaze": {"times": [], "x": [], "y": []},
        "fixations": {"start": [], "end": [], "x": [], "y": []},
    }
    folder = find_child_dir(data_dir, FOLDER_NAMES)
    if folder is None:
        return empty
    origin = origin_s if origin_s is not None else _info_origin(folder)
    empty["video_time_origin"] = _video_time_origin(folder, origin)
    try:
        empty["gaze"] = _gaze_overlay(folder, origin)
        empty["fixations"] = _fixation_overlay(folder, origin)
    except Exception:
        return empty
    return empty


def _video_time_origin(folder: Path, origin: float | None) -> float:
    """Elapsed time of the scene video's first frame on the shared timeline."""
    started = _info_origin(folder)
    if started is None or origin is None:
        return 0.0
    return float(started - origin)


def _gaze_overlay(folder: Path, origin: float | None) -> dict[str, list[float]]:
    raw_path = folder / "gaze ps1.raw"
    dtype_path = folder / "gaze.dtype"
    time_path = folder / "gaze ps1.time"
    if not raw_path.is_file() or not dtype_path.is_file() or not time_path.is_file():
        return {"times": [], "x": [], "y": []}
    raw = _read_raw(raw_path, _read_dtype(dtype_path))
    if raw is None or len(raw) == 0:
        return {"times": [], "x": [], "y": []}
    times_ns = np.fromfile(time_path, dtype="<i8")
    count = min(len(raw), len(times_ns))
    step = _GAZE_STRIDE
    elapsed = _elapsed(times_ns[:count:step], origin)
    x = raw["x"][:count:step].astype(np.float64)
    y = raw["y"][:count:step].astype(np.float64)
    finite = np.isfinite(elapsed) & np.isfinite(x) & np.isfinite(y)
    return {
        "times": _rounded(elapsed[finite], 4),
        "x": _rounded(x[finite], 1),
        "y": _rounded(y[finite], 1),
    }


def _fixation_overlay(folder: Path, origin: float | None) -> dict[str, list[float]]:
    raw_path = folder / "fixations ps1.raw"
    dtype_path = folder / "fixations.dtype"
    if not raw_path.is_file() or not dtype_path.is_file():
        return {"start": [], "end": [], "x": [], "y": []}
    raw = _read_raw(raw_path, _read_dtype(dtype_path))
    if raw is None or len(raw) == 0:
        return {"start": [], "end": [], "x": [], "y": []}
    if origin is None:
        start_s = raw["start_timestamp_ns"].astype(np.float64) * 1e-9
        finite_start = start_s[np.isfinite(start_s)]
        origin = float(finite_start[0]) if len(finite_start) else 0.0
    start = _elapsed(raw["start_timestamp_ns"], origin)
    end = _elapsed(raw["end_timestamp_ns"], origin)
    x = raw["mean_gaze_x"].astype(np.float64)
    y = raw["mean_gaze_y"].astype(np.float64)
    finite = np.isfinite(start) & np.isfinite(end) & np.isfinite(x) & np.isfinite(y)
    order = np.argsort(start[finite], kind="mergesort")
    return {
        "start": _rounded(start[finite][order], 4),
        "end": _rounded(end[finite][order], 4),
        "x": _rounded(x[finite][order], 1),
        "y": _rounded(y[finite][order], 1),
    }


def _rounded(values: np.ndarray, digits: int) -> list[float]:
    scale = 10**digits
    rounded = np.round(np.asarray(values, dtype=np.float64) * scale) / scale
    return rounded.tolist()


def load_eye_named(
    data_dir: Path, name: str, origin_s: float | None, max_points: int
) -> dict[str, Any]:
    sensors = load_eye_sensors(data_dir, origin_s, max_points)
    for sensor in sensors.values():
        if sensor.get("name") == name and "error" not in sensor:
            return sensor
    raise FileNotFoundError(f"Eye-tracking sensor not found: {name}")


def _load_folder(
    folder: Path, origin_s: float | None, max_points: int
) -> dict[str, dict[str, Any]]:
    origin = origin_s if origin_s is not None else _info_origin(folder)
    sensors: dict[str, dict[str, Any]] = {}

    gaze_streams = (
        ("Gaze", "gaze ps1.raw", "gaze.dtype", "gaze ps1.time"),
        ("Gaze left", "gaze_left ps1.raw", "gaze.dtype", "gaze ps1.time"),
        ("Gaze right", "gaze_right ps1.raw", "gaze.dtype", "gaze ps1.time"),
    )
    for name, raw_name, dtype_name, time_name in gaze_streams:
        _add(
            sensors,
            _stream_sensor(
                folder,
                name=name,
                raw_name=raw_name,
                dtype_name=dtype_name,
                time_name=time_name,
                fields={"x": "x", "y": "y"},
                origin=origin,
                max_points=max_points,
            ),
        )

    eye_state_charts = (
        (
            "Pupil diameter",
            {"left_mm": "pupil_diameter_left_mm", "right_mm": "pupil_diameter_right_mm"},
        ),
        (
            "Eyelid aperture",
            {"left_mm": "eyelid_aperture_left_mm", "right_mm": "eyelid_aperture_right_mm"},
        ),
        (
            "Eyelid angle",
            {
                "top_left": "eyelid_angle_top_left",
                "bottom_left": "eyelid_angle_bottom_left",
                "top_right": "eyelid_angle_top_right",
                "bottom_right": "eyelid_angle_bottom_right",
            },
        ),
        (
            "Eyeball center left",
            {
                "x": "eyeball_center_left_x",
                "y": "eyeball_center_left_y",
                "z": "eyeball_center_left_z",
            },
        ),
        (
            "Eyeball center right",
            {
                "x": "eyeball_center_right_x",
                "y": "eyeball_center_right_y",
                "z": "eyeball_center_right_z",
            },
        ),
        (
            "Optical axis left",
            {
                "x": "optical_axis_left_x",
                "y": "optical_axis_left_y",
                "z": "optical_axis_left_z",
            },
        ),
        (
            "Optical axis right",
            {
                "x": "optical_axis_right_x",
                "y": "optical_axis_right_y",
                "z": "optical_axis_right_z",
            },
        ),
    )
    for name, fields in eye_state_charts:
        _add(
            sensors,
            _stream_sensor(
                folder,
                name=name,
                raw_name="eye_state ps1.raw",
                dtype_name="eye_state.dtype",
                time_name="eye_state ps1.time",
                fields=fields,
                origin=origin,
                max_points=max_points,
            ),
        )

    imu_charts = (
        ("IMU accelerometer", {"x": "accel_x", "y": "accel_y", "z": "accel_z"}),
        ("IMU gyroscope", {"x": "gyro_x", "y": "gyro_y", "z": "gyro_z"}),
        (
            "IMU orientation",
            {
                "w": "quaternion_w",
                "x": "quaternion_x",
                "y": "quaternion_y",
                "z": "quaternion_z",
            },
        ),
    )
    for name, fields in imu_charts:
        _add(
            sensors,
            _stream_sensor(
                folder,
                name=name,
                raw_name="imu ps1.raw",
                dtype_name="imu.dtype",
                time_name="imu ps1.time",
                fields=fields,
                origin=origin,
                max_points=max_points,
            ),
        )

    _add(sensors, _worn_sensor(folder, origin, max_points))
    _add(sensors, _blink_sensor(folder, origin, max_points))
    _add(sensors, _fixation_sensor(folder, origin, max_points))
    return sensors


def _stream_sensor(
    folder: Path,
    *,
    name: str,
    raw_name: str,
    dtype_name: str,
    time_name: str,
    fields: dict[str, str],
    origin: float | None,
    max_points: int,
) -> dict[str, Any] | None:
    raw_path = folder / raw_name
    dtype_path = folder / dtype_name
    time_path = folder / time_name
    if not raw_path.is_file() or not dtype_path.is_file() or not time_path.is_file():
        return None
    try:
        dtype = _read_dtype(dtype_path)
        raw = _read_raw(raw_path, dtype)
        if raw is None:
            return None
        times_ns = np.fromfile(time_path, dtype="<i8")
        count = min(len(raw), len(times_ns))
        if count == 0:
            return None
        raw = raw[:count]
        elapsed = _elapsed(times_ns[:count], origin)
        series = {label: raw[field].astype(np.float64) for label, field in fields.items()}
        return build_sensor(
            sensor_id=f"eye.{name}",
            name=name,
            group=GROUP_EYE,
            times=elapsed,
            series=series,
            max_points=max_points,
            source={"kind": "eye", "name": name},
        )
    except Exception as exc:  # noqa: BLE001
        return error_sensor(f"eye.{name}", name, GROUP_EYE, str(exc))


def _worn_sensor(
    folder: Path, origin: float | None, max_points: int
) -> dict[str, Any] | None:
    raw_path = folder / "worn ps1.raw"
    dtype_path = folder / "worn.dtype"
    time_path = folder / "gaze ps1.time"
    if not raw_path.is_file() or not dtype_path.is_file() or not time_path.is_file():
        return None
    try:
        raw = _read_raw(raw_path, _read_dtype(dtype_path))
        if raw is None:
            return None
        times_ns = np.fromfile(time_path, dtype="<i8")
        count = min(len(raw), len(times_ns))
        if count == 0:
            return None
        return build_sensor(
            sensor_id="eye.Worn",
            name="Worn",
            group=GROUP_EYE,
            times=_elapsed(times_ns[:count], origin),
            series={"worn": raw["worn"][:count].astype(np.float64)},
            max_points=max_points,
            source={"kind": "eye", "name": "Worn"},
        )
    except Exception as exc:  # noqa: BLE001
        return error_sensor("eye.Worn", "Worn", GROUP_EYE, str(exc))


def _blink_sensor(
    folder: Path, origin: float | None, max_points: int
) -> dict[str, Any] | None:
    raw_path = folder / "blinks ps1.raw"
    dtype_path = folder / "blinks.dtype"
    if not raw_path.is_file() or not dtype_path.is_file():
        return None
    try:
        raw = _read_raw(raw_path, _read_dtype(dtype_path))
        if raw is None or len(raw) == 0:
            return None
        start = raw["start_timestamp_ns"].astype(np.float64)
        end = raw["end_timestamp_ns"].astype(np.float64)
        return build_sensor(
            sensor_id="eye.Blinks",
            name="Blinks",
            group=GROUP_EYE,
            times=_elapsed(start, origin),
            series={"duration_s": (end - start) * 1e-9},
            max_points=max_points,
            source={"kind": "eye", "name": "Blinks"},
        )
    except Exception as exc:  # noqa: BLE001
        return error_sensor("eye.Blinks", "Blinks", GROUP_EYE, str(exc))


def _fixation_sensor(
    folder: Path, origin: float | None, max_points: int
) -> dict[str, Any] | None:
    raw_path = folder / "fixations ps1.raw"
    dtype_path = folder / "fixations.dtype"
    if not raw_path.is_file() or not dtype_path.is_file():
        return None
    try:
        raw = _read_raw(raw_path, _read_dtype(dtype_path))
        if raw is None or len(raw) == 0:
            return None
        start = raw["start_timestamp_ns"].astype(np.float64)
        end = raw["end_timestamp_ns"].astype(np.float64)
        return build_sensor(
            sensor_id="eye.Fixations",
            name="Fixations",
            group=GROUP_EYE,
            times=_elapsed(start, origin),
            series={
                "duration_s": (end - start) * 1e-9,
                "amplitude_deg": raw["amplitude_angle_deg"].astype(np.float64),
                "mean_velocity": raw["mean_velocity"].astype(np.float64),
                "max_velocity": raw["max_velocity"].astype(np.float64),
            },
            max_points=max_points,
            source={"kind": "eye", "name": "Fixations"},
        )
    except Exception as exc:  # noqa: BLE001
        return error_sensor("eye.Fixations", "Fixations", GROUP_EYE, str(exc))


def _add(sensors: dict[str, dict[str, Any]], sensor: dict[str, Any] | None) -> None:
    if sensor is None:
        return
    sensors[sensor["id"]] = sensor


def _elapsed(times_ns: np.ndarray, origin: float | None) -> np.ndarray:
    seconds = np.asarray(times_ns, dtype=np.float64) * 1e-9
    if origin is None:
        finite = seconds[np.isfinite(seconds)]
        origin = float(finite[0]) if len(finite) else 0.0
    return seconds - origin


def _info_origin(folder: Path) -> float | None:
    info_path = folder / "info.json"
    if not info_path.is_file():
        return None
    import json

    payload = json.loads(info_path.read_text(encoding="utf-8"))
    start = payload.get("start_time")
    if start is None:
        return None
    return float(start) * 1e-9


def _read_dtype(path: Path) -> np.dtype:
    text = path.read_text(encoding="utf-8")
    return np.dtype(ast.literal_eval(text))


def _read_raw(path: Path, dtype: np.dtype) -> np.ndarray | None:
    size = path.stat().st_size
    if dtype.itemsize == 0 or size % dtype.itemsize != 0:
        return None
    return np.fromfile(path, dtype=dtype)
