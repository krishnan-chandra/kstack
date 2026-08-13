#!/usr/bin/env python3
"""Read-only, bounded inspection of a Jujutsu bookmark stack.

No GitHub access, no credentials, no mutation. Emits a JSON model of the
commits from ``trunk()`` up to a selected top bookmark (base -> top), with
change/commit ids, bookmarks, parents, and the states that block submission
(conflict, divergence, merge, empty description). The model is what the skill
formats into its stack table; the script never prints advice.

Usage:
    inspect_stack.py [--repo PATH] [--top BOOKMARK] [--trunk REVSET]
                     [--max-stack N] [--timeout SECS]

Exit codes:
    0  inspection succeeded (blockers may still be present in the output)
    2  jj is missing, too old, or not a jj workspace
    3  the requested top bookmark or trunk revset could not be resolved
    1  any other runtime error

This is a thin CLI wrapper over ``stack_model.build_inspect_model``.
"""

from __future__ import annotations

import argparse
import json
import sys

from stack_model import (
    OUTPUT_CAP_BYTES,
    StackError,
    build_inspect_model,
    enforce_output_cap,
)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Inspect a jj bookmark stack (read-only).")
    parser.add_argument("--repo", default=None, help="Repository path (default: cwd).")
    parser.add_argument("--top", default=None, help="Top bookmark name (default: inferred).")
    parser.add_argument("--trunk", default="trunk()", help="Trunk revset (default: trunk()).")
    parser.add_argument("--max-stack", type=int, default=50, help="Cap on commits emitted.")
    parser.add_argument("--timeout", type=int, default=20, help="Per-jj-command timeout in seconds.")
    args = parser.parse_args(argv)

    cwd = args.repo or "."

    try:
        model = build_inspect_model(
            cwd=cwd,
            trunk_revset=args.trunk,
            top=args.top,
            max_stack=args.max_stack,
            timeout=args.timeout,
        )
    except StackError as exc:
        print(json.dumps({"error": str(exc), "exit_code": exc.exit_code}))
        return exc.exit_code

    enforce_output_cap(model, OUTPUT_CAP_BYTES)
    print(json.dumps(model, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))