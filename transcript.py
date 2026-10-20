"""Local microphone transcription with word times."""

from __future__ import annotations

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


def _load_audio(audio_path: Path) -> Any:
    """Read microphone audio at 16 kHz. PyAV in use here rejects metadata_errors."""
    import av
    import numpy as np

    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks: list[Any] = []
    with av.open(str(audio_path), mode="r") as container:
        if not container.streams.audio:
            raise RuntimeError("The microphone file has no audio.")
        frames = list(container.decode(audio=0))
    frames.append(None)
    for frame in frames:
        try:
            converted = resampler.resample(frame)
        except av.error.InvalidDataError:
            continue
        for item in converted:
            chunks.append(np.asarray(item.to_ndarray()).reshape(-1))
    if not chunks:
        raise RuntimeError("The microphone file has no audio.")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def _transcribe(audio_path: Path) -> list[dict[str, Any]]:
    model = _model_instance()
    audio = _load_audio(audio_path)
    try:
        segments, _info = model.transcribe(
            audio,
            word_timestamps=True,
            vad_filter=True,
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
