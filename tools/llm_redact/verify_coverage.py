#!/usr/bin/env python3
"""Finalize the one exact Source Privacy review receipt."""
import argparse
import json
import pathlib
import sys

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from source_privacy_receipt import finalize_review, install_receipt


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dialogue", type=pathlib.Path, required=True)
    parser.add_argument("--findings", type=pathlib.Path, required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    args = parser.parse_args()

    try:
        review = finalize_review(args.dialogue, args.findings)
        install_receipt(args.receipt, review["receipt"])
    except (OSError, RuntimeError, ValueError) as error:
        print(f"SOURCE_PRIVACY_REVIEW_INVALID: {error}")
        return 1
    receipt = review["receipt"]
    print(json.dumps({
        "status": receipt["status"],
        "bundles": receipt["dialogue"]["bundleCount"],
        "turns": receipt["dialogue"]["turnCount"],
        "redactions": receipt["redactions"]["count"],
        "receipt_digest": receipt["receiptDigest"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
