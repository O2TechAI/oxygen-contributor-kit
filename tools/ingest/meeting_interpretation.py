"""Bounded declarative interpretation for unsupported meeting text layouts."""
from __future__ import annotations
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unicodedata
UNSUPPORTED_CODE = "MEETING_TRANSCRIPT_STRUCTURE_UNSUPPORTED"
CORRECTABLE_CODE = "MEETING_INTERPRETATION_PROPOSAL_INVALID"
EXHAUSTED_CODE = "MEETING_INTERPRETATION_EXHAUSTED"
STATE_INVALID_CODE = "MEETING_INTERPRETATION_STATE_INVALID"
DETECTED_FORMAT = "interpreted-layout"
PLAN_KEYS = {"sourceDigest", "recordForm", "prefix", "separator", "suffix",
             "fields", "blankLines"}
STATE_KEYS = {"sourceDigest", "initialProposalRejected", "rejectedCorrections",
              "lastProposalDigest", "lastValidationCode", "status"}
VALIDATION_CODES = {"PLAN_JSON_INVALID", "PLAN_CONTRACT_INVALID",
                    "SOURCE_DIGEST_MISMATCH", "SOURCE_LAYOUT_MISMATCH"}
TOKEN_LIMIT = 64
PROPOSAL_LIMIT = 8192
STATE_LIMIT = 4096
SPEAKER_LIMIT = 128
HEX_RE = re.compile(r"^[0-9a-f]{64}$")
AMPM_RE = re.compile(r"^(0?[1-9]|1[0-2]):([0-5]\d)(?::([0-5]\d))?[ \t]*(AM|PM)$", re.I)
CLOCK_RE = re.compile(r"^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$")
class InterpretationError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
class PlanError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
def _semantic(character: str) -> bool:
    return character.isalnum() or unicodedata.category(character).startswith("M")
def _speakerish(value) -> bool:
    return (isinstance(value, str) and value == value.strip() and bool(value)
            and len(value) <= SPEAKER_LIMIT and any(c.isalpha() for c in value)
            and not any(unicodedata.category(c).startswith("C") for c in value))
def _clockish(value: str) -> bool:
    return bool(AMPM_RE.fullmatch(value) or CLOCK_RE.fullmatch(value))
def _weak_row_state(lines: list[str]) -> str | None:
    for separator in (",", ";", "\t", " - "):
        rows = [line.split(separator) for line in lines]
        shapes = []
        for row in rows:
            found = set()
            if len(row) == 3:
                for clock in range(3):
                    others = [index for index in range(3) if index != clock]
                    for position, speaker in enumerate(others):
                        if (_clockish(row[clock]) and _speakerish(row[speaker])
                                and row[others[1 - position]].strip()):
                            found.add((clock, speaker))
            shapes.append(found)
        common = set.intersection(*shapes) if shapes and all(shapes) else set()
        if common:
            return "unsupported"
        if any(shapes) and all(separator in line for line in lines):
            return "invalid"
    return None
def _skeleton(line: str) -> tuple[str, int, bool]:
    pieces, in_value, count = [], False, 0
    for character in line:
        valueish = _semantic(character) or character in " \t:.'’\u2010\u2011-"
        if valueish and not in_value:
            pieces.append("{}")
            count += 1
        elif not valueish:
            pieces.append(character)
        in_value = valueish
    signature = "".join(piece for piece in pieces if piece != "{}")
    punctuation = any(character not in ",;.!?()" and not character.isspace()
                      for character in signature)
    return signature, count, punctuation
def classify_plain_structure(text: str) -> str:
    """Classify only the layouts left after canonical known-format parsing."""
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 2:
        return "plain"
    if weak := _weak_row_state(lines):
        return weak
    details = [_skeleton(line) for line in lines]
    counts = Counter(signature for signature, segments, marked in details
                     if marked and segments >= 1)
    repeated = {signature for signature, count in counts.items() if count >= 2}
    if not repeated:
        return "plain"
    if len(repeated) != 1:
        return "invalid"
    signature = next(iter(repeated))
    positions = [index for index, detail in enumerate(details) if detail[0] == signature]
    if len(positions) == len(lines):
        segments = next(detail[1] for detail in details if detail[0] == signature)
        return "unsupported" if segments >= 2 else "plain"
    complete = (positions[0] == 0 and positions[-1] < len(lines) - 1
                and all(right - left > 1 for left, right in zip(positions, positions[1:])))
    if not complete:
        return "invalid"
    structured_body = any(detail[0] in repeated for index, detail in enumerate(details)
                          if index not in positions)
    return "invalid" if structured_body else "unsupported"
def _labeled_header(line: str, separator: str):
    parts = line.split(separator)
    labeled = [part.partition(": ") for part in parts]
    if len(parts) != 2 or not all(marker and label and value for label, marker, value in labeled):
        return None
    values = [item[2] for item in labeled]
    clocks = [index for index, value in enumerate(values) if _clockish(value)]
    if len(clocks) != 1 or not _speakerish(values[1 - clocks[0]]):
        return None
    return tuple(item[0] for item in labeled), clocks[0]
def legacy_override_structure(text: str) -> bool:
    lines = [line for line in text.splitlines() if line.strip()]
    for separator in (" | ", " / ", "/", " - "):
        shapes = [_labeled_header(line, separator) for line in lines]
        for shape, count in Counter(item for item in shapes if item is not None).items():
            positions = [index for index, item in enumerate(shapes) if item == shape]
            complete = (count >= 2 and positions[0] == 0 and positions[-1] < len(lines) - 1
                    and all(right - left > 1 for left, right in zip(positions, positions[1:])))
            if complete:
                return True
    return False
def _canonical_plan(plan: dict) -> bytes:
    return json.dumps(plan, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")
def _valid_token(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return (len(value.encode("utf-8")) <= TOKEN_LIMIT
                and not any(unicodedata.category(c).startswith("C") and c != "\t" for c in value))
    except UnicodeEncodeError:
        return False
def _unique_object(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError
    return value
def _strict_json(raw: bytes):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
def _load_plan(raw: bytes, source_digest: str) -> tuple[dict, str]:
    if len(raw) > PROPOSAL_LIMIT:
        raise PlanError("PLAN_CONTRACT_INVALID")
    try:
        plan = _strict_json(raw)
    except (UnicodeDecodeError, ValueError):
        raise PlanError("PLAN_JSON_INVALID")
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS:
        raise PlanError("PLAN_CONTRACT_INVALID")
    if plan["sourceDigest"] != source_digest:
        raise PlanError("SOURCE_DIGEST_MISMATCH")
    if plan["recordForm"] not in {"header_body", "row"}:
        raise PlanError("PLAN_CONTRACT_INVALID")
    if plan["blankLines"] not in {"body", "record_separator"}:
        raise PlanError("PLAN_CONTRACT_INVALID")
    if (not all(_valid_token(plan[key]) for key in ("prefix", "separator", "suffix"))
            or any("\t" in plan[key] for key in ("prefix", "suffix"))):
        raise PlanError("PLAN_CONTRACT_INVALID")
    fields = plan["fields"]
    allowed_headers = (["speaker"], ["speaker", "timestamp"], ["timestamp", "speaker"])
    if plan["recordForm"] == "header_body":
        valid_fields = fields in allowed_headers
    else:
        valid_fields = (isinstance(fields, list) and len(fields) in {2, 3}
                        and set(fields) == ({"speaker", "body"}
                                            | ({"timestamp"} if len(fields) == 3 else set())))
    if not valid_fields or (len(fields) > 1 and not plan["separator"]):
        raise PlanError("PLAN_CONTRACT_INVALID")
    if plan["recordForm"] == "row" and plan["blankLines"] != "record_separator":
        raise PlanError("PLAN_CONTRACT_INVALID")
    if not (any(plan[key].strip() for key in ("prefix", "separator", "suffix")) or plan["separator"] == "\t"):
        raise PlanError("PLAN_CONTRACT_INVALID")
    return plan, hashlib.sha256(_canonical_plan(plan)).hexdigest()
def _line_value(line: str, plan: dict) -> dict | None:
    prefix, suffix = plan["prefix"], plan["suffix"]
    if not line.startswith(prefix) or (suffix and not line.endswith(suffix)):
        return None
    stop = len(line) - len(suffix) if suffix else len(line)
    if stop < len(prefix):
        return None
    middle = line[len(prefix):stop]
    fields = plan["fields"]
    values = middle.split(plan["separator"]) if len(fields) > 1 else [middle]
    if len(values) != len(fields):
        return None
    return dict(zip(fields, values))
def _timestamp_order(value: str) -> int:
    match = AMPM_RE.fullmatch(value)
    if match:
        hour, minute, second, period = match.groups()
        hour = int(hour) % 12 + (12 if period.upper() == "PM" else 0)
        return hour * 3600 + int(minute) * 60 + int(second or 0)
    match = CLOCK_RE.fullmatch(value)
    if not match:
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    hour, minute, second = match.groups()
    return int(hour) * 3600 + int(minute) * 60 + int(second or 0)
def _validate_record(values: dict, source_line: int) -> dict:
    speaker = values.get("speaker")
    body = values.get("body")
    timestamp = values.get("timestamp") or None
    if not _speakerish(speaker):
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    if (not isinstance(body, str) or not body or not body.strip()
            or any(unicodedata.category(c) == "Cc" and c not in "\r\n\t" for c in body)):
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    if timestamp is not None and timestamp != timestamp.strip():
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    order = _timestamp_order(timestamp) if timestamp else None
    return {"timestamp": timestamp, "speaker": speaker, "text": body,
            "source_line": source_line, "_clock": order}
def _without_terminal_eol(lines: list[str]) -> str:
    value = "".join(lines)
    return value[:-2] if value.endswith("\r\n") else value[:-1] if value.endswith(("\r", "\n")) else value
def apply_plan(source: bytes, plan: dict) -> list[dict]:
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError:
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    physical = text.splitlines(keepends=True)
    if not physical or "".join(physical) != text:
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    records = []
    if plan["recordForm"] == "row":
        seen, pending_blank = False, False
        for number, physical_line in enumerate(physical, 1):
            line = physical_line.rstrip("\r\n")
            if not line:
                if not seen or pending_blank:
                    raise PlanError("SOURCE_LAYOUT_MISMATCH")
                pending_blank = True
                continue
            values = _line_value(line, plan)
            if values is None:
                raise PlanError("SOURCE_LAYOUT_MISMATCH")
            records.append(_validate_record(values, number))
            seen, pending_blank = True, False
        if pending_blank:
            raise PlanError("SOURCE_LAYOUT_MISMATCH")
    else:
        headers = [(number, _line_value(line.rstrip("\r\n"), plan))
                   for number, line in enumerate(physical, 1)]
        indices = [index for index, (_, values) in enumerate(headers) if values is not None]
        if not indices or indices[0] != 0:
            raise PlanError("SOURCE_LAYOUT_MISMATCH")
        for position, start in enumerate(indices):
            stop = indices[position + 1] if position + 1 < len(indices) else len(physical)
            body_lines = physical[start + 1:stop]
            if plan["blankLines"] == "record_separator":
                while body_lines and not body_lines[-1].rstrip("\r\n"):
                    body_lines.pop()
                if any(not line.rstrip("\r\n") for line in body_lines):
                    raise PlanError("SOURCE_LAYOUT_MISMATCH")
            values = dict(headers[start][1])
            values["body"] = _without_terminal_eol(body_lines)
            records.append(_validate_record(values, headers[start][0]))
    if len(records) < 2:
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    clocks = [record["_clock"] for record in records if record["_clock"] is not None]
    if any(left > right for left, right in zip(clocks, clocks[1:])):
        raise PlanError("SOURCE_LAYOUT_MISMATCH")
    for order, record in enumerate(records, 1):
        record.pop("_clock")
        record.update(record_id=f"rec-{order:05d}", order=order)
    return records
def _state_valid(state, digest: str) -> bool:
    if not isinstance(state, dict) or set(state) != STATE_KEYS or state["sourceDigest"] != digest:
        return False
    initial, corrections = state["initialProposalRejected"], state["rejectedCorrections"]
    if type(initial) is not bool or type(corrections) is not int or corrections not in range(3):
        return False
    status, last, code = state["status"], state["lastProposalDigest"], state["lastValidationCode"]
    if status == "awaiting_initial":
        return not initial and corrections == 0 and last is None and code is None
    if status not in {"correctable", "exhausted"} or not initial or not isinstance(last, str):
        return False
    return (bool(HEX_RE.fullmatch(last)) and code in VALIDATION_CODES
            and ((status == "correctable" and corrections < 2)
                 or (status == "exhausted" and corrections == 2)))
def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
def _save_state(path: Path, state: dict) -> None:
    try:
        _atomic_json(path, state)
    except OSError:
        raise InterpretationError(STATE_INVALID_CODE)
def _read_state(path: Path):
    try:
        if path.stat().st_size > STATE_LIMIT:
            raise InterpretationError(STATE_INVALID_CODE)
        return _strict_json(path.read_bytes())
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError, ValueError):
        raise InterpretationError(STATE_INVALID_CODE)
def _read_proposal(path: Path) -> tuple[bytes | None, str]:
    try:
        oversized = path.stat().st_size > PROPOSAL_LIMIT
        if oversized:
            with path.open("rb") as handle:
                return None, hashlib.file_digest(handle, "sha256").hexdigest()
        raw = path.read_bytes()
        return raw, hashlib.sha256(raw).hexdigest()
    except FileNotFoundError:
        raise InterpretationError(UNSUPPORTED_CODE)
    except OSError:
        raise InterpretationError(STATE_INVALID_CODE)
def interpret_or_prepare(source: bytes, out_root: Path) -> tuple[list[dict], str, Path]:
    digest = hashlib.sha256(source).hexdigest()
    preparation = out_root / ".meeting-interpretation" / digest
    state_path, proposal_path = preparation / "state.json", preparation / "proposal.json"
    state = _read_state(state_path)
    if state is not None:
        if not _state_valid(state, digest):
            raise InterpretationError(STATE_INVALID_CODE)
    else:
        state = {"sourceDigest": digest, "initialProposalRejected": False,
                 "rejectedCorrections": 0, "lastProposalDigest": None,
                 "lastValidationCode": None, "status": "awaiting_initial"}
        _save_state(state_path, state)
    if state["status"] == "exhausted":
        raise InterpretationError(EXHAUSTED_CODE)
    proposal_raw, proposal_digest = _read_proposal(proposal_path)
    if proposal_digest == state["lastProposalDigest"]:
        raise InterpretationError(CORRECTABLE_CODE)
    try:
        if proposal_raw is None:
            raise PlanError("PLAN_CONTRACT_INVALID")
        plan, plan_digest = _load_plan(proposal_raw, digest)
        records = apply_plan(source, plan)
    except PlanError as error:
        if not state["initialProposalRejected"]:
            state["initialProposalRejected"] = True
        else:
            state["rejectedCorrections"] += 1
        state.update(lastProposalDigest=proposal_digest, lastValidationCode=error.code,
                     status=("exhausted" if state["rejectedCorrections"] == 2 else "correctable"))
        _save_state(state_path, state)
        raise InterpretationError(EXHAUSTED_CODE if state["status"] == "exhausted"
                                  else CORRECTABLE_CODE)
    return records, plan_digest, preparation
def finish_success(preparation: Path) -> None:
    shutil.rmtree(preparation)
