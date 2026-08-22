#!/usr/bin/env python3
"""Convert one Claude Code transcript JSONL into Oxygen trajectory v0.2."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import mimetypes
import shutil
import sys
from pathlib import Path
from typing import Any, Iterable

import extract_codex_trajectory as common


def claude_action(tool_name: str, arguments: Any) -> str:
    lowered = tool_name.lower()
    direct = {
        "read": "read",
        "glob": "search",
        "grep": "search",
        "write": "create",
        "edit": "update",
        "multiedit": "update",
        "notebookedit": "update",
        "websearch": "web",
        "webfetch": "web",
        "task": "delegate",
        "agent": "delegate",
    }
    if lowered in direct:
        return direct[lowered]
    return common.infer_action(tool_name, common.canonical_json(arguments))


def content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    texts: list[str] = []
    for item in value:
        if isinstance(item, dict) and item.get("type") in {"text", "input_text", "output_text"}:
            text = item.get("text")
            if isinstance(text, str):
                texts.append(text)
    return "\n".join(texts)


class ClaudeExtractor:
    def __init__(
        self,
        session_path: Path,
        output_root: Path,
        trajectory_id: str,
        overwrite: bool,
        source_home: Path,
        source_user: str,
    ) -> None:
        self.session_path = session_path.resolve()
        self.output_root = output_root.resolve()
        self.trajectory_id = common.safe_slug(trajectory_id)
        self.trajectory_dir = self.output_root / self.trajectory_id
        if self.trajectory_dir.exists():
            if not overwrite:
                raise FileExistsError(f"output already exists: {self.trajectory_dir}; pass --overwrite")
            shutil.rmtree(self.trajectory_dir)
        self.trajectory_dir.mkdir(parents=True)
        self.source_home = source_home.resolve()
        self.source_user = source_user
        self.session_id = self.session_path.stem
        self.title: str | None = None
        self.cwd: str | None = None
        self.events: list[dict[str, Any]] = []
        self.event_counter = 0
        self.artifacts = common.ArtifactWriter(self.trajectory_dir, self.source_home)
        self.raw_to_event: dict[str, str] = {}
        self.tool_calls: dict[str, str] = {}
        self.tool_meta: dict[str, dict[str, Any]] = {}
        self.warnings: list[str] = []
        self.is_subagent = "subagents" in self.session_path.parts
        self.parent_session_id = self.session_path.parent.parent.name if self.is_subagent else None

    def next_id(self) -> str:
        self.event_counter += 1
        return f"evt-{self.event_counter:06d}"

    def source(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        record_type: str,
        block_index: int | None = None,
    ) -> dict[str, Any]:
        raw_id = record.get("uuid") or record.get("sessionId") or f"line-{line_number}"
        record_id = f"{raw_id}:{block_index}" if block_index is not None else str(raw_id)
        return {
            "system": "claude-code",
            "session_id": self.session_id,
            "record_id": record_id,
            "record_type": record_type,
            "locator": self.session_path.name,
            "line": line_number,
            "sha256": common.sha256_bytes(raw),
        }

    def relations_for_parent(self, record: dict[str, Any], relation_type: str = "caused_by") -> list[dict[str, str]]:
        parent = record.get("parentUuid")
        if isinstance(parent, str) and parent in self.raw_to_event:
            return [{"type": relation_type, "event_id": self.raw_to_event[parent]}]
        return []

    def add_event(
        self,
        *,
        timestamp: str | None,
        event_type: str,
        actor: dict[str, Any],
        payload: dict[str, Any],
        source: dict[str, Any],
        relations: list[dict[str, str]] | None = None,
        executor: dict[str, Any] | None = None,
        span_id: str | None = None,
        outcome: dict[str, Any] | None = None,
        note: str | None = None,
    ) -> str:
        event_id = self.next_id()
        self.events.append(
            {
                "schema_version": common.SCHEMA_VERSION,
                "event_id": event_id,
                "trajectory_id": self.trajectory_id,
                "conversation_id": f"conv-{self.session_id}",
                "turn_id": None,
                "span_id": span_id,
                "parent_span_id": None,
                "sequence": self.event_counter,
                "timestamp": timestamp,
                "started_at": timestamp if event_type == "tool_call" else None,
                "ended_at": timestamp if event_type == "tool_result" else None,
                "event_type": event_type,
                "actor": actor,
                "executor": executor,
                "relations": relations or [],
                "source": source,
                "payload": payload,
                "outcome": outcome,
                "note": note,
            }
        )
        return event_id

    def add_artifact_event(
        self,
        artifact: common.Artifact,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        created_by: str | None,
    ) -> str:
        relations = [{"type": "produced", "event_id": created_by}] if created_by else []
        return self.add_event(
            timestamp=record.get("timestamp"),
            event_type="artifact",
            actor={"id": "system-claude", "type": "system", "parent_agent_id": None},
            payload={
                "artifact_id": artifact.artifact_id,
                "kind": artifact.kind,
                "original_name": artifact.original_name,
                "stored_name": Path(artifact.path).name,
                "path": artifact.path,
                "media_type": artifact.media_type,
                "size_bytes": artifact.size_bytes,
                "sha256": artifact.sha256,
                "created_by_event": created_by,
            },
            source=self.source(record, raw, line_number, f"artifact:{artifact.kind}"),
            relations=relations,
        )

    def process_text(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        role: str,
        text: str,
        block_index: int | None,
    ) -> str | None:
        if not text.strip():
            return None
        actor = {
            "id": f"participant-{self.source_user}" if role == "user" else f"agent-claude-{self.source_user}",
            "type": "human" if role == "user" else "ai",
            "parent_agent_id": None,
        }
        relation_type = "reply_to" if role == "assistant" else "caused_by"
        return self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor=actor,
            payload={
                "role": role,
                "phase": None,
                "text": common.redact_text(text, self.source_home),
                "attachments": [],
            },
            source=self.source(record, raw, line_number, "message", block_index),
            relations=self.relations_for_parent(record, relation_type),
        )

    def process_image(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        block: dict[str, Any],
        parent_event: str | None,
    ) -> str | None:
        source = block.get("source")
        if not isinstance(source, dict) or source.get("type") != "base64" or not isinstance(source.get("data"), str):
            self.warnings.append(f"line {line_number}: unsupported image source")
            return None
        try:
            data = base64.b64decode(source["data"], validate=True)
        except ValueError:
            self.warnings.append(f"line {line_number}: invalid base64 image")
            return None
        media_type = str(source.get("media_type") or "application/octet-stream")
        suffix = mimetypes.guess_extension(media_type) or ".bin"
        artifact = self.artifacts.write_bytes("image", data, suffix, media_type)
        return self.add_artifact_event(artifact, record, raw, line_number, parent_event)

    def process_tool_use(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        block: dict[str, Any],
        block_index: int,
    ) -> str:
        call_id = str(block.get("id") or f"tool-{line_number}-{block_index}")
        tool_name = str(block.get("name") or "unknown")
        arguments = common.sanitize(block.get("input"), self.source_home)
        arguments_text = common.canonical_json(arguments)
        artifact = self.artifacts.write_text("arguments", arguments_text, ".json")
        action = claude_action(tool_name, arguments)
        event_id = self.add_event(
            timestamp=record.get("timestamp"),
            event_type="tool_call",
            actor={
                "id": f"agent-claude-{self.source_user}",
                "type": "ai",
                "parent_agent_id": None,
            },
            executor={"system": "claude-code", "tool": tool_name},
            payload={
                "call_id": call_id,
                "namespace": None,
                "tool_name": tool_name,
                "action": action,
                "cwd": common.redact_text(str(record.get("cwd") or self.cwd or ""), self.source_home) or None,
                "arguments_ref": artifact.artifact_id,
            },
            source=self.source(record, raw, line_number, "tool_use", block_index),
            relations=self.relations_for_parent(record),
            span_id=call_id,
        )
        self.tool_calls[call_id] = event_id
        intended: list[str] = []
        if isinstance(arguments, dict):
            for key in ("file_path", "path", "notebook_path"):
                value = arguments.get(key)
                if isinstance(value, str) and not common.is_sensitive_path(value):
                    intended.append(common.redact_text(value, self.source_home))
        self.tool_meta[call_id] = {"action": action, "intended_files": intended, "tool_name": tool_name}
        self.add_artifact_event(artifact, record, raw, line_number, event_id)
        return event_id

    def process_tool_result(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        block: dict[str, Any],
        block_index: int,
    ) -> str:
        call_id = str(block.get("tool_use_id") or f"tool-{line_number}-{block_index}")
        text = content_text(block.get("content"))
        if not text and block.get("content") is not None:
            value = common.sanitize(block.get("content"), self.source_home)
            text = value if isinstance(value, str) else common.canonical_json(value)
        artifact = self.artifacts.write_text("stdout", text, ".txt") if text else None
        is_error = bool(block.get("is_error"))
        meta = self.tool_meta.get(call_id, {})
        intended = list(meta.get("intended_files") or [])
        changed = intended if not is_error and meta.get("action") in {"create", "update", "move", "delete"} else []
        event_id = self.add_event(
            timestamp=record.get("timestamp"),
            event_type="tool_result",
            actor={
                "id": f"tool-claude-{self.source_user}",
                "type": "tool",
                "parent_agent_id": f"agent-claude-{self.source_user}",
            },
            executor={"system": "claude-code", "tool": str(meta.get("tool_name") or "tool_result")},
            payload={
                "call_id": call_id,
                "exit_code": 1 if is_error else 0,
                "signal": None,
                "stdout_ref": artifact.artifact_id if artifact and not is_error else None,
                "stderr_ref": artifact.artifact_id if artifact and is_error else None,
                "effects": {
                    "intended_files": intended,
                    "changed_files": changed,
                    "patch_ref": None,
                },
            },
            source=self.source(record, raw, line_number, "tool_result", block_index),
            relations=[{"type": "result_of", "event_id": self.tool_calls[call_id]}] if call_id in self.tool_calls else self.relations_for_parent(record),
            span_id=call_id,
            outcome={"status": "failure" if is_error else "success", "reason": None, "partial": False},
        )
        if artifact:
            self.add_artifact_event(artifact, record, raw, line_number, event_id)
        return event_id

    def process_message_record(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        if record.get("isMeta") is True:
            if isinstance(record.get("uuid"), str) and isinstance(record.get("parentUuid"), str):
                parent_event = self.raw_to_event.get(record["parentUuid"])
                if parent_event:
                    self.raw_to_event[record["uuid"]] = parent_event
            return
        message = record.get("message")
        if not isinstance(message, dict):
            return
        role = message.get("role") or record.get("type")
        if role not in {"user", "assistant"}:
            return
        content = message.get("content")
        generated: list[str] = []
        if isinstance(content, str):
            event_id = self.process_text(record, raw, line_number, role, content, None)
            if event_id:
                generated.append(event_id)
        elif isinstance(content, list):
            for index, block in enumerate(content):
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type")
                event_id = None
                if block_type == "text":
                    event_id = self.process_text(record, raw, line_number, role, str(block.get("text") or ""), index)
                elif block_type == "tool_use":
                    event_id = self.process_tool_use(record, raw, line_number, block, index)
                elif block_type == "tool_result":
                    event_id = self.process_tool_result(record, raw, line_number, block, index)
                elif block_type == "image":
                    event_id = self.process_image(record, raw, line_number, block, generated[-1] if generated else None)
                # thinking blocks are intentionally excluded.
                if event_id:
                    generated.append(event_id)
        raw_uuid = record.get("uuid")
        if isinstance(raw_uuid, str):
            if generated:
                self.raw_to_event[raw_uuid] = generated[-1]
            elif isinstance(record.get("parentUuid"), str) and record["parentUuid"] in self.raw_to_event:
                self.raw_to_event[raw_uuid] = self.raw_to_event[record["parentUuid"]]

    def process(self) -> None:
        with self.session_path.open("rb") as handle:
            for line_number, raw in enumerate(handle, 1):
                raw = raw.rstrip(b"\r\n")
                if not raw:
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError as exc:
                    self.warnings.append(f"line {line_number}: invalid JSON ({exc})")
                    continue
                if not isinstance(record, dict):
                    continue
                if isinstance(record.get("sessionId"), str):
                    self.session_id = record["sessionId"]
                if isinstance(record.get("cwd"), str):
                    self.cwd = record["cwd"]
                record_type = record.get("type")
                if record_type in {"user", "assistant"}:
                    self.process_message_record(record, raw, line_number)
                elif record_type == "ai-title" and isinstance(record.get("aiTitle"), str):
                    self.title = common.redact_text(record["aiTitle"], self.source_home)
                # queue-operation and last-prompt duplicate message content;
                # attachment listing deltas are harness metadata, not uploads.

    def write(self) -> None:
        with (self.trajectory_dir / "events.jsonl").open("w", encoding="utf-8") as handle:
            for event in self.events:
                handle.write(common.canonical_json(event) + "\n")
        manifest = {
            "schema_version": common.SCHEMA_VERSION,
            "trajectory_id": self.trajectory_id,
            "title": self.title or f"Claude Code session {self.session_id}",
            "source_system": "claude-code",
            "source_user": self.source_user,
            "source_session_id": self.session_id,
            "source_locator": self.session_path.name,
            "source_relative_path": self.session_path.relative_to(self.source_home).as_posix(),
            "snapshot_at": common.utc_now(),
            "is_subagent": self.is_subagent,
            "parent_session_id": self.parent_session_id,
            "participants": [
                {"id": f"participant-{self.source_user}", "type": "human"},
                {"id": f"agent-claude-{self.source_user}", "type": "ai"},
            ],
            "event_count": len(self.events),
            "artifact_count": self.artifacts.count,
            "redaction_status": "automatic_only",
            "warnings": self.warnings,
        }
        (self.trajectory_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        redaction = {
            "schema_version": common.SCHEMA_VERSION,
            "trajectory_id": self.trajectory_id,
            "automatic_redaction": True,
            "excluded_record_types": [
                "thinking",
                "queue-operation",
                "last-prompt",
                "harness-attachment-metadata",
                "credentials",
            ],
            "review_status": "pending",
            "publication_approved": False,
            "notes": "Human privacy review is required before publication.",
        }
        (self.trajectory_dir / "redaction.json").write_text(
            json.dumps(redaction, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, default=Path("data"))
    parser.add_argument("--trajectory-id", required=True)
    parser.add_argument("--source-home", type=Path, required=True)
    parser.add_argument("--source-user", required=True)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    common.configure_utf8_stdio()
    args = parse_args(argv)
    try:
        extractor = ClaudeExtractor(
            args.session,
            args.output_root,
            args.trajectory_id,
            args.overwrite,
            args.source_home,
            args.source_user,
        )
        extractor.process()
        extractor.write()
    except (FileNotFoundError, FileExistsError, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(extractor.trajectory_dir)
    print(f"events={len(extractor.events)} artifacts={extractor.artifacts.count} warnings={len(extractor.warnings)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
