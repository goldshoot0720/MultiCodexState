#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  MultiCodexState installer - macOS / Linux
#
#  One-liner:
#    curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.sh | bash
#
#  With options:
#    curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.sh \
#      | bash -s -- --install-dir "$HOME/tools/multicodexstate"
#
#  Checks for Node 18+/npm/git, downloads the source to ~/.multicodexstate,
#  installs dependencies, registers the `MultiCodexState` command globally and
#  runs a smoke test. Re-running updates in place; --force reinstalls from
#  scratch.
#
#  Deliberately POSIX sh: it also runs under dash/ash on Linux.
# ---------------------------------------------------------------------------

# --- Re-exec from a private copy when the script arrives on stdin ----------
#
# `curl ... | bash` feeds this file to the shell through stdin, and the shell
# reads it incrementally - so the first child process that reads stdin (npm,
# git, the Xcode Command Line Tools prompt) would swallow the rest of the
# script. Copy the whole thing out first, then run the copy with stdin
# detached from the pipe.
if [ -z "${MC_REEXEC:-}" ] && [ ! -t 0 ]; then
  _self="$(mktemp "${TMPDIR:-/tmp}/multicodexstate-install.XXXXXX" 2>/dev/null)" || _self=''
  if [ -z "$_self" ]; then
    printf 'install.sh: could not create a temporary file\n' >&2
    exit 1
  fi
  cat > "$_self"
  chmod 700 "$_self"
  MC_REEXEC=1
  MC_SELF="$_self"
  export MC_REEXEC MC_SELF
  exec /bin/sh "$_self" "$@" < /dev/null
fi

if [ -n "${MC_SELF:-}" ]; then
  trap 'rm -f "$MC_SELF"' EXIT HUP INT TERM
fi

set -eu

# --- Defaults --------------------------------------------------------------

INSTALL_DIR="${INSTALL_DIR:-$HOME/.multicodexstate}"
REPO="${REPO:-goldshoot0720/MultiCodexState}"
BRANCH="${BRANCH:-main}"
NO_LINK="${NO_LINK:-0}"
FORCE="${FORCE:-0}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

usage() {
  cat <<'EOF'
MultiCodexState installer - macOS / Linux

Usage:
  curl -fsSL <url>/install.sh | bash
  curl -fsSL <url>/install.sh | bash -s -- [options]

Options:
  --install-dir <path>   Where to install. Default: ~/.multicodexstate
  --repo <owner/name>    Source repository. Default: goldshoot0720/MultiCodexState
  --branch <name>        Branch or tag to install. Default: main
  --no-link              Skip `npm link`; run it via `node bin/gs.js` instead
  -f, --force            Reinstall from scratch, discarding the existing copy
  -h, --help             Show this help

Environment (same settings as the flags):
  INSTALL_DIR, REPO, BRANCH, NO_LINK=1, FORCE=1
  CODEX_HOME            Codex CLI home. Default: ~/.codex
  NO_COLOR             Disable coloured output
EOF
}

expand_tilde() {
  case "$1" in
    '~')    printf '%s' "$HOME" ;;
    '~/'*)  printf '%s' "$HOME/${1#\~/}" ;;
    *)      printf '%s' "$1" ;;
  esac
}

# --- Arguments -------------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)   shift; [ "$#" -gt 0 ] || { printf 'install.sh: --install-dir needs a path\n' >&2; exit 2; }; INSTALL_DIR="$1" ;;
    --install-dir=*) INSTALL_DIR="${1#*=}" ;;
    --repo)          shift; [ "$#" -gt 0 ] || { printf 'install.sh: --repo needs a value\n' >&2; exit 2; }; REPO="$1" ;;
    --repo=*)        REPO="${1#*=}" ;;
    --branch)        shift; [ "$#" -gt 0 ] || { printf 'install.sh: --branch needs a value\n' >&2; exit 2; }; BRANCH="$1" ;;
    --branch=*)      BRANCH="${1#*=}" ;;
    --no-link)       NO_LINK=1 ;;
    -f|--force)      FORCE=1 ;;
    -h|--help)       usage; exit 0 ;;
    *)               printf 'install.sh: unknown option %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

INSTALL_DIR="$(expand_tilde "$INSTALL_DIR")"
# Strip trailing slashes so `git -C` and the guards below see a canonical path.
while [ "${INSTALL_DIR%/}" != "$INSTALL_DIR" ] && [ "$INSTALL_DIR" != "/" ]; do
  INSTALL_DIR="${INSTALL_DIR%/}"
done
[ -n "$INSTALL_DIR" ] || { printf 'install.sh: --install-dir cannot be empty\n' >&2; exit 2; }

# --- Output helpers --------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != 'dumb' ]; then
  _esc="$(printf '\033')"
  C_CYAN="$_esc[36m"; C_GREEN="$_esc[32m"; C_YELLOW="$_esc[33m"
  C_RED="$_esc[31m";  C_DIM="$_esc[90m";   C_OFF="$_esc[0m"
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_OFF=''
fi

say()  { printf '  %s\n' "$*"; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
step() { printf '  %s%s%s\n' "$C_CYAN" "$*" "$C_OFF"; }
ok()   { printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '  %s[!!]%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
die()  { printf '  %s%s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

printf '\n'
printf '  MultiCodexState installer\n'
printf '  %s------------------------%s\n' "$C_DIM" "$C_OFF"
printf '\n'

# --- 1. Platform -----------------------------------------------------------

case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "This script is for macOS and Linux.
       On Windows use install.ps1 (PowerShell) or install.cmd instead." ;;
  *)
    die "Unsupported platform: $(uname -s 2>/dev/null || echo unknown)" ;;
esac

# --- 2. Prerequisites ------------------------------------------------------

step "Checking prerequisites..."

# A non-interactive shell - which is exactly what `curl | bash` gives you -
# never sources ~/.zshrc or ~/.bashrc, so an nvm-managed node looks "missing".
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  die "Node.js 18+ is required but 'node' was not found on PATH.
       Install it with:  brew install node
       (or nvm: https://github.com/nvm-sh/nvm)
       Then open a new terminal and re-run this script."
fi

NODE_VER="$(node --version 2>/dev/null | tr -d 'v\r' || true)"
NODE_MAJOR="${NODE_VER%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "Could not read the Node.js version (got '$NODE_VER')." ;;
esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js 18+ is required (found v$NODE_VER)."
fi
ok "node v$NODE_VER"

if ! command -v npm >/dev/null 2>&1; then
  die "npm was not found on PATH (it ships with Node.js)."
fi
ok "npm available"

if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  if [ "$(uname -s)" = 'Darwin' ]; then
    die "git is required but is not usable.
       On macOS it comes from the Command Line Tools:  xcode-select --install"
  fi
  die "git is required but was not found on PATH.
       Install it from https://git-scm.com and re-run this script."
fi
ok "git available"

# --- 3. Helpers ------------------------------------------------------------

# Refuse to delete anything that is not clearly ours. The default install dir
# is disposable; a user-supplied one might not be, and `rm -rf` on a typo is
# not recoverable.
guard_removal() {
  _d="$1"

  case "$_d" in
    ''|/|"$HOME"|"$HOME/"|"$CODEX_HOME_DIR"|"$CODEX_HOME_DIR"/*|/usr|/usr/*|/etc|/etc/* \
    |/var|/var/*|/bin|/sbin|/opt|/opt/*|/System|/System/*|/Library|/Library/*|/Applications|/Applications/*)
      die "Refusing to delete '$_d' - that path is not safe for this installer to remove." ;;
  esac

  # An install dir that is an ancestor of $HOME (e.g. /Users) is a typo.
  case "$HOME/" in
    "$_d"/*) die "Refusing to delete '$_d' - it contains your home directory." ;;
  esac

  if [ -e "$_d" ]; then
    if [ -f "$_d/package.json" ] && grep -q '"multi-codex-state"' "$_d/package.json" 2>/dev/null; then
      return 0
    fi
    if [ "$FORCE" -ne 1 ]; then
      die "$_d already exists and does not look like a MultiCodexState install.
       Move it aside, or re-run with --force to replace it."
    fi
    warn "Removing $_d (--force)"
  fi
}

# Resolve the branch to an immutable commit SHA.
#
# Branch-name URLs sit behind a CDN with a long TTL, so a download started
# right after a push can still hand back the previous revision. A SHA can
# never be stale.
#
# `git ls-remote` is tried first: the unauthenticated GitHub REST API allows
# only 60 requests/hour per IP and is routinely exhausted behind shared/NAT
# addresses. The API is a fallback for networks that allow plain HTTPS but
# block the git protocol.
resolve_sha() {
  _sha=''
  _sha="$(git ls-remote "https://github.com/$REPO.git" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR==1 { print $1 }')" || _sha=''
  if [ -z "$_sha" ]; then
    _sha="$(git ls-remote "https://github.com/$REPO.git" "refs/tags/$BRANCH^{}" "refs/tags/$BRANCH" 2>/dev/null | awk 'NR==1 { print $1 }')" || _sha=''
  fi
  if [ -z "$_sha" ] && command -v curl >/dev/null 2>&1; then
    _sha="$(curl -fsSL --max-time 20 \
      -H 'Accept: application/vnd.github+json' \
      -H 'User-Agent: MultiCodexState-installer' \
      "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null \
      | grep -o '"sha": *"[0-9a-f]\{40\}"' | head -n 1 \
      | sed 's/.*"\([0-9a-f]\{40\}\)".*/\1/')" || _sha=''
  fi
  # Anything that is not a full 40-char hex SHA is unusable - discard it and
  # let the caller fall back to the branch name.
  if [ "${#_sha}" -ne 40 ]; then
    _sha=''
  fi
  printf '%s' "$_sha"
}

# Move an existing checkout onto the current tip.
update_existing() {
  step "Updating the existing install at $INSTALL_DIR..."
  _sha="$(resolve_sha)"
  _ref="${_sha:-$BRANCH}"
  if git -C "$INSTALL_DIR" fetch -q --depth 1 origin "$_ref" 2>/dev/null \
    && git -C "$INSTALL_DIR" checkout -q FETCH_HEAD 2>/dev/null; then
    ok "source updated"
    return 0
  fi
  warn "Update failed - reinstalling from scratch."
  return 1
}

fetch_fresh() {
  if [ -e "$INSTALL_DIR" ]; then
    guard_removal "$INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"

  step "Downloading source to $INSTALL_DIR..."
  _sha="$(resolve_sha)"
  if [ -z "$_sha" ]; then
    warn "Could not resolve $BRANCH to a commit SHA; cloning the branch name directly."
  fi

  _fetched=0
  if [ -n "$_sha" ]; then
    step "Fetching commit $(printf '%s' "$_sha" | cut -c1-7) on $BRANCH..."
    if git init -q "$INSTALL_DIR" 2>/dev/null \
      && git -C "$INSTALL_DIR" remote add origin "https://github.com/$REPO.git" 2>/dev/null \
      && git -C "$INSTALL_DIR" fetch -q --depth 1 origin "$_sha" 2>/dev/null \
      && git -C "$INSTALL_DIR" checkout -q FETCH_HEAD 2>/dev/null; then
      _fetched=1
    else
      warn "Fetching that commit failed - falling back to the branch name."
      rm -rf "$INSTALL_DIR"
    fi
  fi

  if [ "$_fetched" -ne 1 ]; then
    if ! git clone -q --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR" 2>/dev/null; then
      die "Failed to fetch https://github.com/$REPO.git
       Check the repository name, the branch '$BRANCH', and your network connection."
    fi
  fi

  if [ ! -f "$INSTALL_DIR/package.json" ]; then
    die "The downloaded source has no package.json - $REPO@$BRANCH looks wrong."
  fi
  ok "source downloaded"
}

# --- 4. Source -------------------------------------------------------------

_needs_fetch=1
if [ -f "$INSTALL_DIR/package.json" ] && [ "$FORCE" -ne 1 ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    if update_existing; then
      _needs_fetch=0
    fi
  else
    warn "The copy at $INSTALL_DIR is not a git checkout - reinstalling."
  fi
fi
# Note: FORCE is never set from here. It must mean "the user asked for this",
# because guard_removal() uses it to decide whether an unrecognised directory
# may be deleted - a broken install must not become that authorisation.
if [ "$_needs_fetch" -ne 1 ]; then
  dim "Using the existing copy at $INSTALL_DIR"
fi
if [ "$_needs_fetch" -eq 1 ]; then
  fetch_fresh
fi

# The checkout is deliberately left detached at FETCH_HEAD (see src/version.js,
# which updates by fetching an exact SHA and hard-resetting onto FETCH_HEAD -
# `git pull` would be a silent no-op here).

# --- 5. Dependencies -------------------------------------------------------

step "Installing dependencies (chalk)..."
_log="$(mktemp "${TMPDIR:-/tmp}/multicodexstate-npm.XXXXXX")"
_npm_ok=0

# `npm ci` installs exactly what the lockfile pins and never rewrites it, so it
# is the right default for an install directory. It refuses to run when the
# lockfile has drifted from package.json, so keep `npm install` as a fallback.
if [ -f "$INSTALL_DIR/package-lock.json" ]; then
  if ( cd "$INSTALL_DIR" && npm ci --no-audit --no-fund --loglevel=error >"$_log" 2>&1 ); then
    _npm_ok=1
  fi
fi
if [ "$_npm_ok" -ne 1 ]; then
  if ( cd "$INSTALL_DIR" && npm install --no-audit --no-fund --loglevel=error >"$_log" 2>&1 ); then
    _npm_ok=1
  fi
fi
if [ "$_npm_ok" -ne 1 ]; then
  printf '\n'
  cat "$_log" >&2
  rm -f "$_log"
  die "Installing dependencies failed (npm ci / npm install)."
fi
rm -f "$_log"
ok "dependencies installed"

chmod +x "$INSTALL_DIR/bin/gs.js" 2>/dev/null || true

# npm chmods the bin target to 0755 when it links it, which makes `git status`
# report a mode change and would leave `MultiCodexState update` refusing to run
# ("working tree is dirty"). An install checkout has no business tracking file
# modes, so turn that off for this repository only.
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" config core.fileMode false 2>/dev/null || true
fi

# --- 6. Register the command ----------------------------------------------

NEED_PATH=0
LINK_DIR=''

if [ "$NO_LINK" -eq 1 ]; then
  warn "Skipped npm link (--no-link). Run it with: node \"$INSTALL_DIR/bin/gs.js\""
else
  step "Registering the 'MultiCodexState' command..."
  _log="$(mktemp "${TMPDIR:-/tmp}/multicodexstate-link.XXXXXX")"
  _linked=0
  if ( cd "$INSTALL_DIR" && npm link --no-audit --no-fund --loglevel=error >"$_log" 2>&1 ); then
    _linked=1
  else
    # npm can exit non-zero *after* doing the useful part. On a case-insensitive
    # filesystem (macOS APFS, Windows NTFS) it aborts with EEXIST when a package
    # declares two bin names that differ only in case - it creates the first
    # symlink, then finds the second "already exists" because it is the same
    # file. The link it did create is perfectly usable, so judge by whether the
    # command actually resolves rather than by npm's exit code.
    _prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$_prefix" ] && [ -x "$_prefix/bin/MultiCodexState" ]; then
      _linked=2
    fi
  fi

  if [ "$_linked" -eq 1 ]; then
    ok "command registered"
  elif [ "$_linked" -eq 2 ]; then
    ok "command registered (npm reported an error, but the link is in place)"
  else
    # Usually EACCES: a system-wide Node (nodejs.org pkg installer, or a
    # Homebrew install on Intel) keeps its global prefix root-owned, so
    # `npm link` cannot write there. Fall back to a per-user bin directory.
    warn "npm link failed - falling back to a symlink in ~/.local/bin"
    LINK_DIR="$HOME/.local/bin"
    mkdir -p "$LINK_DIR"
    chmod +x "$INSTALL_DIR/bin/gs.js" 2>/dev/null || true
    ln -sf "$INSTALL_DIR/bin/gs.js" "$LINK_DIR/MultiCodexState"
    ok "linked into $LINK_DIR"
  fi
  rm -f "$_log"
fi

# `npm install` rewrites package-lock.json whenever it drifts from
# package.json, which leaves the checkout dirty - and `MultiCodexState update`
# refuses to run against a dirty tree. The lockfile is generated metadata, so
# put the committed copy back and keep the tree clean.
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" checkout -- package-lock.json 2>/dev/null || true
fi

if [ "$NO_LINK" -eq 1 ]; then
  : # nothing was linked, so there is no PATH entry to check
elif command -v MultiCodexState >/dev/null 2>&1; then
  ok "MultiCodexState -> $(command -v MultiCodexState)"
else
  NEED_PATH=1
  if [ -z "$LINK_DIR" ]; then
    _prefix="$(npm prefix -g 2>/dev/null || true)"
    LINK_DIR="${_prefix:+$_prefix/bin}"
  fi
fi

# --- 7. Verify -------------------------------------------------------------

step "Verifying installation..."
if node "$INSTALL_DIR/bin/gs.js" where >/dev/null 2>&1; then
  ok "smoke test passed"
else
  warn "smoke test returned a non-zero exit code"
  node "$INSTALL_DIR/bin/gs.js" where 2>&1 | sed 's/^/       /' || true
fi

# --- Done ------------------------------------------------------------------

GOT_CODEX=''
for _c in "$CODEX_HOME_DIR/bin/codex" /opt/homebrew/bin/codex /usr/local/bin/codex "$HOME/.local/bin/codex"; do
  if [ -x "$_c" ]; then
    GOT_CODEX="$_c"
    break
  fi
done
if [ -z "$GOT_CODEX" ] && command -v codex >/dev/null 2>&1; then
  GOT_CODEX="$(command -v codex)"
fi

printf '\n'
printf '  %sInstallation complete!%s\n' "$C_GREEN" "$C_OFF"
printf '\n'
printf '  Next steps\n'
dim "    MultiCodexState              # show help"
dim "    MultiCodexState login work   # sign in and archive the account"
dim "    MultiCodexState list --usage # accounts + live quota"
printf '\n'
dim "  Install dir : $INSTALL_DIR"
dim "  Account dir : $CODEX_HOME_DIR/accounts"

if [ "$NEED_PATH" -eq 1 ] && [ -n "$LINK_DIR" ]; then
  printf '\n'
  warn "$LINK_DIR is not on your PATH"
  case "$(basename "${SHELL:-/bin/zsh}")" in
    zsh)  _rc="$HOME/.zshrc" ;;
    bash) if [ -f "$HOME/.bash_profile" ]; then _rc="$HOME/.bash_profile"; else _rc="$HOME/.bashrc"; fi ;;
    fish) _rc="$HOME/.config/fish/config.fish" ;;
    *)    _rc="$HOME/.profile" ;;
  esac
  say "Add it to $_rc:"
  dim "    export PATH=\"$LINK_DIR:\$PATH\""
  say "then open a new terminal (or run: exec \$SHELL -l)."
fi

if [ -z "$GOT_CODEX" ]; then
  printf '\n'
  warn "Codex CLI not found"
  dim "         Install it first: npm install -g @openai/codex"
fi

printf '\n'
