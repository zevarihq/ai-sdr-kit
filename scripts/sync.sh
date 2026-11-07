#!/usr/bin/env bash
# Refresh both skills from the public guides on zevari.ai, the only source of
# their text. Optional argument: a local folder holding the two .md files.
set -euo pipefail
SRC="${1:-https://zevari.ai/guides}"
cd "$(dirname "$0")/.."

sync_skill() { # <skill> <guide file>
  local skill="skills/$1/SKILL.md" tmp
  tmp="$(mktemp)"
  sed '/^<!-- guide below/q' "$skill" > "$tmp"
  echo >> "$tmp"
  case "$SRC" in
    http*) curl -fsSL "$SRC/$2" >> "$tmp" ;;
    *) cat "$SRC/$2" >> "$tmp" ;;
  esac
  mv "$tmp" "$skill"
  echo "synced $skill"
}

sync_skill agentify-outbound agentify-outbound-sop.md
sync_skill outbound-sequence-playbook outbound-sequence-playbook.md
