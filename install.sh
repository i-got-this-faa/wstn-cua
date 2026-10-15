#!/usr/bin/env bash
set -e

# wstn-cua installer
echo "=== wstn-cua: Weston Wayland CUA Supervisor Installer ==="

# 1. Dependency checks
MISSING_DEPS=()
for dep in weston pipewire gcc; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    MISSING_DEPS+=("$dep")
  fi
done

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
  echo "[-] Error: Missing required system dependencies: ${MISSING_DEPS[*]}"
  echo "    Please install them via your package manager (e.g. pacman -S ${MISSING_DEPS[*]} or apt-get install ${MISSING_DEPS[*]})"
  exit 1
fi
echo "[+] System dependencies present: weston, pipewire, gcc"

# Check JS runtime
if command -v bun >/dev/null 2>&1; then
  JS_RUNNER="bun"
elif command -v npm >/dev/null 2>&1; then
  JS_RUNNER="npm"
else
  echo "[-] Error: Neither bun nor npm found. Please install Bun or Node.js."
  exit 1
fi
echo "[+] JavaScript runtime: $JS_RUNNER"

# 2. Package install
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[*] Installing project dependencies..."
if [ "$JS_RUNNER" = "bun" ]; then
  bun install
else
  npm install
fi

# 3. Compile Native Modules if Makefile exists
if [ -f "src/native/Makefile" ]; then
  echo "[*] Compiling native modules (injector & pw_stream)..."
  make -C src/native
fi

# 4. Build TypeScript
echo "[*] Building TypeScript sources..."
if [ "$JS_RUNNER" = "bun" ]; then
  bun run build:ts || true
else
  npm run build:ts || true
fi

# 5. Ensure CLI is executable
chmod +x bin/wstn-cua

# Optional symlink to ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$SCRIPT_DIR/bin/wstn-cua" "$HOME/.local/bin/wstn-cua"

echo "[+] Installation complete!"
echo "    wstn-cua binary linked to $HOME/.local/bin/wstn-cua"
echo "    Run 'wstn-cua start' to launch the Weston CUA supervisor."
