#!/usr/bin/env bash
# Claude Code Stop hook — enforces the documentation maintenance
# protocol described in CLAUDE.md §0.
#
# Fires when Claude tries to end its turn. If source files have changed
# in this session but CLAUDE.md has NOT, prints a loud reminder. The
# warning is non-blocking — Claude still ends the turn — but the
# message lands in the next-turn context, so the agent (or the human
# reviewing the transcript) sees that the protocol may have slipped.
#
# To bypass intentionally (e.g. typo fix, comment-only change), the
# agent should explicitly say in its response why no doc change is
# needed. The hook doesn't force a doc change, it just refuses to be
# silent about the gap.

SRC_PATTERN='\.(ts|tsx|js|jsx|py|go|sql)$|^Makefile$|^Dockerfile|docker-compose|\.toml$|\.cfg$|alembic\.ini$'

# Look at every kind of pending change — staged, unstaged, untracked.
changed=$( {
  git diff --name-only HEAD 2>/dev/null
  git diff --cached --name-only 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
} | sort -u )

if echo "$changed" | grep -qE "$SRC_PATTERN" && ! echo "$changed" | grep -q '^CLAUDE\.md$'; then
  echo "⚠ PROTOCOL ALERT — source files changed, CLAUDE.md was not updated this session."
  echo ""
  echo "Per §0 of CLAUDE.md (Documentation maintenance protocol):"
  echo "  • Update the relevant section(s) of CLAUDE.md in the same commit, OR"
  echo "  • Explicitly state in your response which sections were considered and why no doc change is needed."
  echo ""
  echo "Changed files this session:"
  echo "$changed" | grep -E "$SRC_PATTERN" | sed 's/^/    /'
fi

exit 0
