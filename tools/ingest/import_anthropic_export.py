#!/usr/bin/env python3
"""Import a claude.ai data export (zip / conversations.json / folder) as Oxygen trajectories.

claude.ai (web) exports arrive by mail as a zip containing at least
`conversations.json` (all chats), and usually `projects.json` and `users.json`.
The schema is not publicly guaranteed, so parsing is deliberately tolerant:
unknown fields are ignored, missing ones defaulted, and every parse problem is
reported instead of crashing.

Each conversation becomes one canonical trajectory (message events only — web
exports carry no tool calls). `projects.json` documents are stored under
memory/ since they act as persistent context, similar to agent memory.
"""

from __future__ import annotations

import argparse
import json
import re
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

INGEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(INGEST_DIR))
sys.path.insert(0, str(INGEST_DIR / "vendor"))
import extract_codex_trajectory as vendor_common  # noqa: E402  (secret masking, hashing)
from human_source_projection import digest_value, project_trajectory  # noqa: E402

from oxygen_common import (  # noqa: E402
    configure_utf8_stdio,
    fail,
    progress,
    safe_slug,
    utc_now,
    validate_output_root,
    write_json,
)


EXPORT_SCOPE_INVALID = "ANTHROPIC_EXPORT_SCOPE_INVALID"
EXPORT_IDENTITY_INVALID = "ANTHROPIC_EXPORT_IDENTITY_INVALID"
OUTPUT_NOT_EMPTY = "ANTHROPIC_OUTPUT_NOT_EMPTY"


def _validate_zip_members(archive: zipfile.ZipFile) -> None:
    """Reject archive members that could escape or alias the extraction root."""
    seen: set[str] = set()
    for info in archive.infolist():
        name = info.filename
        path = PurePosixPath(name)
        mode = (info.external_attr >> 16) & 0o170000
        normalized = path.as_posix().casefold()
        if (
            not name
            or normalized in seen
            or "\\" in name
            or path.is_absolute()
            or any(part in {"", ".", ".."} for part in path.parts)
            or re.match(r"^[A-Za-z]:", name)
            or mode == stat.S_IFLNK
        ):
            raise fail(EXPORT_SCOPE_INVALID)
        seen.add(normalized)


def locate_export_scope(source: Path, scratch: Path) -> tuple[Path, Path | None]:
    """Return the exact conversations file and optional authorized supplement root."""
    if source.is_file() and source.suffix.lower() == ".zip":
        try:
            with zipfile.ZipFile(source) as archive:
                _validate_zip_members(archive)
                archive.extractall(scratch)
        except (OSError, zipfile.BadZipFile):
            raise fail(EXPORT_SCOPE_INVALID) from None
        source = scratch
    if source.is_file():
        if source.suffix.lower() != ".json":
            raise fail(EXPORT_SCOPE_INVALID)
        return source, None
    if source.is_dir():
        root = source.resolve(strict=True)
        hits = sorted(source.rglob("conversations.json"))
        if len(hits) != 1:
            raise fail(EXPORT_SCOPE_INVALID)
        conversations_path = hits[0]
        try:
            resolved = conversations_path.resolve(strict=True)
        except (OSError, RuntimeError):
            raise fail(EXPORT_SCOPE_INVALID) from None
        if conversations_path.is_symlink() or not resolved.is_relative_to(root):
            raise fail(EXPORT_SCOPE_INVALID)
        return resolved, resolved.parent
    raise fail(EXPORT_SCOPE_INVALID)


def _contained_supplement(
    path: Path,
    root: Path,
    *,
    directory: bool,
) -> Path:
    try:
        if path.is_symlink():
            raise OSError
        resolved = path.resolve(strict=True)
        physical_root = root.resolve(strict=True)
    except (OSError, RuntimeError):
        raise fail(EXPORT_SCOPE_INVALID) from None
    if not resolved.is_relative_to(physical_root):
        raise fail(EXPORT_SCOPE_INVALID)
    if directory and not resolved.is_dir():
        raise fail(EXPORT_SCOPE_INVALID)
    if not directory and not resolved.is_file():
        raise fail(EXPORT_SCOPE_INVALID)
    return resolved


def validate_supplement_scope(export_dir: Path) -> None:
    for name in ("projects.json", "memories.json"):
        path = export_dir / name
        if path.exists() or path.is_symlink():
            _contained_supplement(path, export_dir, directory=False)
    projects_dir = export_dir / "projects"
    if projects_dir.exists() or projects_dir.is_symlink():
        projects_dir = _contained_supplement(projects_dir, export_dir, directory=True)
        for path in sorted(projects_dir.glob("*.json")):
            _contained_supplement(path, export_dir, directory=False)
    design_dir = export_dir / "design_chats"
    if design_dir.exists() or design_dir.is_symlink():
        design_dir = _contained_supplement(design_dir, export_dir, directory=True)
        for path in sorted(design_dir.glob("*.json")):
            _contained_supplement(path, export_dir, directory=False)


def _planned_trajectory_id(kind: str, explicit_id: str, provenance: dict) -> str:
    identity = (
        {"kind": kind, "sourceId": explicit_id}
        if explicit_id
        else {"kind": kind, "missingIdProvenance": provenance}
    )
    prefix = "traj-claudeai-design-" if kind == "design_chat" else "traj-claudeai-"
    return prefix + digest_value(identity)


def plan_import_identities(
    conversations: list,
    design_chats: list[tuple[dict, str]],
    *,
    conversation_locator: str,
) -> tuple[list[str | None], list[str]]:
    """Plan every output identity before the importer creates any output."""
    seen_source_ids: set[tuple[str, str]] = set()
    seen_trajectory_ids: set[str] = set()

    def plan(kind: str, payload: dict, record_index: int, locator: str) -> str:
        raw_id = payload.get("uuid") or payload.get("id")
        explicit_id = str(raw_id).strip() if raw_id is not None else ""
        if explicit_id:
            source_key = (kind, explicit_id)
            if source_key in seen_source_ids:
                raise fail(EXPORT_IDENTITY_INVALID)
            seen_source_ids.add(source_key)
        trajectory_id = _planned_trajectory_id(
            kind,
            explicit_id,
            {
                "recordIndex": record_index,
                "contentDigest": digest_value(payload),
                "relativeLocator": locator,
            },
        )
        if trajectory_id in seen_trajectory_ids:
            raise fail(EXPORT_IDENTITY_INVALID)
        seen_trajectory_ids.add(trajectory_id)
        return trajectory_id

    conversation_ids = [
        plan("conversation", value, index, conversation_locator)
        if isinstance(value, dict) else None
        for index, value in enumerate(conversations)
    ]
    design_ids = [
        plan("design_chat", value, index, locator)
        for index, (value, locator) in enumerate(design_chats)
    ]
    return conversation_ids, design_ids


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


def convert_conversation(
    conv: dict,
    source_locator: str,
    trajectory_id: str,
    out_root: Path,
    home: Path,
    warnings: list[str],
) -> dict | None:
    conv_id = str(conv.get("uuid") or conv.get("id") or "")
    title = str(conv.get("name") or "").strip() or "(untitled)"
    messages = conv.get("chat_messages")
    if not isinstance(messages, list):
        warnings.append(f"conversation {conv_id or title!r}: no chat_messages list")
        return None
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
                "schema": vendor_common.TRAJECTORY_EVENT_SCHEMA,
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
                    "locator": source_locator,
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
    trajectory_dir = out_root / trajectory_id
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    with (trajectory_dir / "events.jsonl").open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    manifest = {
        "schema": vendor_common.TRAJECTORY_SCHEMA,
        "trajectory_id": trajectory_id,
        "title": vendor_common.redact_text(title, home),
        "source_system": "claude-ai-export",
        "source_session_id": conv_id or None,
        "source_locator": source_locator,
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
        {
            "schema": vendor_common.TRAJECTORY_REDACTION_SCHEMA,
            "review_status": "pending",
            "publication_approved": False,
            "reviewed_by": None,
        },
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
    if projects_file.exists() or projects_file.is_symlink():
        projects_file = _contained_supplement(projects_file, export_dir, directory=False)
        try:
            data = json.loads(projects_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                projects.extend(p for p in data if isinstance(p, dict))
        except (OSError, json.JSONDecodeError):
            pass
    projects_dir = export_dir / "projects"
    if projects_dir.exists() or projects_dir.is_symlink():
        projects_dir = _contained_supplement(projects_dir, export_dir, directory=True)
        for path in sorted(projects_dir.glob("*.json")):
            path = _contained_supplement(path, export_dir, directory=False)
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
    if not memories_file.exists() and not memories_file.is_symlink():
        return 0
    memories_file = _contained_supplement(memories_file, export_dir, directory=False)
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


def load_design_chats(export_dir: Path, warnings: list[str]) -> list[tuple[dict, str]]:
    design_dir = export_dir / "design_chats"
    if not design_dir.exists() and not design_dir.is_symlink():
        return []
    design_dir = _contained_supplement(design_dir, export_dir, directory=True)
    root = export_dir.resolve(strict=True)
    result: list[tuple[dict, str]] = []
    for path in sorted(design_dir.glob("*.json")):
        locator = path.relative_to(export_dir).as_posix()
        try:
            resolved = _contained_supplement(path, root, directory=False)
            chat = json.loads(resolved.read_text(encoding="utf-8"))
        except (OSError, RuntimeError, UnicodeError, json.JSONDecodeError):
            warnings.append(f"design chat {path.name}: unreadable")
            continue
        if not isinstance(chat, dict) or not isinstance(chat.get("messages"), list):
            warnings.append(f"design chat {path.name}: unexpected shape")
            continue
        result.append((chat, locator))
    return result


def convert_design_chat(
    chat: dict,
    source_locator: str,
    trajectory_id: str,
    out_root: Path,
    home: Path,
    warnings: list[str],
) -> dict | None:
    """design_chats/<uuid>.json: {uuid, title, project, messages:[{role, content:{content: str}, created_at, uuid}]}."""
    chat_id = str(chat.get("uuid") or "")
    title = str(chat.get("title") or "").strip() or "(untitled design chat)"
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
            warnings.append(
                f"design chat {source_locator}: skipped message with ambiguous role"
            )
            continue
        sequence += 1
        events.append({
            "schema": vendor_common.TRAJECTORY_EVENT_SCHEMA,
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
            "source": {"system": "claude-ai-export", "session_id": chat_id or None,
                       "record_id": message.get("uuid"), "record_type": "design_chat_message",
                       "origin": "top_level",
                       "interaction_direction": (
                           "human_to_agent" if actor_type == "human" else "agent_to_human"
                       ),
                       "locator": source_locator, "line": None, "sha256": None},
            "payload": {"role": "user" if actor_type == "human" else "assistant",
                        "text": vendor_common.redact_text(text, home), "attachments": [], "phase": None},
            "outcome": None, "note": None,
        })
    if not events:
        return None
    trajectory_dir = out_root / trajectory_id
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    with (trajectory_dir / "events.jsonl").open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    write_json(trajectory_dir / "manifest.json", {
        "schema": vendor_common.TRAJECTORY_SCHEMA, "trajectory_id": trajectory_id,
        "title": vendor_common.redact_text(title, home),
        "source_system": "claude-ai-export", "source_session_id": chat_id or None,
        "source_locator": source_locator, "snapshot_at": utc_now(),
        "created_at": chat.get("created_at"), "updated_at": chat.get("updated_at"),
        "is_subagent": False,
        "participants": [{"id": "participant-claudeai-user", "type": "human"},
                         {"id": "agent-claudeai-design", "type": "ai"}],
        "event_count": len(events), "artifact_count": 0,
        "redaction_status": "automatic_only", "warnings": [],
    })
    write_json(trajectory_dir / "redaction.json", {
        "schema": vendor_common.TRAJECTORY_REDACTION_SCHEMA,
        "review_status": "pending",
        "publication_approved": False,
        "reviewed_by": None,
    })
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
    parser.add_argument("--out", type=Path, required=True,
                        help="explicit local run output directory")
    parser.add_argument("--home", type=Path, default=Path.home(), help="home path to mask in text")
    args = parser.parse_args(argv)

    source = args.source.expanduser().resolve()
    if not source.exists():
        print("ANTHROPIC_EXPORT_SOURCE_INVALID", file=sys.stderr)
        return 1
    try:
        out = validate_output_root(args.out)
    except ValueError as error:
        raise fail(str(error)) from error
    if out.exists() and next(out.iterdir(), None) is not None:
        raise fail(OUTPUT_NOT_EMPTY)
    home = args.home.expanduser().resolve()

    progress(5, "locate", "locating conversations.json")
    with tempfile.TemporaryDirectory(prefix="claudeai-export-") as scratch:
        conversations_path, supplemental_root = locate_export_scope(source, Path(scratch))
        try:
            conversations = json.loads(conversations_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise fail(f"cannot parse {conversations_path}: {error}")
        if isinstance(conversations, dict):  # some exports wrap the list
            conversations = conversations.get("conversations") or []
        if not isinstance(conversations, list):
            raise fail("conversations.json is not a list — schema changed, need a look")

        warnings: list[str] = []
        if supplemental_root is not None:
            validate_supplement_scope(supplemental_root)
        design_chats = (
            load_design_chats(supplemental_root, warnings)
            if supplemental_root is not None else []
        )
        conversation_locator = conversations_path.name
        conversation_ids, design_ids = plan_import_identities(
            conversations,
            design_chats,
            conversation_locator=conversation_locator,
        )

        out.mkdir(parents=True, exist_ok=True)
        progress(10, "convert", f"{len(conversations)} conversations found")
        converted: list[dict] = []
        for index, conv in enumerate(conversations, 1):
            if isinstance(conv, dict):
                trajectory_id = conversation_ids[index - 1]
                assert trajectory_id is not None
                entry = convert_conversation(
                    conv, conversation_locator, trajectory_id,
                    out / "trajectories", home, warnings,
                )
                if entry:
                    converted.append(entry)
            progress(10 + 80 * index / max(1, len(conversations)), "convert",
                     f"[{index}/{len(conversations)}] converted")

        for index, ((chat, locator), trajectory_id) in enumerate(
            zip(design_chats, design_ids, strict=True), 1,
        ):
            entry = convert_design_chat(
                chat, locator, trajectory_id, out / "trajectories", home, warnings,
            )
            if entry:
                converted.append(entry)
            progress(90 + 2 * index / max(1, len(design_chats)), "design",
                     f"[{index}/{len(design_chats)}] design chats")

        progress(93, "memory", "importing project docs + claude.ai memory")
        memory_count = 0
        if supplemental_root is not None:
            memory_count = import_projects(supplemental_root, out, home)
            memory_count += import_memories(supplemental_root, out, home)

    write_json(
        out / "index.json",
        {
            "schema": vendor_common.INGEST_RUN_SCHEMA,
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
    progress(100, "done", f"{len(converted)} conversations, {memory_count} memory docs -> {out}")
    print(json.dumps({"output": str(out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
