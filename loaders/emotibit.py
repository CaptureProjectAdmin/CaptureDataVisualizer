"""Parsed EmotiBit DataParser files in an Emotibit folder.

Per-signal CSVs use LocalTimestamp as Unix seconds. Channels that belong
together (AX/AY/AZ, and so on) are aligned onto one time axis and plotted
like a phone sensor.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from loaders.common import GROUP_EMOTIBIT, build_sensor, error_sensor, find_child_dir

FOLDER_NAMES = ("Emotibit", "_Emotibit", "EmotiBit", "_EmotiBit")

# label, file tag
SensorSpec = list[tuple[str, str]]

# Tags that are parser bookkeeping rather than signals.
_SKIP_TAGS = {"AK", "EM", "RB", "RD", "TL", "timeSyncMap", "timesyncs"}

_SENSOR_SPECS: list[tuple[str, SensorSpec]] = [
    ("Accelerometer", [("x", "AX"), ("y", "AY"), ("z", "AZ")]),
    ("Gyroscope", [("x", "GX"), ("y", "GY"), ("z", "GZ")]),
    ("Magnetometer", [("x", "MX"), ("y", "MY"), ("z", "MZ")]),
    ("Electrodermal activity", [("EDA", "EA")]),
    ("SCR frequency", [("count_per_min", "SF")]),
    ("Temperature", [("T1", "T1"), ("thermopile", "TH")]),
    ("PPG", [("green", "PG"), ("infrared", "PI"), ("red", "PR")]),
    ("Heart rate", [("bpm", "HR")]),
    ("Inter-beat interval", [("ms", "BI")]),
    ("Battery", [("percent", "B%"), ("volts", "BV")]),
]

_EXTRA_LABELS = {
    "EL": "EDA raw",
}


def load_emotibit_sensors(
    data_dir: Path, origin_s: float | None, max_points: int
) -> dict[str, dict[str, Any]]:
    folder = find_child_dir(data_dir, FOLDER_NAMES)
    if folder is None:
        return {}
    try:
        return _load_folder(folder, origin_s, max_points)
    except Exception as exc:  # noqa: BLE001 — phone and eye data still load
        sensor_id = "emotibit._load"
        return {sensor_id: error_sensor(sensor_id, "Emotibit", GROUP_EMOTIBIT, str(exc))}


def load_emotibit_named(
    data_dir: Path, name: str, origin_s: float | None, max_points: int
) -> dict[str, Any]:
    sensors = load_emotibit_sensors(data_dir, origin_s, max_points)
    for sensor in sensors.values():
        if sensor.get("name") == name and "error" not in sensor:
            return sensor
    raise FileNotFoundError(f"Emotibit sensor not found: {name}")


def _load_folder(
    folder: Path, origin_s: float | None, max_points: int
) -> dict[str, dict[str, Any]]:
    channels = _index_channels(folder)
    origin = origin_s if origin_s is not None else _fallback_origin(channels)
    sensors: dict[str, dict[str, Any]] = {}
    used_tags: set[str] = set()

    for name, spec in _SENSOR_SPECS:
        present = [(label, tag) for label, tag in spec if tag in channels]
        used_tags.update(tag for _, tag in spec)
        if not present:
            continue
        sensor_id = f"emotibit.{name}"
        try:
            built = _build_from_tags(name, present, channels, origin, max_points)
        except Exception as exc:  # noqa: BLE001
            sensors[sensor_id] = error_sensor(sensor_id, name, GROUP_EMOTIBIT, str(exc))
            continue
        if built is not None:
            sensors[sensor_id] = built

    for tag in sorted(channels):
        if tag in used_tags or tag in _SKIP_TAGS:
            continue
        name = _EXTRA_LABELS.get(tag, tag)
        sensor_id = f"emotibit.{name}"
        try:
            built = _build_from_tags(name, [(tag, tag)], channels, origin, max_points)
        except Exception as exc:  # noqa: BLE001
            sensors[sensor_id] = error_sensor(sensor_id, name, GROUP_EMOTIBIT, str(exc))
            continue
        if built is None:
            continue
        sensors[sensor_id] = built
    return sensors


def _build_from_tags(
    name: str,
    columns: list[tuple[str, str]],
    channels: dict[str, Path],
    origin: float | None,
    max_points: int,
) -> dict[str, Any] | None:
    loaded: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for label, tag in columns:
        series = _read_channel(channels[tag], tag)
        if series is None:
            continue
        loaded[label] = series
    if not loaded:
        return None

    times, aligned = _align_channels(loaded)
    if origin is not None and len(times):
        times = times - origin
    return build_sensor(
        sensor_id=f"emotibit.{name}",
        name=name,
        group=GROUP_EMOTIBIT,
        times=times,
        series=aligned,
        max_points=max_points,
        source={"kind": "emotibit", "name": name},
    )


def _index_channels(folder: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in folder.glob("*.csv"):
        stem = path.stem
        if "_" not in stem:
            continue
        tag = stem.split("_", 1)[1]
        if tag in {"info", "timeSyncMap", "timesyncs"}:
            continue
        found[tag] = path
    return found


def _read_channel(path: Path, tag: str) -> tuple[np.ndarray, np.ndarray] | None:
    frame = pd.read_csv(path)
    if "LocalTimestamp" not in frame.columns or tag not in frame.columns:
        raise ValueError(f"{path.name} is missing LocalTimestamp or {tag}")
    times = pd.to_numeric(frame["LocalTimestamp"], errors="coerce").to_numpy(dtype=float)
    values = pd.to_numeric(frame[tag], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(values).any():
        return None
    return times, values


def _align_channels(
    loaded: dict[str, tuple[np.ndarray, np.ndarray]],
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    cleaned = {label: _clean_xy(times, values) for label, (times, values) in loaded.items()}
    cleaned = {label: pair for label, pair in cleaned.items() if len(pair[0])}
    if not cleaned:
        return np.array([], dtype=float), {}

    ref_label = max(cleaned, key=lambda label: len(cleaned[label][0]))
    ref_times = cleaned[ref_label][0]
    aligned: dict[str, np.ndarray] = {}
    for label, (times, values) in cleaned.items():
        if label == ref_label:
            aligned[label] = values
            continue
        aligned[label] = np.interp(ref_times, times, values)
    return ref_times, aligned


def _clean_xy(times: np.ndarray, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mask = np.isfinite(times) & np.isfinite(values)
    times = times[mask]
    values = values[mask]
    if len(times) == 0:
        return times, values
    order = np.argsort(times, kind="mergesort")
    times = times[order]
    values = values[order]
    _, unique_idx = np.unique(times, return_index=True)
    return times[unique_idx], values[unique_idx]


def _fallback_origin(channels: dict[str, Path]) -> float | None:
    for tag, path in channels.items():
        if tag in _SKIP_TAGS:
            continue
        series = _read_channel(path, tag)
        if series is None:
            continue
        times = series[0]
        finite = times[np.isfinite(times)]
        if len(finite):
            return float(finite.min())
    return None
