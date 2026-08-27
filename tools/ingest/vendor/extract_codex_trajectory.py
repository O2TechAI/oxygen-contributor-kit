#!/usr/bin/env python3
"""Convert a Codex rollout JSONL session into Oxygen trajectory v0.2.

The extractor retains recorded plaintext reasoning summaries, dialogue, Agent
coordination, and meaningful progress. It omits encrypted reasoning bodies,
developer/system prompts, base instructions, token telemetry, and known
credential files. Its automatic redaction is only a first safety pass; human
review is required before release.
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
from ingest.secret_safety import redact_secret_like_text


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
        r"(\s*[=:]\s*)(?!<redacted>|\[redacted\])([^\s,;\"']+)"
    ),
    re.compile(
        r"(?i)(password|passwd|api[_-]?key|access[_-]?token|secret)"
        r"(\s*[=:]\s*)(?!<redacted>|\[redacted\])([^\s,;\"']+)"
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

CURRENT_CODEX_SEMANTIC_TOOLS = {
    "create_thread", "handoff_thread", "read_thread", "send_message_to_thread", "wait_threads",
}
CURRENT_CODEX_TOOL_PREFIX = "mcp__codex_app__"


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
    return redact_secret_like_text(redacted)


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


def extract_text(content: Any) -> tuple[str, list[tuple[int, dict[str, Any]]]]:
    if isinstance(content, str):
        return content, []
    texts: list[str] = []
    attachments: list[tuple[int, dict[str, Any]]] = []
    if not isinstance(content, list):
        return "", attachments
    for index, item in enumerate(content):
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type in {"input_text", "output_text", "text"}:
            text = item.get("text")
            if isinstance(text, str):
                texts.append(text)
        elif item_type in {"input_image", "image", "input_file", "file"}:
            attachments.append((index, item))
    return "\n".join(texts), attachments


def strip_platform_injected_user_text(text: str) -> str:
    """Remove only structurally complete leading platform envelopes.

    A recorded user item can contain several injected XML-like envelopes and
    then the contributor's actual message. Dropping by prefix erased that
    meaningful suffix, so only known, closed leading blocks are removed.
    """
    remainder = text.lstrip()
    while True:
        matched = next(
            (prefix for prefix in PLATFORM_USER_PREFIXES if remainder.startswith(prefix)),
            None,
        )
        if matched is None:
            return remainder
        if not matched.startswith("<"):
            return ""
        tag = matched[1:-1]
        closing = f"</{tag}>"
        end = remainder.find(closing, len(matched))
        if end < 0:
            return ""
        remainder = remainder[end + len(closing):].lstrip()


def source_turn_id(payload: dict[str, Any]) -> str | None:
    metadata = payload.get("internal_chat_message_metadata_passthrough")
    if isinstance(metadata, dict) and isinstance(metadata.get("turn_id"), str):
        return metadata["turn_id"]
    if isinstance(payload.get("turn_id"), str):
        return payload["turn_id"]
    return None


def session_origin(payload: dict[str, Any]) -> str:
    source = payload.get("source")
    if (
        payload.get("thread_source") == "subagent"
        or isinstance(payload.get("parent_thread_id"), str)
        or isinstance(payload.get("agent_path"), str)
        or (isinstance(source, dict) and "subagent" in source)
    ):
        return "subagent"
    return "top_level"


def extract_reasoning_summary(payload: dict[str, Any]) -> str:
    summary = payload.get("summary")
    if isinstance(summary, str):
        return summary
    if not isinstance(summary, list):
        return ""
    texts: list[str] = []
    for item in summary:
        if not isinstance(item, dict) or item.get("type") != "summary_text":
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            texts.append(text)
    return "\n".join(texts)


def semantic_mirror_signature(
    record: dict[str, Any],
    home: Path,
) -> tuple[str, str, str] | None:
    """Identify only adjacent cross-envelope semantic mirrors.

    Event messages have no stable source ID, so matching them globally or
    non-adjacently could erase a legitimately repeated thought. Exact adjacent
    response/event pairs are the one transport replay we can prove locally.
    """
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    record_type = record.get("type")
    payload_type = payload.get("type")
    text = ""
    family = ""
    attachment_signature = ""
    if record_type == "response_item" and payload_type == "reasoning":
        family = "reasoning"
        text = extract_reasoning_summary(payload)
    elif record_type == "event_msg" and payload_type == "agent_reasoning":
        family = "reasoning"
        text = payload.get("text") if isinstance(payload.get("text"), str) else ""
    elif (
        record_type == "response_item"
        and payload_type == "message"
        and payload.get("role") in {"user", "assistant"}
    ):
        family = f"message:{payload.get('role')}"
        text, attachments = extract_text(payload.get("content"))
        if attachments:
            # Carrier-specific attachment metadata cannot be proven to mirror
            # an event_msg wrapper, so retain both rather than erase source.
            attachment_signature = "response:" + canonical_json(
                [attachment for _, attachment in attachments]
            )
    elif record_type == "event_msg" and payload_type == "agent_message":
        family = "message:assistant"
        text = payload.get("message") if isinstance(payload.get("message"), str) else ""
    elif record_type == "event_msg" and payload_type == "user_message":
        family = "message:user"
        text = payload.get("message") if isinstance(payload.get("message"), str) else ""
        attachment_fields = {
            key: payload[key] for key in (
                "images", "local_images", "audio", "local_audio", "text_elements",
            ) if isinstance(payload.get(key), list) and payload[key]
        }
        if attachment_fields:
            attachment_signature = "event:" + canonical_json(attachment_fields)
    # Compare exact recorded plaintext in memory. Redaction is applied only to
    # the emitted contribution; two distinct source statements must not become
    # a false mirror merely because both redact to the same placeholder.
    exact_text = text.strip()
    return (family, exact_text, attachment_signature) if family and exact_text else None


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


def current_codex_tool_name(tool_name: str) -> str | None:
    if tool_name in CURRENT_CODEX_SEMANTIC_TOOLS:
        return tool_name
    if tool_name.startswith(CURRENT_CODEX_TOOL_PREFIX):
        candidate = tool_name[len(CURRENT_CODEX_TOOL_PREFIX):]
        if candidate in CURRENT_CODEX_SEMANTIC_TOOLS:
            return candidate
    return None


def decode_current_thread_result(value: Any) -> Any:
    """Decode the bounded JSON envelopes used by current thread tools."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, list):
        return value
    decoded: list[Any] = []
    for block in value:
        if not (
            isinstance(block, dict) and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        ):
            return None
        try:
            decoded.append(json.loads(block["text"]))
        except json.JSONDecodeError:
            return None
    return decoded


def stable_thread_id(value: Any) -> str | None:
    if isinstance(value, list) and len(value) == 1:
        return stable_thread_id(value[0])
    if not isinstance(value, dict):
        return None
    thread_id = value.get("threadId")
    return thread_id if isinstance(thread_id, str) and thread_id.strip() else None


def current_thread_call_target(tool_name: str, value: dict[str, Any]) -> str | None:
    direct = stable_thread_id(value)
    if direct or tool_name != "wait_threads":
        return direct
    targets = value.get("targets")
    if not isinstance(targets, list) or len(targets) != 1:
        return None
    return stable_thread_id(targets[0])


def current_thread_result_messages(
    tool_name: str,
    value: Any,
    fallback_thread_id: str | None = None,
) -> list[tuple[str | None, str, str, str]]:
    """Extract only authored read results or terminal wait results."""
    value = decode_current_thread_result(value)
    if not isinstance(value, (dict, list)):
        return []
    messages: list[tuple[str | None, str, str, str]] = []
    seen: set[tuple[str | None, str, str, str]] = set()
    semantic_kinds = {
        "assistant_message", "commentary", "final", "final_report", "finding",
        "message", "progress", "report", "agentmessage",
    }

    def add(thread_id: str | None, role: str, phase: str, text: Any) -> None:
        identity = (thread_id, role, phase, text)
        if isinstance(text, str) and text.strip() and identity not in seen:
            seen.add(identity)
            messages.append((thread_id, role, phase, text))

    def walk(
        node: Any,
        context: str | None = None,
        thread_context: str | None = fallback_thread_id,
    ) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item, context, thread_context)
            return
        if not isinstance(node, dict):
            return
        thread_id = stable_thread_id(node) or thread_context
        if tool_name == "read_thread":
            raw_role = node.get("role")
            normalized_role = raw_role.lower() if isinstance(raw_role, str) else None
            kind = str(node.get("type", node.get("kind", node.get("phase", "")))).lower().replace("-", "_")
            structural_user = normalized_role in {"human", "user"} or kind in {
                "user_message", "usermessage",
            }
            role = None if structural_user else (
                "assistant" if normalized_role in {"agent", "ai", "assistant"}
                else "assistant" if kind in semantic_kinds else context
            )
            phase = str(node.get("phase") or kind or "coordination")
            if role == "assistant" and (not kind or kind in semantic_kinds):
                for key in (
                    "text", "message", "report", "final_text", "finalText",
                    "final_response", "finalResponse", "final_output", "finalOutput",
                ):
                    add(thread_id, role, phase, node.get(key))
                content = node.get("content")
                if isinstance(content, str):
                    add(thread_id, role, phase, content)
                elif isinstance(content, list):
                    add(thread_id, role, phase, extract_text(content)[0])
            for key, child_role in (
                ("items", role), ("messages", role), ("responses", role),
                ("turns", role), ("updates", role), ("latestTurn", None),
            ):
                if key in node:
                    walk(node[key], child_role, thread_id)
            for key in ("agentMessage", "assistantMessage", "latestAssistantMessage"):
                add(thread_id, "assistant", "final", node.get(key))
            return
        if node.get("timedOut") is True:
            return
        raw_status = node.get("status")
        status = str(raw_status).lower().replace("-", "_") if raw_status else context
        if status in {"complete", "completed"}:
            for key in (
                "final", "final_text", "finalText", "final_response", "finalResponse",
                "final_output", "finalOutput", "report", "latestAssistantMessage",
            ):
                add(thread_id, "assistant", "final", node.get(key))
        elif status in {
            "blocked", "needs_attention", "needsattention", "requires_approval",
            "requiresapproval", "waiting_for_user_input", "waitingforuserinput",
        }:
            keys = ("latestAssistantMessage",)
            if status in {"needs_attention", "needsattention"}:
                keys += ("message", "text", "question", "attention_text", "attentionText")
            for key in keys:
                add(thread_id, "assistant", "needs_attention", node.get(key))
        for key, child_status in (
            ("completed", "completed"), ("needs_attention", "needs_attention"),
            ("needsAttention", "needs_attention"), ("results", status),
            ("targets", status), ("threads", status), ("polls", status),
        ):
            if key in node:
                walk(node[key], child_status, thread_id)

    walk(value)
    return messages


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
        self.origin = "top_level"
        self.agent_path: str | None = None
        self.call_events: dict[str, str] = {}
        self.semantic_call_events: dict[str, str] = {}
        self.call_started: dict[str, str] = {}
        self.call_metadata: dict[str, dict[str, Any]] = {}
        self.last_user_event_by_turn: dict[str, str] = {}
        self.assistant_texts_by_turn: dict[str, set[str]] = {}
        self.semantic_record_fingerprints: dict[tuple[str, str, str], str] = {}
        self.thread_semantic_fingerprints: set[tuple[str, str, str, str]] = set()
        self.current_thread_call_targets: dict[str, str] = {}
        self.pending_thread_prompts: dict[str, tuple[str, str, str]] = {}
        self.duplicate_semantic_replays = 0
        self.warnings: list[str] = []

    def next_id(self) -> str:
        self.event_counter += 1
        return f"evt-{self.event_counter:06d}"

    def source(
        self,
        payload: dict[str, Any],
        raw: bytes,
        line_number: int,
        record_type: str,
        interaction_direction: str | None = None,
    ) -> dict[str, Any]:
        record_id = (
            payload.get("id") or payload.get("client_id")
            or payload.get("call_id") or payload.get("turn_id") or f"line-{line_number}"
        )
        source = {
            "system": "codex",
            "session_id": self.session_id,
            "record_id": str(record_id),
            "record_type": record_type,
            "origin": self.origin,
            "locator": self.session_path.name,
            "line": line_number,
            "sha256": sha256_bytes(raw),
        }
        if interaction_direction:
            source["interaction_direction"] = interaction_direction
        return source

    def semantic_source(
        self,
        payload: dict[str, Any],
        raw: bytes,
        line_number: int,
        record_type: str,
        interaction_direction: str,
        semantic_value: Any,
    ) -> dict[str, Any]:
        """Bind replay checks to recorded meaning before local redaction."""
        source = self.source(
            payload, raw, line_number, record_type, interaction_direction,
        )
        source["_semantic_sha256"] = sha256_bytes(
            canonical_json(semantic_value).encode("utf-8")
        )
        return source

    def agent_actor(self) -> dict[str, Any]:
        if self.origin == "subagent":
            return {
                "id": "agent-codex-subagent",
                "type": "ai",
                "parent_agent_id": "agent-codex-parent",
            }
        return {"id": "agent-codex-01", "type": "ai", "parent_agent_id": None}

    def record_assistant_text(self, turn_id: str | None, text: str) -> None:
        if turn_id and text.strip():
            self.assistant_texts_by_turn.setdefault(turn_id, set()).add(text.strip())

    def should_emit_semantic_record(
        self,
        payload: dict[str, Any],
        record_type: str,
        semantic_value: Any,
    ) -> bool:
        record_id = payload.get("id")
        if not isinstance(record_id, str) or not record_id:
            return True
        key = (self.origin, record_type, record_id)
        fingerprint = sha256_bytes(canonical_json(semantic_value).encode("utf-8"))
        previous = self.semantic_record_fingerprints.get(key)
        if previous is None:
            self.semantic_record_fingerprints[key] = fingerprint
            return True
        if previous != fingerprint:
            raise ValueError(
                f"conflicting semantic replay for {record_type} record {record_id}"
            )
        self.duplicate_semantic_replays += 1
        return False

    def add_thread_message(
        self, record: dict[str, Any], raw: bytes, line_number: int,
        source_payload: dict[str, Any], record_type: str, role: str,
        phase: str, direction: str, text: str, thread_id: str | None = None,
    ) -> None:
        semantic_value = {"role": role, "phase": phase, "text": text}
        if not self.should_emit_semantic_record(
            source_payload, record_type, semantic_value,
        ):
            return
        if thread_id:
            thread_key = (
                thread_id, role, phase,
                sha256_bytes(text.encode("utf-8")),
            )
            if thread_key in self.thread_semantic_fingerprints:
                self.duplicate_semantic_replays += 1
                return
            self.thread_semantic_fingerprints.add(thread_key)
        actor = self.agent_actor() if role == "assistant" else {
            "id": "participant-01", "type": "human", "parent_agent_id": None,
        }
        self.add_event(
            timestamp=record.get("timestamp"), event_type="message", actor=actor,
            payload={
                "role": role, "phase": phase, "interaction_direction": direction,
                "text": redact_text(text, self.home), "attachments": [],
            },
            source=self.semantic_source(
                source_payload, raw, line_number, record_type, direction, semantic_value,
            ),
            turn_id=source_turn_id(record["payload"]),
        )

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
        if role == "user":
            filtered_text = strip_platform_injected_user_text(text)
            if filtered_text != text.lstrip():
                self.warnings.append(
                    f"removed platform-injected user metadata at line {line_number}"
                )
            text = filtered_text
            if not text and not attachments:
                return
        semantic_value = {
            "role": role,
            "phase": payload.get("phase"),
            "text": text,
            "attachments": [attachment for _, attachment in attachments],
        }
        if not self.should_emit_semantic_record(payload, "message", semantic_value):
            return
        if self.origin == "subagent":
            direction = "agent_to_subagent" if role == "user" else "subagent_to_agent"
            actor = (
                {"id": "agent-codex-parent", "type": "ai", "parent_agent_id": None}
                if role == "user"
                else self.agent_actor()
            )
        else:
            direction = "human_to_agent" if role == "user" else "agent_to_human"
            actor = (
                {"id": "participant-01", "type": "human", "parent_agent_id": None}
                if role == "user"
                else self.agent_actor()
            )
        turn_id = source_turn_id(payload)
        relations: list[dict[str, str]] = []
        if role == "assistant" and turn_id and turn_id in self.last_user_event_by_turn:
            relations.append({"type": "reply_to", "event_id": self.last_user_event_by_turn[turn_id]})
        source = self.semantic_source(
            payload, raw, line_number, "message", direction, semantic_value,
        )
        event_id = self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor=actor,
            payload={
                "role": role,
                "phase": payload.get("phase"),
                "interaction_direction": direction,
                "text": redact_text(text, self.home),
                "attachments": [],
                "has_attachments": bool(attachments),
            },
            source=source,
            turn_id=turn_id,
            relations=relations,
        )
        if role == "user" and turn_id:
            self.last_user_event_by_turn[turn_id] = event_id
        elif role == "assistant":
            self.record_assistant_text(turn_id, text)
        for attachment_index, attachment in attachments:
            safe_attachment = sanitize(attachment, self.home)
            locator = safe_attachment.get("path") or safe_attachment.get("image_url") or safe_attachment.get("file_id")
            if locator and is_sensitive_path(str(locator)):
                self.warnings.append(f"skipped sensitive attachment reference at line {line_number}")
                continue
            serialized = canonical_json(safe_attachment)
            artifact = self.artifacts.write_text("attachment", serialized, ".json")
            attachment_source = {
                **source,
                "record_type": f"message_attachment:{attachment_index}",
            }
            self.add_artifact_event(
                artifact, record.get("timestamp"), attachment_source, turn_id, event_id,
            )
            self.events[-1]["relations"].append({"type": "reply_to", "event_id": event_id})

    def process_event_user_message(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
    ) -> None:
        payload = record["payload"]
        text = payload.get("message") if isinstance(payload.get("message"), str) else ""
        attachments: list[tuple[str, Any]] = []
        for field in ("images", "local_images", "audio", "local_audio", "text_elements"):
            values = payload.get(field)
            if isinstance(values, list):
                attachments.extend((field, value) for value in values)
        filtered_text = strip_platform_injected_user_text(text)
        text = filtered_text
        if not text.strip() and not attachments:
            return
        semantic_value = {"text": text, "attachments": attachments}
        if not self.should_emit_semantic_record(payload, "user_message", semantic_value):
            return
        if self.origin == "subagent":
            direction = "agent_to_subagent"
            actor = {"id": "agent-codex-parent", "type": "ai", "parent_agent_id": None}
        else:
            direction = "human_to_agent"
            actor = {"id": "participant-01", "type": "human", "parent_agent_id": None}
        turn_id = source_turn_id(payload)
        source = self.semantic_source(
            payload, raw, line_number, "user_message", direction, semantic_value,
        )
        event_id = self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor=actor,
            payload={
                "role": "user",
                "phase": payload.get("phase"),
                "interaction_direction": direction,
                "text": redact_text(text, self.home),
                "attachments": [],
                "has_attachments": bool(attachments),
            },
            source=source,
            turn_id=turn_id,
        )
        for attachment_index, (field, value) in enumerate(attachments):
            safe_attachment = sanitize({"field": field, "value": value}, self.home)
            locator = safe_attachment.get("value") if isinstance(safe_attachment, dict) else None
            if isinstance(locator, str) and is_sensitive_path(locator):
                self.warnings.append(f"skipped sensitive attachment reference at line {line_number}")
                continue
            artifact = self.artifacts.write_text(
                "attachment", canonical_json(safe_attachment), ".json",
            )
            attachment_source = {
                **source,
                "record_type": f"user_message_attachment:{attachment_index}",
            }
            self.add_artifact_event(
                artifact, record.get("timestamp"), attachment_source, turn_id, event_id,
            )
            self.events[-1]["relations"].append({"type": "reply_to", "event_id": event_id})

    def process_reasoning(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        text = extract_reasoning_summary(payload)
        if not text.strip():
            return
        safe_text = redact_text(text, self.home)
        if not self.should_emit_semantic_record(payload, "reasoning_summary", text):
            return
        direction = "subagent_internal_reasoning" if self.origin == "subagent" else "agent_internal_reasoning"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="reasoning",
            actor=self.agent_actor(),
            payload={
                "role": "assistant",
                "phase": "reasoning",
                "interaction_direction": direction,
                "text": safe_text,
            },
            source=self.semantic_source(
                payload, raw, line_number, "reasoning_summary", direction, text,
            ),
            turn_id=source_turn_id(payload),
        )
    def process_task_complete_agent_message(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
    ) -> None:
        payload = record["payload"]
        text = payload.get("last_agent_message")
        if not isinstance(text, str) or not text.strip():
            return
        turn_id = source_turn_id(payload)
        if turn_id and text.strip() in self.assistant_texts_by_turn.get(turn_id, set()):
            self.duplicate_semantic_replays += 1
            return
        direction = "subagent_to_agent" if self.origin == "subagent" else "agent_to_human"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor=self.agent_actor(),
            payload={
                "role": "assistant",
                "phase": "final_answer",
                "interaction_direction": direction,
                "text": redact_text(text, self.home),
                "attachments": [],
            },
            source=self.semantic_source(
                payload,
                raw,
                line_number,
                "task_complete_agent_message",
                direction,
                {"text": text, "turn_id": turn_id},
            ),
            turn_id=turn_id,
        )
        self.record_assistant_text(turn_id, text)

    def process_agent_message(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        text, _ = extract_text(payload.get("content"))
        if not text.strip():
            return
        semantic_value = {
            "author": payload.get("author"),
            "recipient": payload.get("recipient"),
            "text": text,
        }
        if not self.should_emit_semantic_record(payload, "agent_message", semantic_value):
            return
        safe_value = {
            "author": sanitize(payload.get("author"), self.home),
            "recipient": sanitize(payload.get("recipient"), self.home),
            "text": redact_text(text, self.home),
        }
        direction = "agent_to_agent"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor=self.agent_actor(),
            payload={
                "role": "assistant",
                "phase": "coordination",
                "interaction_direction": direction,
                "author": safe_value["author"],
                "recipient": safe_value["recipient"],
                "text": safe_value["text"],
                "attachments": [],
            },
            source=self.semantic_source(
                payload, raw, line_number, "agent_message", direction, semantic_value,
            ),
            turn_id=source_turn_id(payload),
        )
    def process_progress(self, record: dict[str, Any], raw: bytes, line_number: int) -> bool:
        payload = record["payload"]
        action = str(payload.get("type") or "")
        goal = payload.get("goal")
        goal_status = None
        if action == "thread_goal_updated" and isinstance(goal, dict):
            value = goal.get("objective")
            goal_status = goal.get("status") if isinstance(goal.get("status"), str) else None
        else:
            value = goal if action == "thread_goal_updated" else payload.get("reason")
        if not isinstance(value, str) or not value.strip():
            return False
        direction = "subagent_internal_progress" if self.origin == "subagent" else "agent_internal_progress"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="progress",
            actor=self.agent_actor(),
            payload={
                "kind": action,
                "status": goal_status,
                "interaction_direction": direction,
                "text": redact_text(value, self.home),
            },
            source=self.semantic_source(
                payload,
                raw,
                line_number,
                action,
                direction,
                {"text": value, "status": goal_status},
            ),
            turn_id=source_turn_id(payload),
        )
        return True

    def process_event_reasoning(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
    ) -> None:
        payload = record["payload"]
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return
        if not self.should_emit_semantic_record(payload, "agent_reasoning", text):
            return
        direction = "subagent_internal_reasoning" if self.origin == "subagent" else "agent_internal_reasoning"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="reasoning",
            actor=self.agent_actor(),
            payload={
                "role": "assistant",
                "phase": "reasoning",
                "interaction_direction": direction,
                "text": redact_text(text, self.home),
            },
            source=self.semantic_source(
                payload, raw, line_number, "agent_reasoning", direction, text,
            ),
            turn_id=source_turn_id(payload),
        )

    def process_event_agent_message(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
    ) -> None:
        payload = record["payload"]
        text = payload.get("message")
        if not isinstance(text, str) or not text.strip():
            return
        semantic_value = {"message": text, "phase": payload.get("phase")}
        if not self.should_emit_semantic_record(
            payload, "agent_message_event", semantic_value,
        ):
            return
        direction = "subagent_to_agent" if self.origin == "subagent" else "agent_to_human"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="message",
            actor=self.agent_actor(),
            payload={
                "role": "assistant",
                "phase": payload.get("phase"),
                "interaction_direction": direction,
                "text": redact_text(text, self.home),
                "attachments": [],
            },
            source=self.semantic_source(
                payload,
                raw,
                line_number,
                "agent_message_event",
                direction,
                semantic_value,
            ),
            turn_id=source_turn_id(payload),
        )
        self.record_assistant_text(source_turn_id(payload), text)

    def process_semantic_tool_content(
        self,
        record: dict[str, Any],
        raw: bytes,
        line_number: int,
        call_id: str,
        tool_name: str,
        arguments: Any,
    ) -> None:
        if isinstance(arguments, str):
            try:
                value = json.loads(arguments)
            except json.JSONDecodeError:
                return
        else:
            value = arguments
        if not isinstance(value, dict):
            return
        current_tool = current_codex_tool_name(tool_name)
        target_thread_id = (
            current_thread_call_target(current_tool, value) if current_tool else None
        )
        if target_thread_id:
            self.current_thread_call_targets[call_id] = target_thread_id
        if current_tool in {"create_thread", "send_message_to_thread", "handoff_thread"}:
            field = "followUpPrompt" if current_tool == "handoff_thread" else "prompt"
            message = value.get(field)
            if not isinstance(message, str) or not message.strip():
                return
            record_type = f"coordination_prompt:{current_tool}"
            self.add_thread_message(
                record, raw, line_number, record["payload"], record_type,
                "assistant", "coordination", "agent_to_agent", message, target_thread_id,
            )
            if current_tool == "create_thread":
                self.pending_thread_prompts[call_id] = (
                    "assistant", "coordination", message,
                )
            return
        if tool_name in {"spawn_agent", "followup_task", "send_message"}:
            message = value.get("message")
            if not isinstance(message, str) or not message.strip():
                return
            record_type = f"coordination_prompt:{tool_name}"
            semantic_value = {
                "message": message,
                "target": value.get("target"),
                "task_name": value.get("task_name"),
            }
            if not self.should_emit_semantic_record(
                record["payload"], record_type, semantic_value,
            ):
                return
            recipient = value.get("target") or value.get("task_name")
            direction = "agent_to_agent"
            if tool_name == "spawn_agent":
                direction = "agent_to_subagent"
            elif tool_name == "followup_task":
                direction = "agent_to_subagent"
            if (
                self.origin == "subagent"
                and isinstance(self.agent_path, str)
                and self.agent_path.startswith("/")
                and isinstance(recipient, str)
                and recipient.startswith("/")
            ):
                sender_depth = len([part for part in self.agent_path.split("/") if part])
                recipient_depth = len([part for part in recipient.split("/") if part])
                direction = (
                    "subagent_to_agent" if recipient_depth < sender_depth
                    else "agent_to_subagent" if recipient_depth > sender_depth
                    else "agent_to_agent"
                )
            self.add_event(
                timestamp=record.get("timestamp"),
                event_type="message",
                actor=self.agent_actor(),
                payload={
                    "role": "assistant",
                    "phase": "coordination",
                    "interaction_direction": direction,
                    "recipient": sanitize(recipient, self.home),
                    "text": redact_text(message, self.home),
                    "attachments": [],
                },
                source=self.semantic_source(
                    record["payload"],
                    raw,
                    line_number,
                    record_type,
                    direction,
                    semantic_value,
                ),
                turn_id=source_turn_id(record["payload"]),
            )
            return
        if tool_name == "request_user_input":
            questions = value.get("questions")
            if not isinstance(questions, list):
                return
            normalized: list[dict[str, Any]] = []
            lines: list[str] = []
            for question in questions:
                if not isinstance(question, dict):
                    continue
                text = question.get("question")
                if not isinstance(text, str) or not text.strip():
                    continue
                header = question.get("header")
                options: list[dict[str, str]] = []
                for option in question.get("options", []):
                    if not isinstance(option, dict):
                        continue
                    label = option.get("label")
                    description = option.get("description")
                    if not isinstance(label, str) or not label.strip():
                        continue
                    options.append({
                        "label": label,
                        **({"description": description}
                           if isinstance(description, str) and description.strip() else {}),
                    })
                normalized.append({
                    "question": text,
                    **({"header": header}
                       if isinstance(header, str) and header.strip() else {}),
                    "options": options,
                })
                lines.append(
                    f"{header.strip()}: {text.strip()}"
                    if isinstance(header, str) and header.strip() else text.strip()
                )
                lines.extend(
                    f"- {option['label']}"
                    + (f": {option['description']}" if option.get("description") else "")
                    for option in options
                )
            if not normalized:
                return
            semantic_value = {"call_id": call_id, "questions": normalized}
            direction = "agent_to_human"
            event_id = self.add_event(
                timestamp=record.get("timestamp"),
                event_type="message",
                actor=self.agent_actor(),
                payload={
                    "role": "assistant",
                    "phase": "feedback_request",
                    "interaction_direction": direction,
                    "text": redact_text("\n".join(lines), self.home),
                    "attachments": [],
                },
                source=self.semantic_source(
                    record["payload"], raw, line_number, "human_question",
                    direction, semantic_value,
                ),
                turn_id=source_turn_id(record["payload"]),
            )
            self.semantic_call_events[call_id] = event_id
            return
        if tool_name != "update_plan":
            return
        explanation = value.get("explanation")
        lines = [explanation.strip()] if isinstance(explanation, str) and explanation.strip() else []
        plan = value.get("plan")
        semantic_rows: list[dict[str, str]] = []
        if isinstance(plan, list):
            for row in plan:
                if not isinstance(row, dict):
                    continue
                step = row.get("step")
                status = row.get("status")
                if not isinstance(step, str) or not step.strip():
                    continue
                safe_status = status if isinstance(status, str) else ""
                semantic_rows.append({"status": safe_status, "step": step})
                lines.append(f"[{safe_status}] {step}" if safe_status else step)
        if not lines:
            return
        semantic_value = {"explanation": explanation, "plan": semantic_rows}
        if not self.should_emit_semantic_record(
            record["payload"], "agent_plan", semantic_value,
        ):
            return
        direction = "subagent_internal_reasoning" if self.origin == "subagent" else "agent_internal_reasoning"
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="reasoning",
            actor=self.agent_actor(),
            payload={
                "role": "assistant",
                "phase": "planning",
                "interaction_direction": direction,
                "text": redact_text("\n".join(lines), self.home),
            },
            source=self.semantic_source(
                record["payload"],
                raw,
                line_number,
                "agent_plan",
                direction,
                semantic_value,
            ),
            turn_id=source_turn_id(record["payload"]),
        )

    def process_tool_call(self, record: dict[str, Any], raw: bytes, line_number: int) -> None:
        payload = record["payload"]
        call_id = str(payload.get("call_id") or payload.get("id") or f"call-{line_number}")
        turn_id = source_turn_id(payload)
        tool_name = str(payload.get("name") or "unknown")
        namespace = payload.get("namespace")
        arguments = payload.get("input", payload.get("arguments"))
        self.process_semantic_tool_content(
            record, raw, line_number, call_id, tool_name, arguments,
        )
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
        tool_name = str(self.call_metadata.get(call_id, {}).get("tool_name") or "")
        raw_output = payload.get("output", payload.get("result"))
        current_tool = current_codex_tool_name(tool_name)
        decoded_output = decode_current_thread_result(raw_output)
        returned_thread_id = stable_thread_id(decoded_output)
        if current_tool == "create_thread" and returned_thread_id:
            pending = self.pending_thread_prompts.get(call_id)
            if pending:
                role, phase, text = pending
                self.thread_semantic_fingerprints.add((
                    returned_thread_id, role, phase,
                    sha256_bytes(text.encode("utf-8")),
                ))
        if current_tool in {"read_thread", "wait_threads"}:
            fallback_thread_id = (
                returned_thread_id or self.current_thread_call_targets.get(call_id)
            )
            messages = current_thread_result_messages(
                current_tool, raw_output, fallback_thread_id,
            )
            for index, item in enumerate(messages):
                thread_id, role, phase, text = item
                semantic_payload = {
                    **payload,
                    "id": f"{call_id}:{current_tool}:{index}",
                }
                record_type = f"thread_content:{current_tool}"
                self.add_thread_message(
                    record, raw, line_number, semantic_payload, record_type,
                    role, phase, "agent_to_agent", text, thread_id,
                )
        if tool_name == "request_user_input":
            response_value = raw_output
            if isinstance(response_value, str):
                try:
                    response_value = json.loads(response_value)
                except json.JSONDecodeError:
                    response_value = {"answer": response_value}
            answer_parts: list[str] = []
            if isinstance(response_value, dict):
                answers = response_value.get("answers")
                if isinstance(answers, dict):
                    answer_parts.extend(
                        answer for answer in answers.values()
                        if isinstance(answer, str) and answer.strip()
                    )
                for key in ("answer", "response", "selected"):
                    answer = response_value.get(key)
                    if isinstance(answer, str) and answer.strip() and answer not in answer_parts:
                        answer_parts.append(answer)
            if answer_parts:
                answer_text = "\n".join(answer_parts)
                direction = "human_to_agent"
                semantic_value = {"call_id": call_id, "answers": answer_parts}
                self.add_event(
                    timestamp=record.get("timestamp"),
                    event_type="message",
                    actor={"id": "participant-01", "type": "human", "parent_agent_id": None},
                    payload={
                        "role": "user",
                        "phase": "feedback",
                        "interaction_kind": "feedback",
                        "interaction_direction": direction,
                        "text": redact_text(answer_text, self.home),
                        "attachments": [],
                    },
                    source=self.semantic_source(
                        payload,
                        raw,
                        line_number,
                        "human_tool_response",
                        direction,
                        semantic_value,
                    ),
                    turn_id=turn_id,
                    relations=[{
                        "type": "reply_to",
                        "event_id": self.semantic_call_events[call_id],
                    }] if call_id in self.semantic_call_events else [],
                )
        if tool_name == "wait":
            semantic_output = raw_output
            if isinstance(semantic_output, str):
                try:
                    semantic_output = json.loads(semantic_output)
                except json.JSONDecodeError:
                    semantic_output = None
            if (
                isinstance(semantic_output, list)
                and semantic_output
                and all(
                    isinstance(block, dict)
                    and set(block) == {"type", "text"}
                    and block.get("type") == "input_text"
                    and isinstance(block.get("text"), str)
                    for block in semantic_output
                )
            ):
                for block_index, block in enumerate(semantic_output):
                    finding = block.get("text")
                    if not isinstance(finding, str) or not finding.strip():
                        continue
                    semantic_payload = {**payload, "id": f"{call_id}:{block_index}"}
                    semantic_value = {
                        "call_id": call_id,
                        "block_index": block_index,
                        "text": finding,
                    }
                    if not self.should_emit_semantic_record(
                        semantic_payload, "subagent_finding", semantic_value,
                    ):
                        continue
                    self.add_event(
                        timestamp=record.get("timestamp"),
                        event_type="message",
                        actor={
                            "id": "agent-codex-subagent",
                            "type": "ai",
                            "parent_agent_id": "agent-codex-parent",
                        },
                        payload={
                            "role": "assistant",
                            "phase": "coordination",
                            "interaction_direction": "subagent_to_agent",
                            "text": redact_text(finding, self.home),
                            "attachments": [],
                        },
                        source=self.semantic_source(
                            semantic_payload,
                            raw,
                            line_number,
                            "subagent_finding",
                            "subagent_to_agent",
                            semantic_value,
                        ),
                        turn_id=turn_id,
                    )
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
        raw_payload = record["payload"]
        payload = sanitize(raw_payload, self.home)
        payload.pop("type", None)
        semantic_text = next((
            value for value in (
                raw_payload.get("text"), raw_payload.get("message"), raw_payload.get("reason"),
            ) if isinstance(value, str) and value.strip()
        ), "")
        direction = str(raw_payload.get("interaction_direction") or (
            "subagent_internal_progress" if self.origin == "subagent"
            else "agent_internal_progress"
        ))
        projected_payload: dict[str, Any] = {"action": "activity", "details": payload}
        if semantic_text:
            projected_payload.update({
                "interaction_direction": direction,
                "text": redact_text(semantic_text, self.home),
            })
        self.add_event(
            timestamp=record.get("timestamp"),
            event_type="agent",
            actor={"id": "agent-codex-01", "type": "ai", "parent_agent_id": None},
            payload=projected_payload,
            source=(
                self.semantic_source(
                    raw_payload,
                    raw,
                    line_number,
                    "sub_agent_activity",
                    direction,
                    semantic_text,
                )
                if semantic_text else self.source(
                    raw_payload, raw, line_number, "sub_agent_activity",
                )
            ),
            turn_id=source_turn_id(record["payload"]),
        )

    def process(self) -> None:
        previous_mirror: tuple[str, str, str] | None = None
        previous_record_type: str | None = None
        previous_emitted_start: int | None = None
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
                mirror = semantic_mirror_signature(record, self.home)
                skip_adjacent_event_mirror = bool(
                    mirror
                    and mirror == previous_mirror
                    and record_type == "event_msg"
                    and previous_record_type == "response_item"
                )
                if (
                    mirror
                    and mirror == previous_mirror
                    and record_type == "response_item"
                    and previous_record_type == "event_msg"
                    and previous_emitted_start is not None
                    and previous_emitted_start < len(self.events)
                ):
                    removed = len(self.events) - previous_emitted_start
                    del self.events[previous_emitted_start:]
                    self.event_counter -= removed
                    self.duplicate_semantic_replays += 1
                if record_type == "session_meta":
                    self.session_id = str(payload.get("session_id") or payload.get("id") or self.session_id)
                    cwd = payload.get("cwd")
                    self.cwd = str(cwd) if isinstance(cwd, str) else None
                    self.origin = session_origin(payload)
                    self.agent_path = (
                        payload.get("agent_path")
                        if isinstance(payload.get("agent_path"), str) else None
                    )
                    previous_mirror = None
                    previous_record_type = record_type
                    previous_emitted_start = None
                    continue
                before = len(self.events)
                if record_type == "response_item" and payload_type == "message":
                    self.process_message(record, raw, line_number)
                elif record_type == "response_item" and payload_type == "reasoning":
                    self.process_reasoning(record, raw, line_number)
                elif record_type == "response_item" and payload_type == "agent_message":
                    self.process_agent_message(record, raw, line_number)
                elif record_type == "response_item" and payload_type in {"custom_tool_call", "function_call"}:
                    self.process_tool_call(record, raw, line_number)
                elif record_type == "response_item" and payload_type in {"custom_tool_call_output", "function_call_output"}:
                    self.process_tool_result(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "patch_apply_end":
                    self.process_patch_result(record, raw, line_number)
                elif record_type == "event_msg" and payload_type in {"task_started", "task_complete", "turn_aborted", "thread_settings_applied"}:
                    if payload_type == "task_complete":
                        self.process_task_complete_agent_message(record, raw, line_number)
                    self.process_system_event(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "thread_goal_updated":
                    self.process_progress(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "agent_reasoning":
                    if skip_adjacent_event_mirror:
                        self.duplicate_semantic_replays += 1
                    else:
                        self.process_event_reasoning(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "agent_message":
                    if skip_adjacent_event_mirror:
                        self.duplicate_semantic_replays += 1
                    else:
                        self.process_event_agent_message(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "user_message":
                    if skip_adjacent_event_mirror:
                        self.duplicate_semantic_replays += 1
                    else:
                        self.process_event_user_message(record, raw, line_number)
                elif record_type == "event_msg" and payload_type == "sub_agent_activity":
                    self.process_agent_event(record, raw, line_number)
                # Encrypted reasoning bodies, developer/system messages, base
                # instructions, token counts, and world state are intentionally
                # not normalized as contributions.
                previous_mirror = mirror
                previous_record_type = str(record_type)
                previous_emitted_start = before if len(self.events) > before else None

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
            "source_normalization": {
                "duplicate_semantic_replay_count": self.duplicate_semantic_replays,
            },
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
                "encrypted_reasoning_body",
                "duplicate_agent_reasoning_mirror",
                "duplicate_agent_message_mirror",
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
