#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
shopt -s nullglob
packages=(/packages/*.deb)
if [[ ${#packages[@]} != 1 ]]; then
  echo 'Expected exactly one DEB to verify'
  exit 1
fi

apt-get update
# Check declared runtime dependencies before installing the GUI test tools.
apt-get install -y --no-install-recommends "${packages[0]}"
test "$(dpkg-query -W -f='${Package}' dsh-switcher)" = dsh-switcher
test "$(dpkg-query -W -f='${Architecture}' dsh-switcher)" = amd64
version="$(dpkg-query -W -f='${Version}' dsh-switcher)"
if [[ "$version" == *~dev.* ]]; then dpkg --compare-versions "$version" lt "${version%%~*}"; fi
dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' dsh-switcher
dpkg-query -L dsh-switcher > /tmp/switcher-package-files
grep -q '/usr/share/icons/hicolor/.*dsh-switcher' /tmp/switcher-package-files
test -x /usr/bin/dsh-switcher
ldd '/opt/DSH Switcher/dsh-switcher' > /tmp/switcher-libraries
if grep -q 'not found' /tmp/switcher-libraries; then
  cat /tmp/switcher-libraries
  exit 1
fi
apt-get install -y --no-install-recommends desktop-file-utils xvfb xauth dbus-x11 fonts-dejavu-core passwd
desktop-file-validate /usr/share/applications/dsh-switcher.desktop
bash /workspace/scripts/ci/run-linux-desktop.sh /usr/bin/dsh-switcher
apt-get remove -y dsh-switcher
test ! -e '/opt/DSH Switcher/dsh-switcher'
test ! -e /usr/bin/dsh-switcher
test ! -e /usr/share/applications/dsh-switcher.desktop
echo 'PASS: DEB install, dependency resolution, desktop entry, icon, GUI integration, version ordering and uninstall'
