#!/usr/bin/env bash
# The Nim test shards' warm nimcache on the runner pool's shared /mnt/cache
# (.github/workflows/pull-request-tests.yml), kept as snapshots that are
# written once and never changed.
#
#   ci_nimcache.sh restore <shard>   copy the shard's current snapshot into frameos/nimcache
#   ci_nimcache.sh save <shard>      publish frameos/nimcache as the shard's new snapshot
#
# Why snapshots: Nim reuses a module's object file when the C it generates
# equals the .c on disk and the .o is newer than it (shouldRecompile in
# compiler/cgen.nim); nothing ties the .o to that .c. Overlapping runs
# copying into and out of one shared directory paired one build's .c with
# another build's newer .o, Nim linked the wrong object ("undefined
# reference to eqdup___OOZconfig_u2307", shard 1, three runs in a row on
# 2026-10-18), and every save after that wrote the pair back.
#
# A restore resolves the `current` symlink once and copies that snapshot.
# A save writes a new snapshot, hardlinking every file unchanged since that
# restore (so it costs only what the run changed), then swaps `current` in
# one rename. A snapshot a save replaces lives on for half an hour, for a
# restore that had just resolved it.
#
# Hardlinks are rsync's size + mtime check, so they are taken only from the
# snapshot this job restored (cp -a kept its mtimes): every file the job
# wrote is newer than anything in it. Against a snapshot some other run
# published meanwhile, a same-size object compiled in the same second would
# pass for unchanged.
set -euo pipefail

mode="${1:-}"
shard="${2:-}"
[[ ( "$mode" == restore || "$mode" == save ) && -n "$shard" ]] || {
    echo "usage: $0 restore|save <shard>" >&2
    exit 2
}
root="${FRAMEOS_NIMCACHE_ROOT:-/mnt/cache/nimcache/frameos-tests-snapshots}"
local_cache="${FRAMEOS_NIMCACHE_DIR:-frameos/nimcache}"
current="$root/shard-$shard.current"
restored_from="${RUNNER_TEMP:-/tmp}/frameos-nimcache-shard-$shard"

resolve() {
    local target
    target="$(readlink -f "$current" 2>/dev/null || true)"
    if [[ -n "$target" && -d "$target" ]]; then echo "$target"; fi
}

if [[ "$mode" == restore ]]; then
    snapshot="$(resolve)"
    if [[ -z "$snapshot" ]]; then
        echo "no nimcache snapshot for shard $shard yet"
        exit 0
    fi
    mkdir -p "$local_cache"
    # Whatever is copied is whole files of one build: a file pruned away
    # mid-copy is missing, and a missing .c or .o is only a recompile.
    cp -a "$snapshot/." "$local_cache/" || echo "::warning::partial nimcache restore from $snapshot"
    echo "$snapshot" > "$restored_from"
    echo "restored $(du -sh "$local_cache" | cut -f1) from $snapshot"
    exit 0
fi

if [[ ! -d "$(dirname "$root")" || ! -d "$local_cache" ]]; then
    echo "no nimcache to save"
    exit 0
fi
mkdir -p "$root"
# Per-test dirs untouched for two weeks belong to renamed or removed tests.
find "$local_cache" -mindepth 1 -maxdepth 1 -type d -name "*.nim_*" -mtime +14 -exec rm -rf {} + 2>/dev/null || true

previous="$(resolve)"
snapshot="$root/shard-$shard.${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
base="$(cat "$restored_from" 2>/dev/null || true)"
link_dest=()
if [[ -n "$base" && -d "$base" ]]; then link_dest=(--link-dest="$base"); else base=""; fi
if ! rsync -a ${link_dest[@]+"${link_dest[@]}"} "$local_cache/" "$snapshot/"; then
    echo "::warning::nimcache save to $snapshot failed"
    rm -rf "$snapshot"
    exit 0
fi
ln -sfn "$(basename "$snapshot")" "$snapshot.link"
mv -T "$snapshot.link" "$current"
# Retire the replaced snapshot from now (touch sets its ctime), then drop
# every snapshot of this shard retired or written more than 30 minutes ago.
# A save still writing has a ctime minutes old, so it is never one of them.
if [[ -n "$previous" ]]; then touch "$previous"; fi
live="$(resolve)"
find "$root" -mindepth 1 -maxdepth 1 -type d -name "shard-$shard.*" -cmin +30 ! -path "$live" \
    -exec rm -rf {} + 2>/dev/null || true
# du counts a hardlinked file once, under the first path given: the second
# line is what this save added.
if [[ -n "$base" && -d "$base" ]]; then
    added="$(du -sh "$base" "$snapshot" | tail -1 | cut -f1)"
    echo "saved $snapshot: $added new, the rest linked to $base"
else
    echo "saved $snapshot: $(du -sh "$snapshot" | cut -f1)"
fi
