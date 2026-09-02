#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"

api="http://127.0.0.1:8082"
image=""
output=""
export_dir=""
job_json=""
seed="42"
resolution="512"
bg_removal="birefnet"
uv="xatlas"
texture=""
target_faces=""
atlas_size=""
texture_resolution=""
remesh_band=""
texture_encoding=""
poll_seconds="2"
force="0"
job_id=""

usage() {
  cat <<'EOF'
Usage: triastasis_generate.sh --image PATH (--export-dir DIR | --output PATH) [options]

Options:
  --export-dir DIR          Native verified package export (recommended)
  --job-json PATH           Save the final API job view as JSON
  --seed N                 Default: 42
  --resolution N           512, 1024, or 1536. Default: 512
  --bg-removal MODE        auto, birefnet, or threshold. Default: birefnet
  --uv MODE                xatlas or box. Default: xatlas
  --texture MODE           on, off, true, false, 1, or 0
  --target-faces N         10000 through 1000000
  --atlas-size N           128 through 4096
  --texture-resolution N   512 or 1024
  --remesh-band N          0 through 8
  --texture-encoding MODE  auto, webp, or png
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
    --export-dir) export_dir="${2:-}"; shift 2 ;;
    --job-json) job_json="${2:-}"; shift 2 ;;
    --seed) seed="${2:-}"; shift 2 ;;
    --resolution) resolution="${2:-}"; shift 2 ;;
    --bg-removal) bg_removal="${2:-}"; shift 2 ;;
    --uv) uv="${2:-}"; shift 2 ;;
    --texture) texture="${2:-}"; shift 2 ;;
    --target-faces) target_faces="${2:-}"; shift 2 ;;
    --atlas-size) atlas_size="${2:-}"; shift 2 ;;
    --texture-resolution) texture_resolution="${2:-}"; shift 2 ;;
    --remesh-band) remesh_band="${2:-}"; shift 2 ;;
    --texture-encoding) texture_encoding="${2:-}"; shift 2 ;;
    --api) api="${2:-}"; shift 2 ;;
    --poll-seconds) poll_seconds="${2:-}"; shift 2 ;;
    --force) force="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$image" ]] || { usage >&2; exit 2; }
[[ -n "$export_dir" || -n "$output" ]] || { usage >&2; exit 2; }
[[ -z "$export_dir" || -z "$output" ]] || { echo "Choose --export-dir or --output, not both" >&2; exit 2; }
[[ -z "$export_dir" || -z "$job_json" ]] || { echo "--export-dir already creates job.json" >&2; exit 2; }
[[ -z "$export_dir" || "$force" == "0" ]] || { echo "--force is not allowed with non-overwriting native exports" >&2; exit 2; }
[[ -f "$image" ]] || { echo "Input image not found: $image" >&2; exit 2; }
[[ "$resolution" =~ ^(512|1024|1536)$ ]] || { echo "Invalid resolution: $resolution" >&2; exit 2; }
[[ "$bg_removal" =~ ^(auto|birefnet|threshold)$ ]] || { echo "Invalid background removal: $bg_removal" >&2; exit 2; }
[[ "$uv" =~ ^(xatlas|box)$ ]] || { echo "Invalid UV mode: $uv" >&2; exit 2; }
[[ "$seed" =~ ^[0-9]+$ ]] || { echo "Seed must be a nonnegative integer" >&2; exit 2; }
(( ${#seed} <= 10 )) && (( 10#$seed <= 4294967295 )) || { echo "Seed must not exceed 4294967295" >&2; exit 2; }
[[ -z "$texture" || "$texture" =~ ^(on|off|true|false|1|0)$ ]] || { echo "Invalid texture mode: $texture" >&2; exit 2; }
[[ -z "$target_faces" || "$target_faces" =~ ^[0-9]+$ ]] || { echo "Target faces must be an integer" >&2; exit 2; }
[[ -z "$target_faces" ]] || { (( ${#target_faces} <= 7 )) && (( 10#$target_faces >= 10000 && 10#$target_faces <= 1000000 )); } || { echo "Target faces must be between 10000 and 1000000" >&2; exit 2; }
[[ -z "$atlas_size" || "$atlas_size" =~ ^[0-9]+$ ]] || { echo "Atlas size must be an integer" >&2; exit 2; }
[[ -z "$atlas_size" ]] || { (( ${#atlas_size} <= 4 )) && (( 10#$atlas_size >= 128 && 10#$atlas_size <= 4096 )); } || { echo "Atlas size must be between 128 and 4096" >&2; exit 2; }
[[ -z "$texture_resolution" || "$texture_resolution" =~ ^(512|1024)$ ]] || { echo "Texture resolution must be 512 or 1024" >&2; exit 2; }
[[ -z "$remesh_band" || "$remesh_band" =~ ^[0-8]$ ]] || { echo "Remesh band must be between 0 and 8" >&2; exit 2; }
[[ -z "$texture_encoding" || "$texture_encoding" =~ ^(auto|webp|png)$ ]] || { echo "Invalid texture encoding: $texture_encoding" >&2; exit 2; }
[[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "Poll interval must be a positive integer" >&2; exit 2; }
[[ -z "$output" || ! -e "$output" || "$force" == "1" ]] || { echo "Output exists; pass --force to replace it: $output" >&2; exit 2; }
[[ -z "$export_dir" || ! -e "$export_dir" ]] || { echo "Export directory already exists; native exports never overwrite: $export_dir" >&2; exit 2; }
[[ -z "$export_dir" || -d "$(dirname "$export_dir")" ]] || { echo "Export parent directory does not exist: $(dirname "$export_dir")" >&2; exit 2; }
[[ -z "$job_json" || ! -e "$job_json" || "$force" == "1" ]] || { echo "Job JSON exists; pass --force to replace it: $job_json" >&2; exit 2; }

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
if [[ -n "$export_dir" ]]; then
  printf '%s' "$capabilities" | python -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("library",{}).get("available") else 1)' || {
    echo "This build lacks shared Library export. Update the running app before generating a package." >&2
    exit 3
  }
fi
policy="$(printf '%s' "$capabilities" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('capabilities',{}).get('policy','unknown'))")"
persistence_healthy="$(printf '%s' "$capabilities" | python -c "import json,sys; d=json.load(sys.stdin); print(str(d.get('persistenceHealthy',True)).lower())")"
max_concurrency="$(printf '%s' "$capabilities" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('capabilities',{}).get('maxConcurrency','unknown'))")"
if [[ "$persistence_healthy" != "true" ]]; then
  persistence_error="$(printf '%s' "$capabilities" | python -c "import json,sys; print(json.load(sys.stdin).get('persistenceError') or 'unknown persistence error')")"
  echo "Triastasis automation persistence is degraded: $persistence_error" >&2
  exit 3
fi
echo "Triastasis policy: $policy; max concurrency: $max_concurrency" >&2

curl_fields=(
  -F "image=@$image"
  -F "seed=$seed"
  -F "resolution=$resolution"
  -F "bg_removal=$bg_removal"
  -F "uv=$uv"
)
[[ -z "$texture" ]] || curl_fields+=(-F "texture=$texture")
[[ -z "$target_faces" ]] || curl_fields+=(-F "targetFaces=$target_faces")
[[ -z "$atlas_size" ]] || curl_fields+=(-F "atlasSize=$atlas_size")
[[ -z "$texture_resolution" ]] || curl_fields+=(-F "textureResolution=$texture_resolution")
[[ -z "$remesh_band" ]] || curl_fields+=(-F "remeshBand=$remesh_band")
[[ -z "$texture_encoding" ]] || curl_fields+=(-F "textureEncoding=$texture_encoding")

submission="$(curl --fail-with-body --silent --show-error "$api/jobs" "${curl_fields[@]}")"

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
  progress_label="$(printf '%s' "$status_json" | python -c "import json,sys; p=json.load(sys.stdin).get('progress') or {}; parts=[]; stage=p.get('stageLabel'); percent=p.get('percent'); eta=p.get('etaSeconds'); parts += [str(stage)] if stage else []; parts += [f'{percent:.0f}%'] if isinstance(percent,(int,float)) else []; parts += [f'ETA {eta:.0f}s'] if isinstance(eta,(int,float)) else []; print(' · '.join(parts))")"
  if [[ "$status" == "queued" && "$current_ahead" =~ ^[0-9]+$ ]]; then
    queue_label=" · pos ${current_position:-?}, ${current_ahead} ahead"
  fi
  [[ -z "$progress_label" ]] || progress_label=" · $progress_label"
  printf '\r%-12s%-64s %4ss' "$status" "$queue_label$progress_label" "$elapsed" >&2
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

if [[ -n "$export_dir" ]]; then
  command -v cygpath >/dev/null || { echo "cygpath is required for native Windows exports" >&2; exit 2; }
  export_path="$(cygpath -aw "$export_dir")"
  export_payload="$(python -c 'import json,sys; print(json.dumps({"destinationPath": sys.argv[1]}))' "$export_path")"
  version_id="automation-$job_id"
  library_url="$api/library/versions/$version_id"
  registered=0
  for attempt in {1..30}; do
    if version_json="$(curl --fail --silent --show-error "$library_url" 2>/dev/null)"; then registered=1; break; fi
    sleep 2
  done
  if [[ "$registered" != 1 ]]; then
    echo "Generation succeeded ($job_id), but Library registration did not finish. Check /capabilities.library.registrationError; do not regenerate." >&2
    exit 7
  fi
  printf '%s' "$version_json" | python -c 'import json,sys; w=json.load(sys.stdin).get("qualityWarning"); print(w or "", file=sys.stderr); sys.exit(1 if w else 0)' || {
    echo "Quality warning: inspect this version before exporting or integrating." >&2
    exit 8
  }
  export_json="$(curl --fail-with-body --silent --show-error \
    --header "Content-Type: application/json" \
    --data "$export_payload" \
    "$library_url/export")"
  output="$export_dir/asset-static.glb"
  printf '%s\n' "$export_json"
else
  mkdir -p "$(dirname "$output")"
  curl --fail --silent --show-error "$model_url" --output "$output"
  if [[ -n "$job_json" ]]; then
    mkdir -p "$(dirname "$job_json")"
    printf '%s\n' "$status_json" > "$job_json"
  fi
fi

quality_warning="$(printf '%s' "$status_json" | python -c "import json,sys; w=json.load(sys.stdin).get('qualityWarning') or {}; code=w.get('code'); message=w.get('message'); print(f'[{code}] {message}' if code and message else message or '')")"
if [[ -n "$quality_warning" ]]; then
  echo "QUALITY WARNING $quality_warning" >&2
  echo "Do not integrate this model. Improve the source view to show visible depth; do not automatically retry with BiRefNet." >&2
fi

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
