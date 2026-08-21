import importlib.util
from pathlib import Path
import unittest


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


if __name__ == "__main__":
    unittest.main()
