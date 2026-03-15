#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
Push-Location $ProjectRoot

function Step($msg)    { Write-Host "`n=> $msg" -ForegroundColor Cyan }
function Success($msg) { Write-Host "   $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "   $msg" -ForegroundColor Yellow }
function Fail($msg)    { Write-Host "   error: $msg" -ForegroundColor Red; Pop-Location; exit 1 }

Write-Host @"

 ██ ▄█▀ ██▀███   ▄▄▄       ██ ▄█▀▓█████  ███▄    █
 ██▄█▒ ▓██ ▒ ██▒▒████▄     ██▄█▒ ▓█   ▀  ██ ▀█   █
▓███▄░ ▓██ ░▄█ ▒▒██  ▀█▄  ▓███▄░ ▒███   ▓██  ▀█ ██▒
▓██ █▄ ▒██▀▀█▄  ░██▄▄▄▄██ ▓██ █▄ ▒▓█  ▄ ▓██▒  ▐▌██▒
▒██▒ █▄░██▓ ▒██▒ ▓█   ▓██▒▒██▒ █▄░▒████▒▒██░   ▓██░

  autonomous developer agent — windows setup

"@ -ForegroundColor Cyan

# -------------------------------------------------------------------
# 1. Check dependencies
# -------------------------------------------------------------------
Step "checking dependencies"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail "bun is not installed. Install it: https://bun.sh"
}
Success "bun $(bun --version)"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Fail "rust/cargo is not installed. Install it: https://rustup.rs"
}
Success "cargo $((cargo --version) -replace 'cargo ','')"

if (Get-Command go -ErrorAction SilentlyContinue) {
    Success "go $((go version) -replace 'go version go' -replace ' .*','') (optional)"
}

# -------------------------------------------------------------------
# 2. Setup protoc
# -------------------------------------------------------------------
Step "checking protoc"

$ProtocDir = "C:\protoc"
$ProtocExe = "$ProtocDir\bin\protoc.exe"
$ProtocInclude = "$ProtocDir\include"

if (Test-Path $ProtocExe) {
    $env:PROTOC = $ProtocExe
    $env:PROTOC_INCLUDE = $ProtocInclude
    Success "protoc found at $ProtocExe"
} else {
    # Try to find protoc from winget
    $WingetProtoc = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "protoc.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($WingetProtoc) {
        $SourceDir = Split-Path -Parent (Split-Path -Parent $WingetProtoc.FullName)
        Write-Host "   copying protoc to $ProtocDir (avoids unicode path issues)..." -ForegroundColor Yellow
        Copy-Item $SourceDir -Destination $ProtocDir -Recurse -Force
        $env:PROTOC = $ProtocExe
        $env:PROTOC_INCLUDE = $ProtocInclude
        Success "protoc installed to $ProtocDir"
    } elseif (Get-Command protoc -ErrorAction SilentlyContinue) {
        Success "protoc found in PATH"
    } else {
        Fail "protoc is not installed. Install it: winget install Google.Protobuf   (then re-run this script)"
    }
}

# Set persistent env vars so future terminals find protoc
if ($env:PROTOC) {
    [Environment]::SetEnvironmentVariable("PROTOC", $env:PROTOC, "User")
    [Environment]::SetEnvironmentVariable("PROTOC_INCLUDE", $env:PROTOC_INCLUDE, "User")
    Success "PROTOC and PROTOC_INCLUDE set permanently"
}

# -------------------------------------------------------------------
# 3. Install TypeScript dependencies
# -------------------------------------------------------------------
Step "installing dependencies"
bun install
Success "node modules installed"

# -------------------------------------------------------------------
# 4. Generate protobuf code (if buf is available)
# -------------------------------------------------------------------
Step "generating protobuf code"

if (Get-Command buf -ErrorAction SilentlyContinue) {
    buf generate
    if ($LASTEXITCODE -ne 0) { Fail "buf generate failed" }
    Success "protobuf code generated"
} else {
    if ((Test-Path "gen/go/agent") -and (Test-Path "gen/ts/agent")) {
        Warn "buf not installed, using existing generated code"
        Warn "install buf for fresh generation: https://buf.build/docs/installation"
    } else {
        Fail "buf is not installed and no generated code found. Install it: https://buf.build/docs/installation"
    }
}

# -------------------------------------------------------------------
# 5. Build daemon (Rust)
# -------------------------------------------------------------------
Step "building daemon (rust)"
Push-Location apps/daemon
cargo build --release
Pop-Location
Success "daemon built -> apps/daemon/target/release/kraken-daemon.exe"

# -------------------------------------------------------------------
# 6. Register global CLI
# -------------------------------------------------------------------
Step "registering kraken CLI"
bun link
Success "kraken command registered globally"

# -------------------------------------------------------------------
# 7. Verify
# -------------------------------------------------------------------
Step "verifying installation"

if (Get-Command kraken -ErrorAction SilentlyContinue) {
    Success "kraken is available globally"
} else {
    Warn "kraken may not be in PATH"
    Warn "add bun global bin to your PATH: `$env:USERPROFILE\.bun\bin"
}

# -------------------------------------------------------------------
# Done — run init
# -------------------------------------------------------------------
Pop-Location

Write-Host ""
Write-Host "  build complete!" -ForegroundColor Green
Write-Host ""

Step "running kraken init"
kraken init
