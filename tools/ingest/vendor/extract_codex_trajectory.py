#!/usr/bin/env python3
"""Convert a Codex rollout JSONL session into Oxygen trajectory v0.2.

The extractor intentionally omits reasoning records, developer/system prompts,
base instructions, token telemetry, and known credential files. Its automatic
redaction is only a first safety pass; human review is required before release.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

TOOLS_ROOT = Path(__file__).resolve().parents[2]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio


SCHEMA_VERSION = "0.2"
DEFAULT_SESSION_ROOT = Path.home() / ".codex" / "sessions"
SENSITIVE_BASENAMES = {
    "auth.json",
    ".credentials.json",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
    ".access",
}

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b"),
    re.compile(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(
        r"(?i)((?:access|auth|connection|refresh)[_-]?token)"
        r"(\s*[=:]\s*)([^\s,;\"']+)"
    ),
    re.compile(
        r"(?i)(password|passwd|api[_-]?key|access[_-]?token|secret)"
        r"(\s*[=:]\s*)([^\s,;\"']+)"
    ),
    re.compile(r"(密码(?:为|是|[:：])\s*)([^\s,，。;；\"“”']+)"),
    re.compile(r"(?i)(用户名|username)(\+\d{3,}!)"),
]

PLATFORM_USER_PREFIXES = (
    "<recommended_plugins>",
    "<environment_context>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "# AGENTS.md instructions",
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_slug(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return value or "trajectory"


def redact_text(text: str, home: Path) -> str:
    redacted = text.replace(str(home), "<USER_HOME>")
    for pattern in SECRET_PATTERNS:
        if pattern.groups >= 3:
            redacted = pattern.sub(r"\1\2<REDACTED>", redacted)
        elif pattern.groups == 2:
            redacted = pattern.sub(r"\1<REDACTED>", redacted)
        elif pattern.groups == 1:
            redacted = pattern.sub(r"\1 <REDACTED>", redacted)
        else:
            redacted = pattern.sub("<REDACTED>", redacted)
    return redacted


def sanitize(value: Any, home: Path) -> Any:
    if isinstance(value, str):
        return redact_text(value, home)
    if isinstance(value, list):
        return [sanitize(item, home) for item in value]
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            lowered = key.lower()
            if any(marker in lowered for marker in ("credential", "private_key", "auth_token", "cookie")):
                cleaned[key] = "<REDACTED>"
            else:
                cleaned[key] = sanitize(item, home)
        return cleaned
    return value


def is_sensitive_path(path_text: str) -> bool:
    path = Path(path_text)
    if path.name in SENSITIVE_BASENAMES:
        return True
    lowered = path_text.lower()
    return "/.ssh/" in lowered or lowered.endswith(".pem") or lowered.endswith(".key")


def extract_text(content: Any) -> tuple[str, list[dict[str, Any]]]:
    if isinstance(content, str):
        return content, []
    texts: list[str] = []
    attachments: list[dict[str, Any]] = []
    if not isinstance(content, list):
        return "", attachments
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type in {"input_text", "output_text", "text"}:
            text = item.get("text")
            if isinstance(text, str):
                texts.append(text)
        elif item_type in {"input_image", "image", "input_file", "file"}:
            attachments.append(item)
    return "\n".join(texts), attachments


def is_platform_injected_user_text(text: str) -> bool:
    stripped = text.lstrip()
    return any(stripped.startswith(prefix) for prefix in PLATFORM_USER_PREFIXES)


def source_turn_id(payload: dict[str, Any]) -> str | None:
    metadata = payload.get("internal_chat_message_metadata_passthrough")
    if isinstance(metadata, dict) and isinstance(metadata.get("turn_id"), str):
        return metadata["turn_id"]
    if isinstance(payload.get("turn_id"), str):
        return payload["turn_id"]
    return None


def infer_action(tool_name: str, raw_arguments: Any) -> str:
    haystack = f"{tool_name} {raw_arguments}".lower()
    if any(word in haystack for word in ("spawn_agent", "delegate")):
        return "delegate"
    if any(word in haystack for word in ("apply_patch", "write_file", "create_file")):
        return "update"
    if re.search(r"\b(pytest|unittest|npm test|pnpm test|cargo test|go test)\b", haystack):
        return "test"
    if re.search(r"\b(eslint|ruff|mypy|lint)\b", haystack):
        return "lint"
    if re.search(r"\b(build|cargo build|npm run build|make)\b", haystack):
        return "build"
    if any(word in haystack for word in ("web__run", "search_query", "open_url")):
        return "web"
    if re.search(r"\b(rg|grep|find|sed -n|head|tail|cat|ls)\b", haystack):
        return "search" if re.search(r"\b(rg|grep|find)\b", haystack) else "read"
    return "command" if tool_name in {"exec", "exec_command", "write_stdin"} else "other"


def parse_exit_code(text: str) -> int | None:
    matches = re.findall(r"(?i)(?:exit code|process exited with code)\s*[:=]?\s*(-?\d+)", text)
    return int(matches[-1]) if matches else None


def outcome_from_output(text: str, explicit_success: bool | None = None) -> dict[str, Any]:
    exit_code = parse_exit_code(text)
    failure_words = ("script failed", "traceback (most recent call last)", "permission denied")
    failed = explicit_success is False or (exit_code not in (None, 0)) or any(w in text.lower() for w in failure_words)
    status = "failure" if failed else "success"
    return {"status": status, "reason": None, "partial": False}


@dataclass
class Artifact:
    artifact_id: str
    kind: str
    path: str
    media_type: str
    size_bytes: int
    sha256: str
    original_name: str | None = None


class ArtifactWriter:
    def __init__(self, trajectory_dir: Path, home: Path) -> None:
        self.trajectory_dir = trajectory_dir
        self.home = home
        self.count = 0

    def write_text(self, kind: str, text: str, suffix: str = ".txt", original_name: str | None = None) -> Artifact:
        self.count += 1
        artifact_id = f"artifact-{self.count:06d}"
        folder = {
            "arguments": "arguments",
            "stdout": "outputs",
            "stderr": "outputs",
            "patch": "patches",
            "test_report": "tests",
        }.get(kind, "attachments")
        safe_text = redact_text(text, self.home)
        data = safe_text.encode("utf-8")
        name = f"{artifact_id}{suffix}"
        relative = Path("artifacts") / folder / name
        destination = self.trajectory_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        media_type = mimetypes.guess_type(name)[0] or "text/plain"
        return Artifact(
            artifact_id=artifact_id,
            kind=kind,
            path=relative.as_posix(),
            media_type=media_type,
            size_bytes=len(data),
            sha256=sha256_bytes(data),
            original_name=original_name,
        )

    def write_bytes(
        self,
        kind: str,
        data: bytes,
        suffix: str,
        media_type: str,
        original_name: str | None = None,
    ) -> Artifact:
        self.count += 1
        artifact_id = f"artifact-{self.count:06d}"
        folder = "attachments"
        name = f"{artifact_id}{suffix}"
        relative = Path("artifacts") / folder / name
        destination = self.trajectory_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        return Artifact(
            artifact_id=artifact_id,
            kind=kind,
            path=relative.as_posix(),
            media_type=media_type,
            size_bytes=len(data),
            sha256=sha256_bytes(data),
            original_name=original_name,
        )


class Extractor:
    def __init__(
        self,
        session_path: Path,
        output_root: Path,
        trajectory_id: str,
        overwrite: bool,
        source_home: Path | None = None,
        source_user: str | None = None,
    ) -> None:
        self.session_path = session_path.resolve()
        self.output_root = output_root.resolve()
        self.trajectory_id = safe_slug(trajectory_id)
        self.trajectory_dir = self.output_root / self.trajectory_id
        if self.trajectory_dir.exists():
            if not overwrite:
                raise FileExistsError(f"output already exists: {self.trajectory_dir}; pass --overwrite to replace it")
            shutil.rmtree(self.trajectory_dir)
        self.trajectory_dir.mkdir(parents=True)
        self.home = (source_home or Path.home()).resolve()
        self.source_user = source_user or self.home.name
        self.artifacts = ArtifactWriter(self.trajectory_dir, self.home)
        self.events: list[dict[str, Any]] = []
        self.event_counter = 0
        self.session_id = self.session_path.stem
        self.cwd: str | None = None
        self.call_events: dict[str, str] = {}
        self.call_started: dict[str, str] = {}
        self.call_metadata: dict[str, dict[str, Any]] = {}
        self.last_user_event_by_turn: dict[str, str] = {}
        self.warnings: list[str] = []

    def next_id(self) -> str:
        self.event_counter += 1
        return f"evt-{self.event_counter:06d}"

    def source(self, payload: dict[str, Any], raw: bytes, line_number: int, record_type: str) -> dict[str, Any]:
        record_id = payload.get("id") or payload.get("call_id") or f"line-{line_number}"
        return {
            "system": "codex",
            "session_id": self.session_id,
            "record_id": str(record_id),
            "record_type": record_type,
            "locator": self.session_path.name,
            "line": line_number,
            "sha256": sha256_bytes(raw),
        }

    def add_event(
        self,
        *,
        timestamp: str | None,
        event_type: str,
        actor: dict[str, Any],
        payload: dict[str, Any],
        source: dict[str, Any],
        turn_id: str | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        executor: dict[str, Any] | None = None,
        relations: list[dict[str, str]] | None = None,
        outcome: dict[str, Any] | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
        note: str | None = None,
    ) -> str:
        event_id = self.next_id()
        event = {
            "schema_version": SCHEMA_VERSION,
            "event_id": event_id,
            "trajectory_id": self.trajectory_id,
            "conversation_id": f"conv-{self.session_id}",
            "turn_id": turn_id,
            "span_id": span_id,
            "parent_span_id": parent_span_id,
            "sequence": self.event_counter,
            "timestamp": timestamp,
            "started_at": started_at,
            "ended_at": ended_at,
            "event_type": event_type,
            "actor": actor,
            "executor": executor,
            "relations": relations or [],
            "source": source,
            "payload": payload,
            "outcome": outcome,
            "note": note,
        }
        self.events.append(event)
        return event_id

    def add_artifact_event(
        self,
        artifact: Artifact,
        timestamp: str | None,
        source: dict[str, Any],
        turn_id: str | None,
        created_by_event: str | None,
    ) -> str:
        relations = []
        if created_by_event:
            relations.append({"type": "produced", "event_id": created_by_event})
        return self.add_event(
            timestamp=timestamp,
            event_type="artifact",
            actor={"id": "system-codex", "type": "system", "parent_agent_id": None},
            payload={
                "artifact_id": artifact.artifact_id,
                "kind": artifact.kind,
                "original_name": artifact.original_name,
                "stored_name": Path(artifact.path).name,
                "path": artifact.path,
                "media_type": artifact.media_type,
                "size_bytes": artifact.size_bytes,
                "sha256": artifact.sha256,
                "created_by_event": created_by_event,
            },
            source=source,
            turn_id=turn_id,
            relations=relations,
        )

    def process_message(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        role = payload.get("role")
        if role not in {"user", "assistant"}:
            return
        text, attachments = extract_text(payload.get("content"))
        if not text and not attachments:
            return
        if role == "user" and is_platform_injected_user_text(text):
            self.warnings.append(
                f"skipped platform-injected user metadata at line {line_number}"
            )
            return
        turn_id = source_turn_id(payload)
        relations: list[dict[str, str]] = []
        if role == "assistant" and turn_id and turn_id in self.last_user_event_by_turn:
            relations.append({"type": "reply_to", "event_id": self.last_user_event_by_turn[turn_id]})
        source = self.source(payload, raw, line_number, "message")
        event_id = self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor={
                "id": "participant-01" if role == "user" else "agent-codex-01",
                "type": "human" if role == "user" else "ai",
                "parent_agent_id": None,
            },
            payload={
                "role": role,
                "phase": payload.get("phase"),
                "text": redact_text(text, self.home),
                "attachments": [],
            },
            source=source,
            turn_id=turn_id,
            relations=relations,
        )
        if role == "user" and turn_id:
            self.last_user_event_by_turn[turn_id] = event_id
        for attachment in attachments:
            safe_attachment = sanitize(attachment, self.home)
            locator = safe_attachment.get("path") or safe_attachment.get("image_url") or safe_attachment.get("file_id")
            if locator and is_sensitive_path(str(locator)):
                self.warnings.append(f"skipped sensitive attachment reference at line {line_number}")
                continue
            serialized = canonical_json(safe_attachment)
            artifact = self.artifacts.write_text("attachment", serialized, ".json")
            self.add_artifact_event(artifact, record.get("timestamp"), source, turn_id, event_id)
            self.events[-1]["relations"].append({"type": "reply_to", "event_id": event_id})

    def process_tool_call(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        call_id = str(payload.get("call_id") or payload.get("id") or f"call-{line_number}")
        turn_id = source_turn_id(payload)
        tool_name = str(payload.get("name") or "unknown")
        namespace = payload.get("namespace")
        arguments = payload.get("input", payload.get("arguments"))
        sanitized_arguments = sanitize(arguments, self.home)
        argument_text = sanitized_arguments if isinstance(sanitized_arguments, str) else canonical_json(sanitized_arguments)
        argument_ref = None
        if argument_text:
            artifact = self.artifacts.write_text("arguments", argument_text, ".txt")
            argument_ref = artifact.artifact_id
        action = infer_action(tool_name, argument_text)
        event_id = self.add_event(
            timestamp=record.get("timestamp"),
            started_at=record.get("timestamp"),
            event_type="tool_call",
            actor={"id": "agent-codex-01", "type": "ai", "parent_agent_id": None},
            executor={"system": "codex", "tool": tool_name},
            payload={
                "call_id": call_id,
                "namespace": namespace,
                "tool_name": tool_name,
                "action": action,
                "cwd": redact_text(self.cwd, self.home) if self.cwd else None,
                "arguments_ref": argument_ref,
            },
            source=self.source(payload, raw, line_number, payload.get("type", "tool_call")),
            turn_id=turn_id,
            span_id=call_id,
        )
        self.call_events[call_id] = event_id
        self.call_started[call_id] = record.get("timestamp") or ""
        self.call_metadata[call_id] = {
            "tool_name": tool_name,
            "action": action,
            "arguments": argument_text,
            "cwd": redact_text(self.cwd, self.home) if self.cwd else None,
        }
        if argument_ref:
            self.add_artifact_event(artifact, record.get("timestamp"), self.source(payload, raw, line_number, "tool_arguments"), turn_id, event_id)

    def process_tool_result(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        call_id = str(payload.get("call_id") or payload.get("id") or f"call-{line_number}")
        turn_id = source_turn_id(payload)
        text, _ = extract_text(payload.get("output"))
        if not text:
            value = payload.get("output", payload.get("result"))
            if value is not None:
                text = value if isinstance(value, str) else canonical_json(sanitize(value, self.home))
        output_ref = None
        artifact = None
        if text:
            artifact = self.artifacts.write_text("stdout", text, ".txt")
            output_ref = artifact.artifact_id
        exit_code = parse_exit_code(text)
        result_event_id = self.add_event(
            timestamp=record.get("timestamp"),
            started_at=self.call_started.get(call_id),
            ended_at=record.get("timestamp"),
            event_type="tool_result",
            actor={"id": "tool-codex", "type": "tool", "parent_agent_id": "agent-codex-01"},
            executor={"system": "codex", "tool": "tool_result"},
            payload={
                "call_id": call_id,
                "exit_code": exit_code,
                "signal": None,
                "stdout_ref": output_ref,
                "stderr_ref": None,
                "effects": {"intended_files": [], "changed_files": [], "patch_ref": None},
            },
            source=self.source(payload, raw, line_number, payload.get("type", "tool_result")),
            turn_id=turn_id,
            span_id=call_id,
            relations=[{"type": "result_of", "event_id": self.call_events[call_id]}] if call_id in self.call_events else [],
            outcome=outcome_from_output(text),
        )
        if artifact:
            self.add_artifact_event(artifact, record.get("timestamp"), self.source(payload, raw, line_number, "tool_output"), turn_id, result_event_id)
        self.maybe_add_git_event(
            call_id=call_id,
            timestamp=record.get("timestamp"),
            turn_id=turn_id,
            source=self.source(payload, raw, line_number, "git_observation"),
            result_event_id=result_event_id,
            output_ref=output_ref,
            output_text=text,
            outcome=outcome_from_output(text),
        )

    def maybe_add_git_event(
        self,
        *,
        call_id: str,
        timestamp: str | None,
        turn_id: str | None,
        source: dict[str, Any],
        result_event_id: str,
        output_ref: str | None,
        output_text: str,
        outcome: dict[str, Any],
    ) -> None:
        metadata = self.call_metadata.get(call_id, {})
        arguments = str(metadata.get("arguments") or "")
        match = re.search(
            r"(?:^|[;&|\n]\s*|\s)git(?:\s+-C\s+[^\s;|]+)?\s+"
            r"(status|diff|log|show|commit|add|push|pull|fetch|branch|rev-parse)\b",
            arguments,
        )
        if not match:
            return
        action = match.group(1).replace("rev-parse", "revision")
        branch_match = re.search(r"(?m)^On branch\s+([^\s]+)", output_text)
        commit_match = re.search(r"\[[^\]]+\s+([0-9a-f]{7,40})\]", output_text)
        self.add_event(
            timestamp=timestamp,
            event_type="git",
            actor={"id": "agent-codex-01", "type": "ai", "parent_agent_id": None},
            executor={"system": "git", "tool": f"git {action}"},
            payload={
                "action": action,
                "repository": metadata.get("cwd"),
                "branch": branch_match.group(1) if branch_match else None,
                "base_commit": None,
                "commit": commit_match.group(1) if commit_match else None,
                "preexisting_dirty": None,
                "intended_files": [],
                "changed_files": [],
                "before_ref": None,
                "after_ref": output_ref,
                "diff_ref": output_ref if action in {"diff", "show"} else None,
            },
            source=source,
            turn_id=turn_id,
            span_id=call_id,
            relations=[{"type": "observed", "event_id": result_event_id}],
            outcome=outcome,
            note="Normalized from the corresponding Git command; unavailable fields remain null.",
        )

    def process_patch_result(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        call_id = str(payload.get("call_id") or f"patch-{line_number}")
        turn_id = source_turn_id(payload)
        changes = payload.get("changes") if isinstance(payload.get("changes"), dict) else {}
        intended_files: list[str] = []
        changed_files: list[str] = []
        patch_parts: list[str] = []
        for path, change in changes.items():
            safe_path = redact_text(str(path), self.home)
            if is_sensitive_path(str(path)):
                self.warnings.append(f"omitted sensitive patch target at line {line_number}")
                continue
            intended_files.append(safe_path)
            if payload.get("success"):
                changed_files.append(safe_path)
            if isinstance(change, dict):
                diff = change.get("unified_diff")
                if isinstance(diff, str):
                    patch_parts.append(f"--- {safe_path}\n+++ {safe_path}\n{diff}")
                elif isinstance(change.get("content"), str):
                    patch_parts.append(f"--- /dev/null\n+++ {safe_path}\n{change['content']}")
        patch_ref = None
        patch_artifact = None
        if patch_parts:
            patch_artifact = self.artifacts.write_text("patch", "\n".join(patch_parts), ".diff")
            patch_ref = patch_artifact.artifact_id
        stderr = payload.get("stderr") if isinstance(payload.get("stderr"), str) else ""
        stdout = payload.get("stdout") if isinstance(payload.get("stdout"), str) else ""
        output_artifact = None
        if stdout or stderr:
            output_artifact = self.artifacts.write_text("stdout", f"STDOUT\n{stdout}\nSTDERR\n{stderr}", ".txt")
        result_event_id = self.add_event(
            timestamp=record.get("timestamp"),
            started_at=self.call_started.get(call_id),
            ended_at=record.get("timestamp"),
            event_type="tool_result",
            actor={"id": "tool-apply-patch", "type": "tool", "parent_agent_id": "agent-codex-01"},
            executor={"system": "codex", "tool": "apply_patch"},
            payload={
                "call_id": call_id,
                "exit_code": 0 if payload.get("success") else 1,
                "signal": None,
                "stdout_ref": output_artifact.artifact_id if output_artifact else None,
                "stderr_ref": output_artifact.artifact_id if stderr and output_artifact else None,
                "effects": {
                    "intended_files": intended_files,
                    "changed_files": changed_files,
                    "patch_ref": patch_ref,
                },
            },
            source=self.source(payload, raw, line_number, "patch_apply_end"),
            turn_id=turn_id,
            span_id=call_id,
            relations=[{"type": "result_of", "event_id": self.call_events[call_id]}] if call_id in self.call_events else [],
            outcome=outcome_from_output(f"{stdout}\n{stderr}", bool(payload.get("success"))),
        )
        for artifact in (patch_artifact, output_artifact):
            if artifact:
                self.add_artifact_event(artifact, record.get("timestamp"), self.source(payload, raw, line_number, artifact.kind), turn_id, result_event_id)

    def process_system_event(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        action = payload.get("type")
        if action not in {"task_started", "task_complete", "turn_aborted", "thread_settings_applied"}:
            return
        status = {
            "task_started": None,
            "thread_settings_applied": "success",
            "task_complete": "success",
            "turn_aborted": "interrupted",
        }[action]
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="system",
            actor={"id": "system-codex", "type": "system", "parent_agent_id": None},
            payload={"action": action, "reason": sanitize(payload.get("reason"), self.home)},
            source=self.source(payload, raw, line_number, str(action)),
            turn_id=source_turn_id(payload),
            outcome={"status": status, "reason": None, "partial": action == "turn_aborted"} if status else None,
        )

    def process_agent_event(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = sanitize(record["payload"], self.home)
        payload.pop("type", None)
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="agent",
            actor={"id": "agent-codex-01", "type": "ai", "parent_agent_id": None},
            payload={"action": "activity", "details": payload},
            source=self.source(record["payload"], raw, line_number, "sub_agent_activity"),
            turn_id=source_turn_id(record["payload"]),
        )

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
                if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
                    continue
                payload = record["payload"]
                record_type = record.get("type")
                payload_type = payload.get("type")
                if record_type == "session_meta":
                    self.session_id = str(payload.get("session_id") or payload.get("id") or self.session_id)
                    cwd = payload.get("cwd")
                    self.cwd = str(cwd) if isinstance(cwd, str) else None
                    continue
                if record_type == "response_item" and payload_type == "message":
                    self.process_message(record, raw, line_number)
                elif record_type == "response_item" and payload_type in {"custom_tool_call", "function_call"}:
                    self.process_tool_call(record, raw, line_number)
                elif record_type == "response_item" and payload_type in {"custom_tool_call_output", "function_call_output"}:
                    self.process_tool_result(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "patch_apply_end":
                    self.process_patch_result(record, raw, line_number)
                elif record_type == "event_msg" and payload_type in {"task_started", "task_complete", "turn_aborted", "thread_settings_applied"}:
                    self.process_system_event(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "sub_agent_activity":
                    self.process_agent_event(record, raw, line_number)
                # Explicitly skipped: reasoning, agent_reasoning, developer/system
                # messages, base instructions, token counts, and world state.

    def write(self) -> None:
        events_path = self.trajectory_dir / "events.jsonl"
        with events_path.open("w", encoding="utf-8") as handle:
            for event in self.events:
                handle.write(canonical_json(event) + "\n")
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "trajectory_id": self.trajectory_id,
            "title": f"Codex session {self.session_id}",
            "source_system": "codex",
            "source_user": self.source_user,
            "source_session_id": self.session_id,
            "source_locator": self.session_path.name,
            "snapshot_at": utc_now(),
            "participants": [
                {"id": "participant-01", "type": "human"},
                {"id": "agent-codex-01", "type": "ai"},
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
            "schema_version": SCHEMA_VERSION,
            "trajectory_id": self.trajectory_id,
            "automatic_redaction": True,
            "excluded_record_types": [
                "reasoning",
                "agent_reasoning",
                "developer_message",
                "system_message",
                "base_instructions",
                "token_count",
                "world_state",
            ],
            "review_status": "pending",
            "publication_approved": False,
            "notes": "Human privacy review is required before publication.",
        }
        (self.trajectory_dir / "redaction.json").write_text(
            json.dumps(redaction, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


def latest_session(root: Path) -> Path:
    candidates = [path for path in root.rglob("*.jsonl") if path.is_file()]
    if not candidates:
        raise FileNotFoundError(f"no Codex sessions found under {root}")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--session", type=Path, help="Codex rollout JSONL to extract")
    source.add_argument("--latest", action="store_true", help="extract the latest session (default)")
    parser.add_argument("--session-root", type=Path, default=DEFAULT_SESSION_ROOT)
    parser.add_argument("--output-root", type=Path, default=Path("data"))
    parser.add_argument("--trajectory-id", help="output trajectory ID")
    parser.add_argument("--source-home", type=Path, help="source user's home path for path redaction")
    parser.add_argument("--source-user", help="source user recorded in the internal manifest")
    parser.add_argument("--overwrite", action="store_true", help="replace an existing trajectory directory")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    configure_utf8_stdio()
    args = parse_args(argv)
    try:
        session_path = args.session or latest_session(args.session_root)
        if not session_path.is_file():
            raise FileNotFoundError(session_path)
        if is_sensitive_path(str(session_path)):
            raise ValueError("refusing to extract a credential-like path")
        trajectory_id = args.trajectory_id
        if not trajectory_id:
            date = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
            trajectory_id = f"traj-{date}-codex-{session_path.stem[-12:]}"
        extractor = Extractor(
            session_path,
            args.output_root,
            trajectory_id,
            args.overwrite,
            source_home=args.source_home,
            source_user=args.source_user,
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
