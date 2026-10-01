#!/bin/sh
# Keep the existing login, but don't import user tools, hooks or project settings.
if [ "$1" != "exec" ]; then
  exit 64
fi
shift
exec codex exec --ignore-user-config --ignore-rules "$@"
