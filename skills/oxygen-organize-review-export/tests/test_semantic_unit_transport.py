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
import record_semantic_worker as recorder

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
    index["trajectories"].append({
        "trajectory_id": trajectory_id, "ok": True, "cwd_relations": ["exact"],
    })
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


def run_builder(
    run: Path, project: str = "Synthetic Project",
) -> subprocess.CompletedProcess[str]:
    return subprocess.run([
        sys.executable, str(SCRIPTS / "build_project_map.py"), str(run),
        "--primary-project", project, "--summary", "Safe summary.",
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


def registry_proposal(*unit_ids: str, kind: str = "discussion") -> dict:
    return {"units": [{
        "unitId": unit_id,
        "kind": kind,
        "definition": f"Records belonging to {unit_id}.",
        "disambiguation": f"Use only when the record matches {unit_id}.",
        "storyProjection": {
            "label": f"Label {unit_id}",
            "summary": f"Safe semantic summary for {unit_id}.",
        },
    } for unit_id in unit_ids]}


def prepare(
    run: Path,
    output: Path,
    maximum: int = 4096,
    registry: dict | None = None,
) -> dict:
    value = preparer.build_preparation(
        run, maximum, registry if registry is not None else registry_proposal("unit-one"),
    )
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
            "contributionIds": sorted(members, key=lambda value: value.encode("utf-8")),
        } for unit_id, members in sorted(grouped.items(), key=lambda item: item[0].encode("utf-8"))]
        worker_output = {
            "shardId": shard["id"],
            "inputDigest": shard["inputDigest"],
            "proposals": proposals,
        }
        record = output / "records" / shard["id"]
        record.mkdir()
        output_path = record / "output.json"
        output_path.write_text(json.dumps(worker_output, ensure_ascii=False), encoding="utf-8")
        receipt = {
            "status": "complete",
            "shardId": shard["id"],
            "inputDigest": shard["inputDigest"],
            "contributionIds": shard["contributionIds"],
            "outputPath": f"records/{shard['id']}/output.json",
            "outputDigest": builder.digest(worker_output),
            "outputCount": len(proposals),
        }
        (record / "receipt.json").write_text(
            json.dumps(receipt), encoding="utf-8",
        )


class SemanticUnitTransportTests(unittest.TestCase):
    def test_recorder_separates_correctable_mapping_feedback_from_fatal_authority(self):
        cases = {
            "malformed-json": ("{", "SEMANTIC_WORKER_MAPPING_INVALID"),
            "non-array": (json.dumps({}), "SEMANTIC_WORKER_MAPPING_INVALID"),
            "unknown-id": (lambda ids: json.dumps([{
                "unitId": "unknown-unit", "contributionIds": ids,
            }]), "SEMANTIC_WORKER_MAPPING_INVALID"),
            "overlap": (lambda ids: json.dumps([
                {"unitId": "unit-one", "contributionIds": [ids[0]]},
                {"unitId": "unit-one", "contributionIds": [ids[0]]},
            ]), "SEMANTIC_WORKER_MAPPING_INVALID"),
            "missing-coverage": (lambda ids: json.dumps([{
                "unitId": "unit-one", "contributionIds": [ids[0]],
            }]), "SEMANTIC_WORKER_MAPPING_INVALID"),
        }
        for label, (payload, expected) in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                run = root / "run"
                ids = write_trajectory(run, f"traj-{label}", ["one", "two"])
                self.assertEqual(run_builder(run).returncode, 0)
                semantic = root / "semantic"
                prepared = prepare(run, semantic, registry=registry_proposal("unit-one"))
                shard = prepared["manifest"]["shards"][0]
                proposal_path = semantic / shard["proposalPath"]
                value = payload(ids) if callable(payload) else payload
                proposal_path.write_text(value, encoding="utf-8")
                result = subprocess.run([
                    sys.executable, str(SCRIPTS / "record_semantic_worker.py"),
                    str(semantic), shard["id"], str(proposal_path),
                ], capture_output=True, text=True, encoding="utf-8", check=False)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, f"{expected}\n")
                self.assertFalse((semantic / "records" / shard["id"]).exists())

    def test_recorder_keeps_input_tampering_fatal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            ids = write_trajectory(run, "traj-fatal", ["one", "two"])
            self.assertEqual(run_builder(run).returncode, 0)
            semantic = root / "semantic"
            prepared = prepare(run, semantic, registry=registry_proposal("unit-one"))
            shard = prepared["manifest"]["shards"][0]
            proposal_path = semantic / shard["proposalPath"]
            proposal_path.write_text(json.dumps([{
                "unitId": "unit-one", "contributionIds": sorted(ids,
                    key=lambda value: value.encode("utf-8")),
            }]), encoding="utf-8")
            input_path = semantic / shard["inputPath"]
            input_value = json.loads(input_path.read_text(encoding="utf-8"))
            input_value["registry"] = {}
            input_path.write_text(json.dumps(input_value), encoding="utf-8")
            result = subprocess.run([
                sys.executable, str(SCRIPTS / "record_semantic_worker.py"),
                str(semantic), shard["id"], str(proposal_path),
            ], capture_output=True, text=True, encoding="utf-8", check=False)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, "SEMANTIC_WORKER_RECORD_INVALID\n")
            self.assertFalse((semantic / "records" / shard["id"]).exists())

    def test_worker_clis_map_missing_inputs_to_fixed_safe_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / "HOSTILE_SENTINEL_https_example.invalid_exception-body"
            cases = (
                ([sys.executable, str(SCRIPTS / "finalize_semantic_units.py"),
                  str(missing), str(missing)], "SEMANTIC_FINALIZATION_INVALID"),
                ([sys.executable, str(SCRIPTS / "record_semantic_worker.py"),
                  str(missing), "shard-1", str(missing)], "SEMANTIC_WORKER_RECORD_INVALID"),
            )
            for command, code in cases:
                with self.subTest(code=code):
                    result = subprocess.run(
                        command, capture_output=True, text=True, encoding="utf-8", check=False,
                    )
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr, f"{code}\n")
                    self.assertTrue(all(fragment not in result.stderr for fragment in (
                        str(missing), "HOSTILE_SENTINEL", "example.invalid", "Traceback",
                        "FileNotFoundError", "No such file or directory", "cannot find",
                    )))

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
                registry_digest="d" * 64,
            )
            second = builder.canonical_project_map(
                run, "Synthetic Project", "Safe cross-runtime summary.", raw_units,
                registry_digest="d" * 64,
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
                    "source_revision": 1,
                    "source_digest": "9" * 64,
                    "receipt_digest": "8" * 64,
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

    def test_worker_rejects_noncanonical_handoff_and_traversal_before_any_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            contribution_id = write_trajectory(run, "traj", ["one"])[0]
            self.assertEqual(run_builder(run).returncode, 0)
            project_map_before = (run / "project-map.json").read_bytes()
            semantic = root / "semantic"
            prepared = prepare(run, semantic, registry=registry_proposal("unit-discussion"))
            shard = prepared["manifest"]["shards"][0]
            shard_id = shard["id"]
            proposals = [{
                "unitId": "unit-discussion",
                "contributionIds": [contribution_id],
            }]
            outside_proposal = root / "outside.proposals.json"
            outside_proposal.write_text(json.dumps(proposals), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "proposal path is not canonical"):
                recorder.record(semantic, shard_id, outside_proposal)
            self.assertEqual(list((semantic / "records").iterdir()), [])
            self.assertEqual((run / "project-map.json").read_bytes(), project_map_before)

            manifest_path = semantic / "shards.json"
            manifest_before = manifest_path.read_bytes()
            tampered = json.loads(manifest_before)
            traversal_id = "x/../../../outside-pair"
            tampered["shards"][0]["id"] = traversal_id
            tampered["shards"][0]["inputPath"] = f"inputs/{traversal_id}.json"
            tampered["shards"][0]["receiptPath"] = f"records/{traversal_id}/receipt.json"
            builder.atomic_write_json(manifest_path, tampered)
            with self.assertRaisesRegex(ValueError, "shard identity is invalid"):
                recorder.record(semantic, traversal_id, outside_proposal)
            self.assertFalse((root / "outside-pair").exists())
            self.assertEqual(list((semantic / "records").iterdir()), [])
            self.assertEqual((run / "project-map.json").read_bytes(), project_map_before)

            manifest_path.write_bytes(manifest_before)
            canonical_proposal = semantic / "handoffs" / f"{shard_id}.proposals.json"
            canonical_proposal.write_text(json.dumps(proposals), encoding="utf-8")
            receipt = recorder.record(semantic, shard_id, canonical_proposal)
            self.assertEqual(receipt["status"], "complete")
            self.assertEqual(len(finalizer.finalize(run, semantic)["semantic_manifest"]["units"]), 1)

    @unittest.skipUnless(os.name == "nt", "native 8.3 paths are Windows-only")
    def test_worker_accepts_mixed_native_short_and_long_handoff_paths(self):
        import ctypes

        def short_path(path: Path) -> Path:
            buffer = ctypes.create_unicode_buffer(32_768)
            length = ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer))
            if not length or os.path.normcase(buffer.value) == os.path.normcase(str(path)):
                self.skipTest("native 8.3 path aliases are unavailable")
            return Path(buffer.value)

        with tempfile.TemporaryDirectory(
            prefix="oxygen semantic short path ", dir=Path(__file__).resolve().parents[3]
        ) as temporary:
            root = Path(temporary)
            run = root / "run with a long name"
            contribution_id = write_trajectory(run, "traj", ["one"])[0]
            self.assertEqual(run_builder(run).returncode, 0)
            semantic = root / "semantic output with a long name"
            shard = prepare(
                run, semantic, registry=registry_proposal("unit-discussion"),
            )["manifest"]["shards"][0]
            proposal = semantic / "handoffs" / f"{shard['id']}.proposals.json"
            proposal.write_text(json.dumps([{
                "unitId": "unit-discussion",
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            short_root = short_path(semantic)
            short_proposal = short_path(proposal)
            script = SCRIPTS / "record_semantic_worker.py"
            for root_path, proposal_path in (
                (semantic, short_proposal),
                (short_root, proposal),
            ):
                completed = subprocess.run([
                    sys.executable, str(script), str(root_path), shard["id"], str(proposal_path),
                ], capture_output=True, text=True, encoding="utf-8", check=False)
                self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_invalid_mapping_can_be_explicitly_corrected_only_before_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            contribution_id = write_trajectory(run, "traj", ["one"])[0]
            self.assertEqual(run_builder(run).returncode, 0)
            semantic = root / "semantic"
            prepared = prepare(
                run, semantic,
                registry=registry_proposal(
                    "unit-direction", "unit-root", kind="direction_change",
                ),
            )
            shard = prepared["manifest"]["shards"][0]
            shard_id = shard["id"]
            shard_input = semantic / shard["inputPath"]
            input_before = shard_input.read_bytes()
            proposal_path = semantic / "handoffs" / f"{shard_id}.proposals.json"
            proposal_path.write_text(json.dumps([{
                "unitId": "unit-unknown",
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
            self.assertEqual(rejected.stderr.strip(), finalizer.SEMANTIC_WORKER_MAPPING_INVALID)
            self.assertNotIn("unit-unknown", rejected.stderr)
            self.assertNotIn("Traceback", rejected.stderr)
            record_path = semantic / "records" / shard_id
            output_path = record_path / "output.json"
            receipt_path = record_path / "receipt.json"
            self.assertFalse(output_path.exists())
            self.assertFalse(receipt_path.exists())
            self.assertEqual(shard_input.read_bytes(), input_before)

            proposal_path.write_text(json.dumps([{
                "unitId": "unit-direction",
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            accepted = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual([path.name for path in (semantic / "records").iterdir()], [shard_id])
            self.assertEqual(
                {path.name for path in record_path.iterdir()},
                {"output.json", "receipt.json"},
            )
            output_before = output_path.read_bytes()
            receipt_before = receipt_path.read_bytes()
            replayed = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(replayed.returncode, 0, replayed.stderr)
            self.assertEqual(output_path.read_bytes(), output_before)
            self.assertEqual(receipt_path.read_bytes(), receipt_before)
            finalized = finalizer.finalize(run, semantic)
            self.assertEqual(finalized["semantic_manifest"]["units"][0]["kind"],
                             "direction_change")
            self.assertEqual(finalized["semantic_manifest"]["units"][0]["memberCount"], 1)

            proposal_path.write_text(json.dumps([{
                "unitId": "unit-root",
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            immutable = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertNotEqual(immutable.returncode, 0)
            self.assertEqual(immutable.stderr, "SEMANTIC_WORKER_RECORD_INVALID\n")
            self.assertEqual(output_path.read_bytes(), output_before)
            self.assertEqual(receipt_path.read_bytes(), receipt_before)
            self.assertEqual(shard_input.read_bytes(), input_before)

    def test_worker_pair_staged_write_faults_leave_no_final_and_retry(self):
        for fail_after in (1, 2):
            with self.subTest(fail_after=fail_after), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                run = root / "run"
                contribution_id = write_trajectory(run, "traj", ["one"])[0]
                self.assertEqual(run_builder(run).returncode, 0)
                semantic = root / "semantic"
                prepared = prepare(run, semantic)
                shard = prepared["manifest"]["shards"][0]
                proposal_path = semantic / "handoffs" / f"{shard['id']}.proposals.json"
                proposal_path.write_text(json.dumps([{
                    "unitId": "unit-one",
                    "contributionIds": [contribution_id],
                }]), encoding="utf-8")
                skeleton = (run / "project-map.json").read_bytes()
                real_write = recorder.atomic_write_json
                calls = 0

                def fail_after_staged_write(path, value):
                    nonlocal calls
                    real_write(path, value)
                    calls += 1
                    if calls == fail_after:
                        raise OSError("synthetic staged write failure")

                with mock.patch.object(
                    recorder, "atomic_write_json", side_effect=fail_after_staged_write,
                ):
                    with self.assertRaisesRegex(OSError, "synthetic staged write failure"):
                        recorder.record(semantic, shard["id"], proposal_path)

                record = semantic / "records" / shard["id"]
                self.assertFalse(record.exists())
                self.assertEqual(list((semantic / "records").iterdir()), [])
                with self.assertRaises((ValueError, FileNotFoundError)):
                    finalizer.finalize(run, semantic)
                self.assertEqual((run / "project-map.json").read_bytes(), skeleton)

                receipt = recorder.record(semantic, shard["id"], proposal_path)
                self.assertEqual(receipt["status"], "complete")
                finalized = finalizer.finalize(run, semantic)
                self.assertEqual(len(finalized["semantic_manifest"]["units"]), 1)

    def test_worker_pair_late_collision_is_no_clobber_and_retry_succeeds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            contribution_id = write_trajectory(run, "traj", ["one"])[0]
            self.assertEqual(run_builder(run).returncode, 0)
            semantic = root / "semantic"
            prepared = prepare(run, semantic)
            shard = prepared["manifest"]["shards"][0]
            proposal_path = semantic / "handoffs" / f"{shard['id']}.proposals.json"
            proposal_path.write_text(json.dumps([{
                "unitId": "unit-one",
                "contributionIds": [contribution_id],
            }]), encoding="utf-8")
            destination = semantic / "records" / shard["id"]
            owner_bytes = b'{"owner":"external"}\n'

            def collide(_stage, raced_destination):
                self.assertEqual(raced_destination, destination)
                raced_destination.mkdir()
                (raced_destination / "output.json").write_bytes(owner_bytes)
                (raced_destination / "receipt.json").write_bytes(owner_bytes)
                raise FileExistsError(17, "synthetic late collision")

            with mock.patch.object(recorder, "rename_noreplace", side_effect=collide):
                with self.assertRaisesRegex(
                    ValueError, "immutable semantic worker artifact already differs",
                ):
                    recorder.record(semantic, shard["id"], proposal_path)

            self.assertEqual((destination / "output.json").read_bytes(), owner_bytes)
            self.assertEqual((destination / "receipt.json").read_bytes(), owner_bytes)
            self.assertEqual(
                [path.name for path in (semantic / "records").iterdir()],
                [shard["id"]],
            )
            shutil.rmtree(destination)
            recorder.record(semantic, shard["id"], proposal_path)
            finalized = finalizer.finalize(run, semantic)
            self.assertEqual(len(finalized["semantic_manifest"]["units"]), 1)

    def test_cross_shard_matching_unit_ids_require_identical_open_kind_metadata(self):
        proposals = [
            {"id": "unit-shared", "kind": "laboratory_observation", "members": ["item-a"]},
            {"id": "unit-shared", "kind": "supply_chain_exception", "members": ["item-b"]},
        ]
        with self.assertRaisesRegex(ValueError, "disagree on semantic authority"):
            finalizer.compose(proposals, ["item-a", "item-b"])

    def test_unrelated_records_may_remain_distinct_singleton_units(self):
        proposals = [
            {"id": "unit-a", "kind": "discussion", "members": ["item-a"]},
            {"id": "unit-b", "kind": "laboratory_observation", "members": ["item-b"]},
        ]

        self.assertEqual(finalizer.compose(proposals, ["item-a", "item-b"]), proposals)

    def test_two_unrelated_domains_share_one_frozen_registry_across_shard_layouts(self):
        cases = (
            (
                "archive",
                ["unit-catalog", "unit-preservation"],
                "A cataloger compared handwritten shelf cards with indexed artifact records. ",
            ),
            (
                "greenhouse",
                ["unit-irrigation", "unit-temperature"],
                "A grower compared irrigation timing with greenhouse temperature readings. ",
            ),
        )
        for domain, unit_ids, sentence in cases:
            with self.subTest(domain=domain), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                run = root / "run"
                ids = write_trajectory(
                    run, f"traj-{domain}", [sentence * 18 for _ in range(6)],
                )
                self.assertEqual(
                    run_builder(run, f"Synthetic {domain} project").returncode, 0,
                )
                registry = registry_proposal(*unit_ids)
                narrow = root / "semantic-narrow"
                wide = root / "semantic-wide"
                first = prepare(run, narrow, 4096, registry)
                second = prepare(run, wide, 16384, registry)
                self.assertGreater(len(first["inputs"]), 1)
                self.assertNotEqual(len(first["inputs"]), len(second["inputs"]))
                self.assertEqual(first["registry"], second["registry"])
                registry_bytes = builder.canonical_json(first["registry"]).encode("utf-8")
                for prepared in (first, second):
                    manifest = prepared["manifest"]
                    self.assertEqual(manifest["registryPath"], "semantic-registry.json")
                    self.assertEqual(
                        manifest["registryDigest"], prepared["registry"]["registryDigest"],
                    )
                    for shard, input_value in zip(manifest["shards"], prepared["inputs"]):
                        self.assertEqual(
                            builder.canonical_json(input_value["registry"]).encode("utf-8"),
                            registry_bytes,
                        )
                        self.assertEqual(shard["inputPath"], f"inputs/{shard['id']}.json")
                        self.assertEqual(
                            shard["proposalPath"],
                            f"handoffs/{shard['id']}.proposals.json",
                        )
                        self.assertEqual(
                            shard["receiptPath"], f"records/{shard['id']}/receipt.json",
                        )
                first_unit_members = set(ids[:3])
                mapping = lambda contribution_id: (
                    unit_ids[0] if contribution_id in first_unit_members else unit_ids[1]
                )
                write_worker_results(narrow, mapping)
                write_worker_results(wide, mapping)
                first_map = finalizer.finalize(run, narrow)
                second_map = finalizer.finalize(run, wide)
                self.assertEqual(
                    first_map["semantic_manifest"], second_map["semantic_manifest"],
                )

    def test_registry_tampering_stale_digest_and_worker_metadata_fail_before_receipt(self):
        mutations = {
            "registry-tampering": lambda semantic, manifest, shard, proposal: self._field(
                semantic / "semantic-registry.json", "registryDigest", "0" * 64,
            ),
            "stale-digest": lambda semantic, manifest, shard, proposal: self._field(
                semantic / "shards.json", "registryDigest", "0" * 64,
            ),
            "input-registry-tampering": lambda semantic, manifest, shard, proposal: self._field(
                semantic / shard["inputPath"], "registry", {},
            ),
            "worker-metadata-disagreement": lambda semantic, manifest, shard, proposal: (
                proposal.write_text(json.dumps([{
                    "unitId": "unit-a",
                    "kind": "conflicting_worker_metadata",
                    "contributionIds": shard["contributionIds"],
                }]), encoding="utf-8")
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                run = root / "run"
                write_trajectory(run, "traj", [
                    "alpha " * 400, "beta " * 400, "gamma " * 400, "delta " * 400,
                ])
                self.assertEqual(run_builder(run).returncode, 0)
                semantic = root / "semantic"
                prepared = prepare(
                    run, semantic, 8192, registry_proposal("unit-a", "unit-b"),
                )
                self.assertGreaterEqual(len(prepared["inputs"]), 2)
                manifest = prepared["manifest"]
                shard = manifest["shards"][0]
                proposal = semantic / shard["proposalPath"]
                proposal.write_text(json.dumps([{
                    "unitId": "unit-a",
                    "contributionIds": shard["contributionIds"],
                }]), encoding="utf-8")
                mutate(semantic, manifest, shard, proposal)
                with self.assertRaises(ValueError):
                    recorder.record(semantic, shard["id"], proposal)
                self.assertFalse((semantic / "records" / shard["id"]).exists())

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
            prepared = preparer.build_preparation(
                run, 4096, registry_proposal("unit-sanitized"),
            )
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
                    prepared = prepare(
                        run, output, registry=registry_proposal("unit-composed"),
                    )
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
            prepared = prepare(
                run, output, 4096, registry_proposal("unit-跨分片"),
            )
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
                    prepare(run, semantic, registry=registry_proposal("unit-all"))
                    write_worker_results(semantic, lambda _: "unit-all")
                    shard = json.loads((semantic / "shards.json").read_text(encoding="utf-8"))["shards"][0]
                    record = semantic / "records" / shard["id"]
                    receipt = record / "receipt.json"
                    output = record / "output.json"
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
            prepare(
                run, semantic1,
                registry=registry_proposal("unit-first", "unit-second"),
            )
            write_worker_results(
                semantic1,
                lambda contribution_id: "unit-first" if contribution_id in first_ids else "unit-second",
            )
            first = finalizer.finalize(run, semantic1)
            update_trajectory_text(run, "first", 0, "one revised")
            rebuilt = run_builder(run)
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
            semantic2 = root / "semantic-2"
            prepare(
                run, semantic2,
                registry=registry_proposal("unit-first", "unit-second"),
            )
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
            self.assertEqual(result.stderr, "PROJECT_MAP_INPUT_INVALID\n")

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
                preparer.build_preparation(run, 4096, registry_proposal("unit-one"))

    def test_secret_like_content_and_output_junction_fail_before_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj", ["token=secret-value"])
            self.assertEqual(run_builder(run).returncode, 0)
            with self.assertRaisesRegex(ValueError, "secret-like"):
                preparer.build_preparation(run, 4096, registry_proposal("unit-one"))
            self.assertFalse((root / "semantic").exists())

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj", ["safe contribution"])
            self.assertEqual(run_builder(run).returncode, 0)
            prepared = preparer.build_preparation(
                run, 4096, registry_proposal("unit-one"),
            )
            physical = root / "physical"
            physical.mkdir()
            alias = root / "alias"
            directory_link_or_skip(self, alias, physical)
            with self.assertRaisesRegex(ValueError, "aliased"):
                preparer.install_preparation(alias / "semantic", prepared)
            self.assertFalse((physical / "semantic").exists())


if __name__ == "__main__":
    unittest.main()
