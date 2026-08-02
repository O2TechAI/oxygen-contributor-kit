#!/usr/bin/env python3
"""Start the bundled local Viewer and import one Oxygen ingest output."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser


SKILL_DIR = Path(__file__).resolve().parents[1]
KIT_ROOT = SKILL_DIR.parents[1]
VIEWER = KIT_ROOT / "viewer"


def request_json(opener, url: str, *, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"content-type": "application/json"} if data else {},
    )
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read().decode())


def event_content(event: dict, trajectory_dir: Path) -> str:
    payload = event.get("payload") or {}
    if event.get("event_type") == "artifact" and isinstance(payload.get("path"), str):
        candidate = (trajectory_dir / payload["path"]).resolve()
        try:
            candidate.relative_to(trajectory_dir.resolve())
            data = candidate.read_bytes()
            if b"\0" not in data:
                return data.decode("utf-8", errors="replace")
        except (OSError, ValueError):
            pass
    for key in ("text", "content", "stdout", "stderr", "message", "summary", "note"):
        if isinstance(payload.get(key), str) and payload[key]:
            return payload[key]
    if event.get("event_type") == "tool_call":
        return " · ".join(str(value) for value in (
            payload.get("tool_name") or (event.get("executor") or {}).get("tool") or "tool",
            payload.get("action"),
        ) if value)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def import_trajectory(opener, base_url: str, directory: Path, project_map: dict):
    manifest = json.loads((directory / "manifest.json").read_text())
    redaction_path = directory / "redaction.json"
    redaction = json.loads(redaction_path.read_text()) if redaction_path.exists() else {
        "review_status": "pending", "publication_approved": False,
    }
    events = [
        json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()
        if line.strip()
    ]
    event_times = [
        event.get("timestamp") or event.get("started_at") for event in events
        if event.get("timestamp") or event.get("started_at")
    ]
    trajectory_id = manifest.get("trajectory_id") or directory.name
    document = {
        "id": trajectory_id, "kind": "trajectory",
        "title": manifest.get("title") or trajectory_id,
        "sourceUser": manifest.get("source_user"),
        "sourceSystem": manifest.get("source_system"),
        "sourceTimestamp": min(event_times) if event_times else manifest.get("snapshot_at"),
        "metadata": {
            "manifest": manifest,
            "redaction": redaction,
            "project_organization": {
                "primary_project": project_map.get("primary_project", "Unclassified"),
                "projects": project_map.get("projects", []),
                "summary": project_map.get("summary", ""),
            },
        },
        "envelope": {"manifest": manifest, "redaction": redaction, "format": "oxygen-events-jsonl"},
        "itemCount": len(events),
    }
    event_labels = project_map.get("events") or {}
    items = []
    for index, event in enumerate(events, 1):
        event_id = event.get("event_id")
        # Event IDs restart inside every trajectory, so prefer the qualified key.
        label = event_labels.get(f"{trajectory_id}:{event_id}", event_labels.get(event_id, {}))
        items.append({
            "id": f"{trajectory_id}:{event_id or f'event-{index}'}",
            "sequence": event.get("sequence", index),
            "eventType": event.get("event_type"),
            "actorId": (event.get("actor") or {}).get("id"),
            "actorType": (event.get("actor") or {}).get("type"),
            "timestamp": event.get("timestamp") or event.get("started_at"),
            "content": event_content(event, directory),
            "original": event,
            "organizationCategory": label.get("project"),
            "organizationConfidence": label.get("confidence"),
            "organizationReason": label.get("summary") or label.get("reason"),
        })
    for start in range(0, max(1, len(items)), 75):
        request_json(opener, f"{base_url}/api/documents", method="POST", body={
            "document": document, "items": items[start:start + 75],
        })
    return len(items)


def import_meeting(opener, base_url: str, path: Path):
    dataset = json.loads(path.read_text())
    records = dataset.get("records") or []
    meeting_id = dataset.get("meeting_id") or dataset.get("id") or path.parent.name
    document = {
        "id": meeting_id, "kind": "meeting",
        "title": dataset.get("title") or meeting_id,
        "sourceSystem": "meeting-transcript",
        "sourceTimestamp": dataset.get("recorded_at") or dataset.get("date"),
        "metadata": {"review_status": dataset.get("review_status", "pending")},
        "envelope": {**dataset, "records": []},
        "itemCount": len(records),
    }
    items = [{
        "id": f"{meeting_id}:{record.get('record_id') or f'record-{index}'}",
        "sequence": record.get("sequence_in_meeting") or record.get("order") or index,
        "eventType": "record",
        "actorId": record.get("speaker"),
        "actorType": "human",
        "timestamp": record.get("timestamp") or record.get("started_at"),
        "content": record.get("text", ""),
        "original": record,
    } for index, record in enumerate(records, 1)]
    for start in range(0, max(1, len(items)), 75):
        request_json(opener, f"{base_url}/api/documents", method="POST", body={
            "document": document, "items": items[start:start + 75],
        })
    return len(items)


def locate_inputs(run: Path):
    index_path = run / "index.json"
    trajectories = []
    if index_path.exists():
        index = json.loads(index_path.read_text())
        for entry in index.get("trajectories") or []:
            trajectory_id = entry.get("trajectory_id")
            if trajectory_id and entry.get("ok", True):
                directory = run / "trajectories" / trajectory_id
                if (directory / "events.jsonl").exists():
                    trajectories.append(directory)
        if not trajectories:
            trajectories = sorted(
                path.parent for path in (run / "trajectories").glob("*/events.jsonl")
            )
    meeting = run / "meeting.json"
    if not trajectories and not meeting.exists() and not index_path.exists():
        raise SystemExit(f"Unrecognized ingest output: {run}")
    return trajectories, meeting if meeting.exists() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path, help="Oxygen ingest output directory")
    parser.add_argument("--port", type=int, default=3210)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    run = args.run.expanduser().resolve()
    trajectories, meeting = locate_inputs(run)
    project_map_path = run / "project-map.json"
    project_map = json.loads(project_map_path.read_text()) if project_map_path.exists() else {}

    if not args.skip_install and not (VIEWER / "node_modules").exists():
        subprocess.run(["npm", "install"], cwd=VIEWER, check=True)

    signal.signal(signal.SIGTERM, lambda _signum, _frame: (_ for _ in ()).throw(KeyboardInterrupt()))
    base_url = f"http://127.0.0.1:{args.port}"
    internal_port = args.port + 1
    process = subprocess.Popen(
        ["npm", "run", "dev", "--", "--host", "localhost", "--port", str(internal_port)],
        cwd=VIEWER,
    )
    ipv4_bridge = subprocess.Popen(
        [
            "socat",
            f"TCP4-LISTEN:{args.port},bind=127.0.0.1,reuseaddr,fork",
            f"TCP6:[::1]:{internal_port}",
        ],
        cwd=VIEWER,
    )
    try:
        for _ in range(90):
            try:
                urllib.request.urlopen(base_url, timeout=1).close()
                break
            except (OSError, urllib.error.URLError):
                if process.poll() is not None:
                    raise SystemExit("Viewer exited before becoming ready")
                time.sleep(0.5)
        else:
            raise SystemExit("Viewer did not become ready")

        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        event_count = sum(import_trajectory(opener, base_url, path, project_map) for path in trajectories)
        if meeting:
            event_count += import_meeting(opener, base_url, meeting)
        print(f"\nOxygen local review: {base_url}", flush=True)
        print("No password is required for this localhost-only viewer", flush=True)
        print(
            f"Imported: {len(trajectories)} trajectories, {event_count} events/records",
            flush=True,
        )
        print("Nothing has been uploaded. Press Ctrl+C to stop.\n", flush=True)
        if args.smoke_test:
            status = request_json(opener, f"{base_url}/api/organization")
            while status["status"] in {"idle", "running"}:
                status = request_json(
                    opener, f"{base_url}/api/organization", method="POST", body={}
                )
            if event_count and status["status"] != "complete":
                raise SystemExit(f"Organizer did not complete: {status}")
            print(json.dumps({"smoke_test": "passed", "organization": status}))
            return
        if not args.no_browser:
            webbrowser.open(base_url)
        process.wait()
    except KeyboardInterrupt:
        pass
    finally:
        ipv4_bridge.terminate()
        try:
            ipv4_bridge.wait(timeout=3)
        except subprocess.TimeoutExpired:
            ipv4_bridge.kill()
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
