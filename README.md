# playwright-mcp-aws

Self-host the official Microsoft Playwright MCP on a small AWS EC2 instance and connect it to ChatGPT through OpenAI Secure MCP Tunnel.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> EC2 -> Playwright MCP -> Chromium
```

The MCP port is never published to the Internet. The EC2 security group has no inbound rules; both the tunnel and Chromium make outbound connections only. Administration is through AWS Systems Manager Session Manager (SSM), not SSH.

## MVP defaults

- AWS region: `us-east-1`
- EC2: `t4g.small` (ARM64/Graviton)
- OS: Amazon Linux 2023, kernel 6.1 AMI family
- Playwright MCP: `mcr.microsoft.com/playwright/mcp:v0.0.75`
- OpenAI tunnel-client: `ghcr.io/openai/tunnel-client:v0.0.10`
- Docker Compose: `v5.4.0`
- Root disk: 20 GiB encrypted gp3
- Browser profile: persistent EBS-backed host directory
- Public inbound ports: none

Both upstream containers publish Linux ARM64 builds. If ARM64 causes a real runtime problem, deploy with `Architecture=x86_64` and an x86 instance type such as `t3a.small`.

The template intentionally pins AL2023 to the kernel 6.1 AMI family instead of `kernel-default`. AWS changed the default AL2023 kernel from 6.1 to 6.18 on August 17, 2026; pinning 6.1 removes that fresh variable from the MVP. The AMI itself still resolves through AWS's version-specific public SSM alias, so patched 6.1 images continue to be selected.

## Prerequisites

1. An AWS account and CLI credentials that can deploy CloudFormation/IAM/EC2/SSM resources.
2. An OpenAI Secure MCP Tunnel ID (`tunnel_...`).
3. An OpenAI **runtime** API key with `Tunnels Read + Use` for that tunnel.
4. This repository must be publicly readable by the EC2 bootstrap, or `RepositoryRawBaseUrl` must point to another public fork/ref.

Do **not** commit the OpenAI runtime API key. It belongs in SSM Parameter Store as a `SecureString`.

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
InstanceType=t4g.small
Architecture=arm64
VolumeSize=20
RepositoryRawBaseUrl=https://raw.githubusercontent.com/YOU/playwright-mcp-aws/main
PlaywrightMcpImage=mcr.microsoft.com/playwright/mcp:v0.0.75
TunnelClientImage=ghcr.io/openai/tunnel-client:v0.0.10
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

## Security notes

- The repository contains no credentials or deployment-specific tunnel IDs.
- The OpenAI runtime key is read from SSM `SecureString` into `/run` at service start and mounted into the tunnel container as a file.
- EC2 requires IMDSv2 and sets the response hop limit to 1, reducing metadata exposure from bridged containers.
- Playwright MCP is **not** itself a security boundary. A browser automation service can reach arbitrary websites, so this stack uses a dedicated VPC rather than joining unrelated private infrastructure.
- The browser profile can contain authenticated cookies. Treat the EC2/EBS volume as sensitive even though the repository is public.
- The browser data directory is created on the EC2 host with uid/gid `1000`, matching the non-root `node` user in the official Playwright MCP image.

## Configuration philosophy

The MVP intentionally keeps the knobs small: instance type/architecture, disk size, upstream image versions, repository ref, tunnel ID, and SSM parameter name. Everything else has an opinionated default to reduce debugging surface.
