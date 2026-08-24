#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"

api="http://127.0.0.1:8082"
image=""
output=""
seed="42"
resolution="512"
bg_removal="birefnet"
uv="xatlas"
poll_seconds="2"
force="0"
job_id=""

usage() {
  cat <<'EOF'
Usage: triastasis_generate.sh --image PATH --output PATH [options]

Options:
  --seed N                 Default: 42
  --resolution N           512, 1024, or 1536. Default: 512
  --bg-removal MODE        auto, birefnet, or threshold. Default: birefnet
  --uv MODE                xatlas or box. Default: xatlas
  --api URL                Default: http://127.0.0.1:8082
  --poll-seconds N         Default: 2
  --force                  Replace an existing output file
  --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) image="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --seed) seed="${2:-}"; shift 2 ;;
    --resolution) resolution="${2:-}"; shift 2 ;;
    --bg-removal) bg_removal="${2:-}"; shift 2 ;;
    --uv) uv="${2:-}"; shift 2 ;;
    --api) api="${2:-}"; shift 2 ;;
    --poll-seconds) poll_seconds="${2:-}"; shift 2 ;;
    --force) force="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$image" && -n "$output" ]] || { usage >&2; exit 2; }
[[ -f "$image" ]] || { echo "Input image not found: $image" >&2; exit 2; }
[[ "$resolution" =~ ^(512|1024|1536)$ ]] || { echo "Invalid resolution: $resolution" >&2; exit 2; }
[[ "$bg_removal" =~ ^(auto|birefnet|threshold)$ ]] || { echo "Invalid background removal: $bg_removal" >&2; exit 2; }
[[ "$uv" =~ ^(xatlas|box)$ ]] || { echo "Invalid UV mode: $uv" >&2; exit 2; }
[[ "$seed" =~ ^[0-9]+$ ]] || { echo "Seed must be a nonnegative integer" >&2; exit 2; }
[[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "Poll interval must be a positive integer" >&2; exit 2; }
[[ ! -e "$output" || "$force" == "1" ]] || { echo "Output exists; pass --force to replace it: $output" >&2; exit 2; }

command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v python >/dev/null || { echo "python is required for JSON parsing" >&2; exit 2; }

json_field() {
  local field="$1"
  python -c "import json,sys; value=json.load(sys.stdin).get('$field', ''); print(value if value is not None else '')"
}

cancel_queued() {
  if [[ -n "$job_id" ]]; then
    curl --silent --show-error --request DELETE "$api/jobs/$job_id" >/dev/null || true
  fi
}
trap 'cancel_queued; exit 130' INT TERM

curl --fail --silent --show-error "$api/health" >/dev/null || {
  echo "Triastasis automation is unavailable at $api. Start the desktop app first." >&2
  exit 3
}

capabilities="$(curl --fail --silent --show-error "$api/capabilities")"
policy="$(printf '%s' "$capabilities" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('capabilities',{}).get('policy','unknown'))")"
echo "Triastasis policy: $policy" >&2

submission="$(curl --fail --silent --show-error "$api/jobs" \
  -F "image=@$image" \
  -F "seed=$seed" \
  -F "resolution=$resolution" \
  -F "bg_removal=$bg_removal" \
  -F "uv=$uv")"

job_id="$(printf '%s' "$submission" | json_field id)"
status_url="$(printf '%s' "$submission" | json_field statusUrl)"
model_url="$(printf '%s' "$submission" | json_field modelUrl)"
queue_position="$(printf '%s' "$submission" | json_field queuePosition)"
jobs_ahead="$(printf '%s' "$submission" | json_field jobsAhead)"
[[ -n "$job_id" && -n "$status_url" && -n "$model_url" ]] || {
  echo "Unexpected submission response: $submission" >&2
  exit 4
}

echo "Job ID: $job_id" >&2
if [[ "$jobs_ahead" =~ ^[0-9]+$ && "$jobs_ahead" -gt 0 ]]; then
  echo "Queue: position ${queue_position:-unknown}; ${jobs_ahead} job(s) ahead" >&2
else
  echo "Queue: next available job" >&2
fi
started="$(date +%s)"
while true; do
  status_json="$(curl --fail --silent --show-error "$status_url")"
  status="$(printf '%s' "$status_json" | json_field status)"
  current_position="$(printf '%s' "$status_json" | json_field queuePosition)"
  current_ahead="$(printf '%s' "$status_json" | json_field jobsAhead)"
  elapsed="$(( $(date +%s) - started ))"
  queue_label=""
  if [[ "$status" == "queued" && "$current_ahead" =~ ^[0-9]+$ ]]; then
    queue_label=" · pos ${current_position:-?}, ${current_ahead} ahead"
  fi
  printf '\r%-12s%-32s %4ss' "$status" "$queue_label" "$elapsed" >&2
  case "$status" in
    succeeded) printf '\n' >&2; break ;;
    failed)
      printf '\n' >&2
      error="$(printf '%s' "$status_json" | json_field error)"
      echo "Generation failed: $error" >&2
      exit 5
      ;;
    cancelled)
      printf '\nGeneration cancelled\n' >&2
      exit 6
      ;;
    queued|running) sleep "$poll_seconds" ;;
    *) printf '\nUnknown job state: %s\n' "$status" >&2; exit 4 ;;
  esac
done

mkdir -p "$(dirname "$output")"
curl --fail --silent --show-error "$model_url" --output "$output"

python - "$output" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
data = path.read_bytes()
if len(data) < 20 or data[:4] != b"glTF":
    raise SystemExit(f"Downloaded file is not a valid GLB: {path}")
print(f"Saved {path} ({len(data) / 1_000_000:.1f} MB)")
PY

job_id=""
