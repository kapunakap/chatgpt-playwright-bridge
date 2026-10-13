#!/usr/bin/env bash
set -euo pipefail
# AWS_PROFILE is inherited. Nothing is published or added to the security group.
region="${AWS_REGION:-us-east-1}"
stack="${LIVE_VIEW_STACK:-playwright-mcp-aws}"
port="${LIVE_VIEW_LOCAL_PORT:-6080}"
for binary in aws session-manager-plugin python3 curl; do
  command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 1; }
done
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || { echo 'Invalid local port' >&2; exit 1; }
instance="${LIVE_VIEW_INSTANCE:-$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)}"
[[ "$instance" =~ ^i-[0-9a-f]+$ ]] || { echo 'Unable to resolve EC2 instance' >&2; exit 1; }
# Refuse an occupied port so we cannot accidentally open a different service.
python3 - "$port" <<'PY'
import socket, sys
with socket.socket() as s:
    try:
        s.bind(('127.0.0.1', int(sys.argv[1])))
    except OSError:
        sys.exit('Local port is occupied. Close the viewer terminal or set LIVE_VIEW_LOCAL_PORT=6081.')
PY
work="$(mktemp -d "${TMPDIR:-/tmp}/playwright-live-view.XXXXXXXX")"
chmod 700 "$work"
forward_pid=''
cleanup() {
  if [[ -n "$forward_pid" ]]; then
    session_id="$(awk '/Starting session with SessionId:/{print $NF;exit}' "$work/ssm.log" 2>/dev/null || true)"
    if [[ -n "$session_id" ]]; then
      aws ssm terminate-session --region "$region" --session-id "$session_id" >/dev/null 2>&1 || true
    fi
    if command -v pgrep >/dev/null; then
      pgrep -P "$forward_pid" | while read -r child_pid; do kill "$child_pid" 2>/dev/null || true; done
    fi
    kill "$forward_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Only a token hash enters SSM command history. The token stays on this Mac.
python3 - "$work" <<'PY'
import hashlib, json, pathlib, secrets, sys, time
root=pathlib.Path(sys.argv[1]); token=secrets.token_hex(32)
(root/'token').write_text(token)
access=json.dumps({'hash':hashlib.sha256(token.encode()).hexdigest(),'expires':int((time.time()+8*3600)*1000)})
command="install -d -o 1000 -g 1000 -m 0700 /run/playwright-live-view; printf '%s' '"+access+"' > /run/playwright-live-view/access.json; chown 1000:1000 /run/playwright-live-view/access.json; chmod 0600 /run/playwright-live-view/access.json"
(root/'parameters.json').write_text(json.dumps({'commands':[command]}))
PY
command_id="$(aws ssm send-command --region "$region" --instance-ids "$instance" --document-name AWS-RunShellScript --parameters "file://$work/parameters.json" --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$region" --command-id "$command_id" --instance-id "$instance"
[[ "$(aws ssm get-command-invocation --region "$region" --command-id "$command_id" --instance-id "$instance" --query Status --output text)" == Success ]] || { echo 'Viewer authorization failed' >&2; exit 1; }
aws ssm start-session --region "$region" --target "$instance" --document-name AWS-StartPortForwardingSession --parameters "{\"portNumber\":[\"6080\"],\"localPortNumber\":[\"$port\"]}" > "$work/ssm.log" 2>&1 &
forward_pid=$!
ready=false
for ((attempt=0; attempt<40; attempt++)); do
  kill -0 "$forward_pid" 2>/dev/null || { cat "$work/ssm.log" >&2; exit 1; }
  if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.5
done
[[ "$ready" == true ]] || { echo 'SSM viewer forwarding did not become ready' >&2; exit 1; }
url="http://127.0.0.1:$port/#$(cat "$work/token")"
if [[ "$(uname -s)" == Darwin ]]; then open -a "${LIVE_VIEW_CHROME_APP:-/Applications/Google Chrome.app}" "$url"; else xdg-open "$url"; fi
unset url
printf 'Live browser opened. Keep this terminal running; Ctrl+C closes the SSM connection.\n'
wait "$forward_pid"
