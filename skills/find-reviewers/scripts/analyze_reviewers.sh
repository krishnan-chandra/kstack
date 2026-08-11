#!/usr/bin/env bash
# analyze_reviewers.sh — gather reviewer-recommendation signals from git history.
#
# Read-only: runs only non-mutating git commands. Works in any repo.
#
# Usage:
#   analyze_reviewers.sh [--repo <dir>] [--range <base>...<head>] \
#                        [--paths p1,p2,...] [--recent-months N] [--top N]
#
#   --repo <dir>         Repository to analyze (default: current directory).
#   --range <range>      Commit range defining the change, e.g. origin/main...HEAD,
#                        origin/main..HEAD, or just a base ref (head defaults to HEAD).
#                        Default: origin/main...HEAD (falls back to main, then HEAD~10).
#   --paths p1,p2,...    Analyze an explicit list of changed paths instead of a range
#                        (the range is still used to identify the change authors).
#   --recent-months N    Window for "recent" authorship counts (default: 12).
#   --top N              How many authors to show per section (default: 6).
#
# Output sections (plain text, for an LLM or human to interpret):
#   1. Changed files
#   2. Change authors (the PR author(s) — exclude them as reviewers)
#   3. Per-file authorship (all-time and recent commit counts)
#   4. CODEOWNERS rules matching the changed paths
#   5. Adjacent-domain authorship (parent directories of changed files)
#   6. Identity variants for every author seen above (same person, several
#      name/email spellings — merge them before ranking)

set -euo pipefail

REPO="."
RANGE=""
PATHS_ARG=""
RECENT_MONTHS=12
TOP=6

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --range) RANGE="$2"; shift 2 ;;
    --paths) PATHS_ARG="$2"; shift 2 ;;
    --recent-months) RECENT_MONTHS="$2"; shift 2 ;;
    --top) TOP="$2"; shift 2 ;;
    -h|--help) grep '^# \{0,1\}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: $REPO is not a git repository" >&2
  exit 2
fi

DEFAULTED_RANGE=""
if [[ -z "$RANGE" ]]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    RANGE="origin/main...HEAD"
  elif git rev-parse --verify --quiet main >/dev/null; then
    RANGE="main...HEAD"
  else
    RANGE="HEAD~10...HEAD"
    DEFAULTED_RANGE="(no main/origin/main found; defaulted to $RANGE)"
  fi
fi

# Split the range into BASE and HEAD refs. Accept "A...B", "A..B", or "A".
BASE="${RANGE%%...*}"; BASE="${BASE%%..*}"
HEADREF="${RANGE#*...}"
[[ "$HEADREF" == "$RANGE" ]] && HEADREF="${RANGE#*..}"
[[ "$HEADREF" == "$BASE" || -z "$HEADREF" ]] && HEADREF="HEAD"

SCRATCH=$(mktemp /tmp/find-reviewers.XXXXXX)
trap 'rm -f "$SCRATCH" "$SCRATCH.names"' EXIT

count_authors() {
  # count_authors [<git-log-extra-args>...] -- <path...>  =>  "count name <email>" lines
  git log --format='%an <%ae>' --no-merges "$@" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -n "$TOP" | sed 's/^ *//' | tee -a "$SCRATCH.names"
}

echo "=================================================================="
echo "REVIEWER SIGNALS for $(git rev-parse --show-toplevel)"
echo "range: $RANGE $DEFAULTED_RANGE"
echo "=================================================================="

# ---------------------------------------------------------------- 1. files
declare -a FILES=()
if [[ -n "$PATHS_ARG" ]]; then
  IFS=',' read -ra FILES <<< "$PATHS_ARG"
  echo; echo "## 1. Changed files (${#FILES[@]}, provided explicitly)"
else
  while IFS= read -r f; do [[ -n "$f" ]] && FILES+=("$f"); \
    done < <(git diff --name-only "$BASE"..."$HEADREF" 2>/dev/null || git diff --name-only "$BASE" "$HEADREF")
  echo; echo "## 1. Changed files (${#FILES[@]} in $BASE...$HEADREF)"
fi
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "(none — is the branch merged, or the range empty?)"
else
  printf '%s\n' "${FILES[@]}"
fi

# ---------------------------------------------------------------- 2. authors
echo; echo "## 2. Change authors (exclude them from reviewers)"
count_authors "$BASE..$HEADREF"

# ---------------------------------------------------------------- 3. per-file
echo; echo "## 3. Per-file authorship (top $TOP; recent = last $RECENT_MONTHS months)"
for f in "${FILES[@]}"; do
  echo; echo "### $f"
  echo "-- all-time:"
  count_authors -- "$f"
  echo "-- recent:"
  count_authors --since="$RECENT_MONTHS months ago" -- "$f"
done

# ---------------------------------------------------------------- 4. CODEOWNERS
echo; echo "## 4. CODEOWNERS rules matching changed paths"
CODEOWNERS=""
for c in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS .gitlab/CODEOWNERS; do
  if [[ -f "$c" ]]; then CODEOWNERS="$c"; break; fi
done
if [[ -z "$CODEOWNERS" ]]; then
  echo "(no CODEOWNERS file found)"
elif [[ ${#FILES[@]} -eq 0 ]]; then
  echo "(no changed paths to match)"
else
  echo "source: $CODEOWNERS (gitignore-style; last matching rule wins)"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CODEOWNERS" "${FILES[@]}" <<'PYEOF'
import sys, re
co, files = sys.argv[1], sys.argv[2:]

def translate_segment(seg):
    """Translate one pattern segment: '*' and '?' never cross '/'."""
    out = []
    i = 0
    while i < len(seg):
        c = seg[i]
        if c == "*":
            if seg.startswith("**", i):
                out.append(".*")  # '**' crosses directory boundaries
                i += 2
            else:
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            j = seg.find("]", i + 2)
            if j == -1:
                out.append(re.escape(c))
                i += 1
            else:
                cls = seg[i : j + 1]
                if cls.startswith("[!"):
                    cls = "[^" + cls[2:]
                out.append(cls)
                i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)

def compile_pattern(pat):
    """Compile a CODEOWNERS/gitignore pattern.

    Returns (regex, anchored, dir_only). '*' and '?' stay within one path
    segment; '**' crosses segments. A leading '/' or any interior '/' anchors
    the pattern to the repo root; otherwise it matches at any depth. A
    trailing '/' restricts the pattern to directories, and a trailing '/**'
    matches everything inside a directory. A matched directory owns its
    contents, so file paths also match through their directory prefixes.
    """
    p = pat
    dir_only = p.endswith("/")
    p = p.rstrip("/")
    anchored = p.startswith("/")
    p = p.lstrip("/")
    if p.startswith("**/"):
        p = p[3:]  # '**/foo' matches foo at any depth
    elif "/" in p:
        anchored = True
    inside_all = p.endswith("/**")
    if inside_all:
        p = p[:-3]
    # 'a/**/b' matches zero or more intermediate directories
    regex = "(?:/|/.+/)".join(translate_segment(part) for part in p.split("/**/"))
    return re.compile(regex), anchored, dir_only or inside_all

def rule_matches(compiled, f):
    regex, anchored, dir_only = compiled
    parts = f.split("/")
    candidates = set()
    starts = [0] if anchored else range(len(parts))
    for s in starts:
        sub = parts[s:]
        for i in range(1, len(sub) + 1):
            candidates.add("/".join(sub[:i]))
    if dir_only:
        candidates.discard(f)  # must match a directory, not the file itself
    return any(regex.fullmatch(c) for c in candidates)

rules = []
for lineno, line in enumerate(open(co), 1):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    parts = line.split()
    if len(parts) < 2:
        continue
    rules.append((lineno, parts[0], " ".join(parts[1:])))

compiled = [(ln, pat, own, compile_pattern(pat)) for ln, pat, own in rules]
hits = [(ln, pat, own, [f for f in files if rule_matches(c, f)]) for ln, pat, own, c in compiled]
hits = [h for h in hits if h[3]]
if not hits:
    print("(no CODEOWNERS rule matches the changed paths)")
else:
    winner = {}
    for ln, pat, own, fs in hits:  # later rule overrides earlier ones per path
        for f in fs:
            winner[f] = (pat, own)
    for ln, pat, own, fs in hits:
        effective = any(winner[f] == (pat, own) for f in fs)
        tag = "" if effective else "  [OVERRIDDEN by a later rule]"
        print(f"L{ln}: {pat} -> {own}  (matches: {', '.join(fs[:8])}){tag}")
PYEOF
  else
    echo "(python3 unavailable — raw file follows; match patterns manually)"
    cat "$CODEOWNERS"
  fi
fi

# ---------------------------------------------------------------- 5. adjacent dirs
echo; echo "## 5. Adjacent-domain authorship (parent dirs of changed files, top $TOP)"
declare -a DIRS=()
for f in "${FILES[@]}"; do
  d=$(dirname "$f")
  for dd in "$d" "$(dirname "$d")"; do
    [[ "$dd" == "." ]] && continue
    case " ${DIRS[*]:-} " in *" $dd "*) ;; *) DIRS+=("$dd") ;; esac
  done
done
if [[ ${#DIRS[@]} -eq 0 ]]; then
  echo "(all changed files are at the repo root)"
else
  for d in "${DIRS[@]:0:10}"; do
    echo; echo "### $d/"
    echo "-- recent:"
    count_authors --since="$RECENT_MONTHS months ago" -- "$d"
    echo "-- all-time:"
    count_authors -- "$d"
  done
fi

# ---------------------------------------------------------------- 6. identity variants
echo; echo "## 6. Identity variants (merge these before ranking)"
FIRST_TOKENS=$(awk -F'<' '{gsub(/^[0-9 ]+/,""); print tolower($1)}' "$SCRATCH.names" 2>/dev/null \
  | awk '{print $1}' | sort -u | grep -v '^$' || true)
if [[ -z "$FIRST_TOKENS" ]]; then
  echo "(no authors found)"
else
  ALL_IDENTITIES=$(git log --format='%an <%ae>' --since='3 years ago' 2>/dev/null | sort -u || true)
  FOUND=0
  while IFS= read -r tok; do
    variants=$(printf '%s\n' "$ALL_IDENTITIES" | awk -v t="$tok" 'tolower($1) == t' || true)
    n=$(printf '%s\n' "$variants" | grep -c . || true)
    if [[ "$n" -gt 1 ]]; then
      FOUND=1
      echo "-- '$tok' appears as $n identities:"
      printf '%s\n' "$variants" | sed 's/^/     /'
    fi
  done <<< "$FIRST_TOKENS"
  [[ "$FOUND" -eq 0 ]] && echo "(no multi-variant identities detected)"
  echo "(also check for the same email under different names, and noreply GitHub"
  echo " addresses like 12345+user@users.noreply.github.com)"
fi

echo; echo "=================================================================="
echo "Next: merge identity variants, exclude change authors, then rank by"
echo "recent > all-time counts, CODEOWNERS policy, and adjacent-domain fit."
echo "=================================================================="
