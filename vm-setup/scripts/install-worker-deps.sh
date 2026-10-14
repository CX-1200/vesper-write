#!/usr/bin/env bash
# vm-setup/scripts/install-worker-deps.sh — run as root on the VM (07-worker-install.md §3).
#
# Installs the worker's runtime dependencies into <repo>/node_modules WITHOUT
# npm: exactly the versions pinned in package-lock.json, and every tarball is
# checked against the lockfile's sha512 "integrity" before it is unpacked.
# Today that is one package (hpke, which has no dependencies of its own) plus
# the two workspace links (@vesper/core, @vesper/worker).
#
# Why not `apt install npm`: on Ubuntu that pulls in hundreds of node-* packages
# onto the VM that is Vesper's trust root, for the sake of one small library.
set -euo pipefail

ROOT="${1:-/opt/vesper}"
cd "$ROOT"
[ -f package-lock.json ] || { echo "在 $ROOT 找不到 package-lock.json" >&2; exit 1; }

# The packages the worker needs: dependencies of worker/ and packages/core/,
# followed through the lockfile. Workspace packages are linked, not downloaded.
LIST=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const pk = JSON.parse(readFileSync("package-lock.json", "utf8")).packages;
const want = new Map();
const queue = [...Object.keys(pk["worker"].dependencies ?? {}), ...Object.keys(pk["packages/core"].dependencies ?? {})];
while (queue.length) {
  const name = queue.shift();
  if (name.startsWith("@vesper/") || want.has(name)) continue;
  const e = pk["node_modules/" + name];
  if (!e || !e.resolved || !e.integrity) throw new Error("not in package-lock.json: " + name);
  if (!e.resolved.startsWith("https://registry.npmjs.org/") || !e.integrity.startsWith("sha512-")) throw new Error("unexpected source for " + name);
  want.set(name, e);
  queue.push(...Object.keys(e.dependencies ?? {}));
}
for (const [name, e] of want) console.log([name, e.version, e.resolved, e.integrity].join(" "));
')

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
rm -rf node_modules
mkdir -p node_modules/@vesper

while read -r name version url integrity; do
  [ -n "$name" ] || continue
  echo "下载 $name@$version"
  curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$TMP/pkg.tgz"
  actual="sha512-$(openssl dgst -sha512 -binary "$TMP/pkg.tgz" | base64 -w0)"
  if [ "$actual" != "$integrity" ]; then
    echo "完整性检查失败：$name 的 sha512 和 package-lock.json 不同。不要继续。" >&2
    exit 1
  fi
  mkdir -p "node_modules/$name"
  tar -xzf "$TMP/pkg.tgz" --strip-components=1 --no-same-owner -C "node_modules/$name"
  echo "  sha512 与 package-lock.json 相符"
done <<<"$LIST"

ln -s ../../packages/core node_modules/@vesper/core
ln -s ../../worker node_modules/@vesper/worker
chown -R root:root node_modules
chmod -R go-w node_modules
echo "完成。已安装：$(cut -d' ' -f1,2 <<<"$LIST" | tr ' \n' '@ ')（另有 @vesper/core、@vesper/worker 两个连结）"
