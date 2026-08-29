<#
.SYNOPSIS
  Triastasis: one-command setup for Windows (x64).

.DESCRIPTION
  Detects the GPU runtime (CUDA / ROCm / Vulkan), downloads the matching
  trellis-server bundle, installs the Triastasis desktop app, and writes the
  config the app reads on launch.

  Model weights (~6.5-16.5 GB) are NOT downloaded here by default: the app now
  offers verified, resumable in-app downloads on first launch. Pass
  -IncludeModels to keep the legacy installer-side download (one transition
  release only).

.EXAMPLE
  irm https://raw.githubusercontent.com/dmelim/Triastasis/main/install/install.ps1 | iex
  # or, with options:
  ./install.ps1 -Backend vulkan -IncludeModels -Quant q8
#>
[CmdletBinding()]
param(
  # Validated manually below: an empty default (auto-detect) is not a member of the
  # allowed set, and a [ValidateSet] default mismatch is a fatal bind error under
  # `irm ... | iex` (ValidateSetFailure).
  [string]$Backend = "",
  [int]$Gpu = 0,
  [int]$Port = 8080,
  [string]$Dest = "$env:LOCALAPPDATA\triastasis",
  [string]$ModelsDir = "",
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string]$ReleaseTag = "triastasis-v0.0.1-alpha.1",
  # Legacy opt-in: quantized weights "q8" (~10 GB) or "q4" (~6.5 GB). Default f16.
  [string]$Quant = "",
  # Legacy opt-in: download weights in the installer instead of the app.
  [switch]$IncludeModels,
  [switch]$AcceptModelTerms,
  [switch]$SkipApp,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$Repo = "dmelim/Triastasis"
$RelBase = "https://github.com/$Repo/releases/download/$ReleaseTag"
$HfBase = "https://huggingface.co/ilintar/trellis2-gguf/resolve/main"
$Models = @("birefnet.gguf", "dinov3.gguf", "ss_flow.gguf", "ss_dec.gguf",
  "shape_flow_512.gguf", "shape_flow_1024.gguf", "shape_dec.gguf",
  "tex_flow_512.gguf", "tex_flow_1024.gguf", "tex_dec.gguf")

if (-not $ModelsDir) { $ModelsDir = Join-Path $Dest "models" }
$RuntimeDir = Join-Path $Dest "runtime"

# Quantized weights live in q8/ and q4/ subpaths of the HF repo, same filenames.
$WeightsLabel = if ($Quant) { "$($Quant.ToUpper()) (legacy installer download)" } else { "f16 (legacy installer download)" }
if ($Quant -and $Quant -notin @("q4", "q8")) { Die "invalid -Quant: $Quant (use q8 or q4)" }
$QuantPath = if ($Quant) { "$Quant/" } else { "" }
$ConfigDir = Join-Path $env:APPDATA "triastasis"

function Log($m)  { Write-Host "==> $m" -ForegroundColor Green }
function Info($m) { Write-Host " -  $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warn: $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# ---- backend detection -----------------------------------------------------
function Detect-Backend {
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    try {
      if (nvidia-smi -L 2>$null) {
        $capText = nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i $Gpu 2>$null |
          Select-Object -First 1
        $cap = 0.0
        if ([double]::TryParse(
              "$capText".Trim(),
              [System.Globalization.NumberStyles]::Float,
              [System.Globalization.CultureInfo]::InvariantCulture,
              [ref]$cap) -and $cap -ge 6.0 -and $cap -lt 7.5) {
          Info "detected NVIDIA compute capability $capText — selecting the CUDA 12 legacy runtime"
          return "cuda12"
        }
        return "cuda"
      }
    } catch {}
  }
  try {
    $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if ($gpus | Where-Object { $_.Name -match "AMD|Radeon" }) {
      # ROCm is possible on AMD, but the published bundle needs a matching TheRock
      # runtime; Vulkan is self-contained and robust, so it's the safe auto default.
      Info "detected an AMD GPU — ROCm-capable (use -Backend rocm to force it)"
    }
  } catch {}
  return "vulkan"
}

if (-not $Backend) {
  $Backend = Detect-Backend
  Log "auto-detected backend: $Backend"
} else {
  if ($Backend -notin @("cuda", "cuda12", "rocm", "vulkan")) { Die "invalid backend: $Backend (use cuda|cuda12|rocm|vulkan)" }
  Log "backend (forced): $Backend"
}

Write-Host ""
Info "install dir : $Dest"
if ($IncludeModels) {
  Info ("models dir  : {0}" -f $ModelsDir)
  Info "weights     : $WeightsLabel"
} else {
  Info "weights     : downloaded in-app on first launch (use -IncludeModels for legacy behavior)"
}
Info "backend/gpu : $Backend / $Gpu     port: $Port"
Write-Host ""
if ($IncludeModels -and -not $AcceptModelTerms) {
  Warn "the legacy model download combines files governed by separate upstream terms."
  Info "bundle source : https://huggingface.co/ilintar/trellis2-gguf"
  Info "TRELLIS.2     : https://huggingface.co/microsoft/TRELLIS.2-4B"
  Info "DINOv3 terms  : https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md"
  Info "BiRefNet      : https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE"
  if ($Yes) { Die "review the model terms, then re-run with -AcceptModelTerms" }
  $terms = Read-Host "Type ACCEPT to confirm that you reviewed and accept the applicable model terms"
  if ($terms -cne "ACCEPT") { Die "model terms were not accepted; no model files were downloaded" }
}
if (-not $Yes) {
  $ans = Read-Host "Proceed? [Y/n]"
  if ($ans -match "^[nN]") { exit 0 }
}

# ---- download helper (resumable via BITS, IWR fallback) --------------------
function Download($url, $dest) {
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Info "down $(Split-Path $dest -Leaf)"
  try {
    Start-BitsTransfer -Source $url -Destination $dest -DisplayName (Split-Path $dest -Leaf)
  } catch {
    Warn "BITS failed, falling back to Invoke-WebRequest"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }
}

# ---- 1. server runtime bundle ---------------------------------------------
Log "downloading trellis-server ($Backend) runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$bundle = "trellis-$Backend-windows-x64.zip"
$tmp = Join-Path $env:TEMP $bundle
Download "$RelBase/$bundle" $tmp
Expand-Archive -Path $tmp -DestinationPath $RuntimeDir -Force
Remove-Item $tmp -Force
$ServerBin = Join-Path $RuntimeDir "trellis-server.exe"
if (-not (Test-Path $ServerBin)) { Die "trellis-server.exe not found after extract" }

if ($Backend -eq "rocm") {
  Warn "ROCm bundle needs a TheRock ROCm runtime on PATH; see docs/getting-started.md."
  Warn "If the server fails to start, re-run with -Backend vulkan."
}

# ---- 2. weights (legacy opt-in; the app downloads them itself by default) --
if (-not $IncludeModels) {
  Info "skipping model download; choose a bundle in-app on first launch."
} else {
  Log "downloading TRELLIS.2 weights [$WeightsLabel, resumable] -> $ModelsDir"
  New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
  foreach ($m in $Models) { Download "$HfBase/$QuantPath$m" (Join-Path $ModelsDir $m) }
}

# ---- 3. desktop app --------------------------------------------------------
if ($SkipApp) {
  Warn "skipping desktop app download (-SkipApp)."
} else {
  Log "downloading Triastasis desktop app"
  $setup = Join-Path $env:TEMP "triastasis-windows-x64-setup.exe"
  try {
    Download "$RelBase/triastasis-windows-x64-setup.exe" $setup
    Info "launching installer (silent, per-user)"
    Start-Process $setup -ArgumentList "/S" -Wait
  } catch {
    Warn "app installer not available on the latest release yet — skipping."
    Warn "You can still run the UI in a browser against trellis-server (see docs)."
  }
}

# ---- 4. config -------------------------------------------------------------
Log "writing config"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$cfg = [ordered]@{
  serverBin = $ServerBin
  modelsDir = $ModelsDir
  backend   = $Backend
  gpu       = $Gpu
  host      = "127.0.0.1"
  port      = $Port
  outputDir = (Join-Path $Dest "output")
}
# Write UTF-8 *without* a BOM: Windows PowerShell 5.1's `Set-Content -Encoding UTF8`
# prepends a BOM, which serde_json (the app's config reader) refuses to parse, so the
# app would silently fall back to an empty/"unknown" config. WriteAllText with an
# explicit no-BOM encoding works on both Windows PowerShell 5.1 and PowerShell 7.
[System.IO.File]::WriteAllText(
  (Join-Path $ConfigDir "config.json"),
  ($cfg | ConvertTo-Json),
  (New-Object System.Text.UTF8Encoding($false)))
Info "config: $(Join-Path $ConfigDir 'config.json')"

Write-Host ""
Log "done: launch Triastasis from the Start menu."
