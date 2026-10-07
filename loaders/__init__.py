"""Recording loaders. Each device module returns the same sensor record shape."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loaders.common import ordered_sensors, recording_origin_seconds
from loaders.emotibit import load_emotibit_named, load_emotibit_sensors
from loaders.eyetracking import load_eye_named, load_eye_sensors
from loaders.phone import load_phone_csv, load_phone_sensors


def load_sensors(
    data_dir: Path, metadata: dict[str, Any], max_points: int
) -> tuple[dict[str, dict[str, Any]], float | None]:
    origin_s = recording_origin_seconds(metadata)
    sensors: dict[str, dict[str, Any]] = {}
    sensors.update(load_phone_sensors(data_dir, max_points))
    sensors.update(load_eye_sensors(data_dir, origin_s, max_points))
    sensors.update(load_emotibit_sensors(data_dir, origin_s, max_points))
    return sensors, origin_s


def reload_sensor(
    sensor: dict[str, Any],
    data_dir: Path,
    origin_s: float | None,
    max_points: int,
) -> dict[str, Any]:
    source = sensor.get("source") or {}
    kind = source.get("kind")
    if kind == "phone":
        return load_phone_csv(data_dir / str(source.get("file") or ""), max_points)
    if kind == "emotibit":
        return load_emotibit_named(data_dir, str(source.get("name") or sensor.get("name")), origin_s, max_points)
    if kind == "eye":
        return load_eye_named(data_dir, str(source.get("name") or sensor.get("name")), origin_s, max_points)
    raise FileNotFoundError(f"Cannot reload sensor {sensor.get('id')}")


__all__ = [
    "load_sensors",
    "ordered_sensors",
    "reload_sensor",
]
