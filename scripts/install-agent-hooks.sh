#!/usr/bin/env bash
# install-agent-hooks.sh — Protocol v2.9.1
#
# Default (no args):   install this repo's pre-commit secret/privacy scan via a
#                      chaining dispatcher (.git/hooks/pre-commit.d/).
# --capture [repo]:    install the AMP post-commit capture hook
#                      (adapters/git-hooks/post-commit) into any working
#                      repo, same dispatcher convention.
#
# Dispatcher rules (§15.5 chain-never-clobber): a hook file we didn't write
# is left untouched — we refuse with chaining instructions instead of
# overwriting. Re-running is idempotent. The exact pre-v2.8 single-file
# secret-scan hook is recognized and migrated automatically.
set -euo pipefail

memory_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DISPATCHER_SENTINEL="# rxai-amp-dispatcher"

install_dispatcher() { # $1 = git repo root, $2 = hook name (pre-commit / post-commit)
  local root="$1" name="$2"
  local hook="$root/.git/hooks/$name"
  local dir="$root/.git/hooks/$name.d"
  mkdir -p "$dir"

  if [ -f "$hook" ] && ! grep -q "$DISPATCHER_SENTINEL" "$hook"; then
    # Exact pre-v2.8 payload? Migrate it into the dispatcher directory.
    if [ "$name" = "pre-commit" ] && grep -q "node scripts/secret-scan.mjs --staged" "$hook" \
       && [ "$(grep -cv '^\s*$' "$hook")" -le 4 ]; then
      echo "Migrating legacy secret-scan pre-commit hook into $name.d/"
    else
      echo "REFUSING to overwrite existing foreign $name hook: $hook" >&2
      echo "Chain it manually: move it to $dir/50-custom and rerun this installer." >&2
      return 1
    fi
  fi

  cat > "$hook" <<HOOK
#!/usr/bin/env bash
$DISPATCHER_SENTINEL — runs every executable in $name.d/ in order (v2.8)
set -euo pipefail
hook_dir="\$(dirname "\$0")/$name.d"
[ -d "\$hook_dir" ] || exit 0
for part in "\$hook_dir"/*; do
  [ -x "\$part" ] && "\$part" "\$@"
done
exit 0
HOOK
  chmod +x "$hook"
}

if [ "${1:-}" = "--capture" ]; then
  target="${2:-$(pwd)}"
  target="$(cd "$target" && git rev-parse --show-toplevel)"
  install_dispatcher "$target" "post-commit"
  part="$target/.git/hooks/post-commit.d/50-amp-capture"
  # Absolute-path the shared lib so the hook works from any cwd.
  sed "s|__AMP_LIB__|$memory_root/adapters/lib|" \
    "$memory_root/adapters/git-hooks/post-commit" > "$part"
  chmod +x "$part"
  echo "Installed AMP capture post-commit hook in $target (.git/hooks/post-commit.d/50-amp-capture)"
  exit 0
fi

# Default: this repo's own pre-commit secret/privacy scan.
root="$(git rev-parse --show-toplevel)"
install_dispatcher "$root" "pre-commit"
part="$root/.git/hooks/pre-commit.d/10-secret-scan"
cat > "$part" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
node scripts/secret-scan.mjs --staged
HOOK
chmod +x "$part"
echo "Installed agent pre-commit secret/privacy scan hook at .git/hooks/pre-commit.d/10-secret-scan"
