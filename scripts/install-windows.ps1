<#
.SYNOPSIS
Installs the runtime prerequisites Kathara Desktop checks for at startup
(services/desktop/src/prereqs.ts): Docker Desktop, Python 3.10+, Kathara, and this project's own
backend (kathara-api-rest, not published anywhere — installed from this checkout).

Installs into <repo>\.venv rather than system-wide, matching the app's own preflight, which
already looks for .venv\Scripts\python.exe first (services/desktop/src/paths.ts's
devVenvPython) — so a checkout that has run this script needs no further configuration to
launch the desktop app from source.

Needs winget (ships with Windows 10 1809+/11 via App Installer). Safe to re-run.
Docker Desktop also requires WSL2; winget's installer handles enabling it, but that can still
need a reboot before Docker is usable.
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $RepoRoot ".venv"
$AllOk = $true

function Say($msg) { Write-Host "`n== $msg ==" }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "  * $msg" -ForegroundColor Green }

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget wasn't found. Install 'App Installer' from the Microsoft Store, then re-run this script."
    exit 1
}

# ---- Docker Desktop ----
Say "Docker"
$dockerReady = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info *> $null
    $dockerReady = $LASTEXITCODE -eq 0
}
if ($dockerReady) {
    Ok "Docker already installed and reachable"
} else {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements
    }
    Warn "Docker Desktop needs a manual first run: launch it from the Start menu, accept its"
    Warn "license, and finish WSL2 setup if prompted (a reboot may be required). Re-run this"
    Warn "script afterwards — Docker can't be verified until it's fully up."
    $AllOk = $false
}

# ---- Python 3.10+ ----
Say "Python"
function PythonOk {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    $v = & python -c "import sys; print(1 if sys.version_info >= (3, 10) else 0)" 2>$null
    return $v -eq "1"
}
if (PythonOk) {
    $v = & python --version
    Ok "$v found"
} else {
    Warn "Python 3.10+ not found — installing."
    winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
    # winget's PATH update needs a fresh shell to take effect in-process.
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (PythonOk) { Ok "$(& python --version) installed" }
    else { Warn "Installed, but not on PATH yet — open a new terminal and re-run this script."; $AllOk = $false }
}

# ---- Kathara + this project, into <repo>\.venv ----
Say "Kathara Desktop backend (into $Venv)"
if (PythonOk) {
    if (-not (Test-Path (Join-Path $Venv "Scripts\python.exe"))) {
        python -m venv $Venv
    }
    $venvPy = Join-Path $Venv "Scripts\python.exe"
    & $venvPy -m pip install --upgrade pip -q
    & $venvPy -m pip install -q kathara "uvicorn[standard]"
    & $venvPy -m pip install -q -e $RepoRoot
    Ok "kathara, uvicorn and kathara-api-rest installed into $Venv"
} else {
    Warn "Skipped — no usable Python."
    $AllOk = $false
}

Say "Summary"
if ($AllOk) {
    Write-Host "All set. Run the desktop app with: cd services\desktop; npm start"
    exit 0
} else {
    Write-Host "Some steps need your attention — see the warnings above, then re-run this script."
    exit 1
}
