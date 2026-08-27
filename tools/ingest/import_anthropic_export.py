#!/usr/bin/env python3
"""Import a claude.ai data export (zip / conversations.json / folder) as Oxygen trajectories.

claude.ai (web) exports arrive by mail as a zip containing at least
`conversations.json` (all chats), and usually `projects.json` and `users.json`.
The schema is not publicly guaranteed, so parsing is deliberately tolerant:
unknown fields are ignored, missing ones defaulted, and every parse problem is
reported instead of crashing.

Each conversation becomes one v0.2-style trajectory (message events only — web
exports carry no tool calls). `projects.json` documents are stored under
memory/ since they act as persistent context, similar to agent memory.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import zipfile
from pathlib import Path

INGEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(INGEST_DIR))
sys.path.insert(0, str(INGEST_DIR / "vendor"))
import extract_codex_trajectory as vendor_common  # noqa: E402  (secret masking, hashing)
from human_source_projection import digest_value, project_trajectory  # noqa: E402

from oxygen_common import (  # noqa: E402
    configure_utf8_stdio,
    fail,
    progress,
    run_stamp,
    safe_slug,
    utc_now,
    write_json,
)


def locate_export(source: Path, scratch: Path) -> Path:
    """Return a directory containing conversations.json."""
    if source.is_file() and source.suffix.lower() == ".zip":
        with zipfile.ZipFile(source) as archive:
            archive.extractall(scratch)
        source = scratch
    if source.is_file():
        return source.parent
    if source.is_dir():
        hits = sorted(source.rglob("conversations.json"))
        if hits:
            return hits[0].parent
    raise fail(f"could not find conversations.json under {source}")


def message_text(message: dict) -> str:
    parts: list[str] = []
    content = message.get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
    if not parts and isinstance(message.get("text"), str):
        parts.append(message["text"])
    return "\n".join(part for part in parts if part).strip()


def convert_conversation(conv: dict, out_root: Path, home: Path, warnings: list[str]) -> dict | None:
    conv_id = str(conv.get("uuid") or conv.get("id") or "")
    title = str(conv.get("name") or "").strip() or "(untitled)"
    messages = conv.get("chat_messages")
    if not isinstance(messages, list):
        warnings.append(f"conversation {conv_id or title!r}: no chat_messages list")
        return None
    trajectory_id = f"traj-claudeai-{safe_slug(conv_id[:8] or title)[:40]}"
    trajectory_dir = out_root / trajectory_id
    trajectory_dir.mkdir(parents=True, exist_ok=True)

    events = []
    sequence = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        text = message_text(message)
        sender = message.get("sender")
        if sender == "human":
            actor_type = "human"
        elif sender == "assistant":
            actor_type = "ai"
        else:
            warnings.append(
                f"conversation {conv_id or title!r}: skipped message with ambiguous sender"
            )
            continue
        attachments = []
        for kind in ("attachments", "files"):
            for item in message.get(kind) or []:
                if isinstance(item, dict):
                    attachments.append(
                        {
                            "file_name": item.get("file_name") or item.get("name"),
                            "kind": kind,
                            "has_extracted_content": bool(item.get("extracted_content")),
                        }
                    )
        if not text and not attachments:
            continue
        sequence += 1
        events.append(
            {
                "schema_version": "0.2",
                "event_id": f"evt-{sequence:06d}",
                "trajectory_id": trajectory_id,
                "conversation_id": f"conv-{conv_id or 'unknown'}",
                "turn_id": None,
                "span_id": None,
                "parent_span_id": None,
                "sequence": sequence,
                "timestamp": message.get("created_at"),
                "started_at": None,
                "ended_at": None,
                "event_type": "message",
                "actor": {
                    "id": "participant-claudeai-user" if actor_type == "human" else "agent-claudeai",
                    "type": actor_type,
                    "parent_agent_id": None,
                },
                "executor": None,
                "relations": [],
                "source": {
                    "system": "claude-ai-export",
                    "session_id": conv_id or None,
                    "record_id": message.get("uuid"),
                    "record_type": "chat_message",
                    "origin": "top_level",
                    "interaction_direction": (
                        "human_to_agent" if actor_type == "human" else "agent_to_human"
                    ),
                    "locator": "conversations.json",
                    "line": None,
                    "sha256": None,
                },
                "payload": {
                    "role": "user" if actor_type == "human" else "assistant",
                    "text": vendor_common.redact_text(text, home),
                    "attachments": attachments,
                    "has_attachments": bool(attachments),
                    "phase": None,
                },
                "outcome": None,
                "note": None,
            }
        )
    if not events:
        return None
    with (trajectory_dir / "events.jsonl").open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    manifest = {
        "schema_version": "0.2",
        "trajectory_id": trajectory_id,
        "title": vendor_common.redact_text(title, home),
        "source_system": "claude-ai-export",
        "source_session_id": conv_id or None,
        "source_locator": "conversations.json",
        "snapshot_at": utc_now(),
        "created_at": conv.get("created_at"),
        "updated_at": conv.get("updated_at"),
        "is_subagent": False,
        "participants": [
            {"id": "participant-claudeai-user", "type": "human"},
            {"id": "agent-claudeai", "type": "ai"},
        ],
        "event_count": len(events),
        "artifact_count": 0,
        "redaction_status": "automatic_only",
        "warnings": [],
    }
    write_json(trajectory_dir / "manifest.json", manifest)
    write_json(
        trajectory_dir / "redaction.json",
        {"review_status": "pending", "publication_approved": False, "reviewed_by": None},
    )
    projection = project_trajectory(
        trajectory_dir,
        raw_source_digest=digest_value(conv),
    )
    return {
        "trajectory_id": trajectory_id,
        "title": title,
        "event_count": projection["kept_event_count"],
    }


def load_projects(export_dir: Path) -> list[dict]:
    """Projects appear either as one projects.json list or as projects/<uuid>.json files."""
    projects: list[dict] = []
    projects_file = export_dir / "projects.json"
    if projects_file.is_file():
        try:
            data = json.loads(projects_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                projects.extend(p for p in data if isinstance(p, dict))
        except (OSError, json.JSONDecodeError):
            pass
    projects_dir = export_dir / "projects"
    if projects_dir.is_dir():
        for path in sorted(projects_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    projects.append(data)
            except (OSError, json.JSONDecodeError):
                continue
    return projects


def import_projects(export_dir: Path, out: Path, home: Path) -> int:
    count = 0
    for project in load_projects(export_dir):
        slug = safe_slug(str(project.get("name") or project.get("uuid") or "project"))[:60]
        for key in ("prompt_template", "description"):
            value = project.get(key)
            if isinstance(value, str) and value.strip():
                dest = out / "memory" / "claudeai-projects" / slug / f"_{key}.md"
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(vendor_common.redact_text(value, home), encoding="utf-8")
                count += 1
        for doc in project.get("docs") or []:
            if not isinstance(doc, dict):
                continue
            name = safe_slug(str(doc.get("filename") or doc.get("uuid") or f"doc-{count}"))
            content = doc.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            dest = out / "memory" / "claudeai-projects" / slug / f"{name}.md"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(vendor_common.redact_text(content, home), encoding="utf-8")
            count += 1
    return count


def import_memories(export_dir: Path, out: Path, home: Path) -> int:
    """memories.json: [{account_uuid, conversations_memory: str, memory_files: [{path, content, updated_at}]}]."""
    memories_file = export_dir / "memories.json"
    if not memories_file.is_file():
        return 0
    try:
        accounts = json.loads(memories_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    count = 0
    root = out / "memory" / "claudeai-memory"
    for index, account in enumerate(accounts if isinstance(accounts, list) else []):
        if not isinstance(account, dict):
            continue
        prefix = root if len(accounts) == 1 else root / f"account-{index}"
        summary = account.get("conversations_memory")
        if isinstance(summary, str) and summary.strip():
            prefix.mkdir(parents=True, exist_ok=True)
            (prefix / "conversations_memory.md").write_text(
                vendor_common.redact_text(summary, home), encoding="utf-8")
            count += 1
        for entry in account.get("memory_files") or []:
            if not isinstance(entry, dict):
                continue
            content = entry.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            name = safe_slug(str(entry.get("path") or f"memory-{count}"))[:100]
            dest = prefix / "files" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(vendor_common.redact_text(content, home), encoding="utf-8")
            count += 1
    return count


def convert_design_chat(path: Path, out_root: Path, home: Path, warnings: list[str]) -> dict | None:
    """design_chats/<uuid>.json: {uuid, title, project, messages:[{role, content:{content: str}, created_at, uuid}]}."""
    try:
        chat = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        warnings.append(f"design chat {path.name}: unreadable ({error})")
        return None
    if not isinstance(chat, dict) or not isinstance(chat.get("messages"), list):
        warnings.append(f"design chat {path.name}: unexpected shape")
        return None
    chat_id = str(chat.get("uuid") or path.stem)
    title = str(chat.get("title") or "").strip() or "(untitled design chat)"
    trajectory_id = f"traj-claudeai-design-{safe_slug(chat_id[:8])}"
    trajectory_dir = out_root / trajectory_id
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    events = []
    sequence = 0
    for message in chat["messages"]:
        if not isinstance(message, dict):
            continue
        inner = message.get("content")
        text = ""
        if isinstance(inner, dict):
            text = inner.get("content") if isinstance(inner.get("content"), str) else ""
        elif isinstance(inner, str):
            text = inner
        text = (text or "").strip()
        if not text:
            continue
        role = message.get("role") or (inner.get("role") if isinstance(inner, dict) else None)
        if role == "user":
            actor_type = "human"
        elif role == "assistant":
            actor_type = "ai"
        else:
            warnings.append(f"design chat {path.name}: skipped message with ambiguous role")
            continue
        sequence += 1
        events.append({
            "schema_version": "0.2",
            "event_id": f"evt-{sequence:06d}",
            "trajectory_id": trajectory_id,
            "conversation_id": f"conv-{chat_id}",
            "turn_id": None, "span_id": None, "parent_span_id": None,
            "sequence": sequence,
            "timestamp": message.get("created_at"),
            "started_at": None, "ended_at": None,
            "event_type": "message",
            "actor": {"id": "participant-claudeai-user" if actor_type == "human" else "agent-claudeai-design",
                      "type": actor_type, "parent_agent_id": None},
            "executor": None, "relations": [],
            "source": {"system": "claude-ai-export", "session_id": chat_id,
                       "record_id": message.get("uuid"), "record_type": "design_chat_message",
                       "origin": "top_level",
                       "interaction_direction": (
                           "human_to_agent" if actor_type == "human" else "agent_to_human"
                       ),
                       "locator": f"design_chats/{path.name}", "line": None, "sha256": None},
            "payload": {"role": "user" if actor_type == "human" else "assistant",
                        "text": vendor_common.redact_text(text, home), "attachments": [], "phase": None},
            "outcome": None, "note": None,
        })
    if not events:
        return None
    with (trajectory_dir / "events.jsonl").open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    write_json(trajectory_dir / "manifest.json", {
        "schema_version": "0.2", "trajectory_id": trajectory_id,
        "title": vendor_common.redact_text(title, home),
        "source_system": "claude-ai-export", "source_session_id": chat_id,
        "source_locator": f"design_chats/{path.name}", "snapshot_at": utc_now(),
        "created_at": chat.get("created_at"), "updated_at": chat.get("updated_at"),
        "is_subagent": False,
        "participants": [{"id": "participant-claudeai-user", "type": "human"},
                         {"id": "agent-claudeai-design", "type": "ai"}],
        "event_count": len(events), "artifact_count": 0,
        "redaction_status": "automatic_only", "warnings": [],
    })
    write_json(trajectory_dir / "redaction.json",
               {"review_status": "pending", "publication_approved": False, "reviewed_by": None})
    projection = project_trajectory(
        trajectory_dir,
        raw_source_digest=digest_value(chat),
    )
    return {"trajectory_id": trajectory_id, "title": title,
            "event_count": projection["kept_event_count"],
            "kind": "design_chat"}


def main(argv=None) -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="export zip, conversations.json, or folder")
    parser.add_argument("--out", type=Path, help="output dir (default tools/out/claudeai-<ts>)")
    parser.add_argument("--home", type=Path, default=Path.home(), help="home path to mask in text")
    parser.add_argument("--publish", action="store_true",
                        help="copy the result into the shared ingest-staging area")
    args = parser.parse_args(argv)

    source = args.source.expanduser().resolve()
    if not source.exists():
        raise fail(f"source not found: {source}")
    out = (
        args.out.expanduser().resolve()
        if args.out
        else Path(__file__).resolve().parent / "out" / f"claudeai-{run_stamp()}"
    )
    out.mkdir(parents=True, exist_ok=True)
    home = args.home.expanduser().resolve()

    progress(5, "locate", "locating conversations.json")
    with tempfile.TemporaryDirectory(prefix="claudeai-export-") as scratch:
        export_dir = locate_export(source, Path(scratch))
        conversations_path = export_dir / "conversations.json"
        try:
            conversations = json.loads(conversations_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise fail(f"cannot parse {conversations_path}: {error}")
        if isinstance(conversations, dict):  # some exports wrap the list
            conversations = conversations.get("conversations") or []
        if not isinstance(conversations, list):
            raise fail("conversations.json is not a list — schema changed, need a look")

        progress(10, "convert", f"{len(conversations)} conversations found")
        warnings: list[str] = []
        converted: list[dict] = []
        for index, conv in enumerate(conversations, 1):
            if isinstance(conv, dict):
                entry = convert_conversation(conv, out / "trajectories", home, warnings)
                if entry:
                    converted.append(entry)
            progress(10 + 80 * index / max(1, len(conversations)), "convert",
                     f"[{index}/{len(conversations)}] converted")

        design_dir = export_dir / "design_chats"
        design_files = sorted(design_dir.glob("*.json")) if design_dir.is_dir() else []
        for index, path in enumerate(design_files, 1):
            entry = convert_design_chat(path, out / "trajectories", home, warnings)
            if entry:
                converted.append(entry)
            progress(90 + 2 * index / max(1, len(design_files)), "design",
                     f"[{index}/{len(design_files)}] design chats")

        progress(93, "memory", "importing project docs + claude.ai memory")
        memory_count = import_projects(export_dir, out, home)
        memory_count += import_memories(export_dir, out, home)

    write_json(
        out / "index.json",
        {
            "schema_version": "0.2",
            "tool": "import_anthropic_export",
            "generated_at": utc_now(),
            "source": str(source),
            "trajectory_count": len(converted),
            "memory_doc_count": memory_count,
            "warnings": warnings,
            "review_status": "pending",
            "publication_approved": False,
            "trajectories": converted,
        },
    )
    if args.publish:
        from oxygen_common import publish_to_staging
        staged = publish_to_staging(out, out.name)
        if staged:
            progress(98, "publish", f"staged: {staged}")
    progress(100, "done", f"{len(converted)} conversations, {memory_count} memory docs -> {out}")
    print(json.dumps({"output": str(out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
