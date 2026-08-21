import importlib.util
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_local_review.py"
SPEC = importlib.util.spec_from_file_location("run_local_review", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class LauncherUnitTest(unittest.TestCase):
    def test_viewer_binds_requested_ipv4_port_without_bridge(self):
        command = MODULE.viewer_command(3240, "/linux/npm")
        self.assertEqual(command[0], "/linux/npm")
        self.assertEqual(command[-4:], ["--host", "127.0.0.1", "--port", "3240"])
        self.assertNotIn("socat", command)

    def test_port_in_use_fails_immediately_without_killing_owner(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as owner:
            owner.bind(("127.0.0.1", 0))
            port = owner.getsockname()[1]
            started = time.monotonic()
            with self.assertRaisesRegex(SystemExit, f"Port {port} is already in use"):
                MODULE.ensure_port_available(port)
            self.assertLess(time.monotonic() - started, 1)
            owner.listen(1)

    @unittest.skipUnless(os.name == "posix", "POSIX npm layout test")
    def test_incompatible_regular_file_shim_is_detected(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "vinext").write_text("#!/bin/sh\nexec node.exe\n", encoding="utf-8")
            self.assertIn("not a symlink", MODULE.node_modules_issue(viewer))

    @unittest.skipUnless(os.name == "posix", "POSIX npm layout test")
    def test_linux_symlink_layout_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "vinext" / "dist" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "vinext").symlink_to("../vinext/dist/cli.js")
            self.assertIsNone(MODULE.node_modules_issue(viewer))

    def test_runtime_environment_is_scoped_to_owned_root(self):
        root = Path("/tmp/oxygen-launch-test")
        environment = MODULE.viewer_environment(root)
        self.assertEqual(environment["OXYGEN_VIEWER_STATE_DIR"], str(root / "state"))
        self.assertEqual(environment["WRANGLER_LOG_PATH"], str(root / "wrangler.log"))
        self.assertEqual(environment["MINIFLARE_REGISTRY_PATH"], str(root / "registry"))

    @unittest.skipUnless(os.name == "posix", "POSIX process-group test")
    def test_cleanup_terminates_owned_process_group(self):
        process = subprocess.Popen(
            ["bash", "-c", "sleep 60 & wait"],
            start_new_session=True,
        )
        MODULE.terminate_process_group(process, timeout=2)
        self.assertIsNotNone(process.poll())
        with self.assertRaises(ProcessLookupError):
            os.killpg(process.pid, signal.SIGCONT)


if __name__ == "__main__":
    unittest.main()
