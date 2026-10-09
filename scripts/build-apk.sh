#!/usr/bin/env bash
# Build the Trippin' debug APK: bundles trippin/ into the Android shell and runs Gradle.
# Needs JDK 17+, the Android SDK (ANDROID_HOME) and Gradle 8.x on PATH. Output: ./Trippin-debug.apk
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf android/app/src/main/assets/trippin
mkdir -p android/app/src/main/assets
cp -r trippin android/app/src/main/assets/trippin
rm -rf android/app/src/main/assets/trippin/tests
(cd android && gradle --no-daemon -q assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk Trippin-debug.apk
mkdir -p dist && cp Trippin-debug.apk dist/Trippin-debug.apk   # always keep a local copy in dist/
echo "Built $(pwd)/Trippin-debug.apk ($(du -h Trippin-debug.apk | cut -f1))"
