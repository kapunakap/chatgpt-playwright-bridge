# Contributing

Thanks for improving `playwright-mcp-aws`.

## Before opening a pull request

Keep changes focused and preserve the project's security model: no public inbound MCP or SSH port, least-privilege AWS access, runtime credentials in SSM Parameter Store, and a persistent browser profile that is treated as sensitive.

Never commit real API keys, tunnel credentials, AWS credentials, browser cookies, private keys, account-specific ARNs, or deployment-specific secrets. Use obvious placeholders in examples.

For non-trivial behavior changes, explain the problem, the security implications, and how you validated the change.

## Validation

Run the same checks as CI where your environment supports them:

```bash
bash -n scripts/*.sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.cjs
python3 scripts/sync-template.py --check

cp .env.example .env
export OPENAI_RUNTIME_API_KEY_FILE="$(mktemp)"
printf 'not-a-real-key\n' > "$OPENAI_RUNTIME_API_KEY_FILE"
docker compose --env-file .env config >/dev/null
rm -f "$OPENAI_RUNTIME_API_KEY_FILE" .env

cfn-lint infra/cloudformation.yaml
```

Do not run deployment or browser smoke tests against production credentials merely to validate a pull request.

## Embedded runtime files

CloudFormation embeds the runtime files used at first boot. If you change any embedded runtime file, run:

```bash
python3 scripts/sync-template.py
```

Then include the generated `infra/cloudformation.yaml` change in the same pull request. CI verifies parity.

## Upstream components

This repository integrates, but does not vendor, Microsoft Playwright MCP, OpenAI tunnel-client, Nginx, Docker, Amazon Linux, and AWS services. Prefer upstream fixes when a problem belongs to an upstream component rather than adding a permanent compatibility workaround here.
