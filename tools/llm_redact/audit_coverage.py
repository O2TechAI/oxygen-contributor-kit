#!/usr/bin/env python3
"""Report how much of a run the redaction pass actually looked at.

Only conversational turns are sent to the model; everything else is supposed to
have been reduced to an action label before that point. If the reduction was
skipped, this prints the share of shipped bytes nobody reviewed.
"""
import argparse
import collections
import json
import pathlib
import sys

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio

CONVERSATIONAL = {"message", "user", "assistant", "agent"}


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=pathlib.Path)
    args = parser.parse_args()

    chars = collections.Counter()
    counts = collections.Counter()
    for events_path in sorted((args.run / "trajectories").glob("*/events.jsonl")):
        trajectory_dir = events_path.parent
        for line in events_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            # Mirror run_local_review.event_content: an artifact event carries a
            # path, and the importer inlines that file's bytes. Counting only
            # the payload text understates the shipped size by orders of
            # magnitude.
            payload = event.get("payload") or {}
            text = ""
            if event.get("event_type") == "artifact" and isinstance(payload.get("path"), str):
                candidate = (trajectory_dir / payload["path"]).resolve()
                try:
                    candidate.relative_to(trajectory_dir.resolve())
                    data = candidate.read_bytes()
                    if b"\0" not in data:
                        text = data.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise SystemExit(f"artifact is not valid UTF-8 text: {candidate}: {error}") from error
                except (OSError, ValueError):
                    pass
            if not text:
                for key in ("text", "content", "stdout", "stderr", "message", "summary", "note"):
                    if isinstance(payload.get(key), str) and payload[key]:
                        text = payload[key]
                        break
            if not text and event.get("event_type") == "tool_call":
                text = " · ".join(str(value) for value in (
                    payload.get("tool_name") or (event.get("executor") or {}).get("tool") or "tool",
                    payload.get("action"),
                ) if value)
            event_type = event.get("event_type") or "unknown"
            chars[event_type] += len(text)
            counts[event_type] += 1

    total = sum(chars.values())
    reviewed = sum(v for k, v in chars.items() if k in CONVERSATIONAL)
    print(f"{'event_type':<14}{'events':>8}{'chars':>12}{'share':>9}")
    for event_type, value in chars.most_common():
        mark = "  <- reviewed" if event_type in CONVERSATIONAL else ""
        print(f"{event_type:<14}{counts[event_type]:>8}{value:>12}{value/total*100:>8.1f}%{mark}")
    print(f"\ntotal chars: {total}")
    print(f"reviewed by the model: {reviewed} ({reviewed/total*100:.2f}%)")
    print(f"never reviewed:        {total - reviewed} ({(total-reviewed)/total*100:.2f}%)")
    print("\nPolicy requires every non-conversational event to be reduced to a bare")
    print("action_label before release. Anything counted above as 'never reviewed'")
    print("is shipping verbatim unless that reduction runs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
