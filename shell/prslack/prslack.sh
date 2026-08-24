# Source this file from a POSIX-compatible shell to define prslack and prstack.

_prslack_usage() {
	cat <<'EOF'
Usage: prslack [PR] [-R OWNER/REPO] [--label repo|dirs]
       prstack [TOP_PR] [-R OWNER/REPO] [--label repo|dirs]

PR can be a pull request number, URL, branch, or jj bookmark. With no PR,
prslack resolves the current branch's pull request. GitHub CLI output is
captured before prslack writes the completed Markdown line to stdout.

TOP_PR can be a pull request number or branch for any selected stack layer.
prstack prints the prefix from the base pull request through that layer. It
fails without output if the open stack cannot reach the default branch.

The parenthesized label defaults to the repository name. In dirs mode the
label lists up to three top-level directories touched by the PR's diff,
ranked by touched file count (alphabetical tie-break); extra directories
collapse into +N others and root-level files count as the directory "root".
Select the mode with --label, the PRSLACK_LABEL environment variable, or a
label=repo|dirs line in a .prslack file found by walking up from the current
directory, in that order of precedence.
EOF
}

_prslack_error() {
	printf 'prslack: %s\n' "$*" >&2
}

_prslack_require_command() {
	command -v "$1" >/dev/null 2>&1 || {
		_prslack_error "required command not found: $1"
		return 1
	}
}

_prslack_parse_args() {
	PRSLACK_SELECTOR=
	PRSLACK_REPO=
	PRSLACK_LABEL_OPT=
	PRSLACK_HELP=false

	while [ "$#" -gt 0 ]; do
		case "$1" in
			-R | --repo)
				[ "$#" -ge 2 ] || {
					_prslack_error "$1 requires OWNER/REPO"
					return 2
				}
				PRSLACK_REPO=$2
				shift 2
				;;
			--repo=*)
				PRSLACK_REPO=${1#*=}
				shift
				;;
			--label)
				[ "$#" -ge 2 ] || {
					_prslack_error "$1 requires repo or dirs"
					return 2
				}
				PRSLACK_LABEL_OPT=$2
				shift 2
				;;
			--label=*)
				PRSLACK_LABEL_OPT=${1#*=}
				shift
				;;
			-h | --help)
				PRSLACK_HELP=true
				shift
				;;
			--)
				shift
				while [ "$#" -gt 0 ]; do
					[ -z "$PRSLACK_SELECTOR" ] || {
						_prslack_error "expected one PR selector"
						return 2
					}
					PRSLACK_SELECTOR=$1
					shift
				done
				;;
			-*)
				_prslack_error "unknown option: $1"
				return 2
				;;
			*)
				[ -z "$PRSLACK_SELECTOR" ] || {
					_prslack_error "expected one PR selector"
					return 2
				}
				PRSLACK_SELECTOR=$1
				shift
				;;
		esac
	done
}

_prslack_config_label() {
	_prslack_config_dir=$PWD
	while :; do
		if [ -f "$_prslack_config_dir/.prslack" ]; then
			awk -F= '$1 == "label" { value = $2 } END { if (value != "") print value }' \
				"$_prslack_config_dir/.prslack"
			return 0
		fi
		if [ "$_prslack_config_dir" = / ] || [ -z "$_prslack_config_dir" ]; then
			return 0
		fi
		_prslack_config_dir=$(dirname "$_prslack_config_dir") || return 1
	done
}

_prslack_label_mode() {
	if [ -n "$PRSLACK_LABEL_OPT" ]; then
		_prslack_mode_value=$PRSLACK_LABEL_OPT
		_prslack_mode_source='--label'
	elif [ -n "${PRSLACK_LABEL-}" ]; then
		_prslack_mode_value=$PRSLACK_LABEL
		_prslack_mode_source='PRSLACK_LABEL'
	else
		_prslack_mode_value=$(_prslack_config_label) || return 1
		_prslack_mode_source='.prslack'
		[ -n "$_prslack_mode_value" ] || _prslack_mode_value=repo
	fi
	case "$_prslack_mode_value" in
		repo | dirs)
			printf '%s\n' "$_prslack_mode_value"
			;;
		*)
			_prslack_error "invalid label mode from $_prslack_mode_source: $_prslack_mode_value (expected repo or dirs)"
			return 1
			;;
	esac
}

_prslack_record_fields() {
	if [ "$1" = dirs ]; then
		printf '%s' number,baseRefName,url,additions,deletions,title,files
	else
		printf '%s' number,baseRefName,url,additions,deletions,title
	fi
}

# Build the record while changed paths are still structured JSON. GitHub caps
# the files connection at 100 entries per PR, so directory labels for larger
# PRs are an approximation.
_prslack_record_query() {
	if [ "$1" = dirs ]; then
		cat <<'EOF'
(.url | split("/") | .[-3]) as $repo
| ([.files[].path
	| if contains("/") then (split("/")[0] | tojson | .[1:-1]) else "root" end]
	| group_by(.)
	| map({name: .[0], count: length})
	| sort_by(-.count, .name)) as $dirs
| ($dirs | length) as $count
| (if $count == 0 then $repo
	else (([$dirs[0:3][].name]
		+ (if $count > 3
			then ["+\($count - 3) \(if $count == 4 then "other" else "others" end)"]
			else []
			end))
		| join(","))
	end) as $label
| [(.number | tostring), .baseRefName, .url, (.additions | tostring),
	(.deletions | tostring), .title, $label]
| join("\u001f")
EOF
	else
		cat <<'EOF'
(.url | split("/") | .[-3]) as $label
| [(.number | tostring), .baseRefName, .url, (.additions | tostring),
	(.deletions | tostring), .title, $label]
| join("\u001f")
EOF
	fi
}

_prslack_gh_pr_view() {
	_prslack_view_selector=$1
	_prslack_view_repo=$2
	_prslack_view_fields=$3
	_prslack_view_query=$4
	set -- pr view
	[ -z "$_prslack_view_selector" ] || set -- "$@" "$_prslack_view_selector"
	[ -z "$_prslack_view_repo" ] || set -- "$@" --repo "$_prslack_view_repo"
	gh "$@" --json "$_prslack_view_fields" --jq "$_prslack_view_query"
}

_prslack_view_record() {
	_prslack_gh_pr_view "$1" "$2" "$(_prslack_record_fields "$3")" "$(_prslack_record_query "$3")"
}

_prslack_record_complete() {
	[ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] && [ -n "$4" ] && [ -n "$5" ] && [ -n "$6" ]
}

_prslack_infer_jj_top() {
	_prslack_require_command jj || return 1
	_prslack_tops=$(jj log -r 'heads(((trunk())..@) & bookmarks())' --no-graph --no-pager \
		-T 'local_bookmarks.map(|b| b.name() ++ "\n")' 2>/dev/null) || {
		_prslack_error "could not inspect bookmarks between trunk() and @"
		return 1
	}
	_prslack_top_count=$(printf '%s\n' "$_prslack_tops" | awk 'NF { count++ } END { print count + 0 }')
	if [ "$_prslack_top_count" -ne 1 ]; then
		_prslack_error "could not infer one jj top bookmark; pass a PR, branch, or bookmark"
		return 1
	fi
	printf '%s\n' "$_prslack_tops" | awk 'NF { print; exit }'
}

_prslack_repo_from_url() {
	_prslack_repo_url=$1
	_prslack_repo_path=${_prslack_repo_url%/pull/*}
	_prslack_repo_name=${_prslack_repo_path##*/}
	_prslack_owner_path=${_prslack_repo_path%/*}
	_prslack_owner=${_prslack_owner_path##*/}
	_prslack_host_path=${_prslack_owner_path%/*}
	_prslack_host=${_prslack_host_path##*/}

	if [ -z "$_prslack_repo_name" ] || [ -z "$_prslack_owner" ] || [ -z "$_prslack_host" ]; then
		_prslack_error "could not derive a GitHub repository from $_prslack_repo_url"
		return 1
	fi
	if [ "$_prslack_host" = github.com ]; then
		printf '%s/%s\n' "$_prslack_owner" "$_prslack_repo_name"
	else
		printf '%s/%s/%s\n' "$_prslack_host" "$_prslack_owner" "$_prslack_repo_name"
	fi
}

_prslack_resolve_top() {
	_prslack_resolve_selector=$1
	_prslack_resolve_repo=$2
	_prslack_resolve_error=$3
	_prslack_resolve_mode=$4

	if [ -n "$_prslack_resolve_selector" ]; then
		_prslack_view_record "$_prslack_resolve_selector" "$_prslack_resolve_repo" "$_prslack_resolve_mode"
		return
	fi
	if _prslack_view_record "" "$_prslack_resolve_repo" "$_prslack_resolve_mode" 2>"$_prslack_resolve_error"; then
		return 0
	fi
	_prslack_resolve_selector=$(_prslack_infer_jj_top) || {
		cat "$_prslack_resolve_error" >&2
		return 1
	}
	_prslack_view_record "$_prslack_resolve_selector" "$_prslack_resolve_repo" "$_prslack_resolve_mode"
}

prslack() {
	(
		_prslack_require_command gh || exit 1
		_prslack_parse_args "$@" || exit $?
		if [ "$PRSLACK_HELP" = true ]; then
			_prslack_usage
			exit 0
		fi
		_prslack_mode=$(_prslack_label_mode) || exit 1

		_prslack_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prslack.XXXXXX") || exit 1
		trap 'rm -rf "$_prslack_tmp_dir"' 0
		trap 'exit 1' HUP INT TERM
		_prslack_record=$(_prslack_resolve_top "$PRSLACK_SELECTOR" "$PRSLACK_REPO" \
			"$_prslack_tmp_dir/current-error" "$_prslack_mode") || exit 1
		_prslack_record_separator=$(printf '\037')
		IFS="$_prslack_record_separator" read -r _prslack_number _prslack_base _prslack_url _prslack_additions _prslack_deletions _prslack_title _prslack_label <<EOF
$_prslack_record
EOF
		_prslack_record_complete "$_prslack_number" "$_prslack_base" "$_prslack_url" \
			"$_prslack_additions" "$_prslack_deletions" "$_prslack_label" || {
			_prslack_error "GitHub returned an incomplete PR record"
			exit 1
		}
		printf '[%s](%s) (%s +%s/-%s)\n' "$_prslack_title" "$_prslack_url" \
			"$_prslack_label" "$_prslack_additions" "$_prslack_deletions"
	)
}

prstack() {
	(
		_prslack_require_command gh || exit 1
		_prslack_parse_args "$@" || exit $?
		if [ "$PRSLACK_HELP" = true ]; then
			_prslack_usage
			exit 0
		fi
		_prslack_mode=$(_prslack_label_mode) || exit 1

		_prslack_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prstack.XXXXXX") || exit 1
		trap 'rm -rf "$_prslack_tmp_dir"' 0
		trap 'exit 1' HUP INT TERM
		_prslack_rows=$_prslack_tmp_dir/top-to-base.tsv
		_prslack_seen=$_prslack_tmp_dir/seen
		: >"$_prslack_rows"
		: >"$_prslack_seen"

		_prslack_record=$(_prslack_resolve_top "$PRSLACK_SELECTOR" "$PRSLACK_REPO" \
			"$_prslack_tmp_dir/current-error" "$_prslack_mode") || exit 1
		_prslack_record_separator=$(printf '\037')
		IFS="$_prslack_record_separator" read -r _prslack_number _prslack_base _prslack_url _prslack_additions _prslack_deletions _prslack_title _prslack_label <<EOF
$_prslack_record
EOF
		_prslack_record_complete "$_prslack_number" "$_prslack_base" "$_prslack_url" \
			"$_prslack_additions" "$_prslack_deletions" "$_prslack_label" || {
			_prslack_error "GitHub returned an incomplete PR record"
			exit 1
		}
		_prslack_repo=$(_prslack_repo_from_url "$_prslack_url") || exit 1
		_prslack_default_branch=$(gh repo view "$_prslack_repo" --json defaultBranchRef --jq '.defaultBranchRef.name') || exit 1
		[ -n "$_prslack_default_branch" ] || {
			_prslack_error "GitHub returned an empty default branch for $_prslack_repo"
			exit 1
		}
		_prslack_depth=0

		while :; do
			if grep -F -x "$_prslack_number" "$_prslack_seen" >/dev/null 2>&1; then
				_prslack_error "detected a cycle at PR #$_prslack_number"
				exit 1
			fi
			printf '%s\n' "$_prslack_number" >>"$_prslack_seen"
			printf '%s\t[%s](%s) (%s +%s/-%s)\n' "$_prslack_number" "$_prslack_title" "$_prslack_url" \
				"$_prslack_label" "$_prslack_additions" "$_prslack_deletions" >>"$_prslack_rows"
			_prslack_depth=$((_prslack_depth + 1))
			if [ "$_prslack_depth" -gt 50 ]; then
				_prslack_error "stack exceeds the 50-PR limit"
				exit 1
			fi
			[ "$_prslack_base" != "$_prslack_default_branch" ] || break

			_prslack_candidates=$(gh pr list --repo "$_prslack_repo" --state open --head "$_prslack_base" --limit 2 \
				--json "$(_prslack_record_fields "$_prslack_mode")" \
				--jq ".[] | $(_prslack_record_query "$_prslack_mode")") || exit 1
			_prslack_candidate_count=$(printf '%s\n' "$_prslack_candidates" | awk 'NF { count++ } END { print count + 0 }')
			if [ "$_prslack_candidate_count" -eq 0 ]; then
				_prslack_error "no open PR has head branch $_prslack_base; could not reach default branch $_prslack_default_branch"
				exit 1
			fi
			if [ "$_prslack_candidate_count" -ne 1 ]; then
				_prslack_error "multiple open PRs use head branch $_prslack_base"
				exit 1
			fi
			IFS="$_prslack_record_separator" read -r _prslack_number _prslack_base _prslack_url _prslack_additions _prslack_deletions _prslack_title _prslack_label <<EOF
$_prslack_candidates
EOF
			_prslack_record_complete "$_prslack_number" "$_prslack_base" "$_prslack_url" \
				"$_prslack_additions" "$_prslack_deletions" "$_prslack_label" || {
				_prslack_error "GitHub returned an incomplete PR record"
				exit 1
			}
		done

		awk '{ rows[NR] = $0 } END { for (i = NR; i >= 1; i--) { sub(/^[^\t]*\t/, "", rows[i]); print rows[i] } }' \
			"$_prslack_rows"
	)
}
