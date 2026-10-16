#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VOICESITE_ROOT="$PWD"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/voicesite.service" <<UNIT
[Unit]
Description=Voicesite reading and Kokoro speech service
After=network.target

[Service]
Type=simple
WorkingDirectory=$VOICESITE_ROOT
ExecStart=$VOICESITE_ROOT/scripts/start.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now voicesite.service
