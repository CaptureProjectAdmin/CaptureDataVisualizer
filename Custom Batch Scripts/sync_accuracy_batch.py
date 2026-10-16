"""Run the synchronization evaluation on every recording under a folder tree.

A recording is any directory that contains Metadata.csv. Nested session folders
such as RMR001/WALK1 are each evaluated on their own. Results are written in the current directory, outside the recording tree:

  summary.csv   one row per recording, for group comparison
  lags.csv      one row per audio window, for plotting lag across sessions
  recordings/   the full report for each session, including the lag series

Run:
  python "Custom Batch Scripts\\sync_accuracy_batch.py" "D:\\path\\to\\recordings"
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import traceback
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import numpy as np

from sync_accuracy import evaluate

SUMMARY_FIELDS = [
    "subject",
    "session",
    "relative_path",
    "status",
    "error",
    "phone_epoch_denver",
    "phone_quantization_half_ms",
    "phone_time_vs_elapsed_max_abs_ms",
    "scene_first_frame_offset_s",
    "info_json_offset_s",
    "info_json_minus_first_frame_s",
    "scene_time_stamps",
    "scene_video_frames",
    "scene_frame_period_ms",
    "scene_duration_s",
    "audio_windows",
    "audio_windows_kept",
    "audio_offset_median_ms",
    "audio_interval_low_ms",
    "audio_interval_high_ms",
    "audio_peak_half_width_median_ms",
    "audio_peak_half_width_p95_ms",
    "audio_drift_ms_per_min",
    "audio_drift_across_span_ms",
    "audio_span_start_s",
    "audio_span_end_s",
    "emotibit_packets",
    "emotibit_packets_kept",
    "emotibit_packets_dropped_long_rtt",
    "emotibit_rtt_median_ms",
    "emotibit_window_start_phone_s",
    "emotibit_window_end_phone_s",
    "emotibit_window_duration_s",
    "emotibit_residual_median_ms",
    "emotibit_residual_std_ms",
    "emotibit_interval_low_ms",
    "emotibit_interval_high_ms",
    "emotibit_rate_error_ppm",
    "emotibit_rate_error_se_ppm",
    "emotibit_seconds_after_last_packet",
    "emotibit_extrapolated_half_width_ms",
]

LAG_FIELDS = [
    "subject",
    "session",
    "relative_path",
    "phone_s",
    "lag_ms",
    "pearson",
    "kept",
    "peak_half_width_ms",
]


def find_recordings(root: Path) -> list[Path]:
    """Directories that contain Metadata.csv. Do not search inside a recording."""
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        if "Metadata.csv" in filenames:
            found.append(Path(dirpath))
            dirnames.clear()
    return sorted(found, key=lambda path: str(path).lower())


def _json_default(value: object) -> object:
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _blank_row(relative: str) -> dict[str, object]:
    parts = Path(relative).parts
    row = {field: "" for field in SUMMARY_FIELDS}
    row["subject"] = parts[0] if parts else ""
    row["session"] = str(Path(*parts[1:])) if len(parts) > 1 else ""
    row["relative_path"] = relative.replace("\\", "/")
    return row


def _copy(source: dict, target: dict, keys: list[tuple[str, str]]) -> None:
    for source_key, target_key in keys:
        if source_key in source and source[source_key] is not None:
            target[target_key] = source[source_key]


def summary_row(relative: str, report: dict | None, error: str) -> dict[str, object]:
    row = _blank_row(relative)
    if error or not report:
        row["status"] = "error"
        row["error"] = error
        return row
    row["status"] = "ok"
    clocks = report.get("clocks") or {}
    audio = report.get("audio") or {}
    emotibit = report.get("emotibit") or {}
    _copy(
        clocks,
        row,
        [
            ("phone_epoch_denver", "phone_epoch_denver"),
            ("phone_quantization_half_ms", "phone_quantization_half_ms"),
            ("phone_time_vs_elapsed_max_abs_ms", "phone_time_vs_elapsed_max_abs_ms"),
            ("scene_first_frame_offset_s", "scene_first_frame_offset_s"),
            ("info_json_offset_s", "info_json_offset_s"),
            ("info_json_minus_first_frame_s", "info_json_minus_first_frame_s"),
            ("scene_time_stamps", "scene_time_stamps"),
            ("scene_video_frames", "scene_video_frames"),
            ("scene_frame_period_ms", "scene_frame_period_ms"),
            ("scene_duration_s", "scene_duration_s"),
        ],
    )
    _copy(
        audio,
        row,
        [
            ("windows", "audio_windows"),
            ("windows_kept", "audio_windows_kept"),
            ("offset_median_ms", "audio_offset_median_ms"),
            ("interval_low_ms", "audio_interval_low_ms"),
            ("interval_high_ms", "audio_interval_high_ms"),
            ("peak_half_width_median_ms", "audio_peak_half_width_median_ms"),
            ("peak_half_width_p95_ms", "audio_peak_half_width_p95_ms"),
            ("drift_ms_per_min", "audio_drift_ms_per_min"),
            ("drift_across_kept_span_ms", "audio_drift_across_span_ms"),
        ],
    )
    span = audio.get("kept_span_s") or []
    if len(span) == 2:
        row["audio_span_start_s"] = span[0]
        row["audio_span_end_s"] = span[1]
    _copy(
        emotibit,
        row,
        [
            ("packets", "emotibit_packets"),
            ("packets_kept", "emotibit_packets_kept"),
            ("packets_dropped_long_rtt", "emotibit_packets_dropped_long_rtt"),
            ("rtt_median_ms", "emotibit_rtt_median_ms"),
            ("window_start_phone_s", "emotibit_window_start_phone_s"),
            ("window_end_phone_s", "emotibit_window_end_phone_s"),
            ("window_duration_s", "emotibit_window_duration_s"),
            ("residual_median_ms", "emotibit_residual_median_ms"),
            ("residual_std_ms", "emotibit_residual_std_ms"),
            ("interval_low_ms", "emotibit_interval_low_ms"),
            ("interval_high_ms", "emotibit_interval_high_ms"),
            ("rate_error_ppm", "emotibit_rate_error_ppm"),
            ("rate_error_se_ppm", "emotibit_rate_error_se_ppm"),
            ("seconds_after_last_packet", "emotibit_seconds_after_last_packet"),
            ("extrapolated_half_width_ms", "emotibit_extrapolated_half_width_ms"),
        ],
    )
    return row


def lag_rows(relative: str, report: dict | None) -> list[dict[str, object]]:
    if not report:
        return []
    parts = Path(relative).parts
    subject = parts[0] if parts else ""
    session = str(Path(*parts[1:])) if len(parts) > 1 else ""
    path = relative.replace("\\", "/")
    rows = []
    for item in (report.get("audio") or {}).get("series") or []:
        rows.append(
            {
                "subject": subject,
                "session": session,
                "relative_path": path,
                "phone_s": item.get("phone_s", ""),
                "lag_ms": item.get("lag_ms", ""),
                "pearson": item.get("pearson", ""),
                "kept": item.get("kept", ""),
                "peak_half_width_ms": item.get("peak_half_width_ms", ""),
            }
        )
    return rows


def _write_csv(path: Path, fields: list[str], rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _report_path(output: Path, relative: str) -> Path:
    return output / "recordings" / Path(relative).with_suffix(".json")


def _read_report(path: Path) -> tuple[dict | None, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and payload.get("error") and "clocks" not in payload:
        return None, str(payload["error"])
    return payload, ""


def _write_report(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")


def run_batch(root: Path, output: Path, force: bool) -> None:
    print(f"Searching {root}", flush=True)
    recordings = find_recordings(root)
    print(f"Found {len(recordings)} recordings", flush=True)
    summaries: list[dict[str, object]] = []
    lags: list[dict[str, object]] = []
    for index, recording in enumerate(recordings, start=1):
        relative = recording.relative_to(root).as_posix()
        destination = _report_path(output, relative)
        label = f"[{index}/{len(recordings)}] {relative}"
        report: dict | None = None
        error = ""
        if destination.is_file() and not force:
            try:
                report, error = _read_report(destination)
                print(f"{label}  skipped (already saved)", flush=True)
            except (OSError, json.JSONDecodeError) as exc:
                error = str(exc)
                print(f"{label}  saved file could not be read: {error}", flush=True)
        else:
            print(f"{label}  measuring", flush=True)
            try:
                report = evaluate(recording)
                _write_report(destination, report)
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                _write_report(destination, {"error": error, "traceback": traceback.format_exc()})
                print(f"{label}  error: {error}", flush=True)
            else:
                offset = (report.get("audio") or {}).get("offset_median_ms")
                offset_text = f"{offset:.1f} ms" if isinstance(offset, (int, float)) else "no audio offset"
                print(f"{label}  {offset_text}", flush=True)
        summaries.append(summary_row(relative, report, error))
        lags.extend(lag_rows(relative, report))
        _write_csv(output / "summary.csv", SUMMARY_FIELDS, summaries)
        _write_csv(output / "lags.csv", LAG_FIELDS, lags)
    ok = sum(1 for row in summaries if row["status"] == "ok")
    print(f"Done. {ok} ok, {len(summaries) - ok} errors. Results in {output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate synchronization for every recording in a folder tree.")
    parser.add_argument("root", type=Path, help="Folder that contains the participant and session directories.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.cwd(),
        help="Where to write summary.csv, lags.csv, and the per-recording reports. Defaults to the current directory.",
    )
    parser.add_argument("--force", action="store_true", help="Recompute recordings that already have a saved report.")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Folder not found: {root}")
    run_batch(root, args.output.resolve(), args.force)


if __name__ == "__main__":
    main()
