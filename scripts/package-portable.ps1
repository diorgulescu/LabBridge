#Requires -Version 5.1
<#
.SYNOPSIS
  Builds LabBridge in release mode and packages a zero-admin LabBridge-Portable.zip
  containing LabBridge.exe, portable.mode, and README-TEAM.md, plus SHA256SUMS.txt.

.USAGE
  powershell -ExecutionPolicy Bypass -File .\scripts\package-portable.ps1
#>

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot

try {
    Write-Host "==> [1/4] Building React + TypeScript frontend..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed with exit code $LASTEXITCODE"
    }

    Write-Host "==> [2/4] Compiling standalone LabBridge.exe (x86_64-pc-windows-msvc, LTO thin, embedded frontend)..." -ForegroundColor Cyan
    cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) {
        throw "Cargo release build failed with exit code $LASTEXITCODE"
    }

    $ExePath = Join-Path $RepoRoot "src-tauri\target\x86_64-pc-windows-msvc\release\LabBridge.exe"
    if (-not (Test-Path $ExePath)) {
        throw "Expected release executable not found at $ExePath"
    }

    Write-Host "==> [3/4] Staging portable bundle..." -ForegroundColor Cyan
    $OutRoot = Join-Path $RepoRoot "dist-portable"
    $StageDir = Join-Path $OutRoot "LabBridge"
    $ZipPath = Join-Path $OutRoot "LabBridge-Portable.zip"
    $SumsPath = Join-Path $OutRoot "SHA256SUMS.txt"

    if (Test-Path $OutRoot) {
        Remove-Item -Recurse -Force $OutRoot
    }
    New-Item -ItemType Directory -Path $StageDir | Out-Null

    $StagedExe = Join-Path $StageDir "LabBridge.exe"
    Copy-Item $ExePath $StagedExe
    New-Item -ItemType File -Path (Join-Path $StageDir "portable.mode") | Out-Null
    Copy-Item (Join-Path $RepoRoot "README-TEAM.md") (Join-Path $StageDir "README-TEAM.md")

    Write-Host "==> [4/4] Creating LabBridge-Portable.zip & SHA256SUMS.txt..." -ForegroundColor Cyan
    Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -Force

    $ZipHash = (Get-FileHash -Algorithm SHA256 -Path $ZipPath).Hash.ToLowerInvariant()
    $ExeHash = (Get-FileHash -Algorithm SHA256 -Path $StagedExe).Hash.ToLowerInvariant()
    @(
        "$ZipHash  LabBridge-Portable.zip"
        "$ExeHash  LabBridge.exe"
    ) | Set-Content -Encoding ASCII -Path $SumsPath

    Write-Host "Done! Release artifacts created in: $OutRoot" -ForegroundColor Green
}
finally {
    Pop-Location
}
