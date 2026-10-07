"""Shared sensor payload helpers.

Every source is converted into the same sensor record so the API and the
charts do not care which device produced it. Times are seconds from the
phone recording epoch (`Metadata.csv` "recording epoch time"), when that
epoch is available.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

GROUP_PHONE = "Phone"
GROUP_EYE = "Eye-tracking"
GROUP_EMOTIBIT = "Emotibit"
GROUP_ORDER = (GROUP_PHONE, GROUP_EYE, GROUP_EMOTIBIT)


def recording_origin_seconds(metadata: dict[str, Any]) -> float | None:
    """Unix seconds for t = 0 on the shared timeline."""
    raw = metadata.get("recording epoch time")
    if raw is None or str(raw).strip() == "":
        return None
    return float(raw) / 1000.0


def find_child_dir(data_dir: Path, names: tuple[str, ...]) -> Path | None:
    wanted = {name.lower() for name in names}
    if not data_dir.is_dir():
        return None
    for child in data_dir.iterdir():
        if child.is_dir() and child.name.lower() in wanted:
            return child
    return None


def downsample_series(
    times: np.ndarray, values: dict[str, np.ndarray], max_points: int
) -> tuple[list[float], dict[str, list[float | None]]]:
    n = len(times)
    if n == 0:
        return [], {key: [] for key in values}
    if n <= max_points:
        return (
            [float(t) for t in times],
            {key: [_finite_or_none(v) for v in arr] for key, arr in values.items()},
        )

    idx = np.linspace(0, n - 1, max_points, dtype=int)
    out_times = [float(times[i]) for i in idx]
    out_values = {
        key: [_finite_or_none(arr[i]) for i in idx] for key, arr in values.items()
    }
    return out_times, out_values


def build_sensor(
    *,
    sensor_id: str,
    name: str,
    group: str,
    times: np.ndarray,
    series: dict[str, np.ndarray],
    max_points: int,
    kind: str = "timeseries",
    source: dict[str, Any] | None = None,
) -> dict[str, Any]:
    times = np.asarray(times, dtype=float)
    columns = list(series.keys())
    cleaned: dict[str, np.ndarray] = {}
    for column in columns:
        values = np.asarray(series[column], dtype=float)
        if len(values) != len(times):
            raise ValueError(f"{name} column {column} does not match the time axis")
        cleaned[column] = values

    if len(times):
        finite = np.isfinite(times)
        times = times[finite]
        cleaned = {column: values[finite] for column, values in cleaned.items()}

    if len(times) > 1 and np.any(times[1:] < times[:-1]):
        order = np.argsort(times, kind="mergesort")
        times = times[order]
        cleaned = {column: values[order] for column, values in cleaned.items()}

    ds_times, ds_values = downsample_series(times, cleaned, max_points)
    payload: dict[str, Any] = {
        "id": sensor_id,
        "name": name,
        "group": group,
        "columns": columns,
        "series_columns": columns,
        "row_count": int(len(times)),
        "time_min": float(times[0]) if len(times) else 0.0,
        "time_max": float(times[-1]) if len(times) else 0.0,
        "times": ds_times,
        "series": ds_values,
        "kind": kind,
    }
    if source:
        payload["source"] = source
    return payload


def error_sensor(sensor_id: str, name: str, group: str, message: str) -> dict[str, Any]:
    return {
        "id": sensor_id,
        "name": name,
        "group": group,
        "error": message,
        "kind": "timeseries",
    }


def ordered_sensors(sensors: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {group: [] for group in GROUP_ORDER}
    rest: list[dict[str, Any]] = []
    for sensor in sensors.values():
        group = sensor.get("group")
        if group in buckets:
            buckets[group].append(sensor)
        else:
            rest.append(sensor)
    ordered: list[dict[str, Any]] = []
    for group in GROUP_ORDER:
        ordered.extend(buckets[group])
    ordered.extend(rest)
    return ordered


def sensor_view(sensor: dict[str, Any], max_points: int | None = None) -> dict[str, Any]:
    """JSON body for a chart request. Drops loader bookkeeping."""
    columns = list(sensor.get("series_columns") or [])
    times = list(sensor.get("times") or [])
    series = sensor.get("series") or {}
    if max_points is not None and len(times) > max_points:
        idx = np.linspace(0, len(times) - 1, max_points, dtype=int)
        times = [times[int(i)] for i in idx]
        series = {
            column: [series[column][int(i)] for i in idx]
            for column in columns
            if column in series
        }
    else:
        series = {column: series[column] for column in columns if column in series}
    return {
        "id": sensor.get("id"),
        "name": sensor.get("name"),
        "group": sensor.get("group"),
        "columns": columns,
        "times": times,
        "series": series,
    }


def _finite_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(number):
        return None
    return number
