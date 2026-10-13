# ChatGPT Playwright Bridge
<img width="2172" height="724" alt="ChatGPT Image Aug 27, 2026, 01_46_59 AM" src="https://github.com/user-attachments/assets/880739e2-b965-45ce-bbba-fd6b0473b5bc" />

Self-host the official Microsoft Playwright MCP on a small AWS EC2 instance and connect it to ChatGPT through OpenAI Secure MCP Tunnel.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> EC2 -> internal Nginx compatibility proxy -> Playwright MCP -> Chromium
```

The MCP port is never published to the Internet. The EC2 security group has no inbound rules; both the tunnel and Chromium make outbound connections only. Administration is through AWS Systems Manager Session Manager (SSM), not SSH.

## MVP defaults

- AWS region: `us-east-1`
- EC2: `t4g.medium` (ARM64/Graviton, 4 GiB RAM)
- OS: Amazon Linux 2023, kernel 6.1 AMI family
- Playwright MCP: `v0.0.82`, pinned to the ARM64-compatible digest already used by this deployment
- Playwright MCP heartbeat: disabled with `PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0`
- Stale-tab reaper: enabled with `TAB_REAPER_IDLE_MS=1800000` (30 minutes) and `TAB_REAPER_INTERVAL_MS=60000` (60 seconds)
- OpenAI tunnel-client: official stable v0.0.11 GHCR ARM64 digest `ghcr.io/openai/tunnel-client@sha256:c22610c17e4f624fa8114fb93d7d5df915ce7a4d3fe115a6c41ba4677ea54819`
- Internal compatibility proxy: official Nginx `1.29.8-alpine` multi-architecture digest
  `nginx:1.29.8-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de`
- Docker Compose: `v5.4.0`
- Root disk: 20 GiB encrypted gp3
- Browser profile: persistent EBS-backed host directory
- Public inbound ports: none

Both upstream containers publish Linux ARM64 builds. If ARM64 causes a real runtime problem, deploy with `Architecture=x86_64` and an x86 instance type with at least 4 GiB RAM, such as `t3a.medium`.

The template intentionally pins AL2023 to the kernel 6.1 AMI family instead of `kernel-default`. AWS changed the default AL2023 kernel from 6.1 to 6.18 on August 17, 2026; pinning 6.1 removes that fresh variable from the MVP. The AMI itself still resolves through AWS's version-specific public SSM alias, so patched 6.1 images continue to be selected.

## Prerequisites

1. An AWS account and CLI credentials that can deploy CloudFormation/IAM/EC2/SSM resources.
2. An OpenAI Secure MCP Tunnel ID (`tunnel_...`).
3. An OpenAI **runtime** API key with `Tunnels Read + Use` for that tunnel.

The repository may remain private. The CloudFormation template embeds the small runtime files needed at first boot, so EC2 does not need a GitHub token or repository access.

Do **not** commit the OpenAI runtime API key. It belongs in SSM Parameter Store as a `SecureString`.

Before running any AWS CLI command, select the intended account and region, then verify the identity:

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

On Amazon Linux 2023, the bootstrap keeps the existing `curl-minimal` package. It installs `curl-minimal` only if no `curl` command is present; replacing it with the full `curl` package can cause a package conflict.

## 0. Create the OpenAI Secure MCP Tunnel

In the OpenAI Platform tunnel settings, create a tunnel such as `playwright-mcp-aws`.

When creating it, select **both**:

- **Organization** — the OpenAI Platform organization that owns the tunnel and runtime API key.
- **ChatGPT workspace** — the ChatGPT workspace that should be allowed to use the tunnel.

For a personal setup, choose your personal Platform organization and your personal ChatGPT workspace. Selecting the ChatGPT workspace is important so the tunnel can be used from ChatGPT; selecting the organization ties it to the Platform-side API permissions.

A description such as `Private tunnel to self-hosted Playwright MCP on AWS` is sufficient.

After creation:

1. Copy the resulting `tunnel_...` ID. The tunnel ID is configuration, not a secret.
2. Create a **Restricted** OpenAI runtime API key with only **Tunnels: Read + Use** permissions.
3. Treat the `sk-...` runtime key as a secret. Do not commit it, paste it into issues, or place it in `.env` files tracked by Git.
4. Store the runtime key in AWS SSM Parameter Store as described below.

## 1. Store the runtime key

Choose the same region you will deploy into (default `us-east-1`):

```bash
export AWS_REGION=us-east-1
export OPENAI_RUNTIME_API_KEY='paste-runtime-key-here'

aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name /playwright-mcp-aws/openai-runtime-api-key \
  --type SecureString \
  --value "$OPENAI_RUNTIME_API_KEY" \
  --overwrite

unset OPENAI_RUNTIME_API_KEY
```

The command above places the secret in AWS, not in this repository. Avoid saving the key in shell history if your shell records environment assignments.

## 2. Deploy

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name playwright-mcp-aws \
  --template-file infra/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    TunnelId=tunnel_0123456789abcdef0123456789abcdef
```

Useful overrides:

```text
InstanceType=t4g.medium
Architecture=arm64
VolumeSize=20
PlaywrightMcpImage=mcr.microsoft.com/playwright/mcp@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734
TunnelClientImage=ghcr.io/openai/tunnel-client@sha256:c22610c17e4f624fa8114fb93d7d5df915ce7a4d3fe115a6c41ba4677ea54819
```

The stack creates a dedicated VPC/public subnet, one EC2 instance, a no-ingress security group, an SSM-capable IAM role, and the smallest permissions needed to read the one runtime-key parameter.

A public IPv4 address is used only for cheap outbound Internet access. There is no NAT Gateway, ALB, Route53 record, TLS listener, SSH key, or public MCP port.

## 3. Inspect through SSM

Get the instance ID:

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name playwright-mcp-aws \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text
```

Then:

```bash
aws ssm start-session --target i-xxxxxxxxxxxxxxxxx
```

On the instance:

```bash
sudo systemctl status playwright-mcp-aws
cd /opt/playwright-mcp-aws
sudo docker compose --env-file .env ps
sudo docker compose --env-file .env logs --tail=100
```

Compose waits for the Playwright MCP HTTP endpoint before starting the tunnel client, and reports tunnel readiness through its container health check. Both services should be running and healthy before running the smoke test.

## Temporary MCP compatibility proxy

The internal `mcp-proxy` service exists only because Playwright MCP currently returns `400 Invalid request` for its absent OAuth Protected Resource Metadata paths, while tunnel-client's no-auth discovery path expects `404`. Nginx returns `404` only for those two exact metadata paths and proxies all other MCP traffic to Playwright, including session and authorization headers and streaming requests.

Remove `mcp-proxy` and `mcp-proxy.conf` when either upstream changes this behavior: restore the tunnel target to `http://playwright:8931/mcp`, restore the direct Playwright dependency, remove the bootstrap/template config embedding, redeploy cleanly, and re-run readiness, smoke, persistence, and reboot checks.

## 4. Local EC2 smoke test

From the SSM shell:

```bash
sudo /opt/playwright-mcp-aws/start.sh
```

The repository also includes `scripts/smoke-test.sh`; copy/run it on the instance if you want a protocol-level preflight. It verifies the tunnel readiness endpoint, discovers Playwright MCP tools, opens `https://example.com`, takes a screenshot, reads console messages, and inspects network requests.

## 5. ChatGPT acceptance test

After associating the tunnel with your ChatGPT app/workspace, ask ChatGPT to use this MCP and verify all of the following:

1. Open a webpage.
2. Click/type on the page.
3. Take a screenshot.
4. Read browser console messages.
5. Inspect network requests.
6. Set a cookie/localStorage marker.
7. Restart the Playwright container through SSM and verify the marker survives.
8. Reboot EC2 and verify Docker + the tunnel reconnect automatically, then navigate again from ChatGPT.

That is the MVP definition of done.

## Resource and profile safeguards

Playwright is capped at 2560 MiB, the tunnel at 256 MiB, and Nginx at 64 MiB.
Memory-plus-swap limits equal the RAM limits; these containers cannot use swap.
The remaining host RAM is reserved for Linux, Docker, and SSM. A memory cap can
still terminate a heavy browser workload; it prevents that workload from taking
all host memory. No automatic host reboot or profile deletion is configured.

The browser has a stable hostname, `playwright-mcp-aws-browser`. Its profile is
still persistent and shared between MCP clients. Do not add `--isolated` as a
lock workaround: that changes the persistence behavior.

For a stale lock left by an older container hostname, first stop the systemd
service and inspect the lock target. Run `recover-profile.py --expected-lock
OLD_HOST-PID` for a dry run, then repeat with `--apply` only after verifying the
owner is gone. The helper refuses active services, running containers mounting
the profile, live browser processes, non-local filesystems, changed locks, and
non-symlink entries. It removes only `SingletonLock`, `SingletonSocket`, and
`SingletonCookie`, never their targets or other profile files.

`playwright-resource-sample.timer` records numeric host and container resource
measurements every minute in `/var/log/playwright-mcp-aws/resources.jsonl`.
Logs are root-only and rotate at 1 MiB with four backups. They include available
RAM, pressure, cgroup memory/OOM counters, and Chrome/Node RSS sums (shared pages
may be counted more than once). URLs, command lines, credentials, and profile
contents are never collected.

`smoke-test.sh` now verifies real navigation, tab listing, and PNG image content
and fails on MCP tool-level errors. `smoke-test.sh 31 60` runs at least 30 minutes
of checks against Example Domain. This uses the shared browser; run it only in
a maintenance window. Container health remains a transport check, not proof
that browser actions work.

The `tab-reaper` sidecar uses the same pinned Playwright MCP image with a
different entrypoint and connects only to the internal `mcp-proxy`; it does not
create a second browser or profile. Every 60 seconds it checks activity across
the shared context and closes tabs idle for 30 minutes. Navigation, visibility
changes/becoming visible, pointer/touch input, typing and form input, and wheel
input count as activity. It never selects tabs, keeps pages it cannot inspect, never closes
the last tab, and emits counts/diagnostics without URLs, titles, or page data.

After editing runtime files, run `python3 scripts/sync-template.py`. CI checks
that the compressed CloudFormation boot payload matches the source files.
For an existing instance, install the reviewed files through SSM; user-data
updates do not replace that deployment step. Preserve the deployed AMI and
reject any change set that replaces the existing instance or volume.

## Interactive live browser screen

From the repository on your Mac, with AWS CLI and Session Manager plugin installed:

```bash
AWS_PROFILE=your-profile ./scripts/open-live-view.sh
```

The helper resolves the existing instance from `playwright-mcp-aws` in `us-east-1`,
creates an eight-hour viewer credential, starts SSM port forwarding, and opens
Google Chrome. Keep that terminal running; Ctrl+C closes forwarding. If needed,
set `LIVE_VIEW_LOCAL_PORT=6081`, `LIVE_VIEW_STACK`, or `LIVE_VIEW_INSTANCE`.
The operator needs `cloudformation:DescribeStacks`, SSM `SendCommand` for this
instance and `AWS-RunShellScript`, command status/wait permissions, and
`StartSession` for `AWS-StartPortForwardingSession` plus session termination.
Use your existing authorized operator role; the EC2 role is unchanged.

The screen starts **read-only**. Check **Enable control**, then click the screen
and type or scroll. Click the tab buttons to select an existing tab. Each tab has an **×** close button,
enabled when you have control. Closing the last tab leaves a new blank tab in the
same profile. Closing is immediate and discards unsaved page state. Paste text
uses the Mac clipboard when permitted, with a text prompt fallback. Refresh
reconnects the stream; running the launcher again renews access and invalidates
older viewer credentials. One viewer can control at a time. ChatGPT and the human
share input; pause ChatGPT before editing sensitive forms. There is no automation
lock or arbitration against ChatGPT actions.

This uses Chrome DevTools Protocol `Page.startScreencast` and input events,
with the open-source `ws` code already bundled in the pinned Playwright image.
It attaches to the Chromium process launched by MCP and never launches another
browser, desktop, display server, or profile. The viewer follows MCP's selected
tab. Its tab selection uses MCP itself, and the existing deployed shared-tab
compatibility patch now synchronizes already initialized clients as well.

Only `127.0.0.1:6080` is published on EC2. CDP `9222` is on container loopback,
shared only with the viewer's network namespace, and is never published. The
viewer checks Host, WebSocket Origin and a temporary bearer credential before
streaming or accepting input; arbitrary CDP commands are not forwarded. The
credential is passed in a URL fragment, removed from the address bar, and sent
in the WebSocket protocol header. Only its SHA-256 hash and expiry enter SSM
command history. `/run` credentials vanish on EC2 reboot. No security-group
rule, paid service, public listener, OpenAI tunnel change, or extra EC2 is needed.
An authenticated public HTTPS viewer is deferred; the MCP tunnel is not used as
an HTTP viewer proxy.

The viewer has a 128 MiB RAM cap and stops screencasting when nobody is watching.
It touches the existing tab-reaper activity marker while displaying a tab, so
read-only viewing protects that tab too. It retains its upstream MCP session:
upstream deletes the shared browser when its last client is deleted. Restarting
only the viewer does not delete that MCP session or close Chromium. After
recreating the Playwright container, also recreate `live-view`, because it shares
that container's network namespace. Reconnect the tunnel after an MCP restart
if the client still holds a terminated MCP session.

For a first installation on an existing instance, back up its runtime files,
stop new browser work, save tab URLs/selection and cookie hashes through
`scripts/live-view-maintenance.cjs`, then install the runtime files through SSM.
Enable the private CDP launch configuration with one graceful browser restart,
restore tabs, and verify the profile. Tabs reload during this first restart;
unsaved page/form state cannot survive a Chromium restart. No profile recovery,
profile deletion, `--isolated`, instance replacement, or volume replacement is
part of this rollout. Keep the deployed `.env` and local overrides.

New instances receive the larger viewer files through CloudFormation Init
metadata; `scripts/sync-template.py` checks both the compressed payload and
metadata against source, keeping EC2 user data below 15 KiB. Existing-instance
rollouts copy reviewed files directly; changing user data is not a runtime
installation step.

`tests/live-view-integration.js` runs inside a **separate temporary driver
container**, with the existing Chromium only. It requires a temporary
`/run/live-view/test-token` matching `access.json`, and must run in a maintenance
window: it creates a fixture tab, proves input and streaming in both directions,
rejects unauthorized access and read-only input, exercises the rendered viewer
UI, and closes its fixture. Run it with `docker compose run --rm --no-deps
--entrypoint node live-view /opt/viewer/integration.cjs` after copying the driver
there through SSM. Do not run the driver with `docker exec` inside the viewer's
memory budget. No page contents, cookies, tokens, titles or URLs are logged.

## Security notes

- The repository contains no credentials or deployment-specific tunnel IDs.
- The OpenAI runtime key is read from SSM `SecureString` into `/run` at service start and mounted into the tunnel container as a file.
- EC2 requires IMDSv2 and sets the response hop limit to 1, reducing metadata exposure from bridged containers.
- Playwright MCP is **not** itself a security boundary. A browser automation service can reach arbitrary websites, so this stack uses a dedicated VPC rather than joining unrelated private infrastructure.
- The browser profile can contain authenticated cookies. Treat the EC2/EBS volume as sensitive even if the repository is later made public.
- The browser data directory is created on the EC2 host with uid/gid `1000`, matching the non-root `node` user in the official Playwright MCP image.

## Configuration philosophy

The MVP intentionally keeps the knobs small: instance type/architecture, disk size, upstream image versions, tunnel ID, and SSM parameter name. Everything else has an opinionated default to reduce debugging surface.
