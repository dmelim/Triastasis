#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"

api="http://127.0.0.1:8082"
source_path=""
poll_seconds="1"
timeout_seconds="300"

usage() {
  cat <<'EOF'
Usage: triastasis_import.sh (--source PATH | --source-dir DIR) [options]

Options:
  --source PATH           Import one manifest or recursively import a directory
  --source-dir DIR        Recursively import a directory (compatible alias)
  --api URL               Default: http://127.0.0.1:8082
  --poll-seconds N        Default: 1
  --timeout-seconds N     Default: 300
  --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_path="${2:-}"; shift 2 ;;
    --source-dir) source_path="${2:-}"; shift 2 ;;
    --api) api="${2:-}"; shift 2 ;;
    --poll-seconds) poll_seconds="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$source_path" ]] || { usage >&2; exit 2; }
[[ -e "$source_path" ]] || { echo "Source path not found: $source_path" >&2; exit 2; }
if [[ -f "$source_path" && "${source_path,,}" != *.triastasis.json ]]; then
  echo "Source file must end in .triastasis.json: $source_path" >&2
  exit 2
fi
[[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "Poll interval must be a positive integer" >&2; exit 2; }
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "Timeout must be a positive integer" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v python >/dev/null || { echo "python is required for JSON handling" >&2; exit 2; }

native_source="$source_path"
if command -v cygpath >/dev/null; then
  native_source="$(cygpath -aw "$source_path")"
fi

curl --fail --silent --show-error "$api/health" >/dev/null || {
  echo "Triastasis automation is unavailable at $api. Start the desktop app first." >&2
  exit 3
}

capabilities="$(curl --fail --silent --show-error "$api/capabilities")"
supports_imports="$(printf '%s' "$capabilities" | python -c "import json,sys; print(str('POST /imports' in json.load(sys.stdin).get('endpoints',[])).lower())")"
if [[ "$supports_imports" != "true" ]]; then
  echo "This Triastasis build does not expose app-owned imports." >&2
  exit 3
fi

payload="$(python -c 'import json,sys; print(json.dumps({"sourcePath": sys.argv[1]}))' "$native_source")"
submission="$(curl --fail-with-body --silent --show-error --header "Content-Type: application/json" --data "$payload" "$api/imports")"
request_id="$(printf '%s' "$submission" | python -c "import json,sys; print(json.load(sys.stdin).get('id',''))")"
status_url="$(printf '%s' "$submission" | python -c "import json,sys; print(json.load(sys.stdin).get('statusUrl',''))")"
discovered="$(printf '%s' "$submission" | python -c "import json,sys; print(len(json.load(sys.stdin).get('manifestPaths',[])))")"
[[ -n "$request_id" && -n "$status_url" ]] || {
  echo "Unexpected import submission response: $submission" >&2
  exit 4
}

echo "Import request: $request_id" >&2
echo "Discovered manifests: $discovered" >&2
started="$(date +%s)"
while true; do
  status_json="$(curl --fail-with-body --silent --show-error "$status_url")"
  status="$(printf '%s' "$status_json" | python -c "import json,sys; print(json.load(sys.stdin).get('status',''))")"
  elapsed="$(( $(date +%s) - started ))"
  printf '\r%-12s %4ss' "$status" "$elapsed" >&2
  case "$status" in
    completed)
      printf '\n' >&2
      break
      ;;
    pending|running)
      if (( elapsed >= timeout_seconds )); then
        printf '\nTimed out waiting for Triastasis to complete the import. Request: %s\n' "$request_id" >&2
        exit 5
      fi
      sleep "$poll_seconds"
      ;;
    *)
      printf '\nUnknown import state: %s\n' "$status" >&2
      exit 4
      ;;
  esac
done

printf '%s\n' "$status_json"
read -r imported skipped failed <<<"$(printf '%s' "$status_json" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('imported',0), d.get('skipped',0), len(d.get('failures',[])))")"
echo "Imported: $imported; skipped: $skipped; failed: $failed" >&2
if (( failed > 0 )); then
  exit 6
fi
