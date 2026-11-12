#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob
images=(/packages/*.AppImage)
if [[ ${#images[@]} != 1 ]]; then
  echo 'Expected exactly one AppImage to verify'
  exit 1
fi

# A clean Arch image validates the portable package outside the DEB/RPM families.
pacman -Syu --noconfirm --needed gtk3 nss alsa-lib libxss libxtst libnotify \
  libsecret mesa xdg-utils dbus xorg-server-xvfb xorg-xauth ttf-dejavu \
  desktop-file-utils util-linux shadow
mkdir -p /opt/switcher-appimage
image="/opt/switcher-appimage/$(basename "${images[0]}")"
cp "${images[0]}" "$image"
chmod 755 "$image"
cd /opt/switcher-appimage
"$image" --appimage-extract > /tmp/switcher-appimage-files
test -x squashfs-root/AppRun
test -s squashfs-root/resources/app.asar
test -s squashfs-root/resources/icon.png
desktop-file-validate squashfs-root/dsh-switcher.desktop
if grep -Eq '^[[:space:]]*Exec=.*--no-sandbox' squashfs-root/dsh-switcher.desktop; then
  echo 'Portable desktop entry must not disable the sandbox by default'
  exit 1
fi
rm -rf squashfs-root
# Test the actual AppImage executable, including its runtime and launcher, without FUSE.
export APPIMAGE_EXTRACT_AND_RUN=1
bash /workspace/scripts/ci/run-linux-desktop.sh "$image"
echo 'PASS: Arch AppImage extraction, desktop entry and portable GUI integration'
