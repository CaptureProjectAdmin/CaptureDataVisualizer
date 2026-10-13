"""Export fixations for every recording under a folder you choose.

A recording is any directory that contains Metadata.csv. The search does not
enter a recording. Fixations are event type 1 from the Neon fixation file,
the same split the visualizer uses. Each file is that stream at its own
sample times, from Walk Begin through Walk End in EventTable.csv.

The download matches a separate-file visualizer export:
  time_s, Eye-tracking_Fixations_duration_s, Eye-tracking_Fixations_x, Eye-tracking_Fixations_y

Results are written outside the recording tree:

  fixation_exports/summary.csv
  fixation_exports/<relative path>/Eye-tracking_Fixations.csv

Run:
  python export_fixations.py "D:\\path\\to\\recordings"
  python export_fixations.py "D:\\path\\to\\recordings" --output "D:\\path\\to\\results"
"""

from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path

import numpy as np

from loaders.common import find_child_dir, recording_origin_seconds
from loaders.eyetracking import FOLDER_NAMES, _fixation_sensor

WALK_BEGIN = "Walk Begin"
WALK_END = "Walk End"
_FULL_SERIES = 10_000_000

SUMMARY_FIELDS = [
    "subject",
    "session",
    "relative_path",
    "status",
    "error",
    "walk_begin_s",
    "walk_end_s",
    "fixation_rows",
    "output_file",
]


def find_recordings(root: Path) -> list[Path]:
    """Directories that contain Metadata.csv. Do not search inside a recording."""
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        if "Metadata.csv" in filenames:
            found.append(Path(dirpath))
            dirnames.clear()
    return sorted(found, key=lambda path: str(path).lower())


def _read_metadata(recording: Path) -> dict[str, str]:
    path = recording / "Metadata.csv"
    with path.open(newline="", encoding="utf-8-sig") as handle:
        row = next(csv.DictReader(handle), None)
    if not row:
        return {}
    return {str(key): "" if value is None else str(value) for key, value in row.items()}


def _read_events(recording: Path) -> list[dict[str, float | str]]:
    path = recording / "EventTable.csv"
    if not path.is_file():
        return []
    events: list[dict[str, float | str]] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return []
        fields = {name.strip().lower(): name for name in reader.fieldnames}
        time_key = fields.get("time") or fields.get("timestamp") or fields.get("timestamps")
        event_key = fields.get("event") or fields.get("events")
        if not time_key or not event_key:
            return []
        for row in reader:
            try:
                time = round(float(row.get(time_key) or ""), 2)
            except ValueError:
                continue
            event = str(row.get(event_key) or "").strip()
            if event:
                events.append({"time": time, "event": event})
    events.sort(key=lambda item: float(item["time"]))
    return events


def walk_interval(events: list[dict[str, float | str]]) -> tuple[float, float]:
    """First Walk Begin and the first Walk End at or after it."""
    begins = [float(item["time"]) for item in events if str(item["event"]).casefold() == WALK_BEGIN.casefold()]
    ends = [float(item["time"]) for item in events if str(item["event"]).casefold() == WALK_END.casefold()]
    if not begins:
        raise ValueError(f"{WALK_BEGIN} was not found in EventTable.csv.")
    if not ends:
        raise ValueError(f"{WALK_END} was not found in EventTable.csv.")
    start = begins[0]
    later = [time for time in ends if time >= start]
    if not later:
        raise ValueError(f"{WALK_END} is before {WALK_BEGIN}.")
    return start, later[0]


def load_fixations(recording: Path) -> dict:
    metadata = _read_metadata(recording)
    origin = recording_origin_seconds(metadata)
    if origin is None:
        raise ValueError('Metadata.csv has no "recording epoch time".')
    folder = find_child_dir(recording, FOLDER_NAMES)
    if folder is None:
        raise ValueError("No Eye-tracking folder was found.")
    sensor = _fixation_sensor(folder, origin, _FULL_SERIES)
    if sensor is None:
        raise ValueError("No fixations were found.")
    if sensor.get("error"):
        raise ValueError(str(sensor["error"]))
    times = sensor.get("times") or []
    if int(sensor.get("row_count") or 0) != len(times):
        raise RuntimeError("Fixations were shortened, so the original rate would be incomplete.")
    return sensor


def _cell(value: object) -> str:
    if value is None:
        return ""
    number = float(value)
    if not np.isfinite(number):
        return ""
    return f"{number:.10g}"


def write_fixation_csv(path: Path, sensor: dict, start: float, end: float) -> int:
    """One row per fixation whose start time falls in the walk interval."""
    times = np.asarray(sensor.get("times") or [], dtype=float)
    columns = list(sensor.get("columns") or [])
    series = sensor.get("series") or {}
    mask = np.isfinite(times) & (times >= start - 1e-9) & (times <= end + 1e-9)
    group = str(sensor.get("group") or "Eye-tracking")
    name = str(sensor.get("name") or "Fixations")
    headers = ["time_s", *[f"{group}_{name}_{column}" for column in columns]]
    path.parent.mkdir(parents=True, exist_ok=True)
    kept = np.flatnonzero(mask)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        for index in kept:
            row = [f"{float(times[index]):.6f}"]
            for column in columns:
                values = series.get(column) or []
                row.append(_cell(values[index] if index < len(values) else None))
            writer.writerow(row)
    return int(kept.size)


def _labels(root: Path, recording: Path) -> tuple[str, str, str]:
    relative = recording.resolve().relative_to(root.resolve())
    if str(relative) == ".":
        relative = Path(recording.name)
    parts = relative.parts
    subject = parts[0] if parts else ""
    session = str(Path(*parts[1:])) if len(parts) > 1 else ""
    return subject, session, relative.as_posix()


def export_recording(root: Path, recording: Path, output: Path) -> dict[str, object]:
    subject, session, relative = _labels(root, recording)
    row: dict[str, object] = {field: "" for field in SUMMARY_FIELDS}
    row["subject"] = subject
    row["session"] = session
    row["relative_path"] = relative
    try:
        start, end = walk_interval(_read_events(recording))
        sensor = load_fixations(recording)
        destination = output / Path(relative) / f"{sensor.get('group')}_{sensor.get('name')}.csv"
        count = write_fixation_csv(destination, sensor, start, end)
    except Exception as exc:
        row["status"] = "error"
        row["error"] = str(exc)
        return row
    row["status"] = "ok"
    row["walk_begin_s"] = f"{start:.2f}"
    row["walk_end_s"] = f"{end:.2f}"
    row["fixation_rows"] = count
    row["output_file"] = destination.relative_to(output).as_posix()
    return row


def _write_summary(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=SUMMARY_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def run_batch(root: Path, output: Path) -> None:
    print(f"Searching {root}", flush=True)
    recordings = find_recordings(root)
    print(f"Found {len(recordings)} recordings", flush=True)
    rows: list[dict[str, object]] = []
    for index, recording in enumerate(recordings, start=1):
        row = export_recording(root, recording, output)
        rows.append(row)
        _write_summary(output / "summary.csv", rows)
        label = f"[{index}/{len(recordings)}] {row['relative_path']}"
        if row["status"] == "ok":
            print(f"{label}  {row['fixation_rows']} fixations  {row['walk_begin_s']}–{row['walk_end_s']} s", flush=True)
        else:
            print(f"{label}  error: {row['error']}", flush=True)
    ok = sum(1 for row in rows if row["status"] == "ok")
    print(f"Done. {ok} ok, {len(rows) - ok} errors. Results in {output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export original-rate fixations from Walk Begin to Walk End for every recording in a folder tree."
    )
    parser.add_argument("root", type=Path, help="Folder that contains the participant and session directories.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.cwd() / "fixation_exports",
        help="Where to write summary.csv and one fixation CSV per recording. Defaults to ./fixation_exports.",
    )
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"Folder not found: {root}")
    run_batch(root, args.output.expanduser().resolve())


if __name__ == "__main__":
    main()
