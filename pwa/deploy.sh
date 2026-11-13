#!/bin/sh
# Test, build and deploy this checkout as the running bridge, from inside the box.
# The entrypoint's loop runs ~/.local/share/herdr-pwa when it exists and restarts it 5 s after it exits.
# Back to the image's copy: rm -rf ~/.local/share/herdr-pwa, then run the pkill line below.
set -eu
cd "$(dirname "$0")"
dst=~/.local/share/herdr-pwa
npm ci
npm test
npm run build
rm -rf "$dst.new"
cp -a . "$dst.new"
rm -rf "$dst"
mv "$dst.new" "$dst"
pkill -f 'herdr-pwa/server/main.ts' || true
echo "deployed to $dst; the bridge restarts in about 5 s (log: /tmp/herdr-pwa.log)"
