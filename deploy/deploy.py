#!/usr/bin/env python3
"""Build, check, and promote Voicesite under the hosting account. Run as tmn."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
PROJECT = '/srv/hosting/projects/voicesite'
UNIT = '/home/hosting/.config/containers/systemd/voicesite.container'
PUBLIC = 'https://voicesite.remoth.net'


def run(args, **kw):
    return subprocess.run(args, check=True, **kw)


def host(*args, **kw):
    return run(['hosting', *args], **kw)


def output(*args):
    return host(*args, stdout=subprocess.PIPE, text=True).stdout.strip()


def put(path, body):
    # No secrets in argv, logs, or build contexts. umask also protects the temporary file.
    host('sh', '-c', 'umask 077; cat > "$1.tmp"; mv "$1.tmp" "$1"', 'write', path,
         input=body.encode() if isinstance(body, str) else body)


def copy_tree(source, destination):
    with tempfile.TemporaryFile() as archive:
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for path in Path(source).iterdir():
                if path.name not in {'.cache', '__pycache__', 'lost+found'}:
                    tar.add(path, arcname=path.name)
        archive.seek(0)
        host('tar', '--no-same-owner', '-xf', '-', '-C', destination, stdin=archive)


def healthy(url, attempts=30):
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200 and b'Voicesite' in response.read(200_000):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f'Health check failed: {url}')


def unit(image):
    return f'''[Unit]
Description=Voicesite isolated production container
[Container]
Image={image}
ContainerName=voicesite
RunInit=true
UserNS=keep-id:uid=1000,gid=1000
User=1000:1000
Network=slirp4netns:allow_host_loopback=false
PublishPort=127.0.0.1:28767:28767
ReadOnly=true
LogDriver=k8s-file
NoNewPrivileges=true
DropCapability=all
SeccompProfile={PROJECT}/config/chromium-seccomp.json
EnvironmentFile={PROJECT}/config/runtime.env
Volume={PROJECT}/data:/data:rw
Volume={PROJECT}/models:/models:ro
Tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777
PodmanArgs=--memory=6g --memory-swap=6g --cpus=4 --pids-limit=512 --shm-size=256m --log-opt=max-size=10mb --ulimit=core=0:0
[Service]
Restart=on-failure
RestartSec=3
TimeoutStartSec=90
TimeoutStopSec=30
[Install]
WantedBy=default.target
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migrate', action='store_true', help='First deployment: copy existing data/models and retire tmn service')
    parser.add_argument('--full-check', action='store_true', help='Also exercise browser, speech, image and effects workers')
    args = parser.parse_args()
    os.chdir(ROOT)
    if os.getuid() == 0:
        raise SystemExit('Run as tmn, not root. Only the one-time bootstrap needs root.')
    host('true')
    host('mountpoint', '-q', f'{PROJECT}/data')
    host('mkdir', '-p', '/home/hosting/.config/containers/systemd', '/home/hosting/builds')
    # Serialize deployments, including from separate agent sessions.
    lock = '/home/hosting/builds/voicesite.lock'
    try:
        host('mkdir', lock)
    except subprocess.CalledProcessError:
        raise SystemExit('Another deploy is running (or its lock needs inspection).')
    stage = '/home/hosting/builds/voicesite-' + uuid.uuid4().hex
    old_unit = None
    old_stopped = False
    promoted = False
    cutover_started = False
    try:
        previous = subprocess.run(['hosting', 'cat', UNIT], capture_output=True)
        if previous.returncode == 0:
            old_unit = previous.stdout
        if args.migrate and old_unit:
            raise RuntimeError('Already containerized; omit --migrate.')
        if not args.migrate and not old_unit:
            raise RuntimeError('First deployment requires --migrate.')
        if args.migrate:
            existing = output('find', f'{PROJECT}/data', '-mindepth', '1', '-maxdepth', '1', '!', '-name', 'lost+found')
            if existing:
                raise RuntimeError('Migration destination has existing data. Inspect it before retrying; nothing was overwritten.')
        host('mkdir', '-p', stage)
        with tempfile.TemporaryFile() as archive:
            with tarfile.open(fileobj=archive, mode='w') as tar:
                for name in ['package.json', 'pnpm-lock.yaml', '.containerignore', 'server', 'web', 'deploy']:
                    tar.add(ROOT / name, arcname=name, filter=lambda i: None if '__pycache__' in i.name else i)
            archive.seek(0)
            host('tar', '--no-same-owner', '-xf', '-', '-C', stage, stdin=archive)
        tag = 'localhost/voicesite:build-' + uuid.uuid4().hex
        host('podman', 'build', '-t', tag, '-f', stage + '/deploy/Containerfile', stage)
        image = output('podman', 'image', 'inspect', '--format', '{{.Id}}', tag)
        # Chrome chroots inside its nested user namespace. Podman's default profile
        # blocks that syscall after cap-drop=all, even though the nested namespace
        # has its own capabilities. Permit only that syscall; retain all others.
        profile = json.loads(output('cat', '/usr/share/containers/seccomp.json'))
        for rule in profile['syscalls']:
            rule['names'] = [name for name in rule['names'] if name != 'chroot']
        profile['syscalls'] = [rule for rule in profile['syscalls'] if rule['names']]
        profile['syscalls'].append({'names':['chroot'], 'action':'SCMP_ACT_ALLOW', 'args':[]})
        put(f'{PROJECT}/config/chromium-seccomp.json', json.dumps(profile))
        if args.migrate:
            # Extract only needed settings; never copy tmn's paths or other secrets to the image.
            settings = json.loads(run(['node', '--env-file=.env', '-e',
                'console.log(JSON.stringify({password:process.env.ADMIN_PASSWORD,models:process.env.KOKORO_MODELS}))'],
                stdout=subprocess.PIPE, text=True).stdout)
            password = settings.get('password', '')
            if not password or '\n' in password or '\r' in password:
                raise RuntimeError('A single-line ADMIN_PASSWORD is required.')
            host('mkdir', '-p', f'{PROJECT}/models/kokoro')
            copy_tree(settings['models'], f'{PROJECT}/models/kokoro')
            copy_tree(ROOT / 'models', f'{PROJECT}/models')
            put(f'{PROJECT}/config/runtime.env', f'ADMIN_PASSWORD={password}\n')
        # Candidate is checked with private scratch data and no production secrets.
        smoke = 'voicesite-check-' + uuid.uuid4().hex[:12]
        common = ['--init', '--userns=keep-id:uid=1000,gid=1000', '--user=1000:1000', '--read-only',
                  '--cap-drop=all', '--security-opt=no-new-privileges',
                  f'--security-opt=seccomp={PROJECT}/config/chromium-seccomp.json',
                  '--ulimit=core=0:0', '--memory=6g', '--memory-swap=6g',
                  '--cpus=4', '--pids-limit=512', '--shm-size=256m',
                  '--network=slirp4netns:allow_host_loopback=false',
                  '--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777',
                  '--tmpfs=/data:rw,nosuid,nodev,size=128m,mode=1777',
                  '-v', f'{PROJECT}/models:/models:ro']
        # The bootstrap firewall must be active before any production promotion.
        run(['systemctl', 'is-active', '--quiet', 'hosting-egress.service'])
        if args.migrate or args.full_check:
            host('podman', 'run', '--rm', *common, image, 'node', 'deploy/container-check.mjs')
        host('podman', 'run', '-d', '--name', smoke, *common, '-p', '127.0.0.1::28767', image)
        try:
            port = output('podman', 'port', smoke, '28767/tcp').rsplit(':', 1)[1]
            healthy('http://127.0.0.1:' + port)
        finally:
            host('podman', 'rm', '-f', smoke)
        cutover_started = True
        if args.migrate:
            run(['systemctl', '--user', 'stop', 'voicesite.service'])
            old_stopped = True
            copy_tree(ROOT / 'data', f'{PROJECT}/data')
        if old_unit:
            put(UNIT + '.previous', old_unit)
        put(UNIT, unit(image))
        host('systemctl', '--user', 'daemon-reload')
        host('systemctl', '--user', 'restart', 'voicesite.service')
        healthy('http://127.0.0.1:28767')
        healthy(PUBLIC)
        promoted = True
        if args.migrate:
            run(['systemctl', '--user', 'disable', 'voicesite.service'])
        host('podman', 'tag', image, 'localhost/voicesite:live')
        print(f'Deployed {image[:19]} to {PUBLIC}; previous image and original data retained.')
    except BaseException:
        if cutover_started and not promoted and (old_stopped or old_unit):
            subprocess.run(['hosting', 'systemctl', '--user', 'stop', 'voicesite.service'])
            if old_unit:
                put(UNIT, old_unit)
                host('systemctl', '--user', 'daemon-reload')
                host('systemctl', '--user', 'start', 'voicesite.service')
            elif old_stopped:
                subprocess.run(['hosting', 'rm', '-f', UNIT])
                subprocess.run(['hosting', 'systemctl', '--user', 'daemon-reload'])
                run(['systemctl', '--user', 'start', 'voicesite.service'])
        raise
    finally:
        host('rm', '-rf', stage)
        host('rmdir', lock)


if __name__ == '__main__':
    main()
