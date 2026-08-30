import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "prepare_ai_review_run.py"
SPEC = importlib.util.spec_from_file_location("prepare_ai_review_run", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

EXTRACT_PATH = MODULE_PATH.with_name("extract_dialogue.py")
EXTRACT_SPEC = importlib.util.spec_from_file_location(
    "extract_dialogue_for_prepare_test", EXTRACT_PATH
)
EXTRACT = importlib.util.module_from_spec(EXTRACT_SPEC)
assert EXTRACT_SPEC and EXTRACT_SPEC.loader
EXTRACT_SPEC.loader.exec_module(EXTRACT)

LAUNCHER_PATH = (
    MODULE_PATH.parents[2]
    / "skills"
    / "oxygen-organize-review-export"
    / "scripts"
    / "run_local_review.py"
)
LAUNCHER_SPEC = importlib.util.spec_from_file_location(
    "run_local_review_for_prepare_test", LAUNCHER_PATH
)
LAUNCHER = importlib.util.module_from_spec(LAUNCHER_SPEC)
assert LAUNCHER_SPEC and LAUNCHER_SPEC.loader
LAUNCHER_SPEC.loader.exec_module(LAUNCHER)


def write_source_trajectory(run: Path, trajectory_id: str, events: list[dict]) -> Path:
    directory = run / "trajectories" / trajectory_id
    directory.mkdir(parents=True)
    events = [{"schema": MODULE.TRAJECTORY_EVENT_SCHEMA, **event} for event in events]
    (directory / "events.jsonl").write_text(
        "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events),
        encoding="utf-8",
    )
    normalized_count = len(events) + 1
    (directory / "manifest.json").write_text(json.dumps({
        "schema": MODULE.TRAJECTORY_SCHEMA,
        "trajectory_id": trajectory_id,
        "source_system": "codex",
        "warnings": ["synthetic warning"],
        "event_count": len(events),
        "contribution_projection": {
            "policy_id": MODULE.POLICY_ID,
            "raw_source_digest": "a" * 64,
            "projected_universe_digest": MODULE.digest_events(events),
            "raw_event_count": normalized_count + 1,
            "normalized_event_count": normalized_count,
            "kept_event_count": len(events),
            "dropped_event_count": 1,
            "cross_trajectory_semantic_replay_count": 1,
        },
    }), encoding="utf-8")
    index_path = run / "index.json"
    index = (
        json.loads(index_path.read_text(encoding="utf-8"))
        if index_path.exists()
        else {
            "schema": MODULE.project_map_authority.INGEST_RUN_SCHEMA,
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
    return directory


def write_meeting(run: Path, meeting_id: str, *, root=False, records=None) -> Path:
    directory = run if root else run / "meetings" / meeting_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "meeting.json"
    path.write_text(json.dumps({
        "schema": MODULE.MEETING_SCHEMA,
        "meeting_id": meeting_id,
        "title": "Private title",
        "records": records if records is not None else [{
            "record_id": "source-record-id",
            "order": 1,
            "speaker": "Named Person",
            "timestamp": "2026-01-02T03:04:05Z",
            "text": "safe synthetic review text",
        }],
    }), encoding="utf-8")
    return path


def write_semantic_project_map(
    run: Path, *, units: list[dict] | None = None, include_events: bool = True,
) -> dict:
    ids, _, _ = MODULE.project_map_authority.source_inventory(run)
    if units is None:
        units = [{"id": "unit-all", "kind": "discussion", "members": ids}]
    project_map = MODULE.project_map_authority.canonical_project_map(
        run, "Synthetic Project", "Synthetic organization.", units,
    )
    if include_events:
        project_map["events"] = {
            contribution_id: {
                "project": "Synthetic Project",
                "confidence": 100,
                "summary": "Synthetic unit",
            }
            for contribution_id in ids
        }
    (run / "project-map.json").write_text(
        json.dumps(project_map, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return project_map


def tree_bytes(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*")) if path.is_file()
    }


def synthetic_event_id(label: str) -> str:
    return f"evt-{hashlib.sha256(label.encode('utf-8')).hexdigest()}"


def assert_viewer_accepts(test_case: unittest.TestCase, run: Path) -> None:
    project_map = json.loads((run / "project-map.json").read_text(encoding="utf-8"))
    ids, _, digests = MODULE.project_map_authority.source_inventory(run)
    payload = {
        "manifest": project_map["semantic_manifest"],
        "records": [{"id": value, "sourceDigest": digests[value]} for value in ids],
    }
    readiness_uri = (
        MODULE_PATH.parents[2] / "viewer" / "lib" / "story-readiness.ts"
    ).as_uri()
    script = f"""
import {{ registerHooks }} from 'node:module';
registerHooks({{
  resolve(specifier, context, nextResolve) {{
    if (specifier.startsWith('.') && !/\\.[^/]+$/.test(specifier)) {{
      try {{ return nextResolve(`${{specifier}}.ts`, context); }}
      catch {{ return nextResolve(`${{specifier}}/index.ts`, context); }}
    }}
    return nextResolve(specifier, context);
  }},
}});
const {{ validateSemanticManifestAuthority }} = await import({json.dumps(readiness_uri)});
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const result = await validateSemanticManifestAuthority(payload.manifest, payload.records);
if (!result.ok) {{ console.error(JSON.stringify(result)); process.exit(1); }}
"""
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            input=json.dumps(payload), capture_output=True, text=True,
            encoding="utf-8", check=False,
        )
    except FileNotFoundError:
        test_case.skipTest("Node is unavailable for Viewer authority validation")
    test_case.assertEqual(result.returncode, 0, result.stderr)


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


def file_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
        return
    except OSError:
        pass
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", str(link), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        if result.returncode == 0:
            return
    test_case.skipTest("file link creation is unavailable")


class PrepareAiReviewRunTest(unittest.TestCase):
    def run_main(self, source: Path, output: Path) -> None:
        with mock.patch.object(sys, "argv", [
            str(MODULE_PATH), "--run", str(source), "--out", str(output),
        ]), mock.patch("builtins.print"):
            self.assertEqual(MODULE.main(), 0)

    def assert_prepared_authority(self, output: Path) -> dict:
        project_map = json.loads(
            (output / "project-map.json").read_text(encoding="utf-8")
        )
        MODULE.project_map_authority.validate_project_map_authority(output, project_map)
        self.assertEqual(LAUNCHER.finalized_semantic_manifest(output), project_map["semantic_manifest"])
        ids, _, _ = MODULE.project_map_authority.source_inventory(output)
        members = [
            member
            for unit in project_map["semantic_manifest"]["units"]
            for member in unit["members"]
        ]
        self.assertEqual(sorted(members), ids)
        self.assertEqual(len(members), len(set(members)))
        return project_map

    def assert_projection_invalid(self, mutate):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            directory = write_source_trajectory(source, "traj-safe", [{
                "event_id": "evt-safe", "event_type": "message",
                "actor": {"type": "user"}, "payload": {"text": "safe synthetic text"},
            }])
            manifest_path = directory / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            mutate(manifest, directory)
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PROJECTION_INVALID}$"):
                MODULE.prepare_trajectories(source, output)
            self.assertFalse(output.exists())

    def test_semantic_carriers_become_canonical_messages(self):
        cases = [
            ("message", "user", "user"),
            ("user", "user", "user"),
            ("assistant", "assistant", "assistant"),
            ("agent", "agent", "assistant"),
            ("reasoning", "ai", "assistant"),
            ("progress", "ai", "assistant"),
            ("status", "ai", "assistant"),
            ("record", "speaker", "user"),
            ("speech", "speaker", "user"),
        ]
        for event_type, actor_type, role in cases:
            with self.subTest(event_type=event_type):
                event = {
                    "event_id": f"evt-{event_type}",
                    "sequence": 0,
                    "event_type": event_type,
                    "actor": {"type": actor_type},
                    "timestamp": "2026-01-02T03:04:05Z",
                    "payload": {"text": f"reviewable {event_type}"},
                }
                result = MODULE.normalize_event(event, "traj-1", 9)
                self.assertEqual(result["event_type"], "message")
                self.assertEqual(result["event_id"], event["event_id"])
                self.assertEqual(result["sequence"], 0)
                self.assertEqual(result["timestamp"], event["timestamp"])
                self.assertEqual(result["payload"], {
                    "role": role, "text": event["payload"]["text"],
                })

    def test_delegation_and_subagent_message_roles_are_preserved(self):
        cases = [
            ("agent_to_subagent", "user"),
            ("subagent_to_agent", "assistant"),
        ]
        for direction, role in cases:
            with self.subTest(direction=direction):
                result = MODULE.normalize_event({
                    "event_id": f"evt-{direction}",
                    "event_type": "message",
                    "actor": {"type": "ai"},
                    "payload": {
                        "role": role,
                        "interaction_direction": direction,
                        "text": f"semantic {direction}",
                    },
                }, "traj-1", 1)
                self.assertEqual(result["event_type"], "message")
                self.assertEqual(result["payload"]["role"], role)

    def test_nonsemantic_and_malformed_events_use_fixed_labels(self):
        cases = [
            ("tool_call", "[tool call]", {"arguments": "SECRET"}),
            ("tool_result", "[tool result]", {"stdout": "SECRET"}),
            ("system", "[system action]", {"text": "SECRET"}),
            ("git", "[version control]", {"text": "SECRET"}),
            ("version_control", "[version control]", {"text": "SECRET"}),
            ("artifact", "[artifact]", {"text": "SECRET"}),
            ("assistant", "[agent event]", {"text": ""}),
            ("message", "[action]", {"text": "SECRET"}),
            ("unknown", "[action]", {"text": "SECRET"}),
        ]
        for event_type, label, payload in cases:
            with self.subTest(event_type=event_type, label=label):
                result = MODULE.normalize_event({
                    "event_id": f"evt-{event_type}",
                    "sequence": 0,
                    "event_type": event_type,
                    "timestamp": "2026-01-02T03:04:05Z",
                    "actor": {"type": "unknown"},
                    "payload": payload,
                    "executor": {"tool": "shell"},
                }, "traj-1", 2)
                self.assertEqual(result["event_type"], "action_label")
                self.assertEqual(result["sequence"], 0)
                self.assertIsNone(result["timestamp"])
                self.assertEqual(result["payload"]["text"], label)
                self.assertNotIn("SECRET", str(result))
                self.assertNotIn("executor", result)

    def test_trajectory_directory_is_prepared_end_to_end(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            events = [
                {
                    "event_id": "evt-1",
                    "event_type": "message",
                    "actor": {"type": "assistant"},
                    "payload": {"text": "联系李四，token 不应在工具输出中暴露"},
                },
                {
                    "event_id": "evt-2",
                    "event_type": "tool_result",
                    "payload": {"stdout": "token=secret-value"},
                },
            ]
            trajectory = write_source_trajectory(source, "traj-1", events)
            manifest_path = trajectory / "manifest.json"
            source_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            source_manifest["warnings"] = ["warning one", "warning two"]
            manifest_path.write_text(json.dumps(source_manifest), encoding="utf-8")

            MODULE.prepare_trajectories(source, output)

            prepared = (output / "trajectories" / "traj-1" / "events.jsonl").read_text(
                encoding="utf-8"
            )
            self.assertIn("联系李四", prepared)
            self.assertIn("[tool result]", prepared)
            self.assertNotIn("secret-value", prepared)
            manifest = json.loads(
                (output / "trajectories" / "traj-1" / "manifest.json").read_text()
            )
            self.assertEqual(manifest["source_system"], "codex")
            self.assertEqual(manifest["source_warning_count"], 2)
            self.assertFalse(manifest["publication_approved"])

    def test_prepare_extract_and_launcher_projection_contract(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            source_events = [
                {
                    "event_id": "evt-user",
                    "sequence": 7,
                    "event_type": "speech",
                    "actor": {"type": "speaker"},
                    "timestamp": "2026-01-02T03:04:05Z",
                    "payload": {"text": "safe synthetic request"},
                },
                {
                    "event_id": "evt-agent",
                    "sequence": 8,
                    "event_type": "reasoning",
                    "actor": {"type": "ai"},
                    "timestamp": "2026-01-02T03:04:06Z",
                    "payload": {"text": "safe synthetic reasoning"},
                },
                {
                    "event_id": "evt-tool",
                    "sequence": 9,
                    "event_type": "tool_result",
                    "actor": {"type": "tool"},
                    "payload": {"stdout": "SECRET"},
                },
            ]
            source_directory = write_source_trajectory(source, "traj-safe", source_events)
            source_manifest = json.loads(
                (source_directory / "manifest.json").read_text(encoding="utf-8")
            )

            MODULE.prepare_trajectories(source, output)

            prepared_directory = output / "trajectories" / "traj-safe"
            prepared_events = [
                json.loads(line) for line in
                (prepared_directory / "events.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            manifest = json.loads(
                (prepared_directory / "manifest.json").read_text(encoding="utf-8")
            )
            projection = manifest["contribution_projection"]
            source_projection = source_manifest["contribution_projection"]
            self.assertEqual(manifest["event_count"], len(prepared_events))
            self.assertFalse(manifest["publication_approved"])
            self.assertEqual(set(projection), {
                "policy_id", "raw_source_digest", "projected_universe_digest",
                "raw_event_count", "normalized_event_count", "kept_event_count",
                "dropped_event_count", "cross_trajectory_semantic_replay_count",
            })
            for key in (
                "policy_id", "raw_source_digest", "raw_event_count",
                "normalized_event_count", "cross_trajectory_semantic_replay_count",
            ):
                self.assertEqual(projection[key], source_projection[key])
            self.assertEqual(
                projection["projected_universe_digest"],
                MODULE.digest_events(prepared_events),
            )
            self.assertEqual(projection["kept_event_count"], len(prepared_events))
            self.assertEqual(
                projection["normalized_event_count"] - projection["kept_event_count"],
                projection["dropped_event_count"],
            )
            dialogue = EXTRACT.extract_one(prepared_directory)
            self.assertEqual(
                [turn["text"] for turn in dialogue["turns"]],
                ["safe synthetic request", "safe synthetic reasoning"],
            )
            loaded = LAUNCHER._prepare_trajectory(prepared_directory, output)
            self.assertEqual(loaded["events"], prepared_events)

    def test_invalid_source_projection_fails_before_any_output_file(self):
        mutations = [
            ("missing", lambda manifest, _: manifest.pop("contribution_projection")),
            ("stale-event-count", lambda manifest, _: manifest.update(event_count=99)),
            ("boolean-event-count", lambda manifest, _: manifest.update(event_count=True)),
            ("wrong-policy", lambda manifest, _: manifest["contribution_projection"].update(
                policy_id="obsolete-policy"
            )),
            ("stale-digest", lambda manifest, _: manifest["contribution_projection"].update(
                projected_universe_digest="b" * 64
            )),
            ("bad-raw-digest", lambda manifest, _: manifest["contribution_projection"].update(
                raw_source_digest="not-a-digest"
            )),
            ("bad-count-equation", lambda manifest, _: manifest["contribution_projection"].update(
                dropped_event_count=2
            )),
            ("negative-count", lambda manifest, _: manifest["contribution_projection"].update(
                cross_trajectory_semantic_replay_count=-1,
                raw_event_count=1,
            )),
            ("tampered-events", lambda _, directory: (directory / "events.jsonl").write_text(
                json.dumps({
                    "event_id": "evt-safe", "event_type": "message",
                    "actor": {"type": "user"}, "payload": {"text": "tampered"},
                }) + "\n", encoding="utf-8"
            )),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                self.assert_projection_invalid(mutate)

        for field in (
            "raw_event_count", "normalized_event_count", "kept_event_count",
            "dropped_event_count", "cross_trajectory_semantic_replay_count",
        ):
            with self.subTest(boolean_count=field):
                self.assert_projection_invalid(
                    lambda manifest, _, field=field:
                    manifest["contribution_projection"].update({field: True})
                )

        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            event = {
                "event_id": "evt-safe", "event_type": "message",
                "actor": {"type": "user"}, "payload": {"text": "safe synthetic text"},
            }
            write_source_trajectory(source, "traj-a-valid", [event])
            invalid = write_source_trajectory(source, "traj-z-invalid", [event])
            manifest_path = invalid / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["contribution_projection"]["policy_id"] = "obsolete-policy"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PROJECTION_INVALID}$"):
                MODULE.prepare_trajectories(source, output)
            self.assertFalse(output.exists())

    def test_failed_or_stale_index_membership_blocks_before_review_output(self):
        for mutation in ("failed", "extra"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / "source"
                output = root / "review"
                write_source_trajectory(source, "traj-current", [{
                    "event_id": "evt-safe",
                    "event_type": "message",
                    "actor": {"type": "human"},
                    "payload": {"text": "safe synthetic text"},
                }])
                if mutation == "failed":
                    index_path = source / "index.json"
                    index = json.loads(index_path.read_text(encoding="utf-8"))
                    index["trajectory_failures"] = 1
                    index["trajectories"][0]["ok"] = False
                    index_path.write_text(json.dumps(index), encoding="utf-8")
                else:
                    (source / "trajectories" / "traj-stale").mkdir()

                with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_INDEX_INVALID}$"):
                    MODULE.prepare_trajectories(source, output)
                self.assertFalse(output.exists())

    def test_meeting_review_input_is_canonical_text_only(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "private-meeting-id", records=[{
                "record_id": "source-record-id",
                "order": 1,
                "speaker": "Named Person",
                "timestamp": "2026-01-02T03:04:05Z",
                "text": "reviewable text",
            }])
            meeting_path = source / "meetings" / "private-meeting-id" / "meeting.json"
            meeting = json.loads(meeting_path.read_text(encoding="utf-8"))
            meeting.update({
                "meeting_id": "private-meeting-id",
                "title": "Private title",
                "warnings": ["one warning"],
            })
            meeting_path.write_text(json.dumps(meeting), encoding="utf-8")

            meetings = MODULE.discover_meetings(source)
            warning_count = MODULE.prepare_meetings(meetings, output)
            prepared_path = output / "meetings" / "private-meeting-id" / "meeting.json"
            prepared = json.loads(prepared_path.read_text())

            self.assertEqual(len(meetings), 1)
            self.assertEqual(warning_count, 1)
            self.assertEqual(prepared["meeting_id"], "private-meeting-id")
            self.assertEqual(prepared["records"], [{
                "record_id": "source-record-id",
                "order": 1,
                "speaker": "participant",
                "text": "reviewable text",
            }])
            self.assertNotIn("Private title", json.dumps(prepared))
            self.assertNotIn("Named Person", json.dumps(prepared))
            self.assertNotIn("2026-01-02", json.dumps(prepared))

    def test_single_plural_meeting_main_emits_only_plural_topology(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-only")
            write_semantic_project_map(source)

            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]), mock.patch("builtins.print") as emit:
                self.assertEqual(MODULE.main(), 0)

            self.assertFalse((output / "meeting.json").exists())
            self.assertTrue(
                (output / "meetings" / "meeting-only" / "meeting.json").is_file()
            )
            index = json.loads((output / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["meeting_count"], 1)
            report = json.loads(emit.call_args.args[0])
            self.assertEqual(report, {
                "output": str(Path(os.path.abspath(output))),
                "trajectories": 0,
                "meetings": 1,
            })

    def test_real_single_trajectory_flow_rebinds_canonical_authority(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            event_id = synthetic_event_id("single")
            write_source_trajectory(source, "traj-one", [{
                "event_id": event_id,
                "event_type": "tool_result",
                "actor": {"type": "tool"},
                "payload": {"stdout": "private synthetic tool output"},
            }])
            original = write_semantic_project_map(source)

            self.run_main(source, output)

            prepared = self.assert_prepared_authority(output)
            self.assertEqual(prepared["semantic_units"][0]["members"], [event_id])
            self.assertNotEqual(
                prepared["source_authority"]["sourceDigest"],
                original["source_authority"]["sourceDigest"],
            )
            self.assertEqual(prepared["semantic_manifest"]["revision"], 2)
            self.assertEqual(prepared["semantic_manifest"]["units"][0]["revision"], 2)

    def test_real_plural_meetings_preserve_every_semantic_member(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "private-alpha")
            write_meeting(source, "private-beta")
            write_semantic_project_map(source)

            self.run_main(source, output)

            prepared = self.assert_prepared_authority(output)
            expected = [
                "private-alpha:source-record-id",
                "private-beta:source-record-id",
            ]
            self.assertEqual(prepared["semantic_units"][0]["members"], expected)
            self.assertEqual(sorted(prepared["events"]), expected)
            serialized = json.dumps(prepared, ensure_ascii=False)
            self.assertIn("private-alpha", serialized)
            self.assertIn("private-beta", serialized)
            self.assertIn("source-record-id", serialized)
            self.assertFalse((output / "meeting.json").exists())

    def test_mixed_flow_has_exact_coverage_and_deterministic_bytes(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            first = root / "review-first"
            second = root / "review-second"
            event_id = synthetic_event_id("mixed")
            write_source_trajectory(source, "traj-mixed", [{
                "event_id": event_id,
                "event_type": "message",
                "actor": {"type": "user"},
                "payload": {"text": "safe synthetic request"},
            }])
            write_meeting(source, "private-meeting")
            ids, _, _ = MODULE.project_map_authority.source_inventory(source)
            write_semantic_project_map(source, units=[
                {"id": "unit-meeting", "kind": "discussion", "members": [
                    member for member in ids if ":" in member
                ]},
                {"id": "unit-trajectory", "kind": "progression", "members": [
                    member for member in ids if ":" not in member
                ]},
            ])

            self.run_main(source, first)
            self.run_main(source, second)

            prepared = self.assert_prepared_authority(first)
            self.assertEqual(prepared["source_authority"]["contributionCount"], 2)
            self.assertEqual(
                {unit["id"]: unit["memberCount"] for unit in prepared["semantic_manifest"]["units"]},
                {"unit-meeting": 1, "unit-trajectory": 1},
            )
            assert_viewer_accepts(self, first)
            self.assertEqual(tree_bytes(first), tree_bytes(second))

    def test_stale_copied_authority_is_rejected_by_attach_contract(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            prepared = root / "prepared"
            write_meeting(source, "private-meeting")
            stale = write_semantic_project_map(source)
            meetings = MODULE.discover_meetings(source)
            MODULE.prepare_meetings(meetings, prepared)
            before = json.dumps(stale, sort_keys=True)

            with self.assertRaisesRegex(ValueError, "semantic authority is stale"):
                MODULE.project_map_authority.validate_project_map_authority(prepared, stale)

            self.assertEqual(json.dumps(stale, sort_keys=True), before)

    def test_invalid_semantic_authority_fails_atomically(self):
        mutations = {
            "stale-manifest-count": lambda value: value["semantic_manifest"]["units"][0].update(
                memberCount=99
            ),
            "stale-manifest-digest": lambda value: value["semantic_manifest"].update(
                manifestDigest="0" * 64
            ),
            "foreign-member": lambda value: value["semantic_units"][0]["members"].__setitem__(
                0, "foreign-member"
            ),
            "duplicate-member": lambda value: value["semantic_units"][0]["members"].append(
                value["semantic_units"][0]["members"][0]
            ),
            "missing-member": lambda value: value["semantic_units"][0]["members"].pop(),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / "source"
                output = root / "review"
                first_id = synthetic_event_id("invalid-one")
                second_id = synthetic_event_id("invalid-two")
                write_source_trajectory(source, "traj-invalid", [{
                    "event_id": first_id, "event_type": "message",
                    "actor": {"type": "user"}, "payload": {"text": "one"},
                }, {
                    "event_id": second_id, "event_type": "message",
                    "actor": {"type": "assistant"}, "payload": {"text": "two"},
                }])
                project_map = write_semantic_project_map(source)
                mutate(project_map)
                (source / "project-map.json").write_text(
                    json.dumps(project_map, ensure_ascii=False), encoding="utf-8",
                )
                source_before = tree_bytes(source)

                with mock.patch.object(sys, "argv", [
                    str(MODULE_PATH), "--run", str(source), "--out", str(output),
                ]):
                    with self.assertRaisesRegex(
                        SystemExit, f"^{MODULE.INPUT_SEMANTIC_AUTHORITY_INVALID}$"
                    ):
                        MODULE.main()

                self.assertFalse(output.exists())
                self.assertEqual(tree_bytes(source), source_before)

    def test_empty_canonical_universe_does_not_create_a_review_run(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            source.mkdir()
            write_semantic_project_map(source, units=[])

            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), "--run", str(source),
                 "--out", str(output)], capture_output=True, text=True,
                encoding="utf-8", errors="replace", check=False,
            )
            self.assertEqual(
                (result.returncode, result.stdout, result.stderr),
                (1, "", "AI_REVIEW_INPUT_INVALID\n"),
            )
            self.assertNotIn(str(root), result.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".review.prepare-*")), [])

    def test_plural_meetings_prepare_as_distinct_private_documents(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-alpha")
            write_meeting(source, "meeting-beta")

            meetings = MODULE.discover_meetings(source)
            warning_count = MODULE.prepare_meetings(meetings, output)

            prepared_paths = [
                output / "meetings" / "meeting-alpha" / "meeting.json",
                output / "meetings" / "meeting-beta" / "meeting.json",
            ]
            prepared = [json.loads(path.read_text(encoding="utf-8")) for path in prepared_paths]
            self.assertEqual(
                [meeting["meeting_id"] for meeting in prepared],
                ["meeting-alpha", "meeting-beta"],
            )
            self.assertEqual(warning_count, 0)

    def test_reviewed_meetings_preserve_attach_and_privacy_identity(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            meeting_ids = [
                "meeting-alpha-5673aad42405aa9bccf0f3b47716f230a1b5f562f7e46a7a6d6eb410a66721",
                "meeting-beta-dd6ff31480ff3d51eeebe6dfa2f4d2a4e532a24c82c6467151f7a485c8411ec6",
            ]
            for meeting_id in meeting_ids:
                write_meeting(source, meeting_id, records=[{
                    "record_id": "rec-00002", "order": 2,
                    "speaker": "Named Person", "timestamp": "2026-01-02T03:04:06Z",
                    "text": f"第二条 {meeting_id}",
                }, {
                    "record_id": "rec-00001", "order": 1,
                    "speaker": "Named Person", "timestamp": "2026-01-02T03:04:05Z",
                    "text": f"first {meeting_id}",
                }])
            original = write_semantic_project_map(source)
            source_documents = {}
            for meeting in MODULE.discover_meetings(source):
                source_documents[meeting["source_meeting_id"]] = LAUNCHER.meeting_document({
                    "dataset": meeting["dataset"],
                    "meeting_id": meeting["source_meeting_id"],
                })

            self.run_main(source, output)

            reviewed = self.assert_prepared_authority(output)
            self.assertEqual(
                reviewed["semantic_units"], original["semantic_units"],
            )
            self.assertEqual(sorted(path.name for path in (output / "meetings").iterdir()), meeting_ids)
            bundles = {bundle["trajectory"]: bundle for bundle in EXTRACT.extract_bundles(output)}
            for meeting in MODULE.discover_meetings(
                output, expected_schema=MODULE.AI_REVIEW_MEETING_SCHEMA,
            ):
                meeting_id = meeting["source_meeting_id"]
                document = LAUNCHER.meeting_document({
                    "dataset": meeting["dataset"], "meeting_id": meeting_id,
                })
                before_items = sorted(
                    source_documents[meeting_id]["items"], key=lambda item: item["sequence"],
                )
                after_items = document["items"]
                self.assertEqual(
                    [(item["id"], item["sequence"], item["content"]) for item in after_items],
                    [(item["id"], item["sequence"], item["content"]) for item in before_items],
                )
                self.assertEqual([item["sequence"] for item in after_items], [1, 2])
                self.assertEqual(
                    [turn["item_id"] for turn in bundles[meeting_id]["turns"]],
                    [item["id"] for item in after_items],
                )
                self.assertTrue(all(
                    set(record) == {"record_id", "order", "speaker", "text"}
                    and record["speaker"] == "participant"
                    for record in meeting["dataset"]["records"]
                ))

    def test_unicode_record_order_permutations_produce_identical_reviewed_bytes(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            records = [{
                "record_id": "rec-zeta", "order": 2, "speaker": "Z", "text": "再见 🌍",
            }, {
                "record_id": "rec-alpha", "order": 1, "speaker": "A", "text": "你好 café",
            }]
            outputs = []
            for name, ordered in (("forward", records), ("reverse", list(reversed(records)))):
                source = root / name
                output = root / f"{name}-review"
                write_meeting(source, "meeting-unicode", records=ordered)
                write_semantic_project_map(source)
                self.run_main(source, output)
                outputs.append(tree_bytes(output))
            self.assertEqual(outputs[0], outputs[1])

    def test_missing_or_malformed_record_ids_keep_importer_fallback_identity(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            path = write_meeting(source, "meeting-safe", records=[{
                "order": 1, "text": "first fallback record",
            }, {
                "record_id": "other:record", "order": 2,
                "text": "second fallback record",
            }])
            source_meeting = json.loads(path.read_text(encoding="utf-8"))
            expected_ids = MODULE.project_map_authority.meeting_contribution_ids(
                "meeting-safe", source_meeting["records"],
            )
            write_semantic_project_map(source)

            self.run_main(source, output)

            prepared_path = output / "meetings" / "meeting-safe" / "meeting.json"
            prepared = json.loads(prepared_path.read_text(encoding="utf-8"))
            self.assertEqual(
                [f"meeting-safe:{record['record_id']}" for record in prepared["records"]],
                expected_ids,
            )
            turns = EXTRACT.extract_bundles(output)[0]["turns"]
            self.assertEqual([turn["item_id"] for turn in turns], expected_ids)

    def test_invalid_record_identity_and_sequence_authority_fail_atomically(self):
        mutations = {
            "duplicate-record-id": lambda records: records[1].update(record_id=records[0]["record_id"]),
            "missing-sequence": lambda records: records[0].pop("order"),
            "zero-sequence": lambda records: records[0].update(order=0),
            "duplicate-sequence": lambda records: records[1].update(order=records[0]["order"]),
            "gap-sequence": lambda records: records[1].update(order=3),
            "mismatched-sequence-fields": lambda records: records[0].update(sequence_in_meeting=2),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / "source"
                output = root / "existing-review"
                path = write_meeting(source, "meeting-safe", records=[{
                    "record_id": "rec-00001", "order": 1, "text": "one",
                }, {
                    "record_id": "rec-00002", "order": 2, "text": "two",
                }])
                write_semantic_project_map(source)
                meeting = json.loads(path.read_text(encoding="utf-8"))
                mutate(meeting["records"])
                path.write_text(json.dumps(meeting, ensure_ascii=False), encoding="utf-8")
                output.mkdir()
                (output / "sentinel.bin").write_bytes(b"prior reviewed bytes")
                before = tree_bytes(output)

                with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"):
                    MODULE.prepare_run(source, output)

                self.assertEqual(tree_bytes(output), before)

    def test_staged_output_tamper_fails_before_atomic_publication(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-safe")
            write_semantic_project_map(source)
            original_write_json = MODULE.write_json

            def tampering_write(path, value):
                original_write_json(path, value)
                if path.name == "meeting.json":
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    payload["records"][0]["order"] = 0
                    path.write_text(json.dumps(payload), encoding="utf-8")

            with mock.patch.object(MODULE, "write_json", side_effect=tampering_write):
                with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"):
                    MODULE.prepare_run(source, output)
            self.assertFalse(output.exists())

    def test_output_parent_junction_is_rejected_without_external_mutation(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            write_meeting(source, "meeting-safe")
            write_semantic_project_map(source)
            external = root / "external"
            external.mkdir()
            sentinel = external / "sentinel.bin"
            sentinel.write_bytes(b"external owner bytes")
            directory_link_or_skip(self, root / "alias", external)

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.AI_REVIEW_OUTPUT_INVALID}$",
            ):
                MODULE.prepare_run(source, root / "alias" / "review")

            self.assertEqual(sentinel.read_bytes(), b"external owner bytes")
            self.assertFalse((external / "review").exists())

    def test_valid_input_never_replaces_existing_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-safe")
            write_semantic_project_map(source)
            output.mkdir()
            sentinel = output / "sentinel.bin"
            sentinel.write_bytes(b"prior owner bytes")

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.AI_REVIEW_OUTPUT_EXISTS}$",
            ):
                MODULE.prepare_run(source, output)

            self.assertEqual(sentinel.read_bytes(), b"prior owner bytes")
            self.assertEqual(list(output.iterdir()), [sentinel])

    def test_late_output_collision_is_no_clobber_and_retry_succeeds(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-safe")
            write_semantic_project_map(source)
            real_rename = MODULE.rename_noreplace

            def race(staging: Path, final: Path) -> None:
                final.mkdir()
                (final / "owner.bin").write_bytes(b"raced owner bytes")
                real_rename(staging, final)

            with (
                mock.patch.object(MODULE, "rename_noreplace", side_effect=race),
                self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.AI_REVIEW_OUTPUT_EXISTS}$",
                ),
            ):
                MODULE.prepare_run(source, output)

            self.assertEqual((output / "owner.bin").read_bytes(), b"raced owner bytes")
            self.assertEqual(list(root.glob(".review.prepare-*")), [])
            (output / "owner.bin").unlink()
            output.rmdir()
            trajectories, meetings = MODULE.prepare_run(source, output)
            self.assertEqual(trajectories, [])
            self.assertEqual(meetings, 1)
            self.assertTrue((output / "index.json").is_file())

    def test_root_meeting_is_rejected_before_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-root", root=True)
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.main()
            self.assertFalse(output.exists())

    def test_root_meeting_symlink_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            source.mkdir()
            root_meeting = source / "meeting.json"
            with mock.patch.object(
                Path, "is_symlink", autospec=True,
                side_effect=lambda path: path == root_meeting,
            ):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.discover_meetings(source)

    def test_duplicate_and_malformed_meetings_fail_before_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-alpha")
            second = write_meeting(source, "meeting-beta")
            duplicate = json.loads(second.read_text(encoding="utf-8"))
            duplicate["meeting_id"] = "meeting-alpha"
            second.write_text(json.dumps(duplicate), encoding="utf-8")
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.main()
            self.assertFalse(output.exists())

        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-malformed", records="not-a-list")
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.main()
            self.assertFalse(output.exists())

    def test_plural_meeting_path_escape_is_rejected(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            outside = root / "outside"
            write_meeting(outside, "meeting-escape", root=True)
            (source / "meetings").mkdir(parents=True)
            directory_link_or_skip(
                self, source / "meetings" / "meeting-escape", outside
            )

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_PATH_OUTSIDE_RUN}$"
            ):
                MODULE.discover_meetings(source)

    def test_contained_meeting_directory_alias_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            target = write_meeting(source, "real-id").parent
            directory_link_or_skip(
                self, source / "meetings" / "alias-id", target,
            )

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
            ):
                MODULE.discover_meetings(source)

    def test_contained_meetings_root_alias_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            write_meeting(source, "real-id")
            hidden = source / "hidden"
            (source / "meetings").rename(hidden)
            directory_link_or_skip(self, source / "meetings", hidden)

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
            ):
                MODULE.discover_meetings(source)

    def test_contained_meeting_file_alias_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            directory = source / "meetings" / "meeting-one"
            directory.mkdir(parents=True)
            target = directory / "payload.json"
            target.write_text(json.dumps({
                "meeting_id": "meeting-one",
                "records": [{"record_id": "record-one", "text": "safe text"}],
            }), encoding="utf-8")
            file_link_or_skip(self, directory / "meeting.json", target)

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
            ):
                MODULE.discover_meetings(source)


if __name__ == "__main__":
    unittest.main()
