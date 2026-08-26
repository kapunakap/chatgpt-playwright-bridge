#!/usr/bin/env python3
"""Bounded, numeric-only local resource history. No URLs, env, or profile reads."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess

SERVICES = ("playwright", "tunnel", "mcp-proxy")


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=4)


def pressure(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        result[parts[0]] = {key: float(value) for key, value in (item.split("=") for item in parts[1:])}
    return result


def process_rss(output):
    rss = {"chrome": 0, "node": 0}
    for line in output.splitlines()[1:]:
        if not line.strip():
            continue
        fields = line.split()
        name, value = fields[-2:]
        if "chrome" in name or "chromium" in name:
            rss["chrome"] += int(value)
        elif name == "node":
            rss["node"] += int(value)
    return rss


def sample():
    mem = {line.split(":")[0]: int(line.split()[1]) for line in Path("/proc/meminfo").read_text().splitlines()}
    result = {"time": datetime.now(timezone.utc).isoformat(), "host": {
        "available_kib": mem["MemAvailable"], "total_kib": mem["MemTotal"],
        "swap_total_kib": mem["SwapTotal"], "memory_pressure": pressure("/proc/pressure/memory"),
        "io_pressure": pressure("/proc/pressure/io"),
    }, "containers": {}}
    names = ["playwright-mcp-aws-" + service + "-1" for service in SERVICES]
    try:
        info = json.loads(command("docker", "inspect", *names))
    except (subprocess.SubprocessError, json.JSONDecodeError):
        result["collection_error"] = "container_inspection_unavailable"
        return result
    for service, container in zip(SERVICES, info):
        state = container["State"]
        row = {"running": state["Running"], "oom_killed": state["OOMKilled"],
               "restarts": container["RestartCount"], "memory_limit_bytes": container["HostConfig"]["Memory"]}
        result["containers"][service] = row
        if not state["Running"]:
            continue
        try:
            cgroup = Path("/proc/{}/cgroup".format(state["Pid"])).read_text()
            relative = next(line[3:] for line in cgroup.splitlines() if line.startswith("0::"))
            root = Path("/sys/fs/cgroup") / relative.lstrip("/")
            row["memory_current_bytes"] = int((root / "memory.current").read_text())
            row["memory_events"] = {key: int(value) for key, value in
                                    (line.split() for line in (root / "memory.events").read_text().splitlines())}
            # RSS sums can double-count shared pages; names only, never command lines.
            # Docker requires a PID column to filter host ps output to this container.
            row["process_rss_sum_kib"] = process_rss(command("docker", "top", container["Id"], "-eo", "pid,comm,rss"))
        except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
            row["collection_error"] = "process_or_cgroup_unavailable"
    return result


def append_bounded(log_dir, record, max_bytes=1024 * 1024, backups=4):
    log_dir = Path(log_dir)
    log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(log_dir, 0o700)
    with (log_dir / ".writer.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = log_dir / "resources.jsonl"
        data = json.dumps(record, separators=(",", ":")) + "\n"
        if len(data.encode()) > max_bytes:
            raise ValueError("Sample exceeds log size bound")
        if current.exists() and current.stat().st_size + len(data.encode()) > max_bytes:
            for index in range(backups, 0, -1):
                source = current if index == 1 else log_dir / ("resources.jsonl." + str(index - 1))
                if source.exists():
                    os.replace(source, log_dir / ("resources.jsonl." + str(index)))
        fd = os.open(str(current), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as output:
            output.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-dir", default="/var/log/playwright-mcp-aws")
    args = parser.parse_args()
    append_bounded(args.log_dir, sample())
