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
# 2. Check / install Bun
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

New-Item -ItemType Directory -Force -Path $KrakenBin  | Out-Null
New-Item -ItemType Directory -Force -Path $KrakenLib  | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $KrakenHome "config") | Out-Null

$TuiDir = Join-Path $KrakenLib "tui"

if (Test-Path $TuiDir) {
    Warn "existing installation found, updating..."
}

# -------------------------------------------------------------------
# 4. Try downloading pre-built release
# -------------------------------------------------------------------
Step "downloading kraken"

$PrebuiltOk = $false
$ReleaseTag = $null

try {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest" -ErrorAction Stop
    $ReleaseTag = $Release.tag_name

    if ($ReleaseTag) {
        # Note: Windows releases would need to be added to the release workflow.
        # For now, we check for a windows asset; if not found, fall back to source.
        $AssetName = "kraken-$Platform.tar.gz"
        $DownloadUrl = "$GitHubUrl/releases/download/$ReleaseTag/$AssetName"

        Write-Host "  trying $DownloadUrl" -ForegroundColor DarkGray

        $TempFile = Join-Path $env:TEMP $AssetName
        try {
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempFile -ErrorAction Stop

            # Extract tar.gz
            tar -xzf $TempFile -C $KrakenLib 2>$null
            $PrebuiltOk = $true
            Remove-Item $TempFile -Force -ErrorAction SilentlyContinue
            Success "downloaded pre-built binaries ($ReleaseTag)"
        } catch {
            # No pre-built binary available for Windows, fall through to source build
        }
    }
} catch {
    # No releases yet, fall through
}

# -------------------------------------------------------------------
# 5. Fallback: build from source
# -------------------------------------------------------------------
if (-not $PrebuiltOk) {
    Warn "no pre-built release available for Windows, building from source"

    $HasCargo = [bool](Get-Command cargo -ErrorAction SilentlyContinue)
    $HasGo    = [bool](Get-Command go -ErrorAction SilentlyContinue)

    if ($HasCargo) {
        Success "cargo found: $((cargo --version) -replace 'cargo ','')"
    } else {
        Warn "cargo not found -- scheduler won't be built (https://rustup.rs)"
    }

    if ($HasGo) {
        Success "go found: $((go version) -replace 'go version go' -replace ' .*','')"
    } else {
        Warn "go not found -- gateway won't be built (https://go.dev/dl)"
    }

    # Check for git
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Fail "git is required to build from source. Install it: https://git-scm.com"
    }

    Step "cloning repository"

    $TuiGit = Join-Path $TuiDir ".git"
    if (Test-Path $TuiGit) {
        Push-Location $TuiDir
        git pull --rebase --quiet
        Pop-Location
        Success "updated source code"
    } else {
        if (Test-Path $TuiDir) { Remove-Item $TuiDir -Recurse -Force }
        git clone --depth 1 "$GitHubUrl.git" $TuiDir
        Success "cloned repository"
    }

    Step "installing dependencies"
    Push-Location $TuiDir
    try {
        bun install --frozen-lockfile 2>$null
    } catch {
        bun install
    }
    Success "dependencies installed"

    # Check / setup protoc for Rust build
    $ProtocDir = "C:\protoc"
    $ProtocExe = Join-Path $ProtocDir "bin\protoc.exe"

    if ($HasCargo) {
        Step "checking protoc (required for scheduler)"

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
                Warn "protoc not found -- scheduler build may fail"
                Warn "install it: winget install Google.Protobuf"
            }
        }

        Step "building scheduler (rust)"
        Push-Location (Join-Path $TuiDir "apps\scheduler")
        cargo build --release
        $SchedulerExe = Join-Path $TuiDir "apps\scheduler\target\release\scheduler.exe"
        if (Test-Path $SchedulerExe) {
            Copy-Item $SchedulerExe (Join-Path $KrakenLib "scheduler.exe") -Force
        }
        Pop-Location
        Success "scheduler built"
    }

    if ($HasGo) {
        Step "building gateway (go)"
        Push-Location (Join-Path $TuiDir "apps\gateway")
        go build -o gateway.exe ./cmd/gateway
        if (Test-Path "gateway.exe") {
            Copy-Item "gateway.exe" (Join-Path $KrakenLib "gateway.exe") -Force
        }
        Pop-Location
        Success "gateway built"
    }

    Pop-Location  # Back from $TuiDir
}

# -------------------------------------------------------------------
# 6. Create CLI shim
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
# 7. Copy config templates
# -------------------------------------------------------------------
Step "setting up configuration"

$TemplatesDir = Join-Path $TuiDir "apps\cli\templates"
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
# 8. Write version marker
# -------------------------------------------------------------------

if ($ReleaseTag) {
    Set-Content -Path (Join-Path $KrakenHome "version") -Value $ReleaseTag
} else {
    Set-Content -Path (Join-Path $KrakenHome "version") -Value "source"
}

# -------------------------------------------------------------------
# 9. Add to PATH
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
# 10. Verify
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
