#!/usr/bin/env bash
# Builds LabBridge for Windows (x86_64-pc-windows-msvc) using cargo-xwin
# and packages dist-portable/LabBridge-Portable.zip containing:
#   - LabBridge.exe
#   - portable.mode
#   - README-TEAM.md
#
# Prerequisites on macOS / Linux:
#   rustup target add x86_64-pc-windows-msvc
#   cargo install cargo-xwin
#
# Usage:
#   ./scripts/package-portable.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/4] Building React + TypeScript frontend..."
npm run build

echo "==> [2/4] Cross-compiling LabBridge.exe (x86_64-pc-windows-msvc, embedded frontend) via cargo-xwin..."
cargo xwin build --release --features custom-protocol --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml

EXE_PATH="$REPO_ROOT/src-tauri/target/x86_64-pc-windows-msvc/release/LabBridge.exe"
if [[ ! -f "$EXE_PATH" ]]; then
  echo "Error: Release executable not found at $EXE_PATH" >&2
  exit 1
fi

echo "==> [3/4] Staging zero-admin portable directory..."
OUT_ROOT="$REPO_ROOT/dist-portable"
STAGE_DIR="$OUT_ROOT/LabBridge"
ZIP_PATH="$OUT_ROOT/LabBridge-Portable.zip"

rm -rf "$OUT_ROOT"
mkdir -p "$STAGE_DIR"

cp "$EXE_PATH" "$STAGE_DIR/LabBridge.exe"
: > "$STAGE_DIR/portable.mode"
cp "$REPO_ROOT/README-TEAM.md" "$STAGE_DIR/README-TEAM.md"

echo "==> [4/4] Creating LabBridge-Portable.zip..."
(
  cd "$STAGE_DIR"
  zip -9 -r "$ZIP_PATH" LabBridge.exe portable.mode README-TEAM.md
)

echo "Done! Portable archive created at: $ZIP_PATH"
