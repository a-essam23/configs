#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Modular dotfiles initializer
# Cross-platform (Linux + macOS), Bash 3.2-safe
# ─────────────────────────────────────────────────────────────

# Resolve script location, even if symlinked
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
if [[ -L "$SCRIPT_SOURCE" ]]; then
	SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
	if [[ "$SCRIPT_SOURCE" != /* ]]; then
		SCRIPT_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$SCRIPT_SOURCE"
	fi
fi
REPO_ROOT="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
BACKUP_BASE="${HOME}/.dotfiles-backup"

# Globals mutated during run
DRY_RUN=false
BACKUP=false
FORCE=false
BACKUP_DIR=""
MANIFEST=""
SELECTED=()

# ─── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# ─── Logging ────────────────────────────────────────────────
info() { printf "${BLUE}→${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
err()  { printf "${RED}✗${NC} %s\n" "$1" >&2; }
dry()  { printf "${CYAN}∅${NC} %s\n" "$1"; }

# ─── Cross-platform readlink -f replacement ──────────────────
resolve_link() {
	local path="$1"
	while [[ -L "$path" ]]; do
		local target dir
		target="$(readlink "$path")"
		dir="$(cd "$(dirname "$path")" && pwd)"
		if [[ "$target" == /* ]]; then
			path="$target"
		else
			path="$dir/$target"
		fi
	done
	if [[ -d "$path" ]]; then
		(cd "$path" && pwd)
	else
		local dir
		dir="$(cd "$(dirname "$path")" && pwd)"
		echo "$dir/$(basename "$path")"
	fi
}

# ─── Section metadata ───────────────────────────────────────
section_info() {
	case "$1" in
		nvim)     echo "nvim|${HOME}/.config/nvim" ;;
		opencode) echo "opencode|${HOME}/.config/opencode" ;;
		pi-ext)   echo "pi/extensions|${HOME}/.pi/extensions" ;;
		*)        echo "" ;;
	esac
}

check_state() {
	local src="$1" dst="$2"
	if [[ ! -e "$dst" ]] && [[ ! -L "$dst" ]]; then
		echo "missing"
	elif [[ -L "$dst" ]]; then
		local resolved
		resolved="$(resolve_link "$dst")"
		if [[ "$resolved" == "$src" ]]; then
			echo "linked"
		else
			echo "wrong-link"
		fi
	else
		echo "real"
	fi
}

# ─── Backup helpers ─────────────────────────────────────────
ensure_backup_dir() {
	if [[ -z "$BACKUP_DIR" ]]; then
		BACKUP_DIR="${BACKUP_BASE}/$(date +%Y%m%d-%H%M%S)"
		MANIFEST="${BACKUP_DIR}/manifest"
		if "$DRY_RUN"; then
			dry "would mkdir -p $BACKUP_DIR"
		else
			mkdir -p "$BACKUP_DIR"
			touch "$MANIFEST"
		fi
	fi
}

find_latest_backup_manifest() {
	local section="$1"
	local latest=""
	local latest_ts=""
	if [[ ! -d "$BACKUP_BASE" ]]; then
		return 0
	fi
	for dir in "$BACKUP_BASE"/*; do
		[[ -d "$dir" ]] || continue
		local m="${dir}/manifest"
		[[ -f "$m" ]] || continue
		if grep -q "^${section}|" "$m" 2>/dev/null; then
			local ts
			ts="$(basename "$dir")"
			if [[ -z "$latest_ts" ]] || [[ "$ts" > "$latest_ts" ]]; then
				latest_ts="$ts"
				latest="$m"
			fi
		fi
	done
	echo "$latest"
}

# ─── Core linking logic ─────────────────────────────────────
link_dir() {
	local section="$1"
	local info src dst
	info="$(section_info "$section")"
	if [[ -z "$info" ]]; then
		err "[$section] unknown section"
		return 1
	fi
	src="${info%%|*}"
	dst="${info#*|}"
	src="$REPO_ROOT/$src"

	info "[$section] $src → $dst"

	local state
	state="$(check_state "$src" "$dst")"

	if [[ "$state" == "linked" ]]; then
		ok "[$section] already linked, skipping"
		return 0
	fi

	if [[ "$state" == "wrong-link" ]]; then
		warn "[$section] existing symlink points elsewhere, replacing"
	fi

	# Backup or remove existing target
	if [[ "$state" == "real" ]] || [[ "$state" == "wrong-link" ]]; then
		if "$BACKUP"; then
			ensure_backup_dir
			local bp="${BACKUP_DIR}/${section}"
			info "[$section] backing up → $bp"
			if "$DRY_RUN"; then
				dry "would mv $dst $bp"
				dry "would record: ${section}|${dst}|dir"
			else
				mv "$dst" "$bp"
				echo "${section}|${dst}|dir" >> "$MANIFEST"
			fi
		else
			warn "[$section] overwriting $dst"
			if "$DRY_RUN"; then
				dry "would rm -rf $dst"
			else
				rm -rf "$dst"
			fi
		fi
	fi

	# Ensure parent directory exists
	local parent
	parent="$(dirname "$dst")"
	if [[ ! -d "$parent" ]]; then
		if "$DRY_RUN"; then
			dry "would mkdir -p $parent"
		else
			mkdir -p "$parent"
		fi
	fi

	# Create symlink
	if "$DRY_RUN"; then
		dry "would ln -sfn $src $dst"
	else
		ln -sfn "$src" "$dst"
	fi

	ok "[$section] linked"
}

# ─── Risk scanning ──────────────────────────────────────────
collect_risks() {
	local found=false
	for section in "$@"; do
		local info src dst state
		info="$(section_info "$section")"
		[[ -n "$info" ]] || continue
		src="${info%%|*}"
		dst="${info#*|}"
		src="$REPO_ROOT/$src"
		state="$(check_state "$src" "$dst")"
		if [[ "$state" == "real" ]] || [[ "$state" == "wrong-link" ]]; then
			found=true
			echo "  - [$section] $dst (${state})"
		fi
	done
	if "$found"; then
		return 1
	fi
	return 0
}

# ─── Status display ─────────────────────────────────────────
show_status() {
	printf "\n%-10s %-12s %s\n" "SECTION" "STATE" "DETAILS"
	printf "%s\n" "────────────────────────────────────────────────"
	for section in nvim opencode pi-ext; do
		local info src dst state
		info="$(section_info "$section")"
		src="${info%%|*}"
		dst="${info#*|}"
		src="$REPO_ROOT/$src"
		state="$(check_state "$src" "$dst")"
		case "$state" in
			linked)
				printf "%-10s ${GREEN}%-12s${NC} → %s\n" "$section" "linked" "$src"
				;;
			real)
				printf "%-10s ${YELLOW}%-12s${NC} %s\n" "$section" "real" "$dst"
				;;
			missing)
				printf "%-10s ${RED}%-12s${NC}\n" "$section" "missing"
				;;
			wrong-link)
				printf "%-10s ${RED}%-12s${NC} → %s\n" "$section" "wrong-link" "$(resolve_link "$dst")"
				;;
		esac
	done
	echo
}

# ─── Backup management ──────────────────────────────────────
list_backups() {
	if [[ ! -d "$BACKUP_BASE" ]]; then
		info "No backups found."
		return 0
	fi
	local found=false
	for dir in "$BACKUP_BASE"/*; do
		[[ -d "$dir" ]] || continue
		local m="${dir}/manifest"
		[[ -f "$m" ]] || continue
		found=true
		local ts
		ts="$(basename "$dir")"
		echo
		echo "Backup: $ts"
		echo "  Location: $dir"
		while IFS='|' read -r name dst _type; do
			echo "  - $name → $dst"
		done < "$m"
	done
	if ! "$found"; then
		info "No backups found."
	fi
	echo
}

do_restore() {
	local timestamp="$1"
	shift
	local sections=("$@")
	local backup_dir="${BACKUP_BASE}/${timestamp}"
	local manifest="${backup_dir}/manifest"

	if [[ ! -d "$backup_dir" ]]; then
		err "Backup not found: $backup_dir"
		exit 1
	fi
	if [[ ! -f "$manifest" ]]; then
		err "No manifest found in backup $timestamp"
		exit 1
	fi
	if [[ ${#sections[@]} -eq 0 ]]; then
		sections=(nvim opencode pi-ext)
	fi

	for section in "${sections[@]}"; do
		local line
		line="$(grep "^${section}|" "$manifest" 2>/dev/null || true)"
		if [[ -z "$line" ]]; then
			warn "[$section] not found in backup $timestamp"
			continue
		fi
		local dst
		dst="${line#*|}"
		dst="${dst%%|*}"
		local src="${backup_dir}/${section}"

		if [[ ! -e "$src" ]] && [[ ! -L "$src" ]]; then
			warn "[$section] backup item missing: $src"
			continue
		fi

		info "[$section] restoring from backup → $dst"
		if [[ -e "$dst" ]] || [[ -L "$dst" ]]; then
			rm -rf "$dst"
		fi
		mv "$src" "$dst"
		ok "[$section] restored"
	done
}

# ─── Unlink ─────────────────────────────────────────────────
do_unlink() {
	local section="$1"
	local info src dst
	info="$(section_info "$section")"
	if [[ -z "$info" ]]; then
		err "[$section] unknown section"
		return 1
	fi
	src="${info%%|*}"
	dst="${info#*|}"
	src="$REPO_ROOT/$src"

	local state
	state="$(check_state "$src" "$dst")"

	case "$state" in
		linked)
			info "[$section] removing symlink $dst"
			rm -f "$dst"
			local latest_manifest
			latest_manifest="$(find_latest_backup_manifest "$section")"
			if [[ -n "$latest_manifest" ]]; then
				local backup_dir
				backup_dir="$(dirname "$latest_manifest")"
				local backup_src="${backup_dir}/${section}"
				if [[ -e "$backup_src" ]] || [[ -L "$backup_src" ]]; then
					info "[$section] auto-restoring from latest backup"
					mv "$backup_src" "$dst"
					ok "[$section] restored from backup"
				else
					ok "[$section] symlink removed (backup item already restored elsewhere)"
				fi
			else
				ok "[$section] symlink removed (no backup found)"
			fi
			;;
		missing)
			info "[$section] already missing"
			;;
		real)
			warn "[$section] $dst is a real directory, not a symlink — leaving alone"
			;;
		wrong-link)
			warn "[$section] $dst is a symlink to somewhere else — leaving alone"
			;;
	esac
}

# ─── CLI ────────────────────────────────────────────────────
usage() {
	cat <<EOF
Usage: $(basename "$0") [OPTIONS] [SECTION...]

Sections:
  nvim        ~/.config/nvim
  opencode    ~/.config/opencode
  pi-ext      ~/.pi/extensions
  all         All of the above

Options:
  -n, --dry-run        Show what would be done without making changes
  -b, --backup         Backup existing files/directories before replacing
  -f, --force          Skip data-loss warnings
  --status             Show current link state of all sections
  --list-backups       List available backup timestamps
  --restore <ts>       Restore from backup (optionally: section names)
  --unlink [sect...]   Remove symlinks; auto-restores from latest backup if found
  -h, --help           Show this help

Examples:
  $(basename "$0") --dry-run --backup all
  $(basename "$0") --backup nvim
  $(basename "$0") --status
  $(basename "$0") --restore 20260430-195355
  $(basename "$0") --unlink opencode
EOF
}

parse_args() {
	DRY_RUN=false
	BACKUP=false
	FORCE=false
	ACTION="init"
	RESTORE_TS=""
	SELECTED=()

	while [[ $# -gt 0 ]]; do
		case "$1" in
			-n|--dry-run)
				DRY_RUN=true
				shift
				;;
			-b|--backup)
				BACKUP=true
				shift
				;;
			-f|--force)
				FORCE=true
				shift
				;;
			--status)
				ACTION="status"
				shift
				;;
			--list-backups)
				ACTION="list-backups"
				shift
				;;
			--restore)
				ACTION="restore"
				if [[ $# -lt 2 ]] || [[ "$2" == -* ]]; then
					err "--restore requires a timestamp argument"
					exit 1
				fi
				RESTORE_TS="$2"
				shift 2
				;;
			--unlink)
				ACTION="unlink"
				shift
				;;
			-h|--help)
				ACTION="help"
				shift
				;;
				nvim|opencode|pi-ext)
				SELECTED+=("$1")
				shift
				;;
			all)
				SELECTED=(nvim opencode pi-ext)
				shift
				;;
			*)
				err "Unknown argument: $1"
				usage
				exit 1
				;;
		esac
	done
}

# ─── Main ───────────────────────────────────────────────────
main() {
	parse_args "$@"

	case "$ACTION" in
		help)
			usage
			exit 0
			;;
		status)
			show_status
			exit 0
			;;
		list-backups)
			list_backups
			exit 0
			;;
		restore)
			if [[ ${#SELECTED[@]} -eq 0 ]]; then
				SELECTED=(nvim opencode pi-ext)
			fi
			do_restore "$RESTORE_TS" "${SELECTED[@]}"
			exit 0
			;;
		unlink)
			if [[ ${#SELECTED[@]} -eq 0 ]]; then
				SELECTED=(nvim opencode pi-ext)
			fi
			for section in "${SELECTED[@]}"; do
				do_unlink "$section"
			done
			exit 0
			;;
		init)
			if [[ ${#SELECTED[@]} -eq 0 ]]; then
				err "No sections selected."
				usage
				exit 1
			fi

			# Data-loss guardrails
			if ! "$FORCE" && ! "$BACKUP"; then
				local risks
				if ! risks="$(collect_risks "${SELECTED[@]}")"; then
					echo
					err "Existing data detected that would be overwritten:"
					printf "%s\n" "$risks" >&2
					echo
					err "Use --backup to preserve existing files, or --force to overwrite."
					exit 1
				fi
			fi

			if "$BACKUP" && ! "$DRY_RUN"; then
				ensure_backup_dir
			fi

			for section in "${SELECTED[@]}"; do
				link_dir "$section"
			done

			echo
			if "$DRY_RUN"; then
				info "Dry-run complete. No changes made."
			else
				ok "Done."
				if "$BACKUP" && [[ -n "${BACKUP_DIR:-}" ]]; then
					info "Backups saved to: $BACKUP_DIR"
				fi
			fi
			;;
	esac
}

main "$@"
