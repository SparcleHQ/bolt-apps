"""bolt_app_kit: the Bolt Apps authoring kit for Python scripts. Pure stdlib, Python 3.9+.

Authors write data and wiring; the kit does formatting, row structure, JSON output, text safety, probes
and caching. The contract it targets is kit/schema/row.schema.json; see docs/kit-design.md."""
from .cache import Cache
from .fmt import UNKNOWN, fmt_bytes, fmt_count, fmt_duration, fmt_num, fmt_pct, fmt_time, rnd
from .probe import Deadline, Probe, RunResult, os_name, probe, run, run_parallel, which
from .rows import (MULTILINE, NOTE_VIEW, REFRESH_BODY, Headline, KitError, action_chain, action_copy, action_url, back_row, chips, emit, error_row,
                   headline, kv_fields, note_row, refresh_row, row, safe_row, safe_tile, tile, unsupported_row)
from .hero import HERO_MAX_BYTES, HERO_MAX_PARTS, hero_fields, hero_src_template
from .schema import validate_rows
from .secrets import Secret, env_file_path, get_secret, redact, redact_tree, setup_hint
from .text import (clean_lines, clean_text, copy_ok, elide_end, elide_left, host_full, host_label, neutralise_braces,
                   safe_copy, safe_text, text)

__version__ = "0.3.10"
KIT_NAME = "bolt_app_kit"
