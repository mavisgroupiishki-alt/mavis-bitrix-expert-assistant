#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="25.8.7"
readonly ROOT_DIR="$PWD/.local-libreoffice"
readonly SOFFICE="$ROOT_DIR/opt/libreoffice25.8/program/soffice"
readonly ARCHIVE_URL="https://download.documentfoundation.org/libreoffice/stable/${VERSION}/deb/x86_64/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"

if [[ -x "$SOFFICE" ]]; then
  exit 0
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

curl --fail --location --retry 3 --retry-delay 2 "$ARCHIVE_URL" -o "$work_dir/libreoffice.tar.gz"
tar -xzf "$work_dir/libreoffice.tar.gz" -C "$work_dir"
mkdir -p "$ROOT_DIR"
find "$work_dir" -type f -name '*.deb' -exec dpkg-deb -x '{}' "$ROOT_DIR" \;
test -x "$SOFFICE"
