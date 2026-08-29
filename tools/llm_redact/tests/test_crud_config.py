import importlib.util
import io
from pathlib import Path
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "test_crud.py"
SPEC = importlib.util.spec_from_file_location("test_crud", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class CrudConfigTest(unittest.TestCase):
    def test_base_url_is_configurable(self):
        args = MODULE.build_parser().parse_args(["--base-url", "http://127.0.0.1:3242"])
        self.assertEqual(args.base_url, "http://127.0.0.1:3242")

    def test_import_has_no_network_side_effect(self):
        self.assertTrue(callable(MODULE.main))

    def test_main_uses_explicit_keep_and_redact_decisions(self):
        responses = [
            ({"redactions": [
                {"id": "keep-id", "review_state": "needs_confirmation"},
                {"id": "redact-id", "review_state": "needs_confirmation"},
            ]}, 200),
            ({"review_state": "confirmed_keep", "status": "removed"}, 200),
            ({"review_state": "confirmed_redact", "status": "active"}, 200),
        ]
        with mock.patch.object(MODULE, "call", side_effect=responses) as call, \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(MODULE.main([]), 0)

        self.assertEqual(call.call_args_list[1].args[1:], (
            "/api/redactions/keep-id", "PATCH", {"decision": "keep"},
        ))
        self.assertEqual(call.call_args_list[2].args[1:], (
            "/api/redactions/redact-id", "PATCH", {"decision": "redact"},
        ))


if __name__ == "__main__":
    unittest.main()
