# shellcheck shell=bash
# Turns DATABASE_URL into libpq's PG* environment so psql / pg_dump run with
# NO connection string on their command line. A process's argv is readable
# by every local account in `ps` and /proc/*/cmdline for as long as it runs;
# its environment is not. The deploy script goes to the trouble of handing
# the migration runner its URL through a 0600 file for exactly this reason,
# and `psql "$DATABASE_URL"` then put the password straight back on a
# command line. Source this file and call `pg_env_from_url "$DATABASE_URL"`,
# then invoke psql / pg_dump with no dbname argument at all.
#
# Understood: postgres://[user[:password]@]host[:port][/dbname][?sslmode=…]
# (an IPv6 host in brackets, percent-encoded user/password). Other query
# parameters are ignored — add them to the PG* environment yourself.
#
# ops/backup/pg-backup.sh runs standalone under /usr/local/bin and carries
# its own copy of this function; keep the two in step.

pg_url_decode() {
  local s="$1"
  # %XX → the byte. `+` is NOT a space outside a query string, so it stays.
  printf '%b' "${s//%/\\x}"
}

pg_env_from_url() {
  local url="$1"
  case "$url" in
    postgres://* | postgresql://*) ;;
    *)
      echo "pg_env_from_url: DATABASE_URL must be a postgres:// URL" >&2
      return 1
      ;;
  esac
  local rest="${url#*://}" query="" db="" userinfo="" hostport="" user="" pass="" has_pass=0 host="" port=""
  case "$rest" in *\?*) query="${rest#*\?}"; rest="${rest%%\?*}" ;; esac
  case "$rest" in */*) db="${rest#*/}"; rest="${rest%%/*}" ;; esac
  hostport="$rest"
  case "$rest" in *@*) userinfo="${rest%@*}"; hostport="${rest##*@}" ;; esac
  if [ -n "$userinfo" ]; then
    case "$userinfo" in
      *:*) user="${userinfo%%:*}"; pass="${userinfo#*:}"; has_pass=1 ;;
      *) user="$userinfo" ;;
    esac
  fi
  case "$hostport" in
    \[*\]*) host="${hostport%%]*}"; host="${host#[}"; port="${hostport##*]}"; port="${port#:}" ;;
    *:*) host="${hostport%%:*}"; port="${hostport#*:}" ;;
    *) host="$hostport" ;;
  esac
  export PGHOST PGDATABASE
  PGHOST="$(pg_url_decode "${host:-localhost}")"
  PGDATABASE="$(pg_url_decode "$db")"
  if [ -n "$port" ]; then export PGPORT="$port"; else unset PGPORT; fi
  if [ -n "$user" ]; then export PGUSER; PGUSER="$(pg_url_decode "$user")"; else unset PGUSER; fi
  if [ "$has_pass" = 1 ]; then export PGPASSWORD; PGPASSWORD="$(pg_url_decode "$pass")"; else unset PGPASSWORD; fi
  unset PGSSLMODE
  local pair
  local IFS='&'
  for pair in $query; do
    case "$pair" in
      sslmode=*) export PGSSLMODE="${pair#sslmode=}" ;;
    esac
  done
}
