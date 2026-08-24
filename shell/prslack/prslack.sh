# Source this file from a POSIX-compatible shell to define prslack and prstack.

_prslack_usage() {
	cat <<'EOF'
Usage: prslack [PR] [-R OWNER/REPO]
       prstack [TOP_PR] [-R OWNER/REPO]

PR and TOP_PR can be a pull request number, URL, branch, or jj bookmark.
prstack treats TOP_PR as the top of the stack and prints its open ancestors
from base to top.
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

_prslack_gh_pr_view() {
	_prslack_view_selector=$1
	_prslack_view_repo=$2
	_prslack_view_fields=$3
	_prslack_view_output_flag=$4
	_prslack_view_expression=$5
	set -- pr view
	[ -z "$_prslack_view_selector" ] || set -- "$@" "$_prslack_view_selector"
	[ -z "$_prslack_view_repo" ] || set -- "$@" --repo "$_prslack_view_repo"
	gh "$@" --json "$_prslack_view_fields" "$_prslack_view_output_flag" "$_prslack_view_expression"
}

_prslack_view_record() {
	_prslack_view_template='{{printf "%v\t%s\t%s\t%v\t%v\t%s\n" .number .baseRefName .url .additions .deletions .title}}'
	_prslack_gh_pr_view "$1" "$2" number,baseRefName,url,additions,deletions,title \
		--template "$_prslack_view_template"
}

_prslack_render() {
	_prslack_render_query='(.url | split("/") | .[-3]) as $repo | "[\(.title)](\(.url)) (\($repo) +\(.additions)/-\(.deletions))"'
	_prslack_gh_pr_view "$1" "$2" title,url,additions,deletions --jq "$_prslack_render_query"
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

	if [ -n "$_prslack_resolve_selector" ]; then
		_prslack_view_record "$_prslack_resolve_selector" "$_prslack_resolve_repo"
		return
	fi
	if _prslack_view_record "" "$_prslack_resolve_repo" 2>"$_prslack_resolve_error"; then
		return 0
	fi
	_prslack_resolve_selector=$(_prslack_infer_jj_top) || {
		cat "$_prslack_resolve_error" >&2
		return 1
	}
	_prslack_view_record "$_prslack_resolve_selector" "$_prslack_resolve_repo"
}

prslack() {
	(
		_prslack_require_command gh || exit 1
		_prslack_parse_args "$@" || exit $?
		if [ "$PRSLACK_HELP" = true ]; then
			_prslack_usage
			exit 0
		fi

		if [ -n "$PRSLACK_SELECTOR" ]; then
			_prslack_render "$PRSLACK_SELECTOR" "$PRSLACK_REPO"
			exit $?
		fi

		_prslack_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prslack.XXXXXX") || exit 1
		trap 'rm -rf "$_prslack_tmp_dir"' 0
		trap 'exit 1' HUP INT TERM
		if _prslack_render "" "$PRSLACK_REPO" 2>"$_prslack_tmp_dir/current-error"; then
			exit 0
		fi
		PRSLACK_SELECTOR=$(_prslack_infer_jj_top) || {
			cat "$_prslack_tmp_dir/current-error" >&2
			exit 1
		}
		_prslack_render "$PRSLACK_SELECTOR" "$PRSLACK_REPO"
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

		_prslack_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prstack.XXXXXX") || exit 1
		trap 'rm -rf "$_prslack_tmp_dir"' 0
		trap 'exit 1' HUP INT TERM
		_prslack_rows=$_prslack_tmp_dir/top-to-base.tsv
		_prslack_seen=$_prslack_tmp_dir/seen
		: >"$_prslack_rows"
		: >"$_prslack_seen"

		_prslack_record=$(_prslack_resolve_top "$PRSLACK_SELECTOR" "$PRSLACK_REPO" "$_prslack_tmp_dir/current-error") || exit 1
		_prslack_tab=$(printf '\t')
		IFS="$_prslack_tab" read -r _prslack_number _prslack_base _prslack_url _prslack_additions _prslack_deletions _prslack_title <<EOF
$_prslack_record
EOF
		[ -n "$_prslack_number" ] && [ -n "$_prslack_url" ] && [ -n "$_prslack_additions" ] && [ -n "$_prslack_deletions" ] || {
			_prslack_error "GitHub returned an incomplete PR record"
			exit 1
		}
		_prslack_repo=$(_prslack_repo_from_url "$_prslack_url") || exit 1
		_prslack_repo_name=${_prslack_repo##*/}
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
				"$_prslack_repo_name" "$_prslack_additions" "$_prslack_deletions" >>"$_prslack_rows"
			_prslack_depth=$((_prslack_depth + 1))
			if [ "$_prslack_depth" -gt 50 ]; then
				_prslack_error "stack exceeds the 50-PR limit"
				exit 1
			fi
			[ -n "$_prslack_base" ] || break
			[ "$_prslack_base" != "$_prslack_default_branch" ] || break

			_prslack_candidates=$(gh pr list --repo "$_prslack_repo" --state open --head "$_prslack_base" --limit 100 \
				--json number,baseRefName,url,additions,deletions,title \
				--template '{{range .}}{{printf "%v\t%s\t%s\t%v\t%v\t%s\n" .number .baseRefName .url .additions .deletions .title}}{{end}}') || exit 1
			_prslack_candidate_count=$(printf '%s\n' "$_prslack_candidates" | awk 'NF { count++ } END { print count + 0 }')
			if [ "$_prslack_candidate_count" -eq 0 ]; then
				break
			fi
			if [ "$_prslack_candidate_count" -ne 1 ]; then
				_prslack_error "multiple open PRs use head branch $_prslack_base"
				exit 1
			fi
			IFS="$_prslack_tab" read -r _prslack_number _prslack_base _prslack_url _prslack_additions _prslack_deletions _prslack_title <<EOF
$_prslack_candidates
EOF
		done

		awk '{ rows[NR] = $0 } END { for (i = NR; i >= 1; i--) { sub(/^[^\t]*\t/, "", rows[i]); print rows[i] } }' \
			"$_prslack_rows"
	)
}
