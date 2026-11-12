#!/usr/bin/env bash
set -euo pipefail

# /workspace and /node/bin/node are read-only mounts from the CI runner.
# Exercise the installed package as a normal user with an isolated home and DBus.
executable="$1"
work="$(mktemp -d /tmp/switcher-desktop-ci-XXXXXX)"
useradd --create-home --shell /bin/bash switcher-test
chown switcher-test:switcher-test "$work"
mkdir -p /diagnostics
trap 'if [[ -d "$work/test-results" ]]; then cp -a "$work/test-results/." /diagnostics/; chmod -R a+rX /diagnostics; fi' EXIT
cd "$work"
runuser -u switcher-test -- env \
  HOME=/home/switcher-test \
  SWITCHER_TEST_TMP="$work" \
  SWITCHER_TEST_EXECUTABLE="$executable" \
  SWITCHER_EXPECT_ARCH=x64 \
  SWITCHER_TEST_NO_SANDBOX=1 \
  dbus-run-session -- xvfb-run -a /node/bin/node /workspace/scripts/test-desktop.mjs

# Docker's namespace restrictions require the test-only flag above. Native host
# tests run without it; neither the package nor the AppRun launcher sets it.
