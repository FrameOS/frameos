#!/usr/bin/env bash
# The Nim test shards' warm nimcache on the runner pool's shared /mnt/cache
# (.github/workflows/pull-request-tests.yml), kept as one archive per shard.
# Any other build directory that wants the same treatment names its own
# archive directory and local directory: the renderer snapshots' nimcache and
# the ESP32 legs' ccache do (FRAMEOS_NIMCACHE_ROOT, FRAMEOS_NIMCACHE_DIR).
#
#   ci_nimcache.sh restore <shard>   unpack the shard's archive into frameos/nimcache
#   ci_nimcache.sh save <shard>      replace the archive with frameos/nimcache
#
# Why one file: a shard's cache is about 92,000 small files, and every file
# over the VMs' virtiofs mount costs a couple of milliseconds. As a directory
# of files, the restore and the save took 3 and 4 minutes of a 10-minute job,
# nearly all of it per-file work: a save took as long for 17 MB as for 160 MB.
#
# Why never a directory shared between runs: Nim reuses a module's object file
# when the C it generates equals the .c on disk and the .o is newer than it
# (shouldRecompile in compiler/cgen.nim); nothing ties the .o to that .c.
# Overlapping runs copying into and out of one directory paired one build's .c
# with another build's newer .o, Nim linked the wrong object ("undefined
# reference to eqdup___OOZconfig_u2307", shard 1, three runs in a row on
# 2026-10-18), and every save after that wrote the pair back. An archive is one
# build's files, swapped in by one rename, so overlapping runs replace each
# other whole. The last save wins, which is only a less warm cache.
#
# The timestamps are that same rule: --format=posix keeps their nanoseconds, so
# every .o stays exactly as much newer than its .c as it was.
set -euo pipefail

mode="${1:-}"
shard="${2:-}"
[[ ( "$mode" == restore || "$mode" == save ) && -n "$shard" ]] || {
    echo "usage: $0 restore|save <shard>" >&2
    exit 2
}
root="${FRAMEOS_NIMCACHE_ROOT:-/mnt/cache/nimcache/frameos-tests-archives}"
local_cache="${FRAMEOS_NIMCACHE_DIR:-frameos/nimcache}"
archive="$root/shard-$shard.tar.zst"
# A test's objects are largely the same as the last test's, about one test
# back: a window of 128 MB (2^27, which unpacking must be told too) takes the
# archive from 3.9x to 6.1x smaller, and level 1 is as fast as it gets.
zstd_window=27

if [[ "$mode" == restore ]]; then
    if [[ ! -f "$archive" ]]; then
        echo "no nimcache archive for shard $shard yet"
        exit 0
    fi
    mkdir -p "$local_cache"
    # A file cut short by a failed unpack would be an .o newer than its .c, and
    # Nim would link it. All or nothing: a cold compile is only slower.
    if ! zstd -q -d --long="$zstd_window" -c "$archive" | tar -xf - -C "$local_cache"; then
        echo "::warning::nimcache restore from $archive failed, compiling from cold"
        rm -rf "$local_cache"
        exit 0
    fi
    echo "restored $(du -sh "$local_cache" | cut -f1) from $archive ($(du -sh "$archive" | cut -f1))"
    exit 0
fi

if [[ ! -d "$(dirname "$root")" || ! -d "$local_cache" ]]; then
    echo "no nimcache to save"
    exit 0
fi
mkdir -p "$root"
# Per-test dirs untouched for two weeks belong to renamed or removed tests.
find "$local_cache" -mindepth 1 -maxdepth 1 -type d -name "*.nim_*" -mtime +14 -exec rm -rf {} + 2>/dev/null || true
# What a save killed halfway left behind. A save still writing is minutes old.
find "$root" -mindepth 1 -maxdepth 1 -type f -name "shard-$shard.*.tmp" -mmin +60 -delete 2>/dev/null || true

partial="$archive.${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$.tmp"
if ! tar --format=posix --pax-option=delete=atime,delete=ctime -cf - -C "$local_cache" . \
    | zstd -q -1 -T0 --long="$zstd_window" -o "$partial"; then
    echo "::warning::nimcache save to $archive failed"
    rm -f "$partial"
    exit 0
fi
mv -f "$partial" "$archive"
echo "saved $archive: $(du -sh "$archive" | cut -f1) from $(du -sh "$local_cache" | cut -f1)"
