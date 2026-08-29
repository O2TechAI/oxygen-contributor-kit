import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
VENDOR = Path(__file__).resolve().parents[3] / "tools" / "ingest" / "vendor"
sys.path.insert(0, str(VENDOR))
import build_project_map as builder
import extract_codex_trajectory as extractor
import finalize_semantic_units as finalizer
import prepare_semantic_units as preparer

SENSITIVE_KEY_SPELLINGS = (
    "api key", "api_key", "api-key", "apikey",
    "access token", "access_token", "access-token", "accesstoken",
    "token", "password", "passwd", "secret", "authorization",
)
ASSIGNMENT_SEPARATORS = ("=", " = ", "\t=\t", ":", " : ", "\t:\t")
QUOTED_MATRIX_KEYS = ("password", "token", "secret", "authorization")
QUOTES = ('"', "'")
SHORT_PREFIXES = tuple("p" * length for length in range(8))
INTERNAL_SEPARATORS = (" ", "\t", ",", ";")
SECRET_TAILS = (
    "SYNTHETIC_ALPHA_TAIL_7F31",
    "SYNTHETIC_BETA_TAIL_8E42",
    "SYNTHETIC_GAMMA_TAIL_9D53",
)


def generated_quoted_assignments():
    for key in QUOTED_MATRIX_KEYS:
        for quote in QUOTES:
            for prefix in SHORT_PREFIXES:
                for internal_separator in INTERNAL_SEPARATORS:
                    for tail in SECRET_TAILS:
                        value = f"{prefix}{internal_separator}{tail}"
                        yield f"{key}={quote}{value}{quote}, preserve"
                        yield f"{key}={quote}{value}\npreserve"


def generated_key_separator_quoted_assignments():
    sentinel = "CROSS_FAMILY_QUOTED_SENTINEL_6C20"
    for key in SENSITIVE_KEY_SPELLINGS:
        for assignment_separator in ASSIGNMENT_SEPARATORS:
            for quote in QUOTES:
                for prefix in SHORT_PREFIXES:
                    value = f"{prefix}\t{sentinel}"
                    yield f"{key}{assignment_separator}{quote}{value}{quote}; preserve"
                    yield f"{key}{assignment_separator}{quote}{value}\r\npreserve"


def event_id(label: str) -> str:
    return f"evt-{hashlib.sha256(label.encode('utf-8')).hexdigest()}"


def write_trajectory(run: Path, trajectory_id: str, texts: list[str]) -> list[str]:
    directory = run / "trajectories" / trajectory_id
    directory.mkdir(parents=True)
    events = [{
        "schema": builder.TRAJECTORY_EVENT_SCHEMA,
        "event_id": event_id(f"{trajectory_id}-{index}"),
        "event_type": "message",
        "sequence": index,
        "actor": {"type": "human", "id": "private-actor-not-forwarded"},
        "source": {"system": "provider-not-forwarded", "record_type": "message"},
        "payload": {
            "text": text,
            "path": "C:/private/not-forwarded",
            "provider": "not-forwarded",
        },
    } for index, text in enumerate(texts, 1)]
    serialized = "".join(builder.canonical_json(event) + "\n" for event in events)
    (directory / "events.jsonl").write_text(serialized, encoding="utf-8")
    (directory / "manifest.json").write_text(json.dumps({
        "schema": builder.TRAJECTORY_SCHEMA,
        "trajectory_id": trajectory_id,
        "event_count": len(events),
        "contribution_projection": {
            "policy_id": builder.POLICY_ID,
            "raw_source_digest": "a" * 64,
            "projected_universe_digest": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
            "raw_event_count": len(events) + 1,
            "normalized_event_count": len(events) + 1,
            "kept_event_count": len(events),
            "dropped_event_count": 1,
            "cross_trajectory_semantic_replay_count": 0,
        },
    }), encoding="utf-8")
    index_path = run / "index.json"
    index = (
        json.loads(index_path.read_text(encoding="utf-8"))
        if index_path.exists()
        else {
            "schema": builder.INGEST_RUN_SCHEMA,
            "tool": "collect_repo_trajectories",
            "collection_status": "complete",
            "trajectory_count": 0,
            "trajectory_failures": 0,
            "trajectories": [],
        }
    )
    index["trajectories"].append({"trajectory_id": trajectory_id, "ok": True})
    index["trajectory_count"] = len(index["trajectories"])
    index_path.write_text(json.dumps(index), encoding="utf-8")
    return [event["event_id"] for event in events]


def update_trajectory_text(run: Path, trajectory_id: str, index: int, text: str) -> None:
    directory = run / "trajectories" / trajectory_id
    events = [json.loads(line) for line in (directory / "events.jsonl").read_text(
        encoding="utf-8",
    ).splitlines()]
    events[index]["payload"]["text"] = text
    serialized = "".join(builder.canonical_json(event) + "\n" for event in events)
    (directory / "events.jsonl").write_text(serialized, encoding="utf-8")
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["contribution_projection"]["projected_universe_digest"] = hashlib.sha256(
        serialized.encode("utf-8"),
    ).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


def write_meeting(run: Path, meeting_id: str, texts: list[str]) -> list[str]:
    directory = run / "meetings" / meeting_id
    directory.mkdir(parents=True)
    records = [{"record_id": f"record-{index}", "text": text} for index, text in enumerate(texts, 1)]
    (directory / "meeting.json").write_text(json.dumps({
        "schema": builder.MEETING_SCHEMA,
        "meeting_id": meeting_id, "records": records,
    }), encoding="utf-8")
    return [f"{meeting_id}:record-{index}" for index in range(1, len(texts) + 1)]


def run_builder(run: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([
        sys.executable, str(SCRIPTS / "build_project_map.py"), str(run),
        "--primary-project", "Synthetic Project", "--summary", "Safe summary.",
    ], capture_output=True, text=True, encoding="utf-8", check=False)


def directory_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        pass
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        if result.returncode == 0:
            return
    test_case.skipTest("directory link creation is unavailable")


def prepare(run: Path, output: Path, maximum: int = 4096) -> dict:
    value = preparer.build_preparation(run, maximum)
    preparer.install_preparation(output, value)
    return value


def write_worker_results(output: Path, unit_for_id) -> None:
    manifest = json.loads((output / "shards.json").read_text(encoding="utf-8"))
    for shard in manifest["shards"]:
        grouped = {}
        for contribution_id in shard["contributionIds"]:
            unit = unit_for_id(contribution_id)
            grouped.setdefault(unit, []).append(contribution_id)
        proposals = [{
            "unitId": unit_id,
            "kind": "discussion",
            "contributionIds": sorted(members, key=lambda value: value.encode("utf-8")),
            "storyProjection": {
                "label": f"Label {unit_id}",
                "summary": f"Safe semantic summary for {unit_id}.",
            },
        } for unit_id, members in sorted(grouped.items(), key=lambda item: item[0].encode("utf-8"))]
        worker_output = {
            "shardId": shard["id"],
            "inputDigest": shard["inputDigest"],
            "proposals": proposals,
        }
        output_path = output / "outputs" / f"{shard['id']}.json"
        output_path.write_text(json.dumps(worker_output, ensure_ascii=False), encoding="utf-8")
        receipt = {
            "status": "complete",
            "shardId": shard["id"],
            "inputDigest": shard["inputDigest"],
            "contributionIds": shard["contributionIds"],
            "outputPath": f"outputs/{shard['id']}.json",
            "outputDigest": builder.digest(worker_output),
            "outputCount": len(proposals),
        }
        (output / "receipts" / f"{shard['id']}.json").write_text(
            json.dumps(receipt), encoding="utf-8",
        )


class SemanticUnitTransportTests(unittest.TestCase):
    def test_project_map_envelope_is_producer_owned(self):
        with mock.patch.object(builder, "source_inventory", return_value=([], [], {})):
            project_map = builder.canonical_project_map(
                Path("unused"), "Synthetic Project",
                "s" * builder.MAX_PROJECT_MAP_SUMMARY_BYTES,
                [], finalize=False,
            )
            self.assertLessEqual(
                len(builder.transport_json_bytes(project_map)),
                builder.MAX_PROJECT_MAP_BYTES,
            )
            with self.assertRaisesRegex(ValueError, "project summary"):
                builder.canonical_project_map(
                    Path("unused"), "Synthetic Project",
                    "s" * (builder.MAX_PROJECT_MAP_SUMMARY_BYTES + 1),
                    [], finalize=False,
                )
            with self.assertRaisesRegex(ValueError, "transport-byte"):
                builder.canonical_project_map(
                    Path("unused"), "Synthetic Project", "Safe summary.",
                    [{"padding": "x" * builder.MAX_PROJECT_MAP_BYTES}],
                    finalize=False,
                )

    def test_python_project_map_and_node_coverage_finalizer_agree(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            ids = write_trajectory(run, "traj-cross-runtime", ["one", "two", "three", "four"])
            ordered = sorted(ids, key=lambda value: value.encode("utf-8"))
            raw_units = [
                {"id": "unit-a", "kind": "discussion", "members": ordered[:2]},
                {"id": "unit-b", "kind": "routine", "members": ordered[2:]},
            ]
            first = builder.canonical_project_map(
                run, "Synthetic Project", "Safe cross-runtime summary.", raw_units,
            )
            second = builder.canonical_project_map(
                run, "Synthetic Project", "Safe cross-runtime summary.", raw_units,
            )
            first_bytes = builder.transport_json_bytes(first)
            self.assertEqual(first_bytes, builder.transport_json_bytes(second))
            self.assertLessEqual(len(first_bytes), builder.MAX_PROJECT_MAP_BYTES)
            project_map_path = run / "project-map.json"
            builder.atomic_write_json(project_map_path, first)
            first_written = project_map_path.read_bytes()
            builder.atomic_write_json(project_map_path, second)
            self.assertEqual(project_map_path.read_bytes(), first_written)

            manifest_path = root / "semantic-manifest.json"
            draft_path = root / "coverage-draft.json"
            privacy_path = root / "source-privacy.json"
            wrapped_output = root / "wrapped-coverage.json"
            bare_output = root / "bare-coverage.json"
            builder.atomic_write_json(manifest_path, first["semantic_manifest"])
            builder.atomic_write_json(draft_path, {"rows": [
                {"unitId": "unit-a", "disposition": "represented", "ownerId": "chapter-a"},
                {"unitId": "unit-b", "disposition": "excluded",
                 "exclusionReason": "routine_non_narrative"},
            ]})
            builder.atomic_write_json(privacy_path, {
                "redactions": [],
                "job": {
                    "id": "source-privacy-current", "status": "complete", "stage": "complete",
                    "model": None, "completed": 0, "total": 0, "rejected": 0,
                    "source_digest": "9" * 64,
                    "started_at": "2042-01-01T00:00:00.000Z",
                    "updated_at": "2042-01-01T00:00:00.000Z",
                    "completed_at": "2042-01-01T00:00:00.000Z",
                },
            })
            repository = Path(__file__).resolve().parents[3]
            script = repository / "skills" / "oxygen-storytelling-review" / "scripts" / (
                "finalize_story_coverage.mjs"
            )

            def finalize(source: Path, output: Path) -> subprocess.CompletedProcess[str]:
                return subprocess.run([
                    node, str(script), str(source), str(draft_path), str(output),
                    "--source-privacy", str(privacy_path),
                ], cwd=repository, capture_output=True, text=True, encoding="utf-8", check=False)

            wrapped = finalize(project_map_path, wrapped_output)
            bare = finalize(manifest_path, bare_output)
            self.assertEqual(wrapped.returncode, 0, wrapped.stderr)
            self.assertEqual(bare.returncode, 0, bare.stderr)
            self.assertEqual(wrapped_output.read_bytes(), bare_output.read_bytes())

    def test_invalid_kind_can_be_explicitly_corrected_only_before_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            contribution_id = write_trajectory(run, "traj", ["one"])[0]
            self.assertEqual(run_builder(run).returncode, 0)
            semantic = root / "semantic"
            prepared = prepare(run, semantic)
            shard = prepared["manifest"]["shards"][0]
            shard_id = shard["id"]
            shard_input = semantic / shard["inputPath"]
            input_before = shard_input.read_bytes()
            proposal_path = semantic / "handoffs" / f"{shard_id}.proposals.json"
            invalid_kind = "Direction Change RAW_KIND_SENTINEL"
            proposal_path.write_text(json.dumps([{
                "unitId": "unit-direction",
                "kind": invalid_kind,
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            command = [
                sys.executable, str(SCRIPTS / "record_semantic_worker.py"),
                str(semantic), shard_id, str(proposal_path),
            ]
            rejected = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stderr.strip(), builder.SEMANTIC_WORKER_KIND_INVALID)
            self.assertNotIn(invalid_kind, rejected.stderr)
            self.assertNotIn("RAW_KIND_SENTINEL", rejected.stderr)
            self.assertNotIn("Traceback", rejected.stderr)
            output_path = semantic / "outputs" / f"{shard_id}.json"
            receipt_path = semantic / "receipts" / f"{shard_id}.json"
            self.assertFalse(output_path.exists())
            self.assertFalse(receipt_path.exists())
            self.assertEqual(shard_input.read_bytes(), input_before)

            proposal_path.write_text(json.dumps([{
                "unitId": "unit-direction",
                "kind": "direction_change",
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            accepted = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(len(list((semantic / "outputs").glob("*.json"))), 1)
            self.assertEqual(len(list((semantic / "receipts").glob("*.json"))), 1)
            output_before = output_path.read_bytes()
            receipt_before = receipt_path.read_bytes()
            finalized = finalizer.finalize(run, semantic)
            self.assertEqual(finalized["semantic_manifest"]["units"][0]["kind"],
                             "direction_change")
            self.assertEqual(finalized["semantic_manifest"]["units"][0]["memberCount"], 1)

            proposal_path.write_text(json.dumps([{
                "unitId": "unit-direction",
                "kind": "root_cause",
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            immutable = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertNotEqual(immutable.returncode, 0)
            self.assertIn("immutable semantic worker artifact already differs", immutable.stderr)
            self.assertEqual(output_path.read_bytes(), output_before)
            self.assertEqual(receipt_path.read_bytes(), receipt_before)
            self.assertEqual(shard_input.read_bytes(), input_before)

    def test_cross_shard_matching_unit_ids_require_identical_open_kind_metadata(self):
        proposals = [
            {"id": "unit-shared", "kind": "laboratory_observation", "members": ["item-a"]},
            {"id": "unit-shared", "kind": "supply_chain_exception", "members": ["item-b"]},
        ]
        with self.assertRaisesRegex(ValueError, "disagree on semantic authority"):
            finalizer.compose(proposals, ["item-a", "item-b"])

    def test_current_ingest_sanitizer_closes_every_worker_secret_rule(self):
        unsafe = (
            list(generated_quoted_assignments())
            + list(generated_key_separator_quoted_assignments())
            + [
            "-----BEGIN SYNTHETIC PRIVATE KEY-----",
            "api_key=synthetic-sentinel",
            "access token : synthetic-sentinel",
            "TOKEN=synthetic-sentinel",
            "Password = \"synthetic-sentinel\"",
            "passwd=synthetic-sentinel",
            "secret=synthetic-sentinel",
            "Authorization=synthetic-sentinel",
            "sk-syntheticvalue",
            "ghp-syntheticvalue",
            "xoxb-syntheticvalue",
            "AKIAABCDEFGHIJKLMNOP",
            "https://synthetic-user:synthetic-password@example.invalid/path",
            'password="synthetic-sentinel secondword"',
            "password='synthetic-sentinel secondword'",
            'password="synthetic-sentinel, secondword; tail"',
            'password="synthetic-sentinel \\"quoted\\" tail"',
            'password="synthetic-sentinel secondword',
            "password='synthetic-sentinel secondword",
            "token=<redacted>",
            "token=[redacted]",
            "token=<REDACTED>-stillsecret",
            "token=[redacted]-stillsecret",
            'token="<REDACTED>-stillsecret"',
            'token="<REDACTED>" MARKER_SUFFIX_SENTINEL',
            "token=<REDACTED> MARKER_SUFFIX_SENTINEL",
            "authorization: Bearer UNQUOTED_BEARER_SENTINEL",
            "authorization=Basic UNQUOTED_BASIC_SENTINEL credential",
            "Authorization: Token UNQUOTED_TOKEN_SENTINEL",
            "access token: prefix UNQUOTED_ARBITRARY_SENTINEL tail",
            "password=a",
            "前文 token=synthetic-sentinel; password='secondword secret' 后文",
            ]
        )
        self.assertEqual(len(list(generated_quoted_assignments())), 1536)
        self.assertEqual(len(list(generated_key_separator_quoted_assignments())), 2496)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertTrue(all(preparer.secret_like_text(value) for value in unsafe))
            run = root / "run"
            sanitized = [extractor.redact_text(value, root) for value in unsafe]
            self.assertTrue(all(not preparer.secret_like_text(value) for value in sanitized))
            self.assertEqual(
                [extractor.redact_text(value, root) for value in sanitized],
                sanitized,
            )
            ids = write_trajectory(run, "traj-sanitized", sanitized)
            self.assertEqual(run_builder(run).returncode, 0)
            prepared = preparer.build_preparation(run, 4096)
            records = prepared["context"]["contributions"]
            shard_records = [
                record for shard in prepared["inputs"] for record in shard["contributions"]
            ]
            self.assertEqual(
                [record["id"] for record in records],
                sorted(ids, key=lambda value: value.encode("utf-8")),
            )
            self.assertEqual(
                sorted(record["id"] for record in shard_records),
                sorted(ids),
            )
            self.assertTrue(all(not preparer.secret_like_text(record["content"]) for record in records))
            serialized = builder.canonical_json({
                "context": prepared["context"], "inputs": prepared["inputs"],
            })
            for residual in (
                "synthetic-sentinel", "syntheticvalue", "synthetic-user",
                "synthetic-password", "secondword", "stillsecret", "quoted",
                "[redacted]", "<redacted>", "MARKER_SUFFIX_SENTINEL",
                "UNQUOTED_BEARER_SENTINEL", "UNQUOTED_BASIC_SENTINEL",
                "UNQUOTED_TOKEN_SENTINEL", "UNQUOTED_ARBITRARY_SENTINEL",
                "CROSS_FAMILY_QUOTED_SENTINEL_6C20",
                *SECRET_TAILS,
            ):
                self.assertNotIn(residual, serialized)
            self.assertTrue(all(
                not preparer.secret_like_text(record["content"])
                for shard in prepared["inputs"] for record in shard["contributions"]
            ))

    def test_one_multi_and_mixed_current_runs_finalize_without_project_map_editing(self):
        cases = ((["one"], []), (["one", "two", "three"], []), (["one", "two"], ["meeting"]))
        for trajectory_texts, meeting_texts in cases:
            with self.subTest(trajectory=len(trajectory_texts), meeting=len(meeting_texts)):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    run = root / "run"
                    write_trajectory(run, "traj-current", trajectory_texts)
                    if meeting_texts:
                        write_meeting(run, "meeting-current", meeting_texts)
                    result = run_builder(run)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    output = root / "semantic"
                    prepared = prepare(run, output)
                    context_text = (output / "semantic-context.json").read_text(encoding="utf-8")
                    self.assertNotIn("provider-not-forwarded", context_text)
                    self.assertNotIn("private/not-forwarded", context_text)
                    self.assertNotIn("private-actor-not-forwarded", context_text)
                    self.assertEqual(
                        sorted(
                            record["id"] for shard in prepared["inputs"]
                            for record in shard["contributions"]
                        ),
                        sorted(prepared["manifest"]["contributionIds"]),
                    )
                    write_worker_results(output, lambda _: "unit-composed")
                    finalized = finalizer.finalize(run, output)
                    self.assertIsNotNone(finalized["semantic_manifest"])
                    self.assertEqual(finalized["semantic_manifest"]["units"][0]["memberCount"],
                                     len(trajectory_texts) + len(meeting_texts))

    def test_cross_shard_composition_and_unicode_are_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            ids = write_trajectory(run, "traj-unicode", ["😀" * 350, "é" * 700, "二" * 500])
            self.assertEqual(run_builder(run).returncode, 0)
            output = root / "semantic"
            prepared = prepare(run, output, 4096)
            self.assertGreaterEqual(len(prepared["inputs"]), 2)
            write_worker_results(output, lambda _: "unit-跨分片")
            first = finalizer.finalize(run, output)
            first_bytes = (run / "project-map.json").read_bytes()
            second = finalizer.finalize(run, output)
            self.assertEqual((run / "project-map.json").read_bytes(), first_bytes)
            self.assertEqual(first["semantic_manifest"], second["semantic_manifest"])
            self.assertEqual(first["semantic_manifest"]["units"][0]["members"],
                             sorted(ids, key=lambda value: value.encode("utf-8")))

    def test_bad_receipts_and_outputs_fail_without_changing_the_skeleton(self):
        mutations = {
            "missing": lambda root, shard, receipt, output: receipt.unlink(),
            "foreign": lambda root, shard, receipt, output: self._foreign(output),
            "stale": lambda root, shard, receipt, output: self._field(receipt, "inputDigest", "0" * 64),
            "tampered": lambda root, shard, receipt, output: self._field(output, "inputDigest", "0" * 64),
            "overlap": lambda root, shard, receipt, output: self._overlap(output),
            "completed-zero": lambda root, shard, receipt, output: self._zero(receipt, output),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    run = root / "run"
                    write_trajectory(run, "traj", ["one", "two", "three"])
                    self.assertEqual(run_builder(run).returncode, 0)
                    semantic = root / "semantic"
                    prepare(run, semantic)
                    write_worker_results(semantic, lambda _: "unit-all")
                    shard = json.loads((semantic / "shards.json").read_text(encoding="utf-8"))["shards"][0]
                    receipt = semantic / "receipts" / f"{shard['id']}.json"
                    output = semantic / "outputs" / f"{shard['id']}.json"
                    before = (run / "project-map.json").read_bytes()
                    mutate(semantic, shard, receipt, output)
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        finalizer.finalize(run, semantic)
                    self.assertEqual((run / "project-map.json").read_bytes(), before)

    @staticmethod
    def _field(path: Path, key: str, value) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        data[key] = value
        path.write_text(json.dumps(data), encoding="utf-8")

    def _foreign(self, output: Path) -> None:
        data = json.loads(output.read_text(encoding="utf-8"))
        data["proposals"][0]["contributionIds"][0] = "foreign-record"
        output.write_text(json.dumps(data), encoding="utf-8")

    def _overlap(self, output: Path) -> None:
        data = json.loads(output.read_text(encoding="utf-8"))
        duplicate = dict(data["proposals"][0])
        duplicate["unitId"] = "unit-overlap"
        data["proposals"].append(duplicate)
        output.write_text(json.dumps(data), encoding="utf-8")

    def _zero(self, receipt: Path, output: Path) -> None:
        data = json.loads(output.read_text(encoding="utf-8"))
        data["proposals"] = []
        output.write_text(json.dumps(data), encoding="utf-8")
        receipt_data = json.loads(receipt.read_text(encoding="utf-8"))
        receipt_data["outputDigest"] = builder.digest(data)
        receipt_data["outputCount"] = 0
        receipt.write_text(json.dumps(receipt_data), encoding="utf-8")

    def test_source_update_advances_only_affected_unit_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            first_ids = write_trajectory(run, "first", ["one", "two"])
            second_ids = write_trajectory(run, "second", ["three"])
            self.assertEqual(run_builder(run).returncode, 0)
            semantic1 = root / "semantic-1"
            prepare(run, semantic1)
            write_worker_results(
                semantic1,
                lambda contribution_id: "unit-first" if contribution_id in first_ids else "unit-second",
            )
            first = finalizer.finalize(run, semantic1)
            update_trajectory_text(run, "first", 0, "one revised")
            rebuilt = run_builder(run)
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
            semantic2 = root / "semantic-2"
            prepare(run, semantic2)
            write_worker_results(
                semantic2,
                lambda contribution_id: "unit-first" if contribution_id in first_ids else "unit-second",
            )
            second = finalizer.finalize(run, semantic2)
            first_units = {unit["id"]: unit for unit in first["semantic_manifest"]["units"]}
            second_units = {unit["id"]: unit for unit in second["semantic_manifest"]["units"]}
            self.assertEqual(second["semantic_manifest"]["revision"], 2)
            self.assertEqual(second_units["unit-first"]["revision"], 2)
            self.assertEqual(second_units["unit-second"]["revision"], 1)
            self.assertEqual(second_units["unit-second"]["membershipDigest"],
                             first_units["unit-second"]["membershipDigest"])

    def test_old_map_missing_projection_and_hard_link_topology_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj", ["one"])
            (run / "project-map.json").write_text(json.dumps({
                "primary_project": "Historical", "semantic_units": [],
            }), encoding="utf-8")
            result = run_builder(run)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("re-collect", result.stderr)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj", ["one"])
            self.assertEqual(run_builder(run).returncode, 0)
            source = run / "project-map.json"
            alias = root / "map-alias.json"
            try:
                os.link(source, alias)
            except OSError as error:
                self.skipTest(f"hard links unavailable: {error}")
            with self.assertRaisesRegex(ValueError, "hard-link"):
                preparer.build_preparation(run, 4096)

    def test_secret_like_content_and_output_junction_fail_before_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj", ["token=secret-value"])
            self.assertEqual(run_builder(run).returncode, 0)
            with self.assertRaisesRegex(ValueError, "secret-like"):
                preparer.build_preparation(run, 4096)
            self.assertFalse((root / "semantic").exists())

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj", ["safe contribution"])
            self.assertEqual(run_builder(run).returncode, 0)
            prepared = preparer.build_preparation(run, 4096)
            physical = root / "physical"
            physical.mkdir()
            alias = root / "alias"
            directory_link_or_skip(self, alias, physical)
            with self.assertRaisesRegex(ValueError, "aliased"):
                preparer.install_preparation(alias / "semantic", prepared)
            self.assertFalse((physical / "semantic").exists())


if __name__ == "__main__":
    unittest.main()
