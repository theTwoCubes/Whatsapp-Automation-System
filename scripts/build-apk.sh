#!/usr/bin/env bash
# Rebuild the console web bundle and produce a fresh signed-debug APK.
#
# Every time you change the frontend or backend and want the client's phone to
# get the update, run this script and hand them the resulting APK. The wrapper
# points at your hosted URL so most content updates do not need a rebuild at
# all — only rebuild the APK when you change the shell, the app id, or the
# Capacitor plugins.
#
# First run bootstrap (once per machine):
#   npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/push-notifications
#   npx cap add android
#
# Then, from the repo root, just run:
#   ./scripts/build-apk.sh
#
# The APK lands at build/console-latest.apk (also copied to a timestamped
# archive alongside it).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. Sanity check the toolchain up front, so the client is not left staring at
#    a Gradle error twenty minutes in.
if [ ! -d "android" ]; then
  echo "✗ android/ folder is missing." >&2
  echo "  Run this once first:" >&2
  echo "    npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/push-notifications" >&2
  echo "    npx cap add android" >&2
  exit 1
fi

if [ -z "${JAVA_HOME:-}" ] && ! command -v java >/dev/null 2>&1; then
  echo "✗ Java is missing. Gradle cannot run without a JDK." >&2
  echo "  On Ubuntu/Debian:" >&2
  echo "    sudo apt install -y openjdk-21-jdk" >&2
  echo "    echo 'export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64' >> ~/.bashrc" >&2
  echo "    echo 'export PATH=\"\$JAVA_HOME/bin:\$PATH\"' >> ~/.bashrc" >&2
  echo "    source ~/.bashrc" >&2
  exit 1
fi

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  if [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
    echo "ℹ Using ANDROID_HOME=$ANDROID_HOME (auto-detected)"
  else
    echo "✗ ANDROID_HOME is not set and no SDK found at ~/Android/Sdk." >&2
    echo "  Install the command-line tools once:" >&2
    echo "    mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools" >&2
    echo "    wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" >&2
    echo "    unzip commandlinetools-linux-*.zip && mv cmdline-tools latest" >&2
    echo "    export ANDROID_HOME=\$HOME/Android/Sdk" >&2
    echo "    yes | \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses" >&2
    echo "    \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0'" >&2
    exit 1
  fi
fi

echo "▶ Building the web bundle"
(cd web && npm run build)

echo "▶ Syncing the web bundle into the Android project"
npx cap sync android

echo "▶ Assembling the debug APK"
(cd android && ./gradlew assembleDebug)

SRC="android/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$SRC" ]; then
  echo "✗ Gradle finished but did not produce $SRC" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="build"
mkdir -p "$OUT_DIR"
cp "$SRC" "$OUT_DIR/console-latest.apk"
cp "$SRC" "$OUT_DIR/console-$STAMP.apk"

echo
echo "✓ APK ready"
echo "  Latest:   $OUT_DIR/console-latest.apk"
echo "  Archived: $OUT_DIR/console-$STAMP.apk"
echo
echo "  Send this file to the client. They tap it on their phone to install."
