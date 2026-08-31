import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recovery = load("recover-profile")
metrics = load("resource-sample")
sync_spec = importlib.util.spec_from_file_location("sync_template", ROOT / "scripts" / "sync-template.py")
sync_template = importlib.util.module_from_spec(sync_spec)
sync_spec.loader.exec_module(sync_template)


class ProfileRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name).resolve()
        self.expected = "old-container-345"
        for name, target in zip(recovery.LOCK_NAMES, (self.expected, "/missing/socket", "cookie-marker")):
            (self.profile / name).symlink_to(target)
        (self.profile / "keep-profile-data").write_text("must remain")

    def test_dry_run_and_apply_preserve_profile(self):
        check = Mock()
        result = recovery.recover(self.profile, self.expected, check_unused=check)
        self.assertEqual(result["mode"], "dry-run")
        self.assertTrue((self.profile / "SingletonLock").is_symlink())
        result = recovery.recover(self.profile, self.expected, True, check)
        self.assertEqual(set(result["removed_symlinks"]), set(recovery.LOCK_NAMES))
        self.assertEqual(list(self.profile.iterdir()), [self.profile / "keep-profile-data"])
        self.assertEqual((self.profile / "keep-profile-data").read_text(), "must remain")

    def test_owner_uncertainty_never_removes_locks(self):
        for check in (Mock(side_effect=RuntimeError("browser alive")),
                      Mock(side_effect=[None, RuntimeError("container appeared")])):
            with self.assertRaises(RuntimeError):
                recovery.recover(self.profile, self.expected, True, check)
            self.assertTrue((self.profile / "SingletonLock").is_symlink())

    def test_wrong_expected_owner_and_regular_files_refused(self):
        with self.assertRaisesRegex(RuntimeError, "changed"):
            recovery.recover(self.profile, "different-123", True, Mock())
        (self.profile / "SingletonCookie").unlink()
        (self.profile / "SingletonCookie").write_text("do not delete")
        with self.assertRaisesRegex(RuntimeError, "not a symlink"):
            recovery.recover(self.profile, self.expected, True, Mock())
        self.assertTrue((self.profile / "SingletonLock").is_symlink())

    def test_lock_replaced_during_recheck_is_preserved(self):
        calls = []
        def replace(_):
            calls.append(True)
            if len(calls) == 2:
                (self.profile / "SingletonLock").unlink()
                (self.profile / "SingletonLock").symlink_to("new-container-123")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            recovery.recover(self.profile, self.expected, True, replace)
        self.assertEqual(os.readlink(self.profile / "SingletonLock"), "new-container-123")

    def test_running_service_and_mounted_profile_refuse_maintenance(self):
        with patch.object(recovery, "run", return_value="active"):
            with self.assertRaisesRegex(RuntimeError, "Stop"):
                recovery.assert_unused(self.profile)
        mounted = json.dumps([{"Mounts": [{"Source": str(self.profile.parent)}]}])
        with patch.object(recovery, "run", side_effect=["inactive", "xfs", "container-id", mounted]):
            with self.assertRaisesRegex(RuntimeError, "running container"):
                recovery.assert_unused(self.profile)


class MetricsTest(unittest.TestCase):
    def test_numeric_process_totals_with_docker_pid_column(self):
        output = "PID COMMAND RSS\n1 tini 100\n7 node 1000\n25 chrome 2000\n26 chrome_crashpad 100\n\n"
        self.assertEqual(metrics.process_rss(output), {"chrome": 2100, "node": 1000})

    def test_rotation_is_bounded_and_json_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            for index in range(30):
                metrics.append_bounded(directory, {"index": index}, max_bytes=50, backups=2)
            logs = list(Path(directory).glob("resources.jsonl*"))
            self.assertEqual(len(logs), 3)
            for path in logs:
                self.assertLessEqual(path.stat().st_size, 50)
                for line in path.read_text().splitlines():
                    self.assertIn("index", json.loads(line))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((Path(directory) / "resources.jsonl").read_text().splitlines()[-1])["index"], 29)


class TemplateSyncTest(unittest.TestCase):
    def test_runtime_bundle_is_deterministic_and_contains_exact_files(self):
        first = sync_template.runtime_bundle()
        self.assertEqual(first, sync_template.runtime_bundle())
        with tarfile.open(fileobj=io.BytesIO(first), mode="r:gz") as archive:
            self.assertEqual(archive.getnames(), list(sync_template.FILES))
            for name in sync_template.FILES:
                extracted = archive.extractfile(name).read()
                self.assertEqual(extracted, (ROOT / name).read_bytes(), name)

    def test_template_stays_within_guard_and_check_is_in_sync(self):
        rendered = sync_template.synced_template()
        payload = rendered.split("Fn::Base64: !Sub |\n", 1)[1].split("\nOutputs:", 1)[0]
        user_data = "\n".join(line[10:] for line in payload.splitlines()).encode()
        self.assertLessEqual(len(user_data), 15000)
        self.assertEqual(rendered, (ROOT / "infra/cloudformation.yaml").read_text())
        check = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "sync-template.py"), "--check"],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)


if __name__ == "__main__":
    unittest.main()
