import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "build_project_map.py"
SPEC = importlib.util.spec_from_file_location("build_project_map", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_trajectory(run: Path, trajectory_id: str) -> Path:
    directory = run / "trajectories" / trajectory_id
    directory.mkdir(parents=True)
    contribution_id = f"evt-{hashlib.sha256(trajectory_id.encode('utf-8')).hexdigest()}"
    event = {
        "schema": MODULE.TRAJECTORY_EVENT_SCHEMA,
        "event_id": contribution_id,
        "event_type": "message",
        "actor": {"type": "human"},
        "payload": {"text": f"Decision from {trajectory_id}.", "confidence": 1.0},
    }
    serialized = MODULE.canonical_json(event) + "\n"
    (directory / "events.jsonl").write_text(serialized, encoding="utf-8")
    projected_digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    (directory / "manifest.json").write_text(json.dumps({
        "schema": MODULE.TRAJECTORY_SCHEMA,
        "trajectory_id": trajectory_id,
        "event_count": 1,
        "contribution_projection": {
            "policy_id": MODULE.POLICY_ID,
            "raw_source_digest": "a" * 64,
            "projected_universe_digest": projected_digest,
            "raw_event_count": 2,
            "normalized_event_count": 2,
            "kept_event_count": 1,
            "dropped_event_count": 1,
            "cross_trajectory_semantic_replay_count": 0,
        },
    }), encoding="utf-8")
    return directory


def write_meeting(run: Path, directory_id: str, meeting_id: str | None = None) -> Path:
    directory = run / "meetings" / directory_id
    directory.mkdir(parents=True)
    path = directory / "meeting.json"
    path.write_text(json.dumps({
        "schema": MODULE.MEETING_SCHEMA,
        **({"meeting_id": meeting_id} if meeting_id is not None else {}),
        "records": [{"record_id": "record-1", "text": f"Review in {directory_id}."}],
    }), encoding="utf-8")
    return path


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


def semantic_source_digest(ids, source_digests):
    return MODULE.digest([{
        "id": contribution_id,
        "sourceDigest": source_digests[contribution_id],
    } for contribution_id in ids])


class BuildProjectMapTests(unittest.TestCase):
    def test_semantic_kind_is_open_lower_snake_case_with_fixed_safe_failures(self):
        valid_kinds = (
            "direction_change",
            "root_cause",
            "laboratory_observation",
            "supply_chain_exception",
        )
        ids = [f"item-{index}" for index in range(len(valid_kinds))]
        digests = {item: hashlib.sha256(item.encode()).hexdigest() for item in ids}
        source_digest = semantic_source_digest(ids, digests)
        manifest = MODULE.finalize_units(
            "Synthetic Project", ids, digests, source_digest, [{
                "id": f"unit-{index}", "kind": kind, "members": [ids[index]],
            } for index, kind in enumerate(valid_kinds)],
        )
        self.assertEqual(
            [unit["kind"] for unit in manifest["units"]],
            list(valid_kinds),
        )
        self.assertEqual(
            MODULE.validate_previous_manifest(manifest, "Synthetic Project"),
            {key: value for key, value in manifest.items() if key != "serializedBytes"},
        )

        invalid_kinds = (
            "",
            "Direction_change",
            "1direction",
            "direction-change",
            "direction change",
            "direction_\x00change",
            "a" * 65,
        )
        for invalid in invalid_kinds:
            with self.subTest(kind=repr(invalid)):
                with self.assertRaisesRegex(
                    ValueError, f"^{MODULE.SEMANTIC_WORKER_KIND_INVALID}$",
                ) as failure:
                    MODULE.finalize_units(
                        "Synthetic Project", ["item"], {"item": "b" * 64},
                        "a" * 64,
                        [{"id": "unit", "kind": invalid, "members": ["item"]}],
                    )
                self.assertEqual(
                    str(failure.exception), MODULE.SEMANTIC_WORKER_KIND_INVALID,
                )

    def test_canonical_project_map_validator_rejects_stale_corpus_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            trajectory = write_trajectory(run, "traj-one")
            ids, _, _ = MODULE.source_inventory(run)
            project_map = MODULE.canonical_project_map(
                run,
                "Synthetic Project",
                "Safe summary.",
                [{"id": "unit-one", "kind": "discussion", "members": ids}],
            )
            self.assertEqual(
                MODULE.validate_project_map_authority(run, project_map), project_map,
            )

            event = json.loads((trajectory / "events.jsonl").read_text(encoding="utf-8"))
            event["payload"]["text"] = "Changed synthetic decision."
            serialized = MODULE.canonical_json(event) + "\n"
            (trajectory / "events.jsonl").write_text(serialized, encoding="utf-8")
            manifest_path = trajectory / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["contribution_projection"]["projected_universe_digest"] = (
                hashlib.sha256(serialized.encode("utf-8")).hexdigest()
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "semantic authority is stale"):
                MODULE.validate_project_map_authority(run, project_map)

    def test_plural_meetings_share_one_exact_universe(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            write_trajectory(run, "traj-one")
            write_meeting(run, "meeting-alpha")
            write_meeting(run, "meeting-beta")
            ids, sources, digests = MODULE.source_inventory(run)

            self.assertEqual(ids, [
                f"evt-{hashlib.sha256(b'traj-one').hexdigest()}",
                "meeting-alpha:record-1",
                "meeting-beta:record-1",
            ])
            self.assertEqual(len(sources), 3)
            manifest = MODULE.finalize_units(
                "Synthetic Project", ids, digests,
                semantic_source_digest(ids, digests),
                [{"id": "unit-all", "kind": "discussion", "members": ids}],
            )
            self.assertEqual(manifest["units"][0]["memberCount"], 3)

    def test_root_meeting_file_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            (run / "meeting.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "root meeting source"):
                MODULE.source_inventory(run)

        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            root_meeting = run / "meeting.json"
            with mock.patch.object(
                Path, "is_symlink", autospec=True,
                side_effect=lambda path: path == root_meeting,
            ):
                with self.assertRaisesRegex(ValueError, "root meeting source"):
                    MODULE.source_inventory(run)

    def test_duplicate_and_invalid_meeting_identities_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            write_meeting(run, "alpha", "meeting-duplicate")
            write_meeting(run, "beta", "meeting-duplicate")
            with self.assertRaisesRegex(ValueError, "meeting source identity is invalid"):
                MODULE.source_inventory(run)
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            write_meeting(run, "alpha", "../outside")
            with self.assertRaisesRegex(ValueError, "meeting source identity is invalid"):
                MODULE.source_inventory(run)

    def test_contained_meeting_directory_alias_fails_project_map_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            target = write_meeting(run, "real-id", "real-id").parent
            directory_link_or_skip(self, run / "meetings" / "alias-id", target)

            with self.assertRaisesRegex(ValueError, "meeting source path is aliased"):
                MODULE.source_inventory(run)

    def test_contained_meetings_root_alias_fails_project_map_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            write_meeting(run, "real-id", "real-id")
            hidden = run / "hidden"
            (run / "meetings").rename(hidden)
            directory_link_or_skip(self, run / "meetings", hidden)

            with self.assertRaisesRegex(ValueError, "meetings path is aliased"):
                MODULE.source_inventory(run)

    def test_raw_mechanical_digest_drift_does_not_invalidate_semantic_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            directory = write_trajectory(run, "traj-one")
            ids, _, digests = MODULE.source_inventory(run)
            source_digest = semantic_source_digest(ids, digests)
            units = [{"id": "unit-one", "kind": "decision_episode", "members": ids}]
            first = MODULE.finalize_units(
                "Synthetic Project", ids, digests, source_digest, units,
            )
            manifest_path = directory / "manifest.json"
            trajectory_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            trajectory_manifest["contribution_projection"]["raw_source_digest"] = "b" * 64
            manifest_path.write_text(json.dumps(trajectory_manifest), encoding="utf-8")

            next_ids, _, next_digests = MODULE.source_inventory(run)
            second = MODULE.finalize_units(
                "Synthetic Project", next_ids, next_digests,
                semantic_source_digest(next_ids, next_digests), units, first,
            )
            self.assertEqual(second["sourceDigest"], first["sourceDigest"])
            self.assertEqual(second["manifestDigest"], first["manifestDigest"])
            self.assertEqual(second["revision"], first["revision"])
            self.assertEqual(second["units"][0]["revision"], first["units"][0]["revision"])

    def test_destination_symlink_cannot_escape_the_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj-one")
            outside = root / "outside.json"
            outside.write_text("preserve\n", encoding="utf-8")
            destination = run / "project-map.json"
            try:
                destination.symlink_to(outside)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error.__class__.__name__}")
            result = subprocess.run([
                sys.executable, str(MODULE_PATH), str(run),
                "--primary-project", "Synthetic Project", "--summary", "Safe summary.",
            ], capture_output=True, text=True, encoding="utf-8", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(outside.read_text(encoding="utf-8"), "preserve\n")

    def test_utf8_byte_bounds_are_shared_by_project_and_unit_authority(self):
        with self.assertRaisesRegex(ValueError, "project identity is invalid"):
            MODULE.finalize_units("😀" * 76, [], {}, "a" * 64, [])
        with self.assertRaisesRegex(ValueError, "semantic unit identity"):
            MODULE.finalize_units(
                "Synthetic Project", ["item"], {"item": "b" * 64}, "a" * 64,
                [{"id": "😀" * 76, "kind": "discussion", "members": ["item"]}],
            )

    def test_previous_manifest_requires_explicit_valid_content_bound_lineage(self):
        ids = ["item-one"]
        digests = {"item-one": "b" * 64}
        source_digest = semantic_source_digest(ids, digests)
        units = [{"id": "unit-one", "kind": "discussion", "members": ids}]
        first = MODULE.finalize_units(
            "Synthetic Project", ids, digests, source_digest, units,
        )
        retried_without_lineage = MODULE.finalize_units(
            "Synthetic Project", ids, digests, source_digest, units,
        )
        self.assertEqual(retried_without_lineage["revision"], 1)
        self.assertEqual(retried_without_lineage["units"][0]["revision"], 1)

        forged = json.loads(json.dumps(first))
        forged["revision"] = 900
        with self.assertRaisesRegex(ValueError, "manifest digest is stale"):
            MODULE.finalize_units(
                "Synthetic Project", ids, digests, source_digest, units, forged,
            )

    def test_duplicate_topology_is_exact_and_non_chained(self):
        ids = ["item-one", "item-two", "item-three"]
        digests = {item: hashlib.sha256(item.encode()).hexdigest() for item in ids}
        source_digest = semantic_source_digest(ids, digests)
        with self.assertRaisesRegex(ValueError, "duplicate relation is invalid"):
            MODULE.finalize_units(
                "Synthetic Project", ids, digests, source_digest, [
                    {"id": "unit-primary", "kind": "discussion", "members": ["item-one"]},
                    {"id": "unit-duplicate", "kind": "duplicate", "members": ["item-two", "item-three"]},
                ],
            )
        with self.assertRaisesRegex(ValueError, "non-duplicate unit declares"):
            MODULE.finalize_units(
                "Synthetic Project", ids, digests, source_digest, [
                    {"id": "unit-primary", "kind": "discussion", "members": ["item-one"], "duplicateOfUnitId": "unit-other"},
                    {"id": "unit-other", "kind": "discussion", "members": ["item-two", "item-three"]},
                ],
            )
        with self.assertRaisesRegex(ValueError, "duplicate relation is invalid"):
            MODULE.finalize_units(
                "Synthetic Project", ids, digests, source_digest, [
                    {"id": "unit-primary", "kind": "discussion", "members": ["item-one"]},
                    {"id": "unit-duplicate-a", "kind": "duplicate", "members": ["item-two"], "duplicateOfUnitId": "unit-duplicate-b"},
                    {"id": "unit-duplicate-b", "kind": "duplicate", "members": ["item-three"], "duplicateOfUnitId": "unit-primary"},
                ],
            )

    def test_cli_edit_cycle_preserves_and_advances_semantic_revisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            trajectory = write_trajectory(run, "traj-one")
            command = [
                sys.executable, str(MODULE_PATH), str(run),
                "--primary-project", "Synthetic Project", "--summary", "Safe summary.",
            ]
            first_skeleton = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(first_skeleton.returncode, 0, first_skeleton.stderr)
            path = run / "project-map.json"
            draft = json.loads(path.read_text(encoding="utf-8"))
            draft["semantic_units"] = [{
                "id": "unit-one",
                "kind": "decision_episode",
                "members": [f"evt-{hashlib.sha256(b'traj-one').hexdigest()}"],
            }]
            path.write_text(json.dumps(draft), encoding="utf-8")
            first_finalize = subprocess.run(
                [*command, "--finalize"],
                capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(first_finalize.returncode, 0, first_finalize.stderr)
            first = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(first["semantic_manifest"]["revision"], 1)
            self.assertEqual(first["semantic_manifest"]["units"][0]["revision"], 1)

            event = {
                "schema": MODULE.TRAJECTORY_EVENT_SCHEMA,
                "event_id": f"evt-{hashlib.sha256(b'traj-one').hexdigest()}",
                "event_type": "message",
                "actor": {"type": "human"},
                "payload": {"text": "A revised decision.", "confidence": 1.0},
            }
            serialized = MODULE.canonical_json(event) + "\n"
            (trajectory / "events.jsonl").write_text(serialized, encoding="utf-8")
            manifest_path = trajectory / "manifest.json"
            trajectory_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            trajectory_manifest["contribution_projection"]["projected_universe_digest"] = (
                hashlib.sha256(serialized.encode("utf-8")).hexdigest()
            )
            manifest_path.write_text(json.dumps(trajectory_manifest), encoding="utf-8")

            second_skeleton = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(second_skeleton.returncode, 0, second_skeleton.stderr)
            preserved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(preserved["semantic_units"], first["semantic_units"])
            self.assertEqual(preserved["semantic_manifest"], first["semantic_manifest"])
            second_finalize = subprocess.run(
                [*command, "--finalize", "--previous", str(path)],
                capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(second_finalize.returncode, 0, second_finalize.stderr)
            second = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(second["semantic_manifest"]["revision"], 2)
            self.assertEqual(second["semantic_manifest"]["units"][0]["revision"], 2)


if __name__ == "__main__":
    unittest.main()
