#!/usr/bin/env python3
"""=glance: disk, load and listening ports at a glance. Read-only and local.

An example of the Bolt Apps kit: this file holds data and wiring only. Formatting, row structure, text safety,
deadlines, caching and JSON output come from bolt_app_kit."""
import sys

import bolt_app_kit as kit

OS = kit.os_name()
PLATFORMS = ("macos", "linux")
VIEWS = ("overview", "disk")

# Per-OS wiring: the command for each probe. Everything after it is shared.
COMMANDS = {
    "macos": {"ports": ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]},
    "linux": {"ports": ["ss", "-ltnH"]},
}


def parse_disk(out):
    lines = [ln.split() for ln in out.strip().splitlines()]
    if len(lines) < 2 or len(lines[1]) < 4:
        return None
    total, used = int(lines[1][1]), int(lines[1][2])
    if total <= 0:
        return None
    return {"total": total * 1024, "used": used * 1024, "pct": used * 100.0 / total}


def parse_load(out):
    import re
    m = re.search(r"load averages?:\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)", out)
    return {"load1": float(m.group(1))} if m else None


def parse_ports(out):
    lines = [ln.split() for ln in out.splitlines() if ln.strip()]
    if OS == "macos":  # lsof prints a header line and the program name first
        lines = lines[1:]
        names = sorted(set(ln[0] for ln in lines))
    else:
        names = []
    return {"count": len(lines), "names": names[:3]}


def read_all(deadline, cache):
    def disk():
        hit = cache.get("disk")
        if hit is not None:
            return kit.Probe("disk", True, hit)
        p = kit.probe("disk", ["df", "-k", "/"], parse_disk, deadline=deadline, require_output=True)
        cache.put("disk", p.value, ok=p.ok)
        return p

    return kit.run_parallel({
        "disk": disk,
        "load": lambda: kit.probe("load", ["uptime"], parse_load, deadline=deadline, require_output=True),
        # lsof exits 1 with no output when nothing is listening: that is an answer, not a failure
        "ports": lambda: kit.probe("ports", COMMANDS[OS]["ports"], parse_ports, deadline=deadline, empty_ok_rcs=(1,)),
    }, deadline)


def disk_row(p):
    if p.unread:
        return kit.row("Disk: not read", "Could not read the disk. Enter to try again", icon="hard-drive", pane="disk",
                       nav={"view": "disk"}, copy=False)
    d = p.value
    return kit.row("Disk %s used" % kit.fmt_pct(d["pct"]), "%s of %s" % (kit.fmt_bytes(d["used"]), kit.fmt_bytes(d["total"])),
                   icon="hard-drive", pane="disk", nav={"view": "disk"},
                   tile=kit.tile("Disk", d["pct"], "%", 100, note=kit.fmt_bytes(d["total"] - d["used"]) + " free"),
                   badge="FULL" if kit.rnd(d["pct"]) >= 90 else "")


def main(argv):
    if OS not in PLATFORMS:
        kit.emit([kit.unsupported_row(OS, PLATFORMS)])
    view = argv[1] if len(argv) > 1 and argv[1] in VIEWS else "overview"
    deadline = kit.Deadline(14.0)
    cache = kit.Cache("system-glance", 45, shape=lambda v: isinstance(v, dict) and "pct" in v)
    probes = read_all(deadline, cache)
    findings = 0
    d = probes["disk"]
    if d.ok and kit.rnd(d.value["pct"]) >= 90:
        findings += 1
    head = kit.headline(probes, findings)
    if view == "disk":
        rows = [kit.back_row("Back to the overview"), disk_row(d), kit.refresh_row("disk")]
        kit.emit(rows)
    load, ports = probes["load"], probes["ports"]
    rows = [
        kit.row(head.text, "%d of 3 sections read" % sum(1 for p in probes.values() if p.ok), icon="activity",
                badge="" if head.all_clear else "CHECK", copy=False),
        disk_row(d),
        kit.row("Load %s" % (("%.1f" % load.value["load1"]) if load.ok else "not read"), "1 minute average", icon="cpu",
                tile=kit.tile("Load", load.value["load1"] if load.ok else None, "", None)),
        kit.row(kit.fmt_count(ports.value["count"], "listening port") if ports.ok else "Ports: not read",
                ("TCP listeners: " + kit.chips(ports.value["names"])) if ports.ok and ports.value["names"] else "TCP listeners on this machine", icon="network",
                tile=kit.tile("Ports", ports.value["count"] if ports.ok else None, "", None),
                actions=[kit.action_copy("lsof", "Copy command", " ".join(COMMANDS[OS]["ports"]), safe=False)]),
        kit.refresh_row("overview"),
    ]
    kit.emit(rows)


if __name__ == "__main__":
    main(sys.argv)
