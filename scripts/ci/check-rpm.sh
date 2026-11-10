#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob
packages=(/packages/*.rpm)
if [[ ${#packages[@]} != 1 ]]; then
  echo 'Expected exactly one RPM to verify' >&2
  exit 1
fi

dnf install -y "${packages[0]}" desktop-file-utils util-linux
test "$(rpm -q --qf '%{NAME}' dsh-switcher)" = dsh-switcher
test "$(rpm -q --qf '%{ARCH}' dsh-switcher)" = x86_64
rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' dsh-switcher
rpm -ql dsh-switcher > /tmp/switcher-package-files
grep -q '/usr/share/icons/hicolor/.*dsh-switcher' /tmp/switcher-package-files
desktop-file-validate /usr/share/applications/dsh-switcher.desktop
test -x /usr/bin/dsh-switcher
ldd '/opt/DSH Switcher/dsh-switcher' > /tmp/switcher-libraries
if grep -q 'not found' /tmp/switcher-libraries; then
  cat /tmp/switcher-libraries >&2
  exit 1
fi
runuser -u nobody -- env ELECTRON_RUN_AS_NODE=1 /usr/bin/dsh-switcher -e 'console.log("Fedora Electron runtime:", process.versions.electron)'
dnf remove -y dsh-switcher
test ! -e '/opt/DSH Switcher/dsh-switcher'
test ! -e /usr/share/applications/dsh-switcher.desktop
echo 'PASS: Fedora RPM install, dependencies, desktop entry, icon, executable and uninstall'
