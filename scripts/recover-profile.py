#!/usr/bin/env python3
"""Explicit maintenance only: unlink stale singleton symlinks, never profile data."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess

LOCK_NAMES = ("SingletonLock", "SingletonSocket", "SingletonCookie")


def run(*args):
    return subprocess.check_output(args, text=True, timeout=20).strip()


def assert_unused(profile):
    state = run("systemctl", "show", "playwright-mcp-aws.service", "--property=ActiveState", "--value")
    if state != "inactive":
        raise RuntimeError("Stop playwright-mcp-aws.service before profile maintenance")
    if run("findmnt", "-T", str(profile), "-n", "-o", "FSTYPE") not in ("xfs", "ext4", "btrfs"):
        raise RuntimeError("Profile must be on a verified local filesystem")
    ids = run("docker", "ps", "-q").split()
    for container in json.loads(run("docker", "inspect", *ids)) if ids else []:
        for mount in container.get("Mounts", []):
            source = Path(mount["Source"]).resolve()
            if source == profile or source in profile.parents or profile in source.parents:
                raise RuntimeError("A running container mounts the profile or its parent")
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            comm = (entry / "comm").read_text().strip().lower()
        except FileNotFoundError:
            continue
        if "chrome" in comm or "chromium" in comm:
            raise RuntimeError("A browser process is still running; ownership is uncertain")


def recover(profile, expected_lock, apply=False, check_unused=assert_unused):
    profile = Path(profile).absolute()
    if profile.resolve() != profile:
        raise RuntimeError("Profile path must not contain symlinks")
    check_unused(profile)
    fd = os.open(str(profile), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        records = {}
        for name in LOCK_NAMES:
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISLNK(info.st_mode):
                raise RuntimeError(name + " is not a symlink; refusing cleanup")
            records[name] = (info.st_dev, info.st_ino, os.readlink(name, dir_fd=fd))
        if records.get("SingletonLock", (None, None, None))[2] != expected_lock:
            raise RuntimeError("SingletonLock changed or is missing; inspect again")
        if not apply:
            return {"mode": "dry-run", "symlinks": list(records)}
        check_unused(profile)
        for name, original in records.items():
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            current = (info.st_dev, info.st_ino, os.readlink(name, dir_fd=fd))
            if not stat.S_ISLNK(info.st_mode) or current != original:
                raise RuntimeError("Singleton symlinks changed during maintenance")
        for name in records:
            os.unlink(name, dir_fd=fd)
        return {"mode": "applied", "removed_symlinks": list(records)}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="/var/lib/playwright-mcp-aws/profile")
    parser.add_argument("--expected-lock", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    runtime = Path("/run/playwright-mcp-aws")
    runtime.mkdir(mode=0o700, exist_ok=True)
    with (runtime / "profile-maintenance.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(recover(args.profile, args.expected_lock, args.apply)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("Profile recovery refused: " + str(error))
