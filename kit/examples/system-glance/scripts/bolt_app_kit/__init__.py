"""bolt_app_kit: the Bolt Apps authoring kit for Python scripts. Pure stdlib, Python 3.9+.

Authors write data and wiring; the kit does formatting, row structure, JSON output, text safety, probes
and caching. The contract it targets is kit/schema/row.schema.json; see docs/kit-design.md."""
from .cache import Cache
from .fmt import UNKNOWN, fmt_bytes, fmt_count, fmt_duration, fmt_pct, fmt_time, rnd
from .probe import Deadline, Probe, RunResult, os_name, probe, run, run_parallel, which
from .rows import (Headline, KitError, action_chain, action_copy, action_url, back_row, chips, emit, error_row,
                   headline, kv_fields, refresh_row, row, tile, unsupported_row)
from .schema import validate_rows
from .text import (clean_lines, clean_text, copy_ok, elide_end, elide_left, host_label, neutralise_braces,
                   safe_copy, safe_text, text)

__version__ = "0.1.0"
KIT_NAME = "bolt_app_kit"
