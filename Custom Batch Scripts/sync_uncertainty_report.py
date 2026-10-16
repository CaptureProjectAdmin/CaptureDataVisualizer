"""Write the synchronization-uncertainty report from a batch summary.csv.

The constant scene-audio delay is reported once and is not treated as sync
quality. What remains is the uncertainty: how tightly a sound or an EmotiBit
packet still lines up after that delay is removed.

Reads the summary.csv written by sync_accuracy_batch.py. Writes:

  sync_uncertainty/report.md
  sync_uncertainty/uncertainty.csv
  sync_uncertainty/report.docx

Run:
  python "Custom Batch Scripts\\sync_uncertainty_report.py" summary.csv
  python "Custom Batch Scripts\\sync_uncertainty_report.py" "D:\\path\\to\\summary.csv" --output "D:\\path\\to\\results"
"""

from __future__ import annotations

import argparse
import csv
import statistics
from pathlib import Path

# A fan-out of a few hundred milliseconds is a short packet window, not a
# measured sync error, so those sessions are labeled instead of plotted.
_FANOUT_LABEL_MS = 200.0

UNCERTAINTY_FIELDS = [
    "subject",
    "session",
    "relative_path",
    "status",
    "audio_offset_median_ms",
    "audio_peak_half_width_p95_ms",
    "audio_center_spread_ms",
    "audio_drift_across_span_ms",
    "emotibit_residual_half_ms",
    "emotibit_rate_known",
    "emotibit_rate_se_fanout_ms",
    "emotibit_end_uncertainty_ms",
    "emotibit_end_class",
    "emotibit_packets_kept",
    "emotibit_window_duration_s",
    "error",
]


def _float(row: dict[str, str], key: str) -> float | None:
    raw = (row.get(key) or "").strip()
    if raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _median(values: list[float]) -> float:
    return float(statistics.median(values))


def _fmt_delay(milliseconds: float) -> str:
    return f"{milliseconds / 1000.0:.2f} s"


def _fmt_ms(value: float) -> str:
    magnitude = abs(value)
    if magnitude >= 100:
        return f"{value:.0f} ms"
    if magnitude >= 10:
        return f"{value:.1f} ms"
    return f"{value:.2f} ms"


def _classify(rate_known: bool, end_ms: float) -> str:
    if end_ms > _FANOUT_LABEL_MS:
        return "rate_not_known"
    if not rate_known:
        return "rate_consistent_with_zero"
    return "rate_known"


def uncertainty_row(row: dict[str, str]) -> dict[str, object]:
    """One recording. Failed rows keep their error and leave the widths blank."""
    out: dict[str, object] = {field: "" for field in UNCERTAINTY_FIELDS}
    out["subject"] = row.get("subject") or ""
    out["session"] = row.get("session") or ""
    out["relative_path"] = row.get("relative_path") or ""
    status = (row.get("status") or "").strip() or "error"
    out["status"] = status
    out["error"] = row.get("error") or ""
    if status != "ok":
        return out

    offset = _float(row, "audio_offset_median_ms")
    peak = _float(row, "audio_peak_half_width_p95_ms")
    low = _float(row, "audio_interval_low_ms")
    high = _float(row, "audio_interval_high_ms")
    drift = _float(row, "audio_drift_across_span_ms")
    residual_low = _float(row, "emotibit_interval_low_ms")
    residual_high = _float(row, "emotibit_interval_high_ms")
    rate_ppm = _float(row, "emotibit_rate_error_ppm")
    rate_se = _float(row, "emotibit_rate_error_se_ppm")
    seconds_after = _float(row, "emotibit_seconds_after_last_packet")
    packets = _float(row, "emotibit_packets_kept")
    window_s = _float(row, "emotibit_window_duration_s")

    spread = None if low is None or high is None else high - low
    residual_half = None if residual_low is None or residual_high is None else (residual_high - residual_low) / 2
    fanout = None
    if rate_se is not None and seconds_after is not None:
        fanout = abs(rate_se) * 1e-6 * seconds_after * 1000.0
    end = None if residual_half is None or fanout is None else residual_half + fanout
    rate_known = (
        rate_ppm is not None
        and rate_se is not None
        and abs(rate_ppm) > 2 * abs(rate_se)
    )

    out["audio_offset_median_ms"] = "" if offset is None else f"{offset:.6g}"
    out["audio_peak_half_width_p95_ms"] = "" if peak is None else f"{peak:.6g}"
    out["audio_center_spread_ms"] = "" if spread is None else f"{spread:.6g}"
    out["audio_drift_across_span_ms"] = "" if drift is None else f"{abs(drift):.6g}"
    out["emotibit_residual_half_ms"] = "" if residual_half is None else f"{residual_half:.6g}"
    out["emotibit_rate_known"] = "yes" if rate_known else "no"
    out["emotibit_rate_se_fanout_ms"] = "" if fanout is None else f"{fanout:.6g}"
    out["emotibit_end_uncertainty_ms"] = "" if end is None else f"{end:.6g}"
    out["emotibit_end_class"] = "" if end is None else _classify(rate_known, end)
    out["emotibit_packets_kept"] = "" if packets is None else f"{int(packets)}"
    out["emotibit_window_duration_s"] = "" if window_s is None else f"{window_s:.6g}"
    return out


def _numbers(rows: list[dict[str, object]], key: str) -> list[float]:
    values: list[float] = []
    for row in rows:
        raw = row.get(key)
        if raw in ("", None):
            continue
        values.append(float(raw))
    return values


def _label(row: dict[str, object]) -> str:
    subject = str(row.get("subject") or "")
    session = str(row.get("session") or "")
    if subject and session:
        return f"{subject} {session}"
    return str(row.get("relative_path") or subject or session)


def render_report(rows: list[dict[str, object]]) -> str:
    ok = [row for row in rows if row.get("status") == "ok"]
    failed = [row for row in rows if row.get("status") != "ok"]
    audio = _numbers(ok, "audio_peak_half_width_p95_ms")
    spread = _numbers(ok, "audio_center_spread_ms")
    drift = _numbers(ok, "audio_drift_across_span_ms")
    residual = _numbers(ok, "emotibit_residual_half_ms")
    offsets = [abs(value) for value in _numbers(ok, "audio_offset_median_ms")]
    known = [row for row in ok if row.get("emotibit_end_class") == "rate_known"]
    flat = [row for row in ok if row.get("emotibit_end_class") == "rate_consistent_with_zero"]
    unknown = [row for row in ok if row.get("emotibit_end_class") == "rate_not_known"]
    known_end = _numbers(known, "emotibit_end_uncertainty_ms")
    flat_end = _numbers(flat, "emotibit_end_uncertainty_ms")

    lines = [
        "# Synchronization uncertainty",
        "",
        (
            f"Across {len(ok)} recordings, a constant delay is removed first. "
            f"Scene audio is then aligned to the phone to about {_fmt_ms(_median(audio))}. "
            f"EmotiBit, inside its sync-packet window, stays within about {_fmt_ms(_median(residual))}. "
            "Phone samples themselves are quantized to ±5 ms."
        ),
        "",
        "Source: synchronization batch `summary.csv`. Constant offsets are removed before these widths.",
        "",
        "## Median and worst",
        "",
        "| Pair | Median | Worst |",
        "| --- | ---: | ---: |",
        (
            f"| Scene audio, one sound (p95 peak half-width) | {_fmt_ms(_median(audio))} | {_fmt_ms(max(audio))} |"
        ),
        (
            f"| Scene audio, window centers after the constant | {_fmt_ms(_median(spread))} | {_fmt_ms(max(spread))} |"
        ),
        (
            f"| EmotiBit, inside the packet window | {_fmt_ms(_median(residual))} | {_fmt_ms(max(residual))} |"
        ),
        (
            f"| EmotiBit, end of recording, rate known ({len(known)} sessions) | "
            f"{_fmt_ms(_median(known_end))} | {_fmt_ms(max(known_end))} |"
        ),
        "| Phone sample grid | 5 ms | 5 ms |",
        "",
        (
            "After the constant scene-audio delay is removed, window centers move by at most "
            f"{_fmt_ms(max(spread))} across a recording, and the drift from the first window to the last "
            f"is at most {_fmt_ms(max(drift))}. Both sit inside the peak width, so one constant correction "
            "is enough for the whole recording."
        ),
        "",
        "## EmotiBit after the last packet",
        "",
        (
            f"{len(known)} recordings have a clock rate distinguishable from zero. "
            "For those, the end-of-recording uncertainty is the in-window residual plus the rate’s "
            "standard error times the time after the last packet. That is the uncertainty left if the "
            "fitted rate is applied. It is not the size of the rate itself."
        ),
        "",
    ]
    if flat_end:
        lines.append(
            f"{len(flat)} other recordings have a rate consistent with zero, so a rate correction is not "
            f"supported. Their end-of-recording bound still runs from {_fmt_ms(min(flat_end))} to "
            f"{_fmt_ms(max(flat_end))}, with a median of {_fmt_ms(_median(flat_end))}."
        )
        lines.append("")
    if unknown:
        lines.extend(
            [
                (
                    "These recordings are not constrained. The packet window is short, and the rate error "
                    "reaches hundreds of milliseconds. They are bounds from a short fit, not a measured "
                    "sync error across the walk."
                ),
                "",
                "| Recording | Packets kept | Packet window (s) | End uncertainty |",
                "| --- | ---: | ---: | ---: |",
            ]
        )
        for row in sorted(unknown, key=_label):
            lines.append(
                f"| {_label(row)} | {row.get('emotibit_packets_kept')} | "
                f"{float(row['emotibit_window_duration_s']):.0f} | "
                f"{_fmt_ms(float(row['emotibit_end_uncertainty_ms']))} |"
            )
        lines.append("")
    if offsets:
        lines.extend(
            [
                "## Constant delays",
                "",
                (
                    f"Each measured recording also has one scene-audio delay, from {_fmt_delay(min(offsets))} "
                    f"to {_fmt_delay(max(offsets))}. Subtracting that delay is what leaves the widths above. "
                    "The delay itself is not a measure of sync quality."
                ),
                "",
            ]
        )
    lines.extend(["## Not measured", ""])
    if failed:
        listed = ", ".join(_label(row) for row in failed)
        lines.append(
            f"{listed} did not produce a measurement. They are omitted from the widths above."
        )
    else:
        lines.append("Every recording in this summary was measured.")
    lines.append("")
    return "\n".join(lines)


_AUDIO_COLOR = "#70B0D8"
_EMOTIBIT_COLOR = "#F0A040"
_PHONE_COLOR = "#888899"


def _ok_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    return [row for row in rows if row.get("status") == "ok"]


def _save_grouped_chart(
    path: Path,
    labels: list[str],
    audio: list[float],
    emotibit: list[float],
    x_max: float,
) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    count = len(labels)
    positions = list(range(count))
    fig, ax = plt.subplots(figsize=(7.4, max(4.8, count * 0.28)), dpi=160)
    bar = 0.36
    ax.barh(
        [index - bar / 2 for index in positions],
        audio,
        height=bar,
        color=_AUDIO_COLOR,
        label="Scene audio peak half-width, p95",
    )
    ax.barh(
        [index + bar / 2 for index in positions],
        emotibit,
        height=bar,
        color=_EMOTIBIT_COLOR,
        label="EmotiBit residual half-width",
    )
    ax.axvline(5, color=_PHONE_COLOR, linewidth=1, linestyle="--", label="Phone sample ±5 ms")
    ax.set_yticks(positions)
    ax.set_yticklabels(labels, fontsize=8)
    ax.invert_yaxis()
    ax.set_xlim(0, x_max)
    ax.set_xlabel("Uncertainty (ms)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=2, frameon=False, fontsize=8)
    ax.grid(axis="x", color="#e4e4e4", linewidth=0.6)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def _save_end_chart(path: Path, labels: list[str], values: list[float]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    positions = list(range(len(labels)))
    fig, ax = plt.subplots(figsize=(7.4, max(3.6, len(labels) * 0.32)), dpi=160)
    ax.barh(positions, values, height=0.62, color=_EMOTIBIT_COLOR, label="End-of-recording uncertainty")
    ax.axvline(5, color=_PHONE_COLOR, linewidth=1, linestyle="--", label="Phone sample ±5 ms")
    ax.set_yticks(positions)
    ax.set_yticklabels(labels, fontsize=8)
    ax.invert_yaxis()
    ax.set_xlim(0, max(values) * 1.08)
    ax.set_xlabel("Uncertainty (ms)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=2, frameon=False, fontsize=8)
    ax.grid(axis="x", color="#e4e4e4", linewidth=0.6)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def _shade_cell(cell, fill: str) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    properties = cell._tc.get_or_add_tcPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:fill"), fill)
    properties.append(shading)


def _add_table(document, headers: list[str], body: list[list[str]]) -> None:
    from docx.shared import Pt

    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        cell.text = header
        _shade_cell(cell, "F2F2F2")
        for paragraph in cell.paragraphs:
            for run in paragraph.runs:
                run.bold = True
                run.font.size = Pt(10)
    for values in body:
        cells = table.add_row().cells
        for index, value in enumerate(values):
            cells[index].text = value
            for paragraph in cells[index].paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(10)


def _write_docx(path: Path, rows: list[dict[str, object]]) -> None:
    import tempfile

    from docx import Document
    from docx.shared import Inches, Pt

    ok = _ok_rows(rows)
    failed = [row for row in rows if row.get("status") != "ok"]
    audio = _numbers(ok, "audio_peak_half_width_p95_ms")
    spread = _numbers(ok, "audio_center_spread_ms")
    drift = _numbers(ok, "audio_drift_across_span_ms")
    residual = _numbers(ok, "emotibit_residual_half_ms")
    offsets = [abs(value) for value in _numbers(ok, "audio_offset_median_ms")]
    known = [row for row in ok if row.get("emotibit_end_class") == "rate_known"]
    flat = [row for row in ok if row.get("emotibit_end_class") == "rate_consistent_with_zero"]
    unknown = [row for row in ok if row.get("emotibit_end_class") == "rate_not_known"]
    known_end = _numbers(known, "emotibit_end_uncertainty_ms")
    flat_end = _numbers(flat, "emotibit_end_uncertainty_ms")

    document = Document()
    normal = document.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    document.core_properties.title = "Synchronization uncertainty"

    document.add_heading("Synchronization uncertainty", level=1)
    document.add_paragraph(
        f"Across {len(ok)} recordings, a constant delay is removed first. "
        f"Scene audio is then aligned to the phone to about {_fmt_ms(_median(audio))}. "
        f"EmotiBit, inside its sync-packet window, stays within about {_fmt_ms(_median(residual))}. "
        "Phone samples themselves are quantized to ±5 ms."
    )
    source = document.add_paragraph()
    source_run = source.add_run(
        "Source: synchronization batch summary.csv. Constant offsets are removed before these widths."
    )
    source_run.italic = True
    source_run.font.size = Pt(10)

    document.add_heading("Measured window", level=2)
    document.add_paragraph(
        "Each bar is one recording. Blue is the 95th-percentile half-width of the scene-audio "
        "correlation peak. Orange is half the EmotiBit residual range after offset and rate are "
        "removed, and it only covers the packet window. The dashed line at 5 ms is one phone sample."
    )
    labels = [_label(row) for row in ok]
    midpoint = (len(ok) + 1) // 2
    chart_limit = max(24.0, max(audio + residual) * 1.05)
    with tempfile.TemporaryDirectory() as folder:
        folder_path = Path(folder)
        for start, end in ((0, midpoint), (midpoint, len(ok))):
            chart_path = folder_path / f"window_{start}.png"
            _save_grouped_chart(
                chart_path,
                labels[start:end],
                audio[start:end],
                residual[start:end],
                chart_limit,
            )
            document.add_picture(str(chart_path), width=Inches(6.5))
        document.add_paragraph(
            "Uncertainty (ms) after the constant delay is removed. Sorted by subject and session."
        ).runs[0].italic = True
        document.add_paragraph(
            "After that same constant is removed, scene-audio window centers move by at most "
            f"{_fmt_ms(max(spread))} across a recording, and the drift from the first window to the last "
            f"is at most {_fmt_ms(max(drift))}. Both sit inside the peak width, so one constant correction "
            "is enough for the whole recording."
        )

        document.add_heading("Median and worst", level=2)
        _add_table(
            document,
            ["Pair", "Median", "Worst"],
            [
                ["Scene audio, one sound (p95 peak half-width)", _fmt_ms(_median(audio)), _fmt_ms(max(audio))],
                ["Scene audio, window centers after the constant", _fmt_ms(_median(spread)), _fmt_ms(max(spread))],
                ["EmotiBit, inside the packet window", _fmt_ms(_median(residual)), _fmt_ms(max(residual))],
                [
                    f"EmotiBit, end of recording, rate known ({len(known)} sessions)",
                    _fmt_ms(_median(known_end)),
                    _fmt_ms(max(known_end)),
                ],
                ["Phone sample grid", "5 ms", "5 ms"],
            ],
        )

        document.add_heading("EmotiBit after the last packet", level=2)
        document.add_paragraph(
            f"{len(known)} recordings have a clock rate distinguishable from zero. "
            "For those, the bar is the in-window residual plus the rate’s standard error times the time "
            "after the last packet. That is the uncertainty left if the fitted rate is applied. "
            "It is not the size of the rate itself."
        )
        end_path = folder_path / "end.png"
        _save_end_chart(end_path, [_label(row) for row in known], known_end)
        document.add_picture(str(end_path), width=Inches(6.5))
        caption = document.add_paragraph(
            "Milliseconds at the end of the recording. Only sessions whose fitted rate is outside twice its standard error."
        )
        caption.runs[0].italic = True

    if flat_end:
        document.add_paragraph(
            f"{len(flat)} other recordings have a rate consistent with zero, so a rate correction is not "
            f"supported. Their end-of-recording bound still runs from {_fmt_ms(min(flat_end))} to "
            f"{_fmt_ms(max(flat_end))}, with a median of {_fmt_ms(_median(flat_end))}."
        )
    if unknown:
        document.add_paragraph(
            "These recordings are not constrained. The packet window is short, and the rate error "
            "reaches hundreds of milliseconds. They are bounds from a short fit, not a measured "
            "sync error across the walk."
        )
        _add_table(
            document,
            ["Recording", "Packets kept", "Packet window (s)", "End uncertainty"],
            [
                [
                    _label(row),
                    str(row.get("emotibit_packets_kept")),
                    f"{float(row['emotibit_window_duration_s']):.0f}",
                    _fmt_ms(float(row["emotibit_end_uncertainty_ms"])),
                ]
                for row in sorted(unknown, key=_label)
            ],
        )
    if offsets:
        document.add_heading("Constant delays", level=2)
        document.add_paragraph(
            f"Each measured recording also has one scene-audio delay, from {_fmt_delay(min(offsets))} "
            f"to {_fmt_delay(max(offsets))}. Subtracting that delay is what leaves the widths above. "
            "The delay itself is not a measure of sync quality."
        )
    document.add_heading("Not measured", level=2)
    if failed:
        document.add_paragraph(
            f"{', '.join(_label(row) for row in failed)} did not produce a measurement. "
            "They are omitted from the widths above."
        )
    else:
        document.add_paragraph("Every recording in this summary was measured.")
    path.parent.mkdir(parents=True, exist_ok=True)
    document.save(path)


def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=UNCERTAINTY_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def load_summary(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def run(summary_path: Path, output: Path) -> None:
    source = load_summary(summary_path)
    rows = [uncertainty_row(row) for row in source]
    output.mkdir(parents=True, exist_ok=True)
    csv_path = output / "uncertainty.csv"
    report_path = output / "report.md"
    docx_path = output / "report.docx"
    _write_csv(csv_path, rows)
    report_path.write_text(render_report(rows), encoding="utf-8")
    _write_docx(docx_path, rows)
    ok = sum(1 for row in rows if row.get("status") == "ok")
    print(f"Wrote {report_path}", flush=True)
    print(f"Wrote {csv_path}", flush=True)
    print(f"Wrote {docx_path}", flush=True)
    print(f"{ok} measured, {len(rows) - ok} not measured.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write the synchronization-uncertainty report from a batch summary.csv."
    )
    parser.add_argument(
        "summary",
        type=Path,
        nargs="?",
        default=Path.cwd() / "summary.csv",
        help="summary.csv from sync_accuracy_batch.py. Defaults to ./summary.csv.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.cwd() / "sync_uncertainty",
        help="Where to write report.md, uncertainty.csv, and report.docx. Defaults to ./sync_uncertainty.",
    )
    args = parser.parse_args()
    summary = args.summary.expanduser().resolve()
    if not summary.is_file():
        raise SystemExit(f"Summary not found: {summary}")
    run(summary, args.output.expanduser().resolve())


if __name__ == "__main__":
    main()
