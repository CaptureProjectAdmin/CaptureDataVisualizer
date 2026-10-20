"""Local transcription of the phone camera audio, with word times."""

from __future__ import annotations

import csv
import json
import threading
from collections import Counter
from pathlib import Path
from typing import Any, Callable

PAUSE_S = 0.6
TALK_BEGIN = "Talk Begin"
TALK_END = "Talk End"

ReadEvents = Callable[[Path], list[dict[str, Any]]]
WriteEvents = Callable[[Path, list[dict[str, Any]]], None]

_model: Any = None
_model_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def cache_path(data_dir: Path) -> Path:
    return data_dir / ".capture" / "transcript.json"


def transcript_file(data_dir: Path) -> Path:
    return data_dir / "Transcript.csv"


def _line_text(line: dict[str, Any]) -> str:
    if line.get("kind") == "silence":
        return ""
    return " ".join(str(word.get("text") or "").strip() for word in line.get("words") or []).strip()


def _write_transcript_file(data_dir: Path, lines: list[dict[str, Any]]) -> None:
    """Write the transcript beside the recording CSVs."""
    path = transcript_file(data_dir)
    temporary = path.with_suffix(".csv.tmp")
    with temporary.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=["time_start", "time_end", "text"])
        writer.writeheader()
        for line in lines:
            writer.writerow(
                {
                    "time_start": f"{float(line['start']):.2f}",
                    "time_end": f"{float(line['end']):.2f}",
                    "text": _line_text(line),
                }
            )
    temporary.replace(path)


def lines_from_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group words into phrases. A pause of PAUSE_S becomes an empty line between them."""
    lines: list[dict[str, Any]] = []
    speech: dict[str, Any] | None = None
    ordered = sorted(words, key=lambda item: (float(item["start"]), float(item["end"])))
    for word in ordered:
        text = str(word.get("text") or "").strip()
        if not text:
            continue
        start = float(word["start"])
        end = max(start, float(word["end"]))
        token = {"start": start, "end": end, "text": text}
        if speech is None:
            speech = {"kind": "speech", "start": start, "end": end, "words": [token]}
            continue
        gap = start - float(speech["end"])
        if gap >= PAUSE_S:
            lines.append(speech)
            if gap > 0:
                lines.append({"kind": "silence", "start": float(speech["end"]), "end": start})
            speech = {"kind": "speech", "start": start, "end": end, "words": [token]}
            continue
        speech["words"].append(token)
        speech["end"] = end
    if speech is not None:
        lines.append(speech)
    return lines


def events_from_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One Talk Begin and Talk End per spoken line. The description is that line."""
    events: list[dict[str, Any]] = []
    for line in lines:
        if line.get("kind") != "speech":
            continue
        text = " ".join(str(word["text"]) for word in line.get("words") or [])
        events.append({"time": round(float(line["start"]), 2), "event": TALK_BEGIN, "description": text})
        events.append({"time": round(float(line["end"]), 2), "event": TALK_END, "description": text})
    return events


def replace_auto_events(
    current: list[dict[str, Any]],
    previous: list[dict[str, Any]],
    new_events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Drop only the rows written by the previous transcript, then append the new ones."""
    counts: Counter[tuple[float, str, str]] = Counter(_event_key(item) for item in previous)
    kept: list[dict[str, Any]] = []
    for item in current:
        key = _event_key(item)
        if counts[key] > 0:
            counts[key] -= 1
            continue
        kept.append(item)
    kept.extend(new_events)
    kept.sort(key=lambda item: (float(item["time"]), str(item["event"]), str(item["description"])))
    return kept


def _event_key(item: dict[str, Any]) -> tuple[float, str, str]:
    return (round(float(item["time"]), 2), str(item["event"]), str(item["description"]))


def public_view(data_dir: Path, source: str | None = None) -> dict[str, Any]:
    key = str(data_dir)
    with _jobs_lock:
        job = dict(_jobs.get(key) or {})
    cached = _read_cache(data_dir)
    cached_source = str((cached or {}).get("source") or "")
    if source and cached_source and cached_source != source:
        cached = None
    if job.get("state") == "running":
        return {"state": "running", "source": job.get("source") or source or "", "error": "", "lines": []}
    if job.get("state") == "error":
        return {
            "state": "error",
            "source": (cached or {}).get("source") or job.get("source") or source or "",
            "error": str(job.get("error") or "Transcription failed."),
            "lines": list((cached or {}).get("lines") or []),
        }
    if cached:
        return {
            "state": "done",
            "source": str(cached.get("source") or source or ""),
            "error": "",
            "lines": list(cached.get("lines") or []),
        }
    if source:
        return {"state": "absent", "source": source, "error": "", "lines": []}
    return {"state": "unavailable", "source": "", "error": "", "lines": []}


def start(
    data_dir: Path,
    audio_path: Path,
    read_events: ReadEvents,
    write_events: WriteEvents,
) -> dict[str, Any]:
    key = str(data_dir)
    source = audio_path.name
    with _jobs_lock:
        job = _jobs.get(key)
        if job and job.get("state") == "running":
            return public_view(data_dir, source)
        _jobs[key] = {"state": "running", "source": source, "error": ""}
    threading.Thread(
        target=_run,
        args=(data_dir, audio_path, read_events, write_events),
        name="transcript",
        daemon=True,
    ).start()
    return public_view(data_dir, source)


def _run(
    data_dir: Path,
    audio_path: Path,
    read_events: ReadEvents,
    write_events: WriteEvents,
) -> None:
    key = str(data_dir)
    try:
        lines = lines_from_words(_transcribe(audio_path))
        new_events = events_from_lines(lines)
        previous = _read_cache(data_dir)
        merged = replace_auto_events(read_events(data_dir), list((previous or {}).get("events") or []), new_events)
        write_events(data_dir, merged)
        payload = {"source": audio_path.name, "lines": lines, "events": new_events}
        path = cache_path(data_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        temporary.replace(path)
        _write_transcript_file(data_dir, lines)
    except Exception as exc:
        with _jobs_lock:
            _jobs[key] = {"state": "error", "source": audio_path.name, "error": str(exc)}
        return
    with _jobs_lock:
        _jobs[key] = {"state": "done", "source": audio_path.name, "error": ""}


def _read_cache(data_dir: Path) -> dict[str, Any] | None:
    path = cache_path(data_dir)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("lines"), list):
        return None
    return payload


def _model_instance() -> Any:
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel("small", device="cpu", compute_type="int8")
        return _model


def _decode_channels(audio_path: Path) -> tuple[list[Any], int]:
    """Read each audio channel as float samples. Phone video is preferred by the caller."""
    import av
    import numpy as np

    collected: list[list[Any]] = []
    rate = 16000
    with av.open(str(audio_path), mode="r") as container:
        if not container.streams.audio:
            raise RuntimeError("The recording has no audio.")
        stream = container.streams.audio[0]
        rate = int(stream.sample_rate or rate)
        for frame in container.decode(audio=0):
            try:
                samples = np.asarray(frame.to_ndarray(), dtype=np.float32)
            except av.error.InvalidDataError:
                continue
            if samples.ndim == 1:
                samples = samples.reshape(1, -1)
            if not collected:
                collected = [[] for _ in range(samples.shape[0])]
            for index in range(min(len(collected), samples.shape[0])):
                collected[index].append(samples[index])
    if not collected or not collected[0]:
        raise RuntimeError("The recording has no audio.")
    return [np.concatenate(parts) for parts in collected], rate


def _speech_samples(audio: Any) -> int:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    marks = get_speech_timestamps(
        audio,
        VadOptions(threshold=0.35, min_silence_duration_ms=250, max_speech_duration_s=30),
    )
    return sum(int(mark["end"]) - int(mark["start"]) for mark in marks)


def _choose_channel(channels: list[Any], rate: int) -> Any:
    """Keep the channel that contains more speech. Duplicate stereo channels are averaged."""
    import numpy as np

    if len(channels) == 1:
        return channels[0]
    step = max(1, int(rate) // 16000)
    reduced = [np.ascontiguousarray(channel[::step], dtype=np.float32) for channel in channels]
    length = min(channel.size for channel in reduced)
    if length < 16000:
        return channels[0]
    correlation = float(np.corrcoef(reduced[0][:length:40], reduced[1][:length:40])[0, 1])
    native = min(channel.size for channel in channels)
    if np.isfinite(correlation) and correlation > 0.9:
        return ((channels[0][:native] + channels[1][:native]) * 0.5).astype(np.float32)
    scores = [_speech_samples(channel[:length]) for channel in reduced]
    return channels[int(np.argmax(scores))]


def _resample(samples: Any, rate: int) -> Any:
    import av
    import numpy as np

    audio = np.ascontiguousarray(samples, dtype=np.float32)
    if rate == 16000:
        return audio
    resampler = av.audio.resampler.AudioResampler(format="fltp", layout="mono", rate=16000)
    pieces: list[Any] = []
    chunk = rate
    for start in range(0, audio.size, chunk):
        frame = av.AudioFrame.from_ndarray(audio[start : start + chunk].reshape(1, -1), format="fltp", layout="mono")
        frame.sample_rate = rate
        for item in resampler.resample(frame):
            pieces.append(np.asarray(item.to_ndarray(), dtype=np.float32).reshape(-1))
    for item in resampler.resample(None):
        pieces.append(np.asarray(item.to_ndarray(), dtype=np.float32).reshape(-1))
    if not pieces:
        raise RuntimeError("The recording has no audio.")
    return np.concatenate(pieces)


def _load_audio(audio_path: Path) -> Any:
    channels, rate = _decode_channels(audio_path)
    return _resample(_choose_channel(channels, rate), rate)


def _transcribe(audio_path: Path) -> list[dict[str, Any]]:
    from faster_whisper.vad import VadOptions

    model = _model_instance()
    audio = _load_audio(audio_path)
    voice = VadOptions(threshold=0.35, min_silence_duration_ms=250)
    try:
        segments, _info = model.transcribe(
            audio,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=voice,
            condition_on_previous_text=False,
        )
    except Exception:
        segments, _info = model.transcribe(
            audio,
            word_timestamps=True,
            vad_filter=False,
            condition_on_previous_text=False,
        )
    words: list[dict[str, Any]] = []
    for segment in segments:
        segment_words = list(segment.words or [])
        if segment_words:
            for word in segment_words:
                words.append({"start": float(word.start), "end": float(word.end), "text": word.word or ""})
            continue
        words.append({"start": float(segment.start), "end": float(segment.end), "text": segment.text or ""})
    return words
