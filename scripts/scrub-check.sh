#!/usr/bin/env bash
# Public-repo scrub gate (specs/architecture.md#ci). This repository is public, so no marker of a
# real machine, person or session may land in it. Scans every tracked and untracked-but-not-ignored
# file of the git checkout it runs in (never node_modules/, dist/ or .git/) and fails on:
#
#   - a home path with a real-looking user name (/home/<name>, /Users/<name>); the synthetic
#     `user` is allowed everywhere, and Homebrew's `linuxbrew` prefix only inside the committed
#     skill bundle, where a dependency names it
#   - an email address, unless its domain is reserved for documentation (RFC 2606 / 6761:
#     example.com|net|org, *.example, *.test, *.invalid, *.localhost)
#   - a uuid literal outside test/fixtures/, unless it has the synthetic shape the tests and specs
#     use (`xxxxxxxx-xxxx-4000-8000-xxxxxxxxxxxx`)
#
#   bash scripts/scrub-check.sh        # (bun run check:scrub) exit 0 clean, 1 on any hit, 2 on error
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

files=()
while IFS= read -r -d '' f; do
  case "$f" in node_modules/* | */node_modules/* | dist/* | .git/*) continue ;; esac
  [[ -f "$f" && ! -L "$f" ]] && files+=("$f")
done < <(git ls-files -z --cached --others --exclude-standard)

if ((${#files[@]} == 0)); then
  echo "scrub: no files to scan" >&2
  exit 1
fi

# rule name, match pattern (grep -E, case-insensitive), allow pattern over "path:line:match"
rules=(
  "home path"
  '/(home|users)/[a-z0-9._-]+'
  ':/(home|users)/user$|^skills/agent-recall-axi/scripts/agent-recall-axi\.mjs:[0-9]+:/(home)/linuxbrew$'

  "email address"
  '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
  '@(([a-z0-9-]+\.)*example\.(com|net|org)|([a-z0-9-]+\.)*[a-z0-9-]+\.(example|test|invalid|localhost))$'

  "uuid literal"
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  '^test/fixtures/|-4000-8000-[0-9a-f]{12}$'
)

failed=0
for ((i = 0; i < ${#rules[@]}; i += 3)); do
  name=${rules[i]} match=${rules[i + 1]} allow=${rules[i + 2]}
  status=0
  found=$(grep -nIHoiE -- "$match" "${files[@]}") || status=$?
  if ((status > 1)); then
    echo "scrub: grep failed ($status) on rule: $name" >&2
    exit 2
  fi
  hits=$(grep -viE -- "$allow" <<<"$found" || true)
  if [[ -n "$hits" ]]; then
    failed=1
    echo "scrub: $name found (this repository is public; remove it or use a synthetic value):" >&2
    sed 's/^/  /' <<<"$hits" >&2
  fi
done

if ((failed)); then exit 1; fi
echo "scrub: ${#files[@]} files clean"
