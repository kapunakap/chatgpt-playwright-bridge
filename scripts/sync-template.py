#!/usr/bin/env python3
"""Keep CloudFormation's boot payload identical to the reviewed runtime files."""
import argparse
import base64
import gzip
import io
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parent.parent
FILES = ("docker-compose.yml", "mcp-proxy.conf", "scripts/start.sh", "scripts/bootstrap.sh",
         "scripts/smoke-test.sh", "scripts/mcp-smoke.cjs", "scripts/recover-profile.py",
         "scripts/resource-sample.py", "scripts/install-observability.sh", "scripts/tab-reaper.cjs")


def compressed(data):
    # GzipFile keeps the OS byte stable across Python versions and platforms.
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as archive:
        archive.write(data)
    return output.getvalue()


def runtime_bundle():
    """Pack names and bytes together so the CloudFormation user data stays small."""
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        for name in FILES:
            data = (ROOT / name).read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return compressed(archive.getvalue())


def synced_template():
    text = (ROOT / "infra/cloudformation.yaml").read_text()
    encoded = base64.b64encode(runtime_bundle()).decode()
    embedding = "\n".join([
        "          printf '%s' '{}' | base64 -d > \"$work/runtime.tgz\"".format(encoded),
        "          tar -xzf \"$work/runtime.tgz\" -C \"$work\"",
        "          rm -f \"$work/runtime.tgz\"",
    ])
    updated, count = re.subn(r"          printf '%s'.*?(?=          chmod \+x)", embedding + "\n", text, flags=re.S)
    if count != 1:
        raise RuntimeError("Expected exactly one embedded runtime block")
    payload = updated.split("Fn::Base64: !Sub |\n", 1)[1].split("\nOutputs:", 1)[0]
    if len("\n".join(line[10:] for line in payload.splitlines()).encode()) > 15000:
        raise RuntimeError("User data approaches EC2's 16 KiB limit")
    return updated


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "infra/cloudformation.yaml"
    updated = synced_template()
    if args.check:
        if target.read_text() != updated:
            raise SystemExit("Embedded files differ; run python3 scripts/sync-template.py")
    else:
        target.write_text(updated)
