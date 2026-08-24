#!/bin/sh

set -eu

usage() {
	cat <<'EOF'
Usage: install.sh [--prefix DIR]

Install prslack and prstack under DIR. DIR defaults to $HOME/.local.
The installer does not install Kstack or modify shell startup files.
EOF
}

prefix=${PREFIX:-"$HOME/.local"}
while [ "$#" -gt 0 ]; do
	case "$1" in
		--prefix)
			[ "$#" -ge 2 ] || {
				printf 'install.sh: --prefix requires a directory\n' >&2
				exit 2
			}
			prefix=$2
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			printf 'install.sh: unknown option: %s\n' "$1" >&2
			exit 2
			;;
	esac
done

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
mkdir -p "$prefix/bin" "$prefix/lib/prslack"
cp "$script_dir/prslack.sh" "$prefix/lib/prslack/prslack.sh"
cp "$script_dir/bin/prslack" "$prefix/bin/prslack"
chmod 755 "$prefix/bin/prslack"
ln -sf prslack "$prefix/bin/prstack"

printf 'Installed prslack and prstack under %s.\n' "$prefix"
printf 'Add %s/bin to PATH if it is not already present.\n' "$prefix"
printf 'To load the functions directly, source %s/lib/prslack/prslack.sh.\n' "$prefix"
