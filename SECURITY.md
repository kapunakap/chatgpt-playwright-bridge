# Security Policy

## Supported version

Security fixes target the current `main` branch. This project is small and does not maintain separate supported release branches yet.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities that could expose credentials, browser-profile data, tunnel access, AWS resources, or remote-code execution paths.

Use GitHub's private vulnerability reporting for this repository when it is available. If it is not available, use a private contact method listed on the repository owner's GitHub profile. Do not include secrets, session cookies, API keys, tunnel credentials, or other live credentials in a report.

Include enough information to reproduce and assess the problem safely: the affected revision, deployment configuration, impact, and a minimal reproduction where possible. Redact account IDs and other deployment-specific identifiers unless they are essential.

If you believe a credential has been exposed, rotate or revoke it immediately; do not wait for a code fix.

Vulnerabilities in Playwright MCP, OpenAI tunnel-client, Nginx, Docker, Amazon Linux, or AWS services should also be reported to the relevant upstream project or vendor when the issue is not caused by this repository's integration code.
