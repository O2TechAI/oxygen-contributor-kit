"""One unversioned Source Privacy review receipt and its exact validators."""

from __future__ import annotations

import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Any

TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from atomic_rename import rename_noreplace


ALLOWED_CATEGORIES = {
    "credential",
    "private-personal",
    "sensitive",
    "internal-metric",
    "internal-timeline",
    "mosaic-reidentification",
}
REVIEW_STATES = {"deterministic", "needs_confirmation"}
DOCUMENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")
DIGEST = re.compile(r"[0-9a-f]{64}")
MAX_SAFE_INTEGER = 9_007_199_254_740_991

CORPUS_KEYS = {"revision", "digest", "documentCount", "itemCount"}
SOURCE_AUTHORITY_KEYS = {
    "workflowRunId", "sourceRevision", "finalizedCorpus", "sourceDigest",
}
TURN_AUTHORITY_KEYS = {
    "eventId", "itemId", "sequence", "role", "timestamp",
    "textByteLength", "textDigest",
}
BUNDLE_AUTHORITY_KEYS = {
    "documentId", "documentKind", "inputByteLength", "inputDigest", "turns",
}
DIALOGUE_AUTHORITY_KEYS = {"bundleCount", "turnCount", "bundles", "digest"}
REDACTION_AUTHORITY_KEYS = {"count", "digest"}
RECEIPT_CORE_KEYS = {
    "status", "workflowRunId", "sourceRevision", "finalizedCorpus",
    "sourceDigest", "dialogue", "redactions",
}
RECEIPT_KEYS = RECEIPT_CORE_KEYS | {"receiptDigest"}
FINDINGS_REQUIRED_KEYS = {
    "trajectory", "input_digest", "reviewed_item_ids",
    "reviewed_items_digest", "findings", "reviewed_turns",
}
FINDING_KEYS = {
    "event_id", "start", "end", "category", "confidence", "reason",
    "review_state", "uncertainty_reason",
}
TURN_INPUT_KEYS = {
    "event_id", "document_id", "item_id", "sequence", "role", "timestamp", "text",
}
REDACTED_TURN_KEYS = TURN_INPUT_KEYS | {"redactions", "redacted_text"}
REDACTION_KEYS = {
    "start", "end", "category", "confidence", "reason",
    "review_state", "uncertainty_reason",
}


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def canonical_bundle_bytes(value: Any) -> bytes:
    return (canonical_json(value) + "\n").encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_value(value: Any) -> str:
    return digest_bytes(canonical_json(value).encode("utf-8"))


def positive_integer(value: Any) -> bool:
    return (
        isinstance(value, int) and not isinstance(value, bool)
        and 0 < value <= MAX_SAFE_INTEGER
    )


def nonnegative_integer(value: Any) -> bool:
    return (
        isinstance(value, int) and not isinstance(value, bool)
        and 0 <= value <= MAX_SAFE_INTEGER
    )


def assert_literal_physical_path(
    path: Path,
    *,
    allow_missing_leaf: bool = False,
    reject_hardlinked_file: bool = True,
) -> Path:
    """Reject links and Windows reparse points in every literal component."""
    literal = path.expanduser()
    if not literal.is_absolute():
        literal = Path.cwd() / literal
    current = Path(literal.anchor)
    parts = literal.parts[1:] if literal.anchor else literal.parts
    for index, part in enumerate(parts):
        if part in {"", "."}:
            continue
        if part == "..":
            current = current.parent
            continue
        current = current / part
        missing_leaf = allow_missing_leaf and index == len(parts) - 1
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if missing_leaf:
                return Path(os.path.abspath(literal))
            raise ValueError("path component is unavailable") from None
        except OSError as error:
            raise ValueError("path component is unavailable") from error
        attributes = getattr(metadata, "st_file_attributes", None)
        if os.name == "nt" and attributes is None:
            raise ValueError("cannot prove reparse-point safety")
        reparse = bool(attributes is not None and attributes & 0x400)
        if stat.S_ISLNK(metadata.st_mode) or reparse:
            raise ValueError("path component is aliased")
        if index < len(parts) - 1 and not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("path component is not a directory")
        if (reject_hardlinked_file and stat.S_ISREG(metadata.st_mode)
                and metadata.st_nlink != 1):
            raise ValueError("file has hard-link aliases")
    return Path(os.path.abspath(literal))


def validate_source_authority(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SOURCE_AUTHORITY_KEYS:
        raise ValueError("source Privacy authority is invalid")
    corpus = value.get("finalizedCorpus")
    if (
        not isinstance(value.get("workflowRunId"), str)
        or not value["workflowRunId"].strip()
        or not positive_integer(value.get("sourceRevision"))
        or not isinstance(corpus, dict)
        or set(corpus) != CORPUS_KEYS
        or not positive_integer(corpus.get("revision"))
        or not isinstance(corpus.get("digest"), str)
        or DIGEST.fullmatch(corpus["digest"]) is None
        or not nonnegative_integer(corpus.get("documentCount"))
        or not nonnegative_integer(corpus.get("itemCount"))
        or not isinstance(value.get("sourceDigest"), str)
        or DIGEST.fullmatch(value["sourceDigest"]) is None
    ):
        raise ValueError("source Privacy authority is invalid")
    return value


def _turn_authority(turn: Any) -> dict[str, Any]:
    if not isinstance(turn, dict) or set(turn) != TURN_INPUT_KEYS:
        raise ValueError("dialogue turn is invalid")
    event_id = turn.get("event_id")
    item_id = turn.get("item_id")
    sequence = turn.get("sequence")
    role = turn.get("role")
    timestamp = turn.get("timestamp")
    text = turn.get("text")
    if (
        not isinstance(event_id, str) or not event_id
        or not isinstance(item_id, str) or not item_id
        or not positive_integer(sequence)
        or role is not None and not isinstance(role, str)
        or timestamp is not None and not isinstance(timestamp, str)
        or not isinstance(text, str) or not text.strip()
    ):
        raise ValueError("dialogue turn is invalid")
    encoded = text.encode("utf-8")
    return {
        "eventId": event_id,
        "itemId": item_id,
        "sequence": sequence,
        "role": role,
        "timestamp": timestamp,
        "textByteLength": len(encoded),
        "textDigest": digest_bytes(encoded),
    }


def bundle_authority(bundle: Any, raw: bytes) -> dict[str, Any]:
    if not isinstance(bundle, dict) or set(bundle) != {
        "trajectory", "document_kind", "turns", "chars",
    }:
        raise ValueError("dialogue bundle is invalid")
    document_id = bundle.get("trajectory")
    document_kind = bundle.get("document_kind")
    turns = bundle.get("turns")
    if (
        not isinstance(document_id, str)
        or DOCUMENT_ID.fullmatch(document_id) is None
        or not isinstance(document_kind, str)
        or document_kind not in {"trajectory", "meeting"}
        or not isinstance(turns, list) or not turns
        or not nonnegative_integer(bundle.get("chars"))
    ):
        raise ValueError("dialogue bundle is invalid")
    authorities = [_turn_authority(turn) for turn in turns]
    expected_order = sorted(
        authorities,
        key=lambda turn: (turn["sequence"], turn["itemId"].encode("utf-8")),
    )
    if authorities != expected_order:
        raise ValueError("dialogue turn order is invalid")
    if len({turn["eventId"] for turn in authorities}) != len(authorities):
        raise ValueError("dialogue event identity is duplicated")
    if len({turn["itemId"] for turn in authorities}) != len(authorities):
        raise ValueError("dialogue item identity is duplicated")
    if any(turn.get("document_id") != document_id for turn in turns):
        raise ValueError("dialogue turn belongs to a foreign document")
    if any(turn.get("event_id") != turn.get("item_id") for turn in turns):
        raise ValueError("dialogue turn identity is not canonical")
    if bundle["chars"] != sum(len(turn["text"]) for turn in turns):
        raise ValueError("dialogue character count is invalid")
    if canonical_bundle_bytes(bundle) != raw:
        raise ValueError("dialogue bundle bytes are not canonical")
    return {
        "documentId": document_id,
        "documentKind": document_kind,
        "inputByteLength": len(raw),
        "inputDigest": digest_bytes(raw),
        "turns": authorities,
    }


def dialogue_authority(bundle_records: list[tuple[dict[str, Any], bytes]]) -> dict[str, Any]:
    bundles = [bundle_authority(bundle, raw) for bundle, raw in bundle_records]
    bundles.sort(key=lambda bundle: bundle["documentId"].encode("utf-8"))
    document_ids = [bundle["documentId"] for bundle in bundles]
    item_ids = [
        turn["itemId"] for bundle in bundles for turn in bundle["turns"]
    ]
    if len(document_ids) != len(set(document_ids)) or len(item_ids) != len(set(item_ids)):
        raise ValueError("dialogue authority identity is duplicated")
    authority = {
        "bundleCount": len(bundles),
        "turnCount": len(item_ids),
        "bundles": bundles,
    }
    return {**authority, "digest": digest_value(authority["bundles"])}


def read_dialogue(dialogue_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    dialogue_root = assert_literal_physical_path(dialogue_root).resolve(strict=True)
    index_path = dialogue_root / "index.json"
    try:
        index = json.loads(assert_literal_physical_path(index_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("dialogue authority index is missing or invalid") from error
    if not isinstance(index, dict) or set(index) != SOURCE_AUTHORITY_KEYS | {"dialogue"}:
        raise ValueError("dialogue authority index is invalid")
    source = validate_source_authority({key: index[key] for key in SOURCE_AUTHORITY_KEYS})
    declared = index.get("dialogue")
    if not isinstance(declared, dict) or set(declared) != DIALOGUE_AUTHORITY_KEYS:
        raise ValueError("dialogue authority index is invalid")
    declared_bundles = declared.get("bundles")
    if not isinstance(declared_bundles, list) or not declared_bundles:
        raise ValueError("dialogue authority index is invalid")
    document_ids = []
    bundle_records = []
    bundles = []
    for authority in declared_bundles:
        if not isinstance(authority, dict) or set(authority) != BUNDLE_AUTHORITY_KEYS:
            raise ValueError("dialogue bundle authority is invalid")
        document_id = authority.get("documentId")
        if not isinstance(document_id, str) or DOCUMENT_ID.fullmatch(document_id) is None:
            raise ValueError("dialogue bundle authority is invalid")
        path = dialogue_root / f"{document_id}.json"
        try:
            raw = assert_literal_physical_path(path).read_bytes()
            bundle = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("dialogue bundle is missing or invalid") from error
        bundle_records.append((bundle, raw))
        bundles.append(bundle)
        document_ids.append(document_id)
    actual_names = sorted(
        path.name for path in dialogue_root.glob("*.json") if path.name != "index.json"
    )
    if actual_names != sorted(f"{document_id}.json" for document_id in document_ids):
        raise ValueError("dialogue bundle set is incomplete or foreign")
    actual = dialogue_authority(bundle_records)
    if declared != actual:
        raise ValueError("dialogue authority is stale or tampered")
    return {**source, "dialogue": declared}, bundles


def validate_findings(
    findings: list[Any],
    turns_by_id: dict[str, dict[str, Any]],
    document_id: str,
    rejects: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    by_event: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        if (
            not isinstance(finding, dict)
            or not {"event_id", "start", "end", "category", "review_state"} <= set(finding)
            or not set(finding) <= FINDING_KEYS
        ):
            rejects.append({"trajectory": document_id, "reason": "finding shape is invalid"})
            continue
        event_id = finding.get("event_id")
        category = finding.get("category")

        def drop(why: str) -> None:
            rejects.append({
                "trajectory": document_id,
                "event_id": event_id,
                "category": category,
                "reason": why,
            })

        if not isinstance(event_id, str) or not event_id:
            drop("event_id is invalid")
            continue
        turn = turns_by_id.get(event_id)
        if turn is None:
            drop("unknown event_id")
            continue
        if not isinstance(category, str) or category not in ALLOWED_CATEGORIES:
            drop("category not in allowlist")
            continue
        confidence = finding.get("confidence")
        reason = finding.get("reason")
        if confidence is not None and (
            not isinstance(confidence, str)
            or confidence not in {"high", "medium", "low"}
        ):
            drop("confidence is invalid")
            continue
        if reason is not None and not isinstance(reason, str):
            drop("reason is invalid")
            continue
        review_state = finding.get("review_state")
        uncertainty_reason = finding.get("uncertainty_reason")
        if not isinstance(review_state, str) or review_state not in REVIEW_STATES:
            drop("review_state is missing or invalid")
            continue
        if review_state == "needs_confirmation":
            if not isinstance(uncertainty_reason, str) or not uncertainty_reason.strip():
                drop("needs_confirmation requires a nonempty uncertainty_reason")
                continue
        elif uncertainty_reason is not None:
            drop("deterministic requires uncertainty_reason to be omitted or null")
            continue
        start = finding.get("start")
        end = finding.get("end")
        if (
            not isinstance(start, int) or isinstance(start, bool)
            or not isinstance(end, int) or isinstance(end, bool)
        ):
            drop("missing or non-integer offsets")
            continue
        if not 0 <= start < end <= len(turn["text"]):
            drop(f"offsets out of range for text of length {len(turn['text'])}")
            continue
        by_event.setdefault(event_id, []).append({
            "start": start,
            "end": end,
            "category": category,
            "confidence": confidence,
            "reason": reason,
            "review_state": review_state,
            "uncertainty_reason": uncertainty_reason,
        })

    for event_id, spans in by_event.items():
        spans.sort(key=lambda span: (span["start"], -(span["end"] - span["start"])))
        kept = []
        for span in spans:
            if kept and span["start"] < kept[-1]["end"]:
                rejects.append({
                    "trajectory": document_id,
                    "event_id": event_id,
                    "category": span["category"],
                    "reason": "overlaps an earlier span",
                })
                continue
            kept.append(span)
        by_event[event_id] = kept
    return by_event


def apply_spans(text: str, spans: list[dict[str, Any]]) -> str:
    output: list[str] = []
    cursor = 0
    for span in spans:
        output.append(text[cursor:span["start"]])
        output.append(f'<redacted category="{span["category"]}"/>')
        cursor = span["end"]
    output.append(text[cursor:])
    return "".join(output)


def transport_redaction(turn: dict[str, Any], span: dict[str, Any]) -> dict[str, Any]:
    return {
        "itemId": turn["item_id"],
        "documentId": turn["document_id"],
        "startOffset": span["start"],
        "endOffset": span["end"],
        "category": span["category"],
        "confidence": span.get("confidence"),
        "reason": span.get("reason"),
        "reviewState": span["review_state"],
        "uncertaintyReason": span.get("uncertainty_reason"),
        "createdBy": "llm",
    }


def canonical_transport_redactions(
    redactions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return sorted(redactions, key=lambda span: (
        span["documentId"].encode("utf-8"),
        span["itemId"].encode("utf-8"),
        span["startOffset"],
        span["endOffset"],
        span["category"].encode("utf-8"),
    ))


def finalize_review(dialogue_root: Path, findings_root: Path) -> dict[str, Any]:
    source, bundles = read_dialogue(dialogue_root)
    findings_root = assert_literal_physical_path(findings_root).resolve(strict=True)
    declared = {bundle["documentId"]: bundle for bundle in source["dialogue"]["bundles"]}
    expected_names = sorted(f"{document_id}.json" for document_id in declared)
    actual_names = sorted(path.name for path in findings_root.glob("*.json"))
    if actual_names != expected_names:
        raise ValueError("worker findings set is incomplete or foreign")
    rejects: list[dict[str, Any]] = []
    by_document: dict[str, dict[str, list[dict[str, Any]]]] = {}
    redactions = []
    for bundle in bundles:
        document_id = bundle["trajectory"]
        path = findings_root / f"{document_id}.json"
        try:
            worker = json.loads(assert_literal_physical_path(path).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("worker findings are missing or invalid") from error
        if (
            not isinstance(worker, dict)
            or not FINDINGS_REQUIRED_KEYS <= set(worker) <= FINDINGS_REQUIRED_KEYS | {"notes"}
            or worker.get("trajectory") != document_id
            or worker.get("input_digest") != declared[document_id]["inputDigest"]
            or not nonnegative_integer(worker.get("reviewed_turns"))
            or worker["reviewed_turns"] != len(bundle["turns"])
        ):
            raise ValueError("worker review authority is missing, foreign, or stale")
        item_ids = [turn["item_id"] for turn in bundle["turns"]]
        if (
            worker.get("reviewed_item_ids") != item_ids
            or worker.get("reviewed_items_digest") != digest_value(item_ids)
            or not isinstance(worker.get("findings"), list)
        ):
            raise ValueError("worker reviewed item set is incomplete or foreign")
        turns_by_id = {turn["event_id"]: turn for turn in bundle["turns"]}
        by_event = validate_findings(worker["findings"], turns_by_id, document_id, rejects)
        by_document[document_id] = by_event
        for turn in bundle["turns"]:
            redactions.extend(
                transport_redaction(turn, span)
                for span in by_event.get(turn["event_id"], [])
            )
    if rejects:
        raise ValueError("worker findings contain rejected spans")
    redactions = canonical_transport_redactions(redactions)
    core = {
        "status": "complete",
        "workflowRunId": source["workflowRunId"],
        "sourceRevision": source["sourceRevision"],
        "finalizedCorpus": source["finalizedCorpus"],
        "sourceDigest": source["sourceDigest"],
        "dialogue": source["dialogue"],
        "redactions": {"count": len(redactions), "digest": digest_value(redactions)},
    }
    receipt = {**core, "receiptDigest": digest_value(core)}
    return {
        "receipt": receipt,
        "bundles": bundles,
        "byDocument": by_document,
        "redactions": redactions,
    }


def validate_receipt(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != RECEIPT_KEYS:
        raise ValueError("source Privacy receipt is invalid")
    source = validate_source_authority({key: value[key] for key in SOURCE_AUTHORITY_KEYS})
    if value.get("status") != "complete":
        raise ValueError("source Privacy receipt is invalid")
    dialogue = value.get("dialogue")
    redactions = value.get("redactions")
    if (
        not isinstance(dialogue, dict) or set(dialogue) != DIALOGUE_AUTHORITY_KEYS
        or not positive_integer(dialogue.get("bundleCount"))
        or not positive_integer(dialogue.get("turnCount"))
        or not isinstance(dialogue.get("bundles"), list)
        or dialogue["bundleCount"] != len(dialogue["bundles"])
        or not isinstance(dialogue.get("digest"), str)
        or DIGEST.fullmatch(dialogue["digest"]) is None
        or dialogue["digest"] != digest_value(dialogue["bundles"])
        or not isinstance(redactions, dict) or set(redactions) != REDACTION_AUTHORITY_KEYS
        or not nonnegative_integer(redactions.get("count"))
        or not isinstance(redactions.get("digest"), str)
        or DIGEST.fullmatch(redactions["digest"]) is None
        or not isinstance(value.get("receiptDigest"), str)
        or DIGEST.fullmatch(value["receiptDigest"]) is None
    ):
        raise ValueError("source Privacy receipt is invalid")
    actual_turn_count = 0
    for bundle in dialogue["bundles"]:
        if not isinstance(bundle, dict) or set(bundle) != BUNDLE_AUTHORITY_KEYS:
            raise ValueError("source Privacy receipt is invalid")
        if (
            not isinstance(bundle.get("documentKind"), str)
            or bundle["documentKind"] not in {"trajectory", "meeting"}
            or not isinstance(bundle.get("documentId"), str)
            or DOCUMENT_ID.fullmatch(bundle["documentId"]) is None
            or not positive_integer(bundle.get("inputByteLength"))
            or not isinstance(bundle.get("inputDigest"), str)
            or DIGEST.fullmatch(bundle["inputDigest"]) is None
            or not isinstance(bundle.get("turns"), list) or not bundle["turns"]
        ):
            raise ValueError("source Privacy receipt is invalid")
        actual_turn_count += len(bundle["turns"])
        for turn in bundle["turns"]:
            if not isinstance(turn, dict) or set(turn) != TURN_AUTHORITY_KEYS:
                raise ValueError("source Privacy receipt is invalid")
            if (
                not isinstance(turn.get("eventId"), str) or not turn["eventId"]
                or not isinstance(turn.get("itemId"), str) or not turn["itemId"]
                or turn["eventId"] != turn["itemId"]
                or not positive_integer(turn.get("sequence"))
                or turn.get("role") is not None and not isinstance(turn.get("role"), str)
                or turn.get("timestamp") is not None and not isinstance(turn.get("timestamp"), str)
                or not positive_integer(turn.get("textByteLength"))
                or not isinstance(turn.get("textDigest"), str)
                or DIGEST.fullmatch(turn["textDigest"]) is None
            ):
                raise ValueError("source Privacy receipt is invalid")
    if actual_turn_count != dialogue["turnCount"]:
        raise ValueError("source Privacy receipt is invalid")
    document_ids = [bundle["documentId"] for bundle in dialogue["bundles"]]
    item_ids = [
        turn["itemId"] for bundle in dialogue["bundles"] for turn in bundle["turns"]
    ]
    if (
        document_ids != sorted(document_ids, key=lambda item: item.encode("utf-8"))
        or len(document_ids) != len(set(document_ids))
        or len(item_ids) != len(set(item_ids))
        or source["finalizedCorpus"]["documentCount"] < len(document_ids)
        or source["finalizedCorpus"]["itemCount"] < len(item_ids)
    ):
        raise ValueError("source Privacy receipt is invalid")
    for bundle in dialogue["bundles"]:
        turns = bundle["turns"]
        if turns != sorted(
            turns,
            key=lambda turn: (turn["sequence"], turn["itemId"].encode("utf-8")),
        ) or len({turn["eventId"] for turn in turns}) != len(turns):
            raise ValueError("source Privacy receipt is invalid")
    core = {key: value[key] for key in RECEIPT_CORE_KEYS}
    if value["receiptDigest"] != digest_value(core):
        raise ValueError("source Privacy receipt is invalid")
    return value


def read_receipt(path: Path) -> dict[str, Any]:
    try:
        physical = assert_literal_physical_path(path)
        raw = physical.read_bytes()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("source Privacy receipt is missing or invalid") from error
    except ValueError as error:
        raise ValueError("source Privacy receipt is missing or invalid") from error
    validated = validate_receipt(value)
    if raw != canonical_bundle_bytes(validated):
        raise ValueError("source Privacy receipt is missing or invalid")
    return validated


def install_receipt(path: Path, value: dict[str, Any]) -> None:
    validate_receipt(value)
    path = assert_literal_physical_path(path, allow_missing_leaf=True)
    if path.exists() or path.is_symlink():
        if read_receipt(path) != value:
            raise ValueError("immutable source Privacy receipt already differs")
        return
    handle = tempfile.NamedTemporaryFile(
        mode="wb", prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            handle.write(canonical_bundle_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            rename_noreplace(temporary, path)
        except OSError as error:
            if error.errno not in {errno.EEXIST, errno.EACCES}:
                raise
            if read_receipt(path) != value:
                raise ValueError("immutable source Privacy receipt already differs") from None
    finally:
        if temporary.exists():
            temporary.unlink()
