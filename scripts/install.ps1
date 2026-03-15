#Requires -Version 5.1
<#
.SYNOPSIS
    Kraken Installer for Windows
.DESCRIPTION
    Usage: irm https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.ps1 | iex
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

function Step($msg)    { Write-Host "`n=> $msg" -ForegroundColor Cyan }
function Success($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Fail($msg)    { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

function Prompt-YesNo($question, $default = "y") {
    $suffix = " [$default]"
    Write-Host "  $question$suffix" -NoNewline
    $answer = Read-Host
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $default }
    return $answer -match "^[Yy]"
}

$KrakenHome = Join-Path $env:USERPROFILE ".kraken"
$KrakenBin  = Join-Path $KrakenHome "bin"
$KrakenLib  = Join-Path $KrakenHome "lib"
$KrakenSrc  = Join-Path $KrakenLib "tui"
$GitHubRepo = "galfrevn/kraken"
$GitHubUrl  = "https://github.com/$GitHubRepo"

# -------------------------------------------------------------------
# Banner
# -------------------------------------------------------------------

Write-Host @"

 ██ ▄█▀ ██▀███   ▄▄▄       ██ ▄█▀▓█████  ███▄    █
 ██▄█▒ ▓██ ▒ ██▒▒████▄     ██▄█▒ ▓█   ▀  ██ ▀█   █
▓███▄░ ▓██ ░▄█ ▒▒██  ▀█▄  ▓███▄░ ▒███   ▓██  ▀█ ██▒
▓██ █▄ ▒██▀▀█▄  ░██▄▄▄▄██ ▓██ █▄ ▒▓█  ▄ ▓██▒  ▐▌██▒
▒██▒ █▄░██▓ ▒██▒ ▓█   ▓██▒▒██▒ █▄░▒████▒▒██░   ▓██░

  autonomous developer agent — windows installer

"@ -ForegroundColor Cyan

# -------------------------------------------------------------------
# 1. Detect platform
# -------------------------------------------------------------------

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { Fail "unsupported architecture: $_" }
}

$Platform = "windows-$Arch"
Success "detected platform: $Platform"

# -------------------------------------------------------------------
# 2. Check / install Bun (the only hard requirement)
# -------------------------------------------------------------------
Step "checking bun"

if (Get-Command bun -ErrorAction SilentlyContinue) {
    $BunVersion = bun --version
    Success "bun v$BunVersion"
} else {
    Warn "bun is not installed"

    if (Prompt-YesNo "Install bun automatically? (Y/n)") {
        Write-Host ""
        irm https://bun.sh/install.ps1 | iex

        # Refresh PATH for this session
        $BunPath = Join-Path $env:USERPROFILE ".bun\bin"
        if (Test-Path $BunPath) {
            $env:PATH = "$BunPath;$env:PATH"
        }

        if (Get-Command bun -ErrorAction SilentlyContinue) {
            Success "bun installed: v$(bun --version)"
        } else {
            Fail "bun installation failed. Install manually: https://bun.sh"
        }
    } else {
        Fail "bun is required. Install it: https://bun.sh"
    }
}

# -------------------------------------------------------------------
# 3. Prepare install directory
# -------------------------------------------------------------------
Step "preparing installation"

New-Item -ItemType Directory -Force -Path $KrakenBin | Out-Null
New-Item -ItemType Directory -Force -Path $KrakenLib | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $KrakenHome "config") | Out-Null

if (Test-Path $KrakenSrc) {
    Warn "existing installation found, updating..."
}

# -------------------------------------------------------------------
# 4. Clone / update the repository (always needed for TypeScript code)
# -------------------------------------------------------------------
Step "fetching kraken source"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is required. Install it: https://git-scm.com"
}

$TuiGit = Join-Path $KrakenSrc ".git"
if (Test-Path $TuiGit) {
    Push-Location $KrakenSrc
    git pull --rebase --quiet
    Pop-Location
    Success "updated source code"
} else {
    if (Test-Path $KrakenSrc) { Remove-Item $KrakenSrc -Recurse -Force }
    git clone --depth 1 "$GitHubUrl.git" $KrakenSrc
    Success "cloned repository"
}

# -------------------------------------------------------------------
# 5. Install TypeScript dependencies
# -------------------------------------------------------------------
Step "installing dependencies"
Push-Location $KrakenSrc
try {
    bun install --frozen-lockfile 2>$null
} catch {
    bun install
}
Pop-Location
Success "dependencies installed"

# -------------------------------------------------------------------
# 6. Build daemon binary (Rust)
# -------------------------------------------------------------------
Step "setting up native binaries"

$PrebuiltOk = $false
$ReleaseTag = $null

# Try downloading pre-built binaries from the latest release
try {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest" -ErrorAction Stop
    $ReleaseTag = $Release.tag_name

    if ($ReleaseTag) {
        $AssetName = "kraken-$Platform.tar.gz"
        $DownloadUrl = "$GitHubUrl/releases/download/$ReleaseTag/$AssetName"

        Write-Host "  trying $DownloadUrl" -ForegroundColor DarkGray

        $TempFile = Join-Path $env:TEMP $AssetName
        try {
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempFile -ErrorAction Stop
            tar -xzf $TempFile -C $KrakenLib 2>$null
            $PrebuiltOk = $true
            Remove-Item $TempFile -Force -ErrorAction SilentlyContinue
            Success "downloaded pre-built binaries ($ReleaseTag)"
        } catch {
            # No pre-built binary available for this platform
        }
    }
} catch {
    # No releases yet
}

# Fallback: build from source if pre-built binaries are not available
if (-not $PrebuiltOk) {
    Warn "no pre-built binaries available, trying to build from source"

    $HasCargo = [bool](Get-Command cargo -ErrorAction SilentlyContinue)
    $HasGo    = [bool](Get-Command go -ErrorAction SilentlyContinue)

    if ($HasCargo) {
        Success "cargo found: $((cargo --version) -replace 'cargo ','')"
    } else {
        Warn "cargo not found -- daemon won't be available (https://rustup.rs)"
    }

    # Check / setup protoc for Rust build
    $ProtocDir = "C:\protoc"
    $ProtocExe = Join-Path $ProtocDir "bin\protoc.exe"

    if ($HasCargo) {
        Step "checking protoc (required for daemon)"

        if (Test-Path $ProtocExe) {
            $env:PROTOC = $ProtocExe
            $env:PROTOC_INCLUDE = Join-Path $ProtocDir "include"
            Success "protoc found at $ProtocExe"
        } elseif (Get-Command protoc -ErrorAction SilentlyContinue) {
            Success "protoc found in PATH"
        } else {
            $WingetProtoc = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "protoc.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($WingetProtoc) {
                $SourceDir = Split-Path -Parent (Split-Path -Parent $WingetProtoc.FullName)
                Warn "copying protoc to $ProtocDir (avoids unicode path issues)"
                Copy-Item $SourceDir -Destination $ProtocDir -Recurse -Force
                $env:PROTOC = $ProtocExe
                $env:PROTOC_INCLUDE = Join-Path $ProtocDir "include"
                Success "protoc installed to $ProtocDir"
            } else {
                Warn "protoc not found -- daemon build may fail"
                Warn "install it: winget install Google.Protobuf"
            }
        }

        Step "building daemon (rust)"
        Push-Location (Join-Path $KrakenSrc "apps\daemon")
        cargo build --release
        $DaemonExe = Join-Path $KrakenSrc "apps\daemon\target\release\kraken-daemon.exe"
        if (Test-Path $DaemonExe) {
            Copy-Item $DaemonExe (Join-Path $KrakenLib "kraken-daemon.exe") -Force
        }
        Pop-Location
        Success "daemon built"
    }
}

# -------------------------------------------------------------------
# 7. Create CLI shim
# -------------------------------------------------------------------
Step "creating CLI"

$ShimPath = Join-Path $KrakenBin "kraken.cmd"
$ShimContent = @"
@echo off
bun run "%USERPROFILE%\.kraken\lib\tui\apps\cli\src\index.ts" %*
"@
Set-Content -Path $ShimPath -Value $ShimContent -Encoding ASCII

# Also create a ps1 shim for PowerShell users
$Ps1ShimPath = Join-Path $KrakenBin "kraken.ps1"
$Ps1ShimContent = @"
#!/usr/bin/env pwsh
& bun run "`$env:USERPROFILE\.kraken\lib\tui\apps\cli\src\index.ts" @args
"@
Set-Content -Path $Ps1ShimPath -Value $Ps1ShimContent -Encoding UTF8

Success "created $ShimPath"

# -------------------------------------------------------------------
# 8. Copy config templates
# -------------------------------------------------------------------
Step "setting up configuration"

$TemplatesDir = Join-Path $KrakenSrc "apps\cli\templates"
$ConfigDir = Join-Path $KrakenHome "config"

if (Test-Path $TemplatesDir) {
    $EnvExample = Join-Path $TemplatesDir "env.example"
    $YmlExample = Join-Path $TemplatesDir "kraken.example.yml"

    if ((Test-Path $EnvExample) -and -not (Test-Path (Join-Path $ConfigDir ".env.example"))) {
        Copy-Item $EnvExample (Join-Path $ConfigDir ".env.example")
    }
    if ((Test-Path $YmlExample) -and -not (Test-Path (Join-Path $ConfigDir "kraken.example.yml"))) {
        Copy-Item $YmlExample (Join-Path $ConfigDir "kraken.example.yml")
    }
    Success "config templates copied"
}

# -------------------------------------------------------------------
# 9. Write version marker
# -------------------------------------------------------------------

if ($ReleaseTag) {
    Set-Content -Path (Join-Path $KrakenHome "version") -Value $ReleaseTag
} else {
    Set-Content -Path (Join-Path $KrakenHome "version") -Value "source"
}

# -------------------------------------------------------------------
# 10. Add to PATH
# -------------------------------------------------------------------
Step "configuring PATH"

$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$PathAdded = $false

if ($UserPath -notlike "*$KrakenBin*") {
    [Environment]::SetEnvironmentVariable("PATH", "$KrakenBin;$UserPath", "User")
    $env:PATH = "$KrakenBin;$env:PATH"
    $PathAdded = $true
    Success "added $KrakenBin to user PATH"
} else {
    Success "$KrakenBin already in PATH"
    $env:PATH = "$KrakenBin;$env:PATH"
}

# -------------------------------------------------------------------
# 11. Verify
# -------------------------------------------------------------------
Step "verifying installation"

if (Test-Path $ShimPath) {
    try {
        & $ShimPath version 2>$null
        Success "kraken is working"
    } catch {
        Success "kraken installed at $ShimPath"
    }
} else {
    Warn "kraken installed but shim was not created"
}

# -------------------------------------------------------------------
# Done — run init
# -------------------------------------------------------------------
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""

Step "running kraken init"
& $ShimPath init
