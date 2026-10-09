"""Estimate synchronization offset, interval, and drift for one recording.

The shared timeline is phone elapsed time. This report does not change playback.
Run: python sync_accuracy.py "F:\\Files\\RMR001\\WALK1"
"""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

DENVER = ZoneInfo("America/Denver")
ENVELOPE_HZ = 50
WINDOW_S = 25.0
HOP_S = 30.0
MAX_LAG_S = 2.5
MIN_PEARSON = 0.35
MAX_RTT_MS = 200.0


def _ffmpeg_f32(path: Path, sample_rate: int = 8000) -> np.ndarray:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode != 0:
        message = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(message or f"ffmpeg failed on {path.name}")
    return np.frombuffer(result.stdout, dtype=np.float32).astype(np.float64)


def _envelope(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    hop = sample_rate // ENVELOPE_HZ
    count = len(samples) // hop
    if count < 2:
        return np.zeros(0)
    block = np.abs(samples[: count * hop]).reshape(count, hop)
    return block.mean(axis=1)


def _normalized_lags(reference: np.ndarray, other: np.ndarray) -> np.ndarray:
    """Pearson r for every alignment of `reference` inside the longer `other`."""
    window = len(reference)
    centered = reference - reference.mean()
    reference_energy = float(np.dot(centered, centered))
    if reference_energy <= 0 or len(other) < window:
        return np.zeros(0)
    cumulative = np.cumsum(other)
    cumulative_sq = np.cumsum(other * other)
    starts = np.arange(len(other) - window + 1)
    ends = starts + window - 1
    previous = starts - 1
    sum_ = cumulative[ends] - np.where(previous >= 0, cumulative[previous], 0.0)
    sum_sq = cumulative_sq[ends] - np.where(previous >= 0, cumulative_sq[previous], 0.0)
    variance = np.maximum(sum_sq - (sum_ * sum_) / window, 0.0)
    correlation = np.correlate(other, centered, mode="valid")
    denominator = np.sqrt(reference_energy * variance)
    scores = np.full(correlation.shape, -np.inf)
    valid = denominator > 0
    scores[valid] = correlation[valid] / denominator[valid]
    return scores


def _peak_lag(scores: np.ndarray, max_lag: int) -> tuple[float, float, float]:
    """Return interpolated lag in samples, peak r, and half-width in samples."""
    if scores.size == 0 or not np.isfinite(scores).any():
        return 0.0, 0.0, float(max_lag)
    peak = int(np.argmax(scores))
    score = float(scores[peak])
    lag = float(peak - max_lag)
    if 0 < peak < len(scores) - 1:
        left, center, right = float(scores[peak - 1]), score, float(scores[peak + 1])
        denom = left - 2.0 * center + right
        if denom < 0:
            lag += 0.5 * (left - right) / denom
    above = np.where(scores >= max(score - 0.05, 0.5 * score))[0]
    half_width = float((above[-1] - above[0]) / 2.0) if above.size else 0.0
    return lag, score, half_width


def _lag_sign_check() -> dict:
    """A known delay must come back with the same sign."""
    rate = ENVELOPE_HZ
    timeline = np.arange(0, 40 * rate)
    pulse = np.zeros_like(timeline, dtype=float)
    pulse[(timeline > 5 * rate) & (timeline < 6 * rate)] = 1.0
    delay = 17
    shifted = np.zeros_like(pulse)
    shifted[delay:] = pulse[:-delay]
    scores = _normalized_lags(pulse[rate:-rate], shifted[: len(pulse)])
    lag, score, _width = _peak_lag(scores, rate)
    return {
        "inserted_delay_samples": delay,
        "recovered_lag_samples": round(lag, 2),
        "pearson": round(score, 4),
        "passed": bool(abs(lag - delay) < 0.6 and score > 0.99),
    }


def _clock_baseline(root: Path) -> dict:
    metadata = pd.read_csv(root / "Metadata.csv", nrows=1).iloc[0]
    epoch_s = float(metadata["recording epoch time"]) / 1000.0
    recorded = datetime.fromtimestamp(epoch_s, DENVER)

    accel = pd.read_csv(root / "Accelerometer.csv", usecols=["time", "seconds_elapsed"])
    absolute_s = accel["time"].to_numpy(dtype=np.float64) / 1e9
    elapsed = accel["seconds_elapsed"].to_numpy(dtype=np.float64)
    phone_residual_ms = (absolute_s - epoch_s - elapsed) * 1000.0
    gaps = np.diff(elapsed)
    gaps = gaps[np.isfinite(gaps) & (gaps > 0)]

    eye = root / "EyeTracking"
    info = json.loads((eye / "info.json").read_text(encoding="utf-8"))
    info_start_s = float(info["start_time"]) * 1e-9
    scene_times = np.fromfile(eye / "Neon Scene Camera v1 ps1.time", dtype="<i8")
    scene_s = scene_times.astype(np.float64) / 1e9
    frame_dt_ms = np.diff(scene_s) * 1000.0
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames",
            "-of",
            "csv=p=0",
            str(eye / "Neon Scene Camera v1 ps1.mp4"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    video_frames = int(probe.stdout.strip() or "0")

    return {
        "recording": root.name,
        "phone_epoch_unix_s": epoch_s,
        "phone_epoch_denver": recorded.strftime("%Y-%m-%d %H:%M:%S"),
        "phone_time_vs_elapsed_max_abs_ms": float(np.nanmax(np.abs(phone_residual_ms))),
        "phone_sample_period_ms": float(np.median(gaps) * 1000.0),
        "phone_quantization_half_ms": float(np.median(gaps) * 500.0),
        "info_json_offset_s": float(info_start_s - epoch_s),
        "scene_first_frame_offset_s": float(scene_s[0] - epoch_s),
        "info_json_minus_first_frame_s": float(info_start_s - scene_s[0]),
        "scene_time_stamps": int(scene_times.size),
        "scene_video_frames": video_frames,
        "scene_frame_period_ms": float(np.median(frame_dt_ms)),
        "scene_frame_dt_p05_ms": float(np.percentile(frame_dt_ms, 5)),
        "scene_frame_dt_p95_ms": float(np.percentile(frame_dt_ms, 95)),
        "scene_duration_s": float(scene_s[-1] - scene_s[0]),
    }


def _parse_host_time(text: str) -> float:
    stamp = datetime.strptime(str(text).strip(), "%Y-%m-%d_%H-%M-%S-%f")
    return stamp.replace(tzinfo=DENVER).timestamp()


def _emotibit_sync(root: Path, epoch_s: float) -> dict:
    folder = root / "Emotibit"
    packets = pd.read_csv(folder / "EMdata_timesyncs.csv")
    packets.columns = [str(column).strip() for column in packets.columns]
    packets["host_send_s"] = packets["TS_sent"].map(_parse_host_time)
    packets["host_mid_s"] = packets["host_send_s"] + packets["RoundTrip"].astype(float) / 2000.0
    packets["device_s"] = packets["TS_received"].astype(float) / 1000.0
    kept = packets[packets["RoundTrip"].astype(float) <= MAX_RTT_MS].copy()
    dropped = int(len(packets) - len(kept))

    device = kept["device_s"].to_numpy(dtype=float)
    host = kept["host_mid_s"].to_numpy(dtype=float)
    slope, intercept = np.polyfit(device, host, 1)
    fitted = intercept + slope * device
    residual_s = host - fitted
    residual_ms = residual_s * 1000.0
    rate_error = float(slope - 1.0)
    dof = max(len(device) - 2, 1)
    sigma = float(np.sqrt(np.sum(residual_s**2) / dof))
    centered_device = device - device.mean()
    slope_se = sigma / float(np.sqrt(np.sum(centered_device**2)))
    dropped_rtt = [
        float(value)
        for value in packets.loc[packets["RoundTrip"].astype(float) > MAX_RTT_MS, "RoundTrip"]
    ]

    sync_map = pd.read_csv(folder / "EMdata_timeSyncMap.csv")
    sync_map.columns = [str(column).strip() for column in sync_map.columns]
    row = sync_map.iloc[0]
    te0 = float(row["TE0"])
    te1 = float(row["TE1"])
    tl0 = float(row["TL0"])
    tl1 = float(row["TL1"])
    end_device_s = float(row["EmotiBitEndTime"]) / 1000.0
    map_slope = (tl1 - tl0) / ((te1 - te0) / 1000.0)

    def mapped(device_ms: np.ndarray) -> np.ndarray:
        return tl0 + (device_ms - te0) * (tl1 - tl0) / (te1 - te0)

    map_residual_ms = (host - mapped(kept["TS_received"].to_numpy(dtype=float))) * 1000.0
    last_device_s = float(device[-1])
    seconds_after = max(0.0, end_device_s - last_device_s)
    residual_half_ms = float(np.percentile(np.abs(residual_ms), 95))
    extrapolated_half_ms = residual_half_ms + abs(rate_error) * seconds_after * 1000.0
    low_ms = float(np.percentile(residual_ms, 2.5))
    high_ms = float(np.percentile(residual_ms, 97.5))

    return {
        "packets": int(len(packets)),
        "packets_kept": int(len(kept)),
        "packets_dropped_long_rtt": dropped,
        "dropped_rtt_ms": dropped_rtt,
        "rtt_median_ms": float(packets["RoundTrip"].median()),
        "rtt_kept_median_ms": float(kept["RoundTrip"].median()),
        "window_start_denver": datetime.fromtimestamp(float(host[0]), DENVER).strftime("%H:%M:%S"),
        "window_end_denver": datetime.fromtimestamp(float(host[-1]), DENVER).strftime("%H:%M:%S"),
        "window_start_phone_s": float(host[0] - epoch_s),
        "window_end_phone_s": float(host[-1] - epoch_s),
        "window_duration_s": float(host[-1] - host[0]),
        "fit_slope_host_s_per_device_s": float(slope),
        "rate_error_s_per_s": rate_error,
        "rate_error_ppm": rate_error * 1e6,
        "rate_error_se_ppm": slope_se * 1e6,
        "map_slope_host_s_per_device_s": float(map_slope),
        "residual_median_ms": float(np.median(residual_ms)),
        "residual_std_ms": float(np.std(residual_ms)),
        "interval_low_ms": low_ms,
        "interval_high_ms": high_ms,
        "map_residual_std_ms": float(np.std(map_residual_ms)),
        "seconds_after_last_packet": seconds_after,
        "extrapolated_half_width_ms": extrapolated_half_ms,
        "claim": (
            "Measured only between the kept sync packets. "
            "The wider number after the last packet is |rate| times the remaining device time, "
            "added to the residual spread. It is not another measurement."
        ),
    }


def _window_lags(
    phone_env: np.ndarray,
    scene_env: np.ndarray,
    rate_hz: float,
    max_lag_s: float,
) -> list[dict]:
    window = int(WINDOW_S * rate_hz)
    hop = int(HOP_S * rate_hz)
    max_lag = int(max_lag_s * rate_hz)
    last = min(len(phone_env), len(scene_env)) - window - max_lag
    rows = []
    start = max_lag
    while start <= last:
        reference = phone_env[start : start + window]
        other = scene_env[start - max_lag : start + window + max_lag]
        scores = _normalized_lags(reference, other)
        lag, score, width = _peak_lag(scores, max_lag)
        center_s = (start + window / 2) / rate_hz
        rows.append(
            {
                "phone_s": round(center_s, 1),
                "lag_ms": lag / rate_hz * 1000.0,
                "peak_half_width_ms": width / rate_hz * 1000.0,
                "pearson": round(score, 4),
                "kept": bool(score >= MIN_PEARSON),
            }
        )
        start += hop
    return rows


def _audio_drift(root: Path) -> dict:
    phone = _ffmpeg_f32(root / "Microphone.mp4")
    scene = _ffmpeg_f32(root / "EyeTracking" / "Neon Scene Camera v1 ps1.mp4")
    coarse = _window_lags(_envelope(phone, 8000), _envelope(scene, 8000), ENVELOPE_HZ, MAX_LAG_S)
    coarse_lags = [row["lag_ms"] for row in coarse if row["kept"]]
    coarse_median_ms = float(np.median(coarse_lags)) if coarse_lags else 0.0
    fine_rate = 1000.0
    fine_hop = 8000 // int(fine_rate)
    phone_fine = np.abs(phone[: len(phone) // fine_hop * fine_hop]).reshape(-1, fine_hop).mean(axis=1)
    scene_fine = np.abs(scene[: len(scene) // fine_hop * fine_hop]).reshape(-1, fine_hop).mean(axis=1)
    shift = int(round(coarse_median_ms * fine_rate / 1000.0))
    if shift >= 0:
        scene_shifted = scene_fine[shift:]
        phone_use = phone_fine[: len(scene_shifted)]
    else:
        phone_use = phone_fine[-shift:]
        scene_shifted = scene_fine[: len(phone_use)]
    rows = _window_lags(phone_use, scene_shifted, fine_rate, 0.08)
    applied_ms = shift / fine_rate * 1000.0
    phone_origin_s = 0.0 if shift >= 0 else (-shift) / fine_rate
    for row in rows:
        row["lag_ms"] = row["lag_ms"] + applied_ms
        row["phone_s"] = round(row["phone_s"] + phone_origin_s, 1)

    kept = [row for row in rows if row["kept"]]
    if len(kept) < 3:
        return {
            "windows": len(rows),
            "windows_kept": len(kept),
            "min_pearson": MIN_PEARSON,
            "claim": "Too few windows correlated strongly enough to estimate a lag.",
            "series": rows,
        }

    times = np.array([row["phone_s"] for row in kept], dtype=float)
    lags = np.array([row["lag_ms"] for row in kept], dtype=float)
    slope, intercept = np.polyfit(times, lags, 1)
    residual = lags - (intercept + slope * times)
    dof = max(len(times) - 2, 1)
    sigma = float(np.sqrt(np.sum(residual**2) / dof))
    centered = times - times.mean()
    slope_se = sigma / float(np.sqrt(np.sum(centered**2)))
    low = float(np.percentile(lags, 2.5))
    high = float(np.percentile(lags, 97.5))
    median = float(np.median(lags))
    widths = np.array([row["peak_half_width_ms"] for row in kept], dtype=float)
    return {
        "windows": len(rows),
        "windows_kept": len(kept),
        "min_pearson": MIN_PEARSON,
        "window_s": WINDOW_S,
        "hop_s": HOP_S,
        "envelope_ms": 1.0,
        "coarse_offset_median_ms": coarse_median_ms,
        "sign_check": _lag_sign_check(),
        "offset_median_ms": median,
        "interval_low_ms": low,
        "interval_high_ms": high,
        "peak_half_width_median_ms": float(np.median(widths)),
        "peak_half_width_p95_ms": float(np.percentile(widths, 95)),
        "drift_ms_per_s": float(slope),
        "drift_ms_per_min": float(slope * 60.0),
        "drift_se_ms_per_min": float(slope_se * 60.0),
        "drift_across_kept_span_ms": float(slope * (times[-1] - times[0])),
        "kept_span_s": [float(times[0]), float(times[-1])],
        "definition": (
            "Lag is scene-file time minus phone-file time for the same sound. "
            "Positive means the scene recording places that sound later than the phone recording. "
            "The player currently treats those file times as equal."
        ),
        "series": rows,
    }


def evaluate(root: Path) -> dict:
    clocks = _clock_baseline(root)
    emotibit = _emotibit_sync(root, clocks["phone_epoch_unix_s"])
    audio = _audio_drift(root)
    return {"clocks": clocks, "emotibit": emotibit, "audio": audio}


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate sync offset, interval, and drift.")
    parser.add_argument("recording", type=Path)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    report = evaluate(args.recording.resolve())
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    summary = {
        "clocks": report["clocks"],
        "emotibit": {key: value for key, value in report["emotibit"].items()},
        "audio": {key: value for key, value in report["audio"].items() if key != "series"},
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
