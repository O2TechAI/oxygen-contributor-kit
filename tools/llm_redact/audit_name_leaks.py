#!/usr/bin/env python3
"""Find person names in the release text that no redaction span covers.

The model pass is judgement-based and its recall on names is uneven -- it
catches a name in one sentence and misses the same name two turns later. This
checks a known roster against the applied spans so the misses are countable
rather than anecdotal.
"""
import argparse
import json
import pathlib
import re


SYSTEM_ACCOUNTS = {"ubuntu", "root", "admin", "lost+found", "shared", "user"}


def load_names(roster: pathlib.Path | None, home: pathlib.Path | None) -> list:
    """Build the roster to search for.

    A file of one name per line is the portable option and the one to use in
    CI. Deriving names from a host's home directories only works on a shared
    box where colleagues have accounts, so it is opt-in.
    """
    names = set()
    if roster:
        for line in roster.read_text(encoding="utf-8").splitlines():
            candidate = line.strip().lower()
            if candidate and not candidate.startswith("#"):
                names.add(candidate)
    if home and home.is_dir():
        for entry in home.iterdir():
            base = entry.name.lower()
            names.add(base)
            for part in re.split(r"[_.\-]", base):
                if len(part) >= 4:
                    names.add(part)
    names -= SYSTEM_ACCOUNTS
    return sorted(names, key=len, reverse=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redacted", type=pathlib.Path, required=True)
    parser.add_argument("--roster", type=pathlib.Path,
                        help="file with one name per line (portable; use this in CI)")
    parser.add_argument("--from-home", type=pathlib.Path, nargs="?", const=pathlib.Path("/home"),
                        help="also derive names from a host's home directories "
                             "(shared-box convenience; defaults to /home)")
    parser.add_argument("--extra", nargs="*", default=[])
    args = parser.parse_args()

    names = load_names(args.roster, args.from_home) + [n.lower() for n in args.extra]
    if not names:
        raise SystemExit("no names to check — pass --roster, --from-home, or --extra")
    hits = {}
    covered = {}

    bundles = [p for p in sorted(args.redacted.glob("*.json")) if p.name != "index.json"]
    for path in bundles:
        bundle = json.loads(path.read_text())
        for turn in bundle["turns"]:
            text = turn["text"]
            lowered = text.lower()
            spans = turn.get("redactions", [])
            for name in names:
                for match in re.finditer(re.escape(name), lowered):
                    start, end = match.start(), match.end()
                    inside = any(s["start"] <= start and end <= s["end"] for s in spans)
                    key = name
                    if inside:
                        covered[key] = covered.get(key, 0) + 1
                    else:
                        hits.setdefault(key, []).append(
                            (bundle["trajectory"], turn["event_id"], start))

    print(f"{'name':<16}{'leaked':>8}{'redacted':>10}")
    total_leaked = 0
    for name in sorted(set(list(hits) + list(covered))):
        leaked = len(hits.get(name, []))
        total_leaked += leaked
        print(f"{name:<16}{leaked:>8}{covered.get(name, 0):>10}")
    print(f"\nunredacted name occurrences: {total_leaked}")
    if hits:
        print("\nfirst few locations:")
        for name, places in list(hits.items())[:6]:
            trajectory, event_id, offset = places[0]
            print(f"  {name}: {trajectory} {event_id} @{offset} "
                  f"({len(places)} occurrence(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
