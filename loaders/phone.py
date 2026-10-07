"""Sensor Logger CSVs that sit in the recording root."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from loaders.common import GROUP_PHONE, build_sensor, error_sensor

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


def load_phone_sensors(data_dir: Path, max_points: int) -> dict[str, dict[str, Any]]:
    sensors: dict[str, dict[str, Any]] = {}
    for csv_path in _list_sensor_csvs(data_dir):
        sensor_id = f"phone.{csv_path.stem}"
        try:
            sensors[sensor_id] = load_phone_csv(csv_path, max_points)
        except Exception as exc:  # noqa: BLE001 — keep the rest of the export
            sensors[sensor_id] = error_sensor(sensor_id, csv_path.stem, GROUP_PHONE, str(exc))
    return sensors


def load_phone_csv(path: Path, max_points: int) -> dict[str, Any]:
    frame = pd.read_csv(path)
    if "seconds_elapsed" not in frame.columns:
        raise ValueError(f"{path.name} is missing seconds_elapsed")

    frame = frame.sort_values("seconds_elapsed").reset_index(drop=True)
    value_cols = [column for column in frame.columns if column not in {"time", "seconds_elapsed"}]
    preferred = AXIS_GROUPS.get(path.stem)
    if preferred:
        series_cols = [column for column in preferred if column in value_cols]
    else:
        series_cols = value_cols

    times = frame["seconds_elapsed"].to_numpy(dtype=float)
    series = {column: frame[column].to_numpy(dtype=float) for column in series_cols}
    kind = "map" if path.stem in MAP_SENSORS else "timeseries"
    return build_sensor(
        sensor_id=f"phone.{path.stem}",
        name=path.stem,
        group=GROUP_PHONE,
        times=times,
        series=series,
        max_points=max_points,
        kind=kind,
        source={"kind": "phone", "file": path.name},
    )


def _list_sensor_csvs(data_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in data_dir.glob("*.csv")
        if path.name.lower() not in {"metadata.csv", "camera.csv", "eventtable.csv"}
    )
