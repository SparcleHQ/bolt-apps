"""Fixture script app: prints rows from made-up data, offline (no network)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bolt_app_kit import rows, dates  # noqa: E402

q = sys.argv[1] if len(sys.argv) > 1 else "nest"
print(json.dumps(rows.build(q, dates.stamp("2026-10-31"))))
