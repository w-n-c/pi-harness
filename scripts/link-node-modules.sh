#!/usr/bin/env bash
# Links the repo's node_modules to the currently-installed Pi release so that
# TypeScript and Bun resolve @earendil-works/* and typebox without hardcoding a
# version in tsconfig.json. Re-run after `pi update`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="$repo_root/agent/install"
version_file="$install_dir/current-version"

if [[ ! -f "$version_file" ]]; then
	echo "error: $version_file not found. Install Pi first (pi update)." >&2
	exit 1
fi

version="$(tr -d '[:space:]' < "$version_file")"
release_modules="$install_dir/releases/$version/node_modules"

if [[ ! -d "$release_modules" ]]; then
	echo "error: release $version has no node_modules at $release_modules" >&2
	exit 1
fi

ln -sfn "$release_modules" "$repo_root/node_modules"
echo "node_modules -> agent/install/releases/$version/node_modules"
