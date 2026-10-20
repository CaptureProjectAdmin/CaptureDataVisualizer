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
TRANSCRIPT_PIPELINE = 3
# Short navigation phrases spoken on the walk. Kept at the front so they survive the prompt limit.
NAVIGATION_CUES = (
    "Wrong way",
    "You're going the wrong way",
    "Left",
    "Right",
    "Go straight",
    "Exit that door",
    "Turn left",
    "Turn right",
    "Turn around",
    "Go back",
    "Stop",
    "Wait",
    "This way",
    "That way",
    "Straight ahead",
    "Keep going",
    "Follow me",
    "On your left",
    "On your right",
    "Through the door",
    "Enter the door",
    "Exit",
    "Doorway",
    "Upstairs",
    "Downstairs",
    "Go inside",
    "Go outside",
    "Cross the street",
    "Wait here",
    "Come this way",
    "The other way",
    "Take a left",
    "Take a right",
    "Bear left",
    "Bear right",
    "Go forward",
    "Go ahead",
    "Not that way",
    "Back up",
    "Out that door",
    "In that door",
    "Next door",
    "Around the corner",
    "Keep left",
    "Keep right",
    "Slight left",
    "Slight right",
    "Make a left",
    "Make a right",
    "Continue straight",
    "Down the hall",
    "To the left",
    "To the right",
    "Straight through",
    "Wrong door",
    "That door",
    "This door",
    "Go through",
    "Step outside",
    "Step inside",
    "Dead end",
    "U-turn",
)

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
    cached = _usable_cache(data_dir, source)
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
        payload = {
            "pipeline": TRANSCRIPT_PIPELINE,
            "source": audio_path.name,
            "lines": lines,
            "events": new_events,
        }
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


def _usable_cache(data_dir: Path, source: str | None) -> dict[str, Any] | None:
    """Ignore a saved transcript from another audio file or an older pipeline."""
    cached = _read_cache(data_dir)
    if not cached:
        return None
    if int(cached.get("pipeline") or 0) != TRANSCRIPT_PIPELINE:
        return None
    cached_source = str(cached.get("source") or "")
    if source and cached_source and cached_source != source:
        return None
    return cached


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


def _vad_options() -> Any:
    from faster_whisper.vad import VadOptions

    return VadOptions(
        threshold=0.25,
        min_speech_duration_ms=60,
        min_silence_duration_ms=250,
        speech_pad_ms=300,
    )


def _speech_samples(audio: Any) -> int:
    from faster_whisper.vad import get_speech_timestamps

    marks = get_speech_timestamps(audio, _vad_options())
    return sum(int(mark["end"]) - int(mark["start"]) for mark in marks)


def _highpass(samples: Any, rate: int, cutoff: float = 100.0) -> Any:
    """Remove wind rumble below the voice."""
    import numpy as np
    from scipy import signal

    audio = np.ascontiguousarray(samples, dtype=np.float32)
    if audio.size == 0 or rate <= cutoff * 2:
        return audio
    sos = signal.butter(2, cutoff, btype="highpass", fs=rate, output="sos")
    return np.ascontiguousarray(signal.sosfilt(sos, audio), dtype=np.float32)


def _enhance_voice(samples: Any, rate: int) -> Any:
    """Turn down wind around the voice. The speech band is reduced only lightly."""
    import numpy as np
    from scipy import signal
    from scipy.ndimage import uniform_filter1d

    audio = np.ascontiguousarray(samples, dtype=np.float32)
    if audio.size < rate // 2:
        return audio
    nperseg = 512
    noverlap = 256
    freqs, _, spectrum = signal.stft(
        audio,
        fs=rate,
        nperseg=nperseg,
        noverlap=noverlap,
        window="hann",
        boundary="zeros",
        padded=True,
    )
    power = (np.abs(spectrum) ** 2).astype(np.float32)
    hop = nperseg - noverlap
    chunk = max(1, int(rate * 8 / hop))
    noise = np.empty_like(power)
    for start in range(0, power.shape[1], chunk):
        end = min(power.shape[1], start + chunk)
        context_start = max(0, start - chunk // 4)
        context_end = min(power.shape[1], end + chunk // 4)
        noise[:, start:end] = np.percentile(power[:, context_start:context_end], 20, axis=1, keepdims=True)
    strength = np.full(freqs.shape[0], 0.7, dtype=np.float32)
    strength[freqs < 250] = 0.95
    strength[(freqs >= 300) & (freqs <= 3400)] = 0.4
    gain = 1.0 - strength[:, None] * (noise / (power + 1e-10))
    np.clip(gain, 0.12, 1.0, out=gain)
    gain = uniform_filter1d(gain, size=3, axis=1, mode="nearest")
    _, enhanced = signal.istft(
        spectrum * gain,
        fs=rate,
        nperseg=nperseg,
        noverlap=noverlap,
        window="hann",
        input_onesided=True,
        boundary="zeros",
    )
    enhanced = np.ascontiguousarray(enhanced, dtype=np.float32)
    if enhanced.size < audio.size:
        enhanced = np.pad(enhanced, (0, audio.size - enhanced.size))
    return enhanced[: audio.size]


def _compress(samples: Any, rate: int) -> Any:
    """Lift a quiet voice toward a normal speaking level, up to about 11 dB."""
    import numpy as np
    from scipy.ndimage import uniform_filter1d

    audio = np.ascontiguousarray(samples, dtype=np.float32)
    if audio.size == 0:
        return audio
    window = max(1, int(rate * 0.04))
    power = np.convolve(audio.astype(np.float64) ** 2, np.ones(window) / window, mode="same")
    level = np.sqrt(np.maximum(power, 1e-12))
    target = 0.06
    max_gain = 3.5
    gain = np.ones(level.shape, dtype=np.float64)
    audible = level >= 0.004
    gain[audible] = np.maximum(1.0, np.minimum(max_gain, (target / level[audible]) ** (2.0 / 3.0)))
    loud = level > 0.2
    gain[loud] = np.minimum(gain[loud], 0.2 / level[loud])
    gain = uniform_filter1d(gain, size=max(1, int(rate * 0.08)), mode="nearest")
    enhanced = audio * gain.astype(np.float32)
    peak = float(np.max(np.abs(enhanced))) if enhanced.size else 0.0
    if peak > 0.98:
        enhanced *= np.float32(0.98 / peak)
    return np.ascontiguousarray(enhanced, dtype=np.float32)


def _navigation_hotwords(model: Any) -> str:
    """Prompt text for the navigation dictionary, trimmed to Whisper's prompt budget."""
    tokenizer = model.hf_tokenizer

    def token_count(text: str) -> int:
        encoded = tokenizer.encode(" " + text)
        ids = encoded.ids if hasattr(encoded, "ids") else encoded
        return len(ids)

    kept: list[str] = []
    for phrase in NAVIGATION_CUES:
        trial = ". ".join([*kept, phrase]) + "."
        if token_count(trial) >= 220:
            break
        kept.append(phrase)
    if not kept:
        return NAVIGATION_CUES[0]
    return ". ".join(kept) + "."


def _repair_word_times(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pull a word that was timestamped into a long pause back onto the next word."""
    repaired = [dict(word) for word in words]
    for index in range(len(repaired) - 1):
        if str(repaired[index]["text"]).rstrip().endswith((".", "?", "!")):
            continue
        gap = float(repaired[index + 1]["start"]) - float(repaired[index]["end"])
        if gap <= 3.0:
            continue
        duration = max(0.08, float(repaired[index]["end"]) - float(repaired[index]["start"]))
        repaired[index]["end"] = float(repaired[index + 1]["start"])
        repaired[index]["start"] = max(0.0, repaired[index]["end"] - duration)
    return repaired


def _segment_words(segment: Any) -> list[dict[str, Any]]:
    """Drop a segment that is silence, repetition, or too unsure to trust."""
    if float(getattr(segment, "avg_logprob", -10.0)) < -1.2:
        return []
    if float(getattr(segment, "compression_ratio", 0.0)) > 2.4:
        return []
    if float(getattr(segment, "no_speech_prob", 0.0)) > 0.85 and float(getattr(segment, "avg_logprob", -10.0)) < -0.6:
        return []
    spoken = list(segment.words or [])
    words: list[dict[str, Any]] = []
    if spoken:
        for word in spoken:
            text = str(word.word or "").strip()
            if not text:
                continue
            probability = getattr(word, "probability", None)
            if probability is not None and float(probability) < 0.05:
                continue
            words.append({"start": float(word.start), "end": float(word.end), "text": text})
        return _repair_word_times(words)
    text = str(segment.text or "").strip()
    if not text:
        return []
    return [{"start": float(segment.start), "end": float(segment.end), "text": text}]


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
    filtered = [_highpass(channel, rate) for channel in channels]
    chosen = _choose_channel(filtered, rate)
    speech = _resample(chosen, rate)
    speech = _enhance_voice(speech, 16000)
    return _compress(speech, 16000)


def _transcribe_samples(model: Any, audio: Any) -> list[dict[str, Any]]:
    hotwords = _navigation_hotwords(model)
    settings = {
        "language": "en",
        "word_timestamps": True,
        "temperature": 0.0,
        "condition_on_previous_text": False,
        "hotwords": hotwords,
        "no_speech_threshold": 0.75,
        "log_prob_threshold": -1.0,
        "compression_ratio_threshold": 2.4,
        "hallucination_silence_threshold": 2.0,
    }
    try:
        segments, _info = model.transcribe(audio, vad_filter=True, vad_parameters=_vad_options(), **settings)
    except Exception:
        segments, _info = model.transcribe(audio, vad_filter=False, **settings)
    words: list[dict[str, Any]] = []
    for segment in segments:
        words.extend(_segment_words(segment))
    return words


def _transcribe(audio_path: Path) -> list[dict[str, Any]]:
    model = _model_instance()
    return _transcribe_samples(model, _load_audio(audio_path))
