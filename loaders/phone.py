"""Sensor Logger CSVs that sit in the recording root."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
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
            if csv_path.stem.lower() == "location":
                location, velocity = _load_location_pair(csv_path, max_points)
                sensors[location["id"]] = location
                sensors[velocity["id"]] = velocity
            else:
                sensors[sensor_id] = load_phone_csv(csv_path, max_points)
        except Exception as exc:  # noqa: BLE001 — keep the rest of the export
            sensors[sensor_id] = error_sensor(sensor_id, csv_path.stem, GROUP_PHONE, str(exc))
    return _place_velocity_after_location(sensors)


def load_phone_stream(data_dir: Path, file_name: str, stream_name: str, max_points: int) -> dict[str, Any]:
    """Reload one phone stream. Location and Velocity both come from Location.csv."""
    path = data_dir / file_name
    if stream_name in {"Location", "Velocity"} or path.stem.lower() == "location":
        location_path = path if path.stem.lower() == "location" else data_dir / "Location.csv"
        location, velocity = _load_location_pair(location_path, max_points)
        return velocity if stream_name == "Velocity" else location
    return load_phone_csv(path, max_points)


def load_phone_csv(path: Path, max_points: int) -> dict[str, Any]:
    if path.stem.lower() == "location":
        location, _velocity = _load_location_pair(path, max_points)
        return location
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
        if path.name.lower() not in {"metadata.csv", "camera.csv", "eventtable.csv", "transcript.csv"}
    )


def _place_velocity_after_location(sensors: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    velocity = sensors.get("phone.Velocity")
    if velocity is None or "phone.Location" not in sensors:
        return sensors
    ordered: dict[str, dict[str, Any]] = {}
    for key, sensor in sensors.items():
        if key == "phone.Velocity":
            continue
        ordered[key] = sensor
        if key == "phone.Location":
            ordered["phone.Velocity"] = velocity
    return ordered


def _load_location_pair(path: Path, max_points: int) -> tuple[dict[str, Any], dict[str, Any]]:
    frame = pd.read_csv(path)
    if "seconds_elapsed" not in frame.columns:
        raise ValueError(f"{path.name} is missing seconds_elapsed")
    frame = frame.sort_values("seconds_elapsed").reset_index(drop=True)
    cleaned = _clean_location(frame, _read_pedometer(path), _read_yaw(path))
    source = {"kind": "phone", "file": path.name, "name": "Location"}
    velocity_source = {"kind": "phone", "file": path.name, "name": "Velocity"}
    location = build_sensor(
        sensor_id="phone.Location",
        name="Location",
        group=GROUP_PHONE,
        times=cleaned["times"],
        series={
            "latitude": cleaned["latitude"],
            "longitude": cleaned["longitude"],
            "altitude": cleaned["altitude"],
            "bearing": cleaned["bearing"],
            "horizontalAccuracy": cleaned["horizontal_accuracy"],
            "verticalAccuracy": cleaned["vertical_accuracy"],
            "bearingAccuracy": cleaned["bearing_accuracy"],
            "interpolated": cleaned["location_interpolated"],
            "latitude_raw": cleaned["latitude_raw"],
            "longitude_raw": cleaned["longitude_raw"],
            "segment": cleaned["segment"],
            "impossible": cleaned["impossible"],
            "heading": cleaned["heading"],
        },
        max_points=max_points,
        kind="map",
        source=source,
    )
    hidden = {"latitude_raw", "longitude_raw", "segment", "impossible", "heading"}
    location["step_m"] = float(cleaned["step_m"])
    location["columns"] = [column for column in location["columns"] if column not in hidden]
    location["series_columns"] = [column for column in location["series_columns"] if column not in hidden]
    velocity = build_sensor(
        sensor_id="phone.Velocity",
        name="Velocity",
        group=GROUP_PHONE,
        times=cleaned["times"],
        series={
            "Velocity": cleaned["velocity"],
            "Velocity uncertainty": cleaned["velocity_uncertainty"],
            "interpolated": cleaned["velocity_interpolated"],
        },
        max_points=max_points,
        kind="timeseries",
        source=velocity_source,
    )
    return location, velocity


def _read_pedometer(location_path: Path) -> tuple[np.ndarray, np.ndarray]:
    pedometer_path = None
    direct = location_path.with_name("Pedometer.csv")
    if direct.is_file():
        pedometer_path = direct
    else:
        for candidate in location_path.parent.glob("*.csv"):
            if candidate.stem.lower() == "pedometer":
                pedometer_path = candidate
                break
    if pedometer_path is None:
        return np.zeros(0), np.zeros(0)
    frame = pd.read_csv(pedometer_path)
    if "seconds_elapsed" not in frame.columns or "steps" not in frame.columns:
        return np.zeros(0), np.zeros(0)
    frame = frame.sort_values("seconds_elapsed")
    return (
        frame["seconds_elapsed"].to_numpy(dtype=float),
        frame["steps"].to_numpy(dtype=float),
    )


def _column(frame: pd.DataFrame, name: str) -> np.ndarray:
    if name not in frame.columns:
        return np.full(len(frame), np.nan)
    return frame[name].to_numpy(dtype=float)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000.0
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlambda = np.radians(lon2 - lon1)
    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2.0) ** 2
    return float(2.0 * radius * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0))))


def _steps_between(ped_t: np.ndarray, ped_steps: np.ndarray, start: float, end: float) -> float:
    if ped_t.size < 2 or end <= start:
        return 0.0
    before, after = np.interp([start, end], ped_t, ped_steps)
    return float(max(0.0, after - before))


def _estimate_step_length(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    accuracy: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
) -> float:
    lengths: list[float] = []
    for index in range(len(times) - 1):
        if accuracy[index] > 12 or accuracy[index + 1] > 12:
            continue
        dt = float(times[index + 1] - times[index])
        if dt < 0.2 or dt > 3:
            continue
        distance = _haversine_m(lat[index], lon[index], lat[index + 1], lon[index + 1])
        implied = distance / dt
        if implied < 0.5 or implied > 2.0:
            continue
        steps = _steps_between(ped_t, ped_steps, float(times[index]), float(times[index + 1]))
        if steps < 0.8:
            continue
        lengths.append(distance / steps)
    if len(lengths) < 8:
        return 0.75
    length = float(np.median(lengths))
    return float(min(1.05, max(0.45, length)))


def _fill(values: np.ndarray, drop: np.ndarray, times: np.ndarray, circular: bool = False) -> np.ndarray:
    filled = values.astype(float).copy()
    kept = np.flatnonzero(~drop)
    if kept.size == 0:
        return filled
    for index in np.flatnonzero(drop):
        previous = kept[kept < index]
        following = kept[kept > index]
        if previous.size and following.size:
            left = int(previous[-1])
            right = int(following[0])
            span = float(times[right] - times[left])
            weight = 0.0 if span <= 0 else float(times[index] - times[left]) / span
            if circular:
                change = (filled[right] - filled[left] + 180.0) % 360.0 - 180.0
                filled[index] = (filled[left] + weight * change) % 360.0
            else:
                filled[index] = filled[left] + weight * (filled[right] - filled[left])
        elif previous.size:
            filled[index] = filled[int(previous[-1])]
        else:
            filled[index] = filled[int(following[0])]
    return filled


def _clean_location(
    frame: pd.DataFrame,
    pedometer: tuple[np.ndarray, np.ndarray],
    yaw: tuple[np.ndarray, np.ndarray],
) -> dict[str, np.ndarray]:
    """Rebuild bad stretches from steps and phone heading, then set speed from that path.

    A single bad fix expands to at least ten seconds. The replacement follows the
    pedometer distance and the phone's yaw, and meets a trustworthy GPS anchor
    when that anchor agrees with the steps. Speed is measured on the new path
    and replaced by the pedometer wherever the two disagree.
    """
    times = _column(frame, "seconds_elapsed")
    lat = _column(frame, "latitude")
    lon = _column(frame, "longitude")
    raw_lat = lat.copy()
    raw_lon = lon.copy()
    altitude = _column(frame, "altitude")
    bearing = _column(frame, "bearing")
    speed = _column(frame, "speed")
    horizontal = _column(frame, "horizontalAccuracy")
    vertical = _column(frame, "verticalAccuracy")
    bearing_accuracy = _column(frame, "bearingAccuracy")
    speed_accuracy = _column(frame, "speedAccuracy")
    count = len(times)
    ped_t, ped_steps = pedometer
    drop = np.zeros(count, dtype=bool)
    heading = np.full(count, np.nan)
    if count >= 3 and np.isfinite(lat).all() and np.isfinite(lon).all():
        step_m = _estimate_step_length(times, lat, lon, horizontal, ped_t, ped_steps)
        drop = _location_outliers(times, lat, lon, horizontal, ped_t, ped_steps, step_m)
        drop = _expand_mask(times, drop, 10.0)
        heading = _heading_radians(times, lat, lon, horizontal, ped_t, ped_steps, step_m, yaw)
        segments = _assign_segments(times, heading)
        drop = _mark_inconsistent_pieces(times, lat, lon, segments, ped_t, ped_steps, step_m, drop)
        drop = _pad_short_runs(times, drop, 10.0)
        lat, lon, drop = _refit_runs(times, lat, lon, horizontal, heading, ped_t, ped_steps, step_m, drop)
        altitude = _fill(altitude, drop, times)
        bearing = _course_degrees(lat, lon, heading, drop, bearing)
    else:
        step_m = 0.75
    velocity, velocity_drop = _speed_from_path(times, lat, lon, speed, drop, ped_t, ped_steps, step_m)
    if count < 3 or not (np.isfinite(lat).all() and np.isfinite(lon).all()):
        segments = _assign_segments(times, heading)
    impossible = _mark_fast_building_crossings(times, lat, lon)
    return {
        "times": times,
        "latitude": lat,
        "longitude": lon,
        "altitude": altitude,
        "bearing": bearing,
        "horizontal_accuracy": horizontal,
        "vertical_accuracy": vertical,
        "bearing_accuracy": bearing_accuracy,
        "velocity": velocity,
        "velocity_uncertainty": speed_accuracy,
        "location_interpolated": drop.astype(float),
        "velocity_interpolated": velocity_drop.astype(float),
        "latitude_raw": raw_lat,
        "longitude_raw": raw_lon,
        "segment": segments,
        "impossible": impossible,
        "heading": heading,
        "step_m": np.array(step_m),
    }


def _location_outliers(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    horizontal: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
) -> np.ndarray:
    count = len(times)
    drop = np.zeros(count, dtype=bool)
    _mark_inaccurate_fixes(times, lat, lon, horizontal, ped_t, ped_steps, step_m, drop)
    for index in range(count):
        selected = np.flatnonzero(np.abs(times - times[index]) <= 12.0)
        selected = selected[selected != index]
        if selected.size < 3:
            continue
        distance = _haversine_m(lat[index], lon[index], float(np.median(lat[selected])), float(np.median(lon[selected])))
        walked = _steps_between(ped_t, ped_steps, float(times[index]) - 12.0, float(times[index]) + 12.0) * step_m
        if distance > max(25.0, walked * 1.5 + 12.0):
            drop[index] = True
    for index in range(1, count - 1):
        if drop[index]:
            continue
        to_previous = _haversine_m(lat[index - 1], lon[index - 1], lat[index], lon[index])
        to_next = _haversine_m(lat[index], lon[index], lat[index + 1], lon[index + 1])
        across = _haversine_m(lat[index - 1], lon[index - 1], lat[index + 1], lon[index + 1])
        if to_previous <= 30 or to_next <= 30 or across >= min(to_previous, to_next) * 0.35:
            continue
        walked = _steps_between(ped_t, ped_steps, float(times[index - 1]), float(times[index + 1])) * step_m
        if max(to_previous, to_next) > max(30.0, walked * 2.0 + 15.0):
            drop[index] = True
    _mark_stalled_fixes(times, lat, lon, ped_t, ped_steps, step_m, drop)
    _mark_unwalked_jumps(times, lat, lon, horizontal, ped_t, ped_steps, step_m, drop)
    if drop.all():
        drop[:] = False
    return drop


def _mark_unwalked_jumps(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    horizontal: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    drop: np.ndarray,
) -> None:
    """Drop the less reliable end of a short jump the pedometer did not walk."""
    for index in range(len(times) - 1):
        if drop[index] and drop[index + 1]:
            continue
        dt = float(times[index + 1] - times[index])
        if dt <= 0 or dt > 12.0:
            continue
        distance = _haversine_m(lat[index], lon[index], lat[index + 1], lon[index + 1])
        walked = _steps_between(ped_t, ped_steps, float(times[index]), float(times[index + 1])) * step_m
        if distance <= max(30.0, walked * 1.8 + 10.0):
            continue
        worse = index if float(horizontal[index]) >= float(horizontal[index + 1]) else index + 1
        drop[worse] = True


def _mark_inaccurate_fixes(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    horizontal: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    drop: np.ndarray,
) -> None:
    """Drop a high-uncertainty fix when reliable fixes nearby put it off the path."""
    reliable = np.flatnonzero(np.isfinite(horizontal) & (horizontal <= 30.0))
    for index in np.flatnonzero(np.isfinite(horizontal) & (horizontal >= 80.0)):
        earlier = reliable[reliable < index]
        later = reliable[reliable > index]
        anchors: list[int] = []
        if earlier.size and float(times[index] - times[int(earlier[-1])]) <= 45.0:
            anchors.append(int(earlier[-1]))
        if later.size and float(times[int(later[0])] - times[index]) <= 45.0:
            anchors.append(int(later[0]))
        if len(anchors) == 2:
            left, right = anchors
            span = float(times[right] - times[left])
            weight = 0.0 if span <= 0 else float(times[index] - times[left]) / span
            predicted_lat = float(lat[left] + weight * (lat[right] - lat[left]))
            predicted_lon = float(lon[left] + weight * (lon[right] - lon[left]))
            residual = _haversine_m(lat[index], lon[index], predicted_lat, predicted_lon)
            walked = _steps_between(ped_t, ped_steps, float(times[left]), float(times[right])) * step_m
            if residual > max(20.0, walked + 15.0):
                drop[index] = True
        elif len(anchors) == 1:
            anchor = anchors[0]
            residual = _haversine_m(lat[index], lon[index], lat[anchor], lon[anchor])
            walked = _steps_between(ped_t, ped_steps, float(times[min(index, anchor)]), float(times[max(index, anchor)])) * step_m
            if residual > max(25.0, walked + 15.0):
                drop[index] = True
        elif float(horizontal[index]) >= 150.0:
            drop[index] = True


def _mark_stalled_fixes(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    drop: np.ndarray,
) -> None:
    """Fill a frozen stretch when the pedometer kept counting and a later fix catches up."""
    count = len(times)
    frozen = np.ones(count, dtype=bool)
    for point in range(1, count):
        dt = max(float(times[point] - times[point - 1]), 1e-3)
        implied = _haversine_m(lat[point - 1], lon[point - 1], lat[point], lon[point]) / dt
        frozen[point] = implied < 1.0
    index = 0
    while index < count:
        if drop[index] or not frozen[index]:
            index += 1
            continue
        end = index
        while end + 1 < count and not drop[end + 1] and frozen[end + 1]:
            if _haversine_m(lat[index], lon[index], lat[end + 1], lon[end + 1]) > 12.0:
                break
            end += 1
        duration = float(times[end] - times[index])
        walked = _steps_between(ped_t, ped_steps, float(times[index]), float(times[end])) * step_m
        catch = None
        if duration >= 8.0 and walked > 10.0 and end > index:
            for candidate in range(end + 1, count):
                if float(times[candidate] - times[end]) > 25.0:
                    break
                if drop[candidate]:
                    continue
                travel = _haversine_m(lat[index], lon[index], lat[candidate], lon[candidate])
                jump = _haversine_m(lat[end], lon[end], lat[candidate], lon[candidate])
                walked_to_catch = _steps_between(ped_t, ped_steps, float(times[index]), float(times[candidate])) * step_m
                if jump < 15.0 or walked_to_catch <= 0 or not (0.45 * walked_to_catch <= travel <= 2.2 * walked_to_catch):
                    continue
                following = [
                    point
                    for point in range(candidate + 1, count)
                    if not drop[point] and float(times[point] - times[candidate]) <= 12.0
                ]
                if following and _haversine_m(lat[candidate], lon[candidate], lat[following[0]], lon[following[0]]) > 20.0:
                    continue
                catch = candidate
                break
        if catch is not None:
            drop[index + 1 : catch] = True
            index = catch
            continue
        index = max(end, index) + 1


def _speed_outliers(
    times: np.ndarray,
    speed: np.ndarray,
    speed_accuracy: np.ndarray,
    location_drop: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
) -> np.ndarray:
    drop = location_drop.copy()
    if ped_t.size < 2:
        return drop
    count = len(times)
    ped_speed = np.zeros(count)
    for index in range(count):
        ped_speed[index] = _steps_between(ped_t, ped_steps, float(times[index]) - 2.0, float(times[index]) + 2.0) * step_m / 4.0
    agreed = np.flatnonzero(np.isfinite(speed) & (np.abs(speed - ped_speed) <= 0.75) & ~location_drop)
    for index in range(count):
        if drop[index] or not np.isfinite(speed[index]):
            drop[index] = True
            continue
        tolerance = max(0.75, min(float(speed_accuracy[index]) if np.isfinite(speed_accuracy[index]) else 0.75, 1.5))
        if abs(float(speed[index]) - float(ped_speed[index])) <= tolerance:
            continue
        nearby = agreed[(times[agreed] >= times[index] - 15.0) & (times[agreed] <= times[index] + 15.0)]
        if nearby.size < 2:
            continue
        if abs(float(speed[index]) - float(np.median(speed[nearby]))) > 0.6:
            drop[index] = True
    return drop


def _read_yaw(location_path: Path) -> tuple[np.ndarray, np.ndarray]:
    path = location_path.with_name("Orientation.csv")
    if not path.is_file():
        for candidate in location_path.parent.glob("*.csv"):
            if candidate.stem.lower() == "orientation":
                path = candidate
                break
        else:
            return np.zeros(0), np.zeros(0)
    frame = pd.read_csv(path)
    if "seconds_elapsed" not in frame.columns or "yaw" not in frame.columns:
        return np.zeros(0), np.zeros(0)
    frame = frame.sort_values("seconds_elapsed")
    return frame["seconds_elapsed"].to_numpy(dtype=float), frame["yaw"].to_numpy(dtype=float)


def _expand_mask(times: np.ndarray, drop: np.ndarray, seconds: float) -> np.ndarray:
    """A replaced fix covers the surrounding window, never a single sample."""
    expanded = drop.copy()
    bad = times[drop]
    if bad.size == 0:
        return expanded
    for moment in bad:
        expanded |= np.abs(times - moment) <= seconds
    return expanded


def _mark_inconsistent_pieces(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    segments: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    drop: np.ndarray,
) -> np.ndarray:
    """Replace a straight piece whose length does not match the pedometer."""
    marked = drop.copy()
    if ped_t.size < 2:
        return marked
    for segment in np.unique(segments.astype(int)):
        idx = np.flatnonzero(segments.astype(int) == int(segment))
        if idx.size < 2:
            continue
        kept = idx[~drop[idx]]
        if kept.size < 2:
            marked[idx] = True
            continue
        distance = 0.0
        for cursor in range(1, kept.size):
            left = int(kept[cursor - 1])
            right = int(kept[cursor])
            distance += _haversine_m(lat[left], lon[left], lat[right], lon[right])
        walked = _steps_between(ped_t, ped_steps, float(times[int(idx[0])]), float(times[int(idx[-1])])) * step_m
        if walked < 8.0:
            continue
        if distance < 0.65 * walked or distance > 1.55 * walked:
            marked[idx] = True
    return marked


def _pad_short_runs(times: np.ndarray, drop: np.ndarray, minimum: float) -> np.ndarray:
    """A replaced run lasts at least `minimum` seconds, including the next sample if the gap is short."""
    padded = drop.copy()
    count = len(times)
    index = 0
    while index < count:
        if not drop[index]:
            index += 1
            continue
        end = index
        while end + 1 < count and drop[end + 1]:
            end += 1
        left = index
        right = end
        while float(times[right] - times[left]) < minimum and (left > 0 or right + 1 < count):
            extend_left = right + 1 >= count or (
                left > 0 and float(times[index] - times[left - 1]) <= float(times[right + 1] - times[end])
            )
            if extend_left and left > 0:
                left -= 1
            elif right + 1 < count:
                right += 1
            else:
                break
            padded[left] = True
            padded[right] = True
        index = end + 1
    return padded


def _circ(delta: float) -> float:
    return float((delta + np.pi) % (2.0 * np.pi) - np.pi)


def _forward_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dlambda = np.radians(lon2 - lon1)
    east = np.sin(dlambda) * np.cos(phi2)
    north = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlambda)
    return float(np.arctan2(east, north))


def _move_meters(lat: float, lon: float, bearing: float, distance: float) -> tuple[float, float]:
    north = distance * np.cos(bearing)
    east = distance * np.sin(bearing)
    return (
        lat + north / 111_320.0,
        lon + east / (111_320.0 * max(0.2, np.cos(np.radians(lat)))),
    )


def _heading_radians(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    horizontal: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    yaw: tuple[np.ndarray, np.ndarray],
) -> np.ndarray:
    """Phone yaw turned into a walking direction. The pocket offset comes from good GPS."""
    yaw_t, yaw_values = yaw
    heading = np.full(len(times), np.nan)
    if yaw_t.size < 2:
        return heading
    sampled = np.interp(times, yaw_t, np.unwrap(yaw_values))
    offsets: list[float] = []
    for index in range(len(times) - 1):
        dt = float(times[index + 1] - times[index])
        if dt < 0.4 or dt > 3.0 or horizontal[index] > 15.0 or horizontal[index + 1] > 15.0:
            continue
        distance = _haversine_m(lat[index], lon[index], lat[index + 1], lon[index + 1])
        if distance / dt < 0.5 or distance / dt > 2.2:
            continue
        walked = _steps_between(ped_t, ped_steps, float(times[index]), float(times[index + 1])) * step_m
        if walked < 0.3 or not (0.5 * walked <= distance <= 1.8 * walked):
            continue
        course = _forward_bearing(lat[index], lon[index], lat[index + 1], lon[index + 1])
        offsets.append(_circ(course - float(sampled[index])))
    offset = 0.0 if len(offsets) < 8 else float(np.angle(np.mean(np.exp(1j * np.array(offsets)))))
    return (sampled + offset + np.pi) % (2.0 * np.pi) - np.pi


def _refit_runs(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    horizontal: np.ndarray,
    heading: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    drop: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Walk each bad run by steps and heading, and blend the ends into the anchors."""
    lat = lat.copy()
    lon = lon.copy()
    count = len(times)
    if count > 2 and bool(drop.all()):
        drop = drop.copy()
        drop[0] = False
        drop[-1] = False
    index = 0
    while index < count:
        if not drop[index]:
            index += 1
            continue
        end = index
        while end + 1 < count and drop[end + 1]:
            end += 1
        left = index - 1 if index > 0 else None
        right = end + 1 if end + 1 < count else None
        if left is None and right is None:
            index = end + 1
            continue
        if left is None and right is not None:
            lat, lon = _integrate_backward(times, lat, lon, heading, ped_t, ped_steps, step_m, index, right)
        elif left is None:
            index = end + 1
            continue
        else:
            lat, lon = _integrate_forward(
                times, lat, lon, horizontal, heading, ped_t, ped_steps, step_m, drop, left, end, right
            )
        index = end + 1
    return lat, lon, drop


def _integrate_forward(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    horizontal: np.ndarray,
    heading: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    drop: np.ndarray,
    left: int,
    end: int,
    right: int | None,
) -> tuple[np.ndarray, np.ndarray]:
    trust_right = False
    if right is not None:
        chord = _haversine_m(float(lat[left]), float(lon[left]), float(lat[right]), float(lon[right]))
        ped_len = _steps_between(ped_t, ped_steps, float(times[left]), float(times[right])) * step_m
        trust_right = (
            not drop[right]
            and np.isfinite(horizontal[right])
            and float(horizontal[right]) <= 25.0
            and ped_len > 1.0
            and 0.55 * ped_len <= chord <= 1.7 * ped_len
        )
    if right is None:
        placed, _, _ = _walk_heading(times, lat, lon, heading, ped_t, ped_steps, step_m, left, end, right, 0.0)
    else:
        delta = _heading_delta(times, lat, lon, heading, ped_t, ped_steps, step_m, left, end, right) if trust_right else 0.0
        placed, cursor_lat, cursor_lon = _walk_heading(
            times, lat, lon, heading, ped_t, ped_steps, step_m, left, end, right, delta
        )
        anchor_lat = float(lat[right])
        anchor_lon = float(lon[right])
        # Heading that cannot reach a trustworthy fix would draw an out-and-back.
        # The chord is used only when that fix already agrees with the pedometer.
        missed = _haversine_m(cursor_lat, cursor_lon, anchor_lat, anchor_lon) > 8.0
        if trust_right and missed:
            placed = _place_along_chord(times, lat, lon, ped_t, ped_steps, step_m, left, end, right)
        elif not missed:
            end_time = float(times[end])
            blended: list[tuple[int, float, float]] = []
            for point, new_lat, new_lon in placed:
                remain = end_time - float(times[point])
                if remain < 3.0:
                    weight = 0.5 - 0.5 * np.cos(np.pi * (1.0 - remain / 3.0))
                    new_lat += weight * (anchor_lat - new_lat)
                    new_lon += weight * (anchor_lon - new_lon)
                blended.append((point, new_lat, new_lon))
            placed = blended
    for point, new_lat, new_lon in placed:
        lat[point] = new_lat
        lon[point] = new_lon
    return lat, lon


def _place_along_chord(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    left: int,
    end: int,
    right: int,
) -> list[tuple[int, float, float]]:
    """Space the gap by steps along the straight line between the two kept fixes."""
    span = _steps_between(ped_t, ped_steps, float(times[left]), float(times[right])) * step_m
    if span <= 0.3:
        duration = float(times[right] - times[left])
        span = duration if duration > 0 else 1.0
        walked_of = lambda point: float(times[point] - times[left])
    else:
        walked_of = lambda point: _steps_between(ped_t, ped_steps, float(times[left]), float(times[point])) * step_m
    placed: list[tuple[int, float, float]] = []
    for point in range(left + 1, end + 1):
        fraction = float(np.clip(walked_of(point) / span, 0.0, 1.0))
        placed.append(
            (
                point,
                float(lat[left]) + fraction * (float(lat[right]) - float(lat[left])),
                float(lon[left]) + fraction * (float(lon[right]) - float(lon[left])),
            )
        )
    return placed


def _heading_delta(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    heading: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    left: int,
    end: int,
    right: int,
) -> float:
    """A few degrees of yaw, chosen so the pedometer path meets the next anchor."""
    best_delta = 0.0
    best_error = float("inf")
    for degrees in range(-15, 16, 3):
        delta = float(np.deg2rad(degrees))
        _, cursor_lat, cursor_lon = _walk_heading(
            times, lat, lon, heading, ped_t, ped_steps, step_m, left, end, right, delta
        )
        error = _haversine_m(cursor_lat, cursor_lon, float(lat[right]), float(lon[right]))
        if error < best_error:
            best_error = error
            best_delta = delta
    return best_delta


def _walk_heading(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    heading: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    left: int,
    end: int,
    right: int | None,
    delta: float,
) -> tuple[list[tuple[int, float, float]], float, float]:
    cursor_lat = float(lat[left])
    cursor_lon = float(lon[left])
    last_heading = (float(heading[left]) if np.isfinite(heading[left]) else 0.0) + delta
    placed: list[tuple[int, float, float]] = []
    stop = (right if right is not None else end) + 1
    for point in range(left + 1, stop):
        distance = _steps_between(ped_t, ped_steps, float(times[point - 1]), float(times[point])) * step_m
        if np.isfinite(heading[point]):
            last_heading = float(heading[point]) + delta
        cursor_lat, cursor_lon = _move_meters(cursor_lat, cursor_lon, last_heading, distance)
        if point <= end:
            placed.append((point, cursor_lat, cursor_lon))
    return placed, cursor_lat, cursor_lon


def _integrate_backward(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    heading: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
    start: int,
    right: int,
) -> tuple[np.ndarray, np.ndarray]:
    cursor_lat = float(lat[right])
    cursor_lon = float(lon[right])
    last_heading = float(heading[right]) if np.isfinite(heading[right]) else 0.0
    for point in range(right - 1, start - 1, -1):
        distance = _steps_between(ped_t, ped_steps, float(times[point]), float(times[point + 1])) * step_m
        if np.isfinite(heading[point]):
            last_heading = float(heading[point])
        cursor_lat, cursor_lon = _move_meters(cursor_lat, cursor_lon, last_heading + np.pi, distance)
        lat[point] = cursor_lat
        lon[point] = cursor_lon
    return lat, lon


def _course_degrees(
    lat: np.ndarray,
    lon: np.ndarray,
    heading: np.ndarray,
    drop: np.ndarray,
    bearing: np.ndarray,
) -> np.ndarray:
    course = bearing.astype(float).copy()
    for index in range(1, len(lat)):
        if not (drop[index] or drop[index - 1]):
            continue
        course[index] = np.degrees(_forward_bearing(lat[index - 1], lon[index - 1], lat[index], lon[index])) % 360.0
        if not np.isfinite(course[index]) and np.isfinite(heading[index]):
            course[index] = np.degrees(heading[index]) % 360.0
    return course


def _speed_from_path(
    times: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    original: np.ndarray,
    location_drop: np.ndarray,
    ped_t: np.ndarray,
    ped_steps: np.ndarray,
    step_m: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Path speed, replaced by the pedometer wherever the two disagree."""
    count = len(times)
    path = np.zeros(count)
    ped = np.zeros(count)
    for index in range(count):
        ped[index] = _steps_between(ped_t, ped_steps, float(times[index]) - 2.0, float(times[index]) + 2.0) * step_m / 4.0
        if index == 0:
            continue
        dt = float(times[index] - times[index - 1])
        if dt > 0:
            path[index] = _haversine_m(lat[index - 1], lon[index - 1], lat[index], lon[index]) / dt
    if count > 1:
        path[0] = path[1]
        ped[0] = ped[1] if ped[1] else ped[0]
    velocity = path.copy()
    replaced = location_drop.copy()
    for index in range(count):
        reference = float(ped[index])
        if ped_t.size < 2:
            reference = float(path[index])
        if abs(float(path[index]) - reference) > max(0.45, 0.35 * max(reference, float(path[index]))):
            velocity[index] = reference
            replaced[index] = True
        elif location_drop[index]:
            velocity[index] = float(path[index])
        elif np.isfinite(original[index]) and abs(float(original[index]) - reference) <= max(0.45, 0.35 * max(reference, float(original[index]))):
            velocity[index] = float(original[index])
            replaced[index] = False
        else:
            velocity[index] = reference if ped_t.size >= 2 else float(path[index])
            replaced[index] = True
    return velocity, replaced


def _assign_segments(times: np.ndarray, heading: np.ndarray) -> np.ndarray:
    count = len(times)
    segments = np.zeros(count)
    if count == 0:
        return segments
    current = 0
    anchor = float(heading[0]) if np.isfinite(heading[0]) else 0.0
    started = float(times[0]) if count else 0.0
    for index in range(1, count):
        sample = float(heading[index]) if np.isfinite(heading[index]) else anchor
        if abs(_circ(sample - anchor)) > np.deg2rad(40.0) and float(times[index]) - started > 8.0:
            window = heading[(times >= times[index]) & (times <= times[index] + 4.0)]
            window = window[np.isfinite(window)]
            if window.size:
                turned = float(np.angle(np.mean(np.exp(1j * window))))
                if abs(_circ(turned - anchor)) > np.deg2rad(30.0):
                    current += 1
                    anchor = turned
                    started = float(times[index])
        segments[index] = current
    return segments


_BUILDING_CACHE: dict[tuple[float, float, float, float], list[list[tuple[float, float]]]] = {}


def _mark_fast_building_crossings(times: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Flag a jump across a building. A walking pace through a doorway is allowed."""
    impossible = np.zeros(len(times))
    rings = _building_rings(lat, lon)
    if not rings:
        return impossible
    for index in range(1, len(times)):
        dt = float(times[index] - times[index - 1])
        if dt <= 0:
            continue
        distance = _haversine_m(lat[index - 1], lon[index - 1], lat[index], lon[index])
        if distance / dt <= 2.5:
            continue
        if _crosses_building(float(lat[index - 1]), float(lon[index - 1]), float(lat[index]), float(lon[index]), rings):
            impossible[index - 1] = 1.0
            impossible[index] = 1.0
    return impossible


def _building_rings(lat: np.ndarray, lon: np.ndarray) -> list[list[tuple[float, float]]]:
    finite = np.isfinite(lat) & np.isfinite(lon)
    if int(finite.sum()) < 2:
        return []
    south = float(np.min(lat[finite]))
    north = float(np.max(lat[finite]))
    west = float(np.min(lon[finite]))
    east = float(np.max(lon[finite]))
    key = (round(south, 3), round(north, 3), round(west, 3), round(east, 3))
    cached = _BUILDING_CACHE.get(key)
    if cached is not None:
        return cached
    query = (
        f"[out:json][timeout:12];way[\"building\"]({south - 0.001},{west - 0.001},{north + 0.001},{east + 0.001});out geom;"
    )
    rings = _fetch_building_rings(query)
    if rings is not None:
        _BUILDING_CACHE[key] = rings
    return rings or []


def _fetch_building_rings(query: str) -> list[list[tuple[float, float]]] | None:
    """Return building outlines, or None when every map server fails."""
    endpoints = (
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    )
    for endpoint in endpoints:
        request = urllib.request.Request(
            endpoint,
            data=query.encode("utf-8"),
            headers={"User-Agent": "CaptureDataVisualizer", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=4) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception:
            continue
        rings: list[list[tuple[float, float]]] = []
        for element in payload.get("elements", []):
            geometry = element.get("geometry") or []
            if len(geometry) < 4:
                continue
            rings.append([(float(point["lat"]), float(point["lon"])) for point in geometry])
        return rings
    return None


def _crosses_building(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
    rings: list[list[tuple[float, float]]],
) -> bool:
    mid_lat = (lat1 + lat2) / 2.0
    mid_lon = (lon1 + lon2) / 2.0
    for ring in rings:
        lats = [point[0] for point in ring]
        lons = [point[1] for point in ring]
        if max(lat1, lat2) < min(lats) or min(lat1, lat2) > max(lats):
            continue
        if max(lon1, lon2) < min(lons) or min(lon1, lon2) > max(lons):
            continue
        if _ring_contains(mid_lat, mid_lon, ring):
            return True
        for edge in range(len(ring) - 1):
            if _segments_cross((lat1, lon1), (lat2, lon2), ring[edge], ring[edge + 1]):
                return True
    return False


def _ring_contains(lat: float, lon: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    previous = len(ring) - 1
    for index, (row_lat, row_lon) in enumerate(ring):
        prev_lat, prev_lon = ring[previous]
        if (row_lon > lon) != (prev_lon > lon):
            cross = (prev_lat - row_lat) * (lon - row_lon) / (prev_lon - row_lon + 1e-15) + row_lat
            if lat < cross:
                inside = not inside
        previous = index
    return inside


def _segments_cross(
    start: tuple[float, float],
    end: tuple[float, float],
    edge_start: tuple[float, float],
    edge_end: tuple[float, float],
) -> bool:
    def side(origin: tuple[float, float], dest: tuple[float, float], point: tuple[float, float]) -> float:
        return (dest[0] - origin[0]) * (point[1] - origin[1]) - (dest[1] - origin[1]) * (point[0] - origin[0])

    return side(start, end, edge_start) * side(start, end, edge_end) < 0 and side(edge_start, edge_end, start) * side(
        edge_start, edge_end, end
    ) < 0
