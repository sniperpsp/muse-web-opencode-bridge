#!/bin/sh
set -eu

# The container owns this display; a restart can leave the stopped Xvfb's sockets behind.
display_number=${DISPLAY#:}
display_number=${display_number%%.*}
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:7900 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
sleep 1
exec node src/server.js
