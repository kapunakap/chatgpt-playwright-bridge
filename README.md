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
- Playwright MCP: `mcr.microsoft.com/playwright/mcp:v0.0.79`
- Playwright MCP heartbeat: disabled with `PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0`
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
PlaywrightMcpImage=mcr.microsoft.com/playwright/mcp:v0.0.79
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

After editing runtime files, run `python3 scripts/sync-template.py`. CI checks
that the compressed CloudFormation boot payload matches the source files.
For an existing instance, install the reviewed files through SSM; user-data
updates do not replace that deployment step. Preserve the deployed AMI and
reject any change set that replaces the existing instance or volume.

## Security notes

- The repository contains no credentials or deployment-specific tunnel IDs.
- The OpenAI runtime key is read from SSM `SecureString` into `/run` at service start and mounted into the tunnel container as a file.
- EC2 requires IMDSv2 and sets the response hop limit to 1, reducing metadata exposure from bridged containers.
- Playwright MCP is **not** itself a security boundary. A browser automation service can reach arbitrary websites, so this stack uses a dedicated VPC rather than joining unrelated private infrastructure.
- The browser profile can contain authenticated cookies. Treat the EC2/EBS volume as sensitive even if the repository is later made public.
- The browser data directory is created on the EC2 host with uid/gid `1000`, matching the non-root `node` user in the official Playwright MCP image.

## Configuration philosophy

The MVP intentionally keeps the knobs small: instance type/architecture, disk size, upstream image versions, tunnel ID, and SSM parameter name. Everything else has an opinionated default to reduce debugging surface.
