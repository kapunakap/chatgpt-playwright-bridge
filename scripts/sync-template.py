#!/usr/bin/env python3
"""Keep CloudFormation's boot payload semantically synchronized with runtime files."""
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


def runtime_block(encoded):
    return "\n".join([
        "          printf '%s' '{}' | base64 -d > \"$work/runtime.tgz\"".format(encoded),
        "          tar -xzf \"$work/runtime.tgz\" -C \"$work\"",
        "          rm -f \"$work/runtime.tgz\"",
    ]) + "\n"


def embedded_archive(text):
    pattern = re.compile(
        r"(?m)^          printf '%s' '(?P<encoded>[^']+)' \| base64 -d > \"\$work/runtime\.tgz\"\n"
        r"          tar -xzf \"\$work/runtime\.tgz\" -C \"\$work\"\n"
        r"          rm -f \"\$work/runtime\.tgz\"\n"
    )
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one embedded runtime block")
    match = matches[0]
    try:
        bundle = base64.b64decode(match.group("encoded"), validate=True)
    except Exception as error:
        raise RuntimeError("Embedded runtime archive is not valid base64") from error
    return match, bundle


def archive_matches_sources(bundle):
    try:
        with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as archive:
            if archive.getnames() != list(FILES):
                return False
            for name in FILES:
                member = archive.getmember(name)
                if not member.isfile() or archive.extractfile(member).read() != (ROOT / name).read_bytes():
                    return False
    except (OSError, tarfile.TarError, EOFError):
        return False
    return True


def user_data_bytes(text):
    payload = text.split("Fn::Base64: !Sub |\n", 1)[1].split("\nOutputs:", 1)[0]
    return len("\n".join(line[10:] for line in payload.splitlines()).encode())


def validate_template(text):
    _, bundle = embedded_archive(text)
    if not archive_matches_sources(bundle):
        raise RuntimeError("Embedded runtime archive differs from FILES")
    try:
        size = user_data_bytes(text)
    except (IndexError, ValueError) as error:
        raise RuntimeError("Expected CloudFormation user-data block") from error
    if size > 15000:
        raise RuntimeError("User data approaches EC2's 16 KiB limit")
    return size


def check_template(text):
    return validate_template(text)


def synced_template(text=None):
    text = (ROOT / "infra/cloudformation.yaml").read_text() if text is None else text
    match, bundle = embedded_archive(text)
    encoded = match.group("encoded") if archive_matches_sources(bundle) else base64.b64encode(runtime_bundle()).decode()
    updated = text[:match.start()] + runtime_block(encoded) + text[match.end():]
    validate_template(updated)
    return updated


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "infra/cloudformation.yaml"
    if args.check:
        check_template(target.read_text())
    else:
        target.write_text(synced_template())
