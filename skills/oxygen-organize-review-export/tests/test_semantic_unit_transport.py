import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import build_project_map as builder
import finalize_semantic_units as finalizer
import prepare_semantic_units as preparer


def event_id(label: str) -> str:
    return f"evt-{hashlib.sha256(label.encode('utf-8')).hexdigest()}"


def write_trajectory(run: Path, trajectory_id: str, texts: list[str]) -> list[str]:
    directory = run / "trajectories" / trajectory_id
    directory.mkdir(parents=True)
    events = [{
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
