#!/usr/bin/env bash
set -euo pipefail
install -d -m 0700 /var/log/playwright-mcp-aws
cat > /etc/systemd/system/playwright-resource-sample.service <<'UNIT'
[Unit]
Description=Local numeric resource history for Playwright MCP
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/playwright-mcp-aws/resource-sample.py
TimeoutStartSec=25
UMask=0077
Nice=10
UNIT
cat > /etc/systemd/system/playwright-resource-sample.timer <<'UNIT'
[Unit]
Description=Sample Playwright resources every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=1s
Unit=playwright-resource-sample.service

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now playwright-resource-sample.timer
