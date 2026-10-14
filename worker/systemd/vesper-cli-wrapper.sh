#!/bin/sh
# /usr/local/bin/vesper — runs the Vesper CLI as the vesper user.
set -eu
if [ "$(id -un)" != "vesper" ]; then
  echo "请用 vesper 用户执行，例如：sudo -u vesper -i vesper $*" >&2
  exit 1
fi
umask 077
export VESPER_CONFIG=/etc/vesper/worker.json
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:3128
export HTTP_PROXY=http://127.0.0.1:3128
exec /usr/bin/node --disable-warning=ExperimentalWarning /opt/vesper/worker/cli/vesper.ts "$@"
