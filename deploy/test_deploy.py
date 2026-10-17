"""Cutover failure tests. No containers, services, secrets, or production data are touched."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class CutoverTests(unittest.TestCase):
    def exercise(self, *, build_failure=False, health_failure=False, migration_copy_failure=False):
        calls, writes = [], []
        previous = b'[Container]\nImage=previous-image\n'
        migration = migration_copy_failure

        def host(*args, **kwargs):
            calls.append(('hosting', *args))
            if build_failure and args[:2] == ('podman', 'build'):
                raise RuntimeError('build failed')

        def run(args, **kwargs):
            calls.append(tuple(args))
            if args[0] == 'node':
                return subprocess.CompletedProcess(args, 0, '{"password":"fixture-only","models":"unused"}')
            return subprocess.CompletedProcess(args, 0)

        def raw_run(args, **kwargs):
            calls.append(tuple(args))
            if args[:2] == ['hosting', 'cat']:
                return subprocess.CompletedProcess(args, 1 if migration else 0, b'' if migration else previous)
            return subprocess.CompletedProcess(args, 0)

        def output(*args):
            if args[0] == 'find':
                return ''
            if args[0] == 'cat':
                return '{"syscalls":[{"names":["chroot","read"],"action":"SCMP_ACT_ALLOW"}]}'
            if args[:2] == ('podman', 'port'):
                return '127.0.0.1:29999'
            return 'candidate-image'

        def healthy(url, **kwargs):
            if health_failure and url == 'http://127.0.0.1:28767':
                raise RuntimeError('candidate unhealthy')

        def copy_tree(source, target):
            if migration_copy_failure and target.endswith('/data'):
                raise RuntimeError('data copy failed')

        argv = ['deploy.py', '--migrate'] if migration else ['deploy.py']
        with patch.object(deployment, 'host', host), patch.object(deployment, 'run', run), \
             patch.object(deployment, 'output', output), patch.object(deployment, 'healthy', healthy), \
             patch.object(deployment, 'copy_tree', copy_tree), \
             patch.object(deployment, 'put', lambda p, b: writes.append((p, b))), \
             patch.object(deployment.subprocess, 'run', raw_run), \
             patch.object(deployment.os, 'getuid', return_value=1000), \
             patch('sys.argv', argv):
            with self.assertRaises(RuntimeError):
                deployment.main()
        return calls, writes, previous

    def test_failed_build_does_not_restart_or_stop_production(self):
        calls, writes, _ = self.exercise(build_failure=True)
        self.assertFalse(any('systemctl' in call for call in calls))
        self.assertEqual(writes, [])

    def test_unhealthy_cutover_restores_previous_unit_and_service(self):
        calls, writes, previous = self.exercise(health_failure=True)
        self.assertEqual(writes[-1], (deployment.UNIT, previous))
        self.assertIn(('hosting', 'systemctl', '--user', 'stop', 'voicesite.service'), calls)
        self.assertIn(('hosting', 'systemctl', '--user', 'start', 'voicesite.service'), calls)

    def test_failed_data_copy_restores_legacy_service_without_disabling_it(self):
        calls, _, _ = self.exercise(migration_copy_failure=True)
        self.assertIn(('systemctl', '--user', 'stop', 'voicesite.service'), calls)
        self.assertIn(('systemctl', '--user', 'start', 'voicesite.service'), calls)
        self.assertNotIn(('systemctl', '--user', 'disable', 'voicesite.service'), calls)


if __name__ == '__main__':
    unittest.main()
