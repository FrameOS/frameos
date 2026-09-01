#!/usr/bin/env node
/* global console, fetch, URL */
// The Phase 2 gate (cloud/docs/accounting-todo.md §7 Phase 2, §9.3): does
// the meter agree with the two other parties that counted the same tokens?
//
//   1. `ai_usage_records` — what we metered (and will bill on).
//   2. PostHog `$ai_generation` — the same rounds, captured independently
//      by the telemetry path. One event per model ROUND; a usage record is
//      one TURN with `rounds` on it, so the counts compare rounds to rounds.
//   3. OpenAI's own usage API — what the provider will invoice. This is the
//      comparison that settles §8.2 (do reasoning tokens bill as output?)
//      and the one that matters: if it disagrees, the bill is wrong.
//
// Written as a script rather than run once by hand so it can be re-run on
// the next model change, and every side is optional: it compares whatever
// it has credentials for and says plainly which sides it could not see.
//
//   DATABASE_URL=postgres://…                      \
//   POSTHOG_PERSONAL_API_KEY=phx_… POSTHOG_PROJECT_ID=12345 \
//   OPENAI_ADMIN_KEY=sk-admin-…                    \
//   node scripts/ai-metering-compare.mjs [--since 2026-08-26] [--until 2026-09-02] [--json]
//
// Days are UTC, `--until` exclusive; the default window is the last seven
// complete days. Token vocabularies differ and are normalised here:
//   - the meter stores DISJOINT counts (input_tokens = uncached input),
//     PostHog and OpenAI both report input INCLUDING the cached part, so the
//     meter's "reported input" is input + cached;
//   - reasoning tokens are a subset of output everywhere.
// Exit status 1 when any side present disagrees with the meter by more
// than --tolerance (default 1%) on any day/model with real volume.

import process from "node:process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const json = args.includes("--json");
const tolerance = Number(flag("tolerance", "0.01"));

const today = new Date();
const utcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const until = flag("until") ? new Date(`${flag("until")}T00:00:00Z`) : utcDay(today);
const since = flag("since")
  ? new Date(`${flag("since")}T00:00:00Z`)
  : new Date(until.getTime() - 7 * 24 * 3600 * 1000);
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
  console.error("Bad --since/--until (YYYY-MM-DD, since < until)");
  process.exit(2);
}
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

// day → model → {requests, input, cached, output, reasoning, cost_micros}
const empty = () => ({ cached: 0, cost_micros: 0, input: 0, output: 0, reasoning: 0, requests: 0 });
const sides = {};
const missing = [];

// ---- 1. the meter -------------------------------------------------------
if (process.env.DATABASE_URL) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`
      select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day,
             model,
             surface,
             count(*)::int as turns,
             coalesce(sum(rounds), 0)::int as rounds,
             coalesce(sum(input_tokens + cached_input_tokens), 0)::bigint as input,
             coalesce(sum(cached_input_tokens), 0)::bigint as cached,
             coalesce(sum(output_tokens), 0)::bigint as output,
             coalesce(sum(reasoning_tokens), 0)::bigint as reasoning,
             coalesce(sum(cost_micros), 0)::bigint as cost_micros,
             count(*) filter (where credential_source = 'account')::int as own_key_turns
        from ai_usage_records
       where occurred_at >= ${since.toISOString()}::timestamptz
         and occurred_at < ${until.toISOString()}::timestamptz
       group by 1, 2, 3
       order by 1, 2, 3`;
    const meter = {};
    const bySurface = {};
    for (const row of rows) {
      const bucket = ((meter[row.day] ??= {})[row.model] ??= empty());
      // Rounds are what PostHog counts; a record from before `rounds` was
      // stored (0) counts as one, which is the floor a turn can have.
      bucket.requests += row.rounds > 0 ? row.rounds : row.turns;
      bucket.turns = (bucket.turns ?? 0) + row.turns;
      bucket.input += Number(row.input);
      bucket.cached += Number(row.cached);
      bucket.output += Number(row.output);
      bucket.reasoning += Number(row.reasoning);
      bucket.cost_micros += Number(row.cost_micros);
      const s = (bySurface[row.surface ?? "(none)"] ??= { own_key_turns: 0, turns: 0 });
      s.turns += row.turns;
      s.own_key_turns += row.own_key_turns;
    }
    sides.meter = meter;
    sides.meter_surfaces = bySurface;
  } finally {
    await sql.end();
  }
} else {
  missing.push("meter (DATABASE_URL)");
}

// ---- 2. PostHog ---------------------------------------------------------
if (process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID) {
  const host = (process.env.POSTHOG_HOST || "https://eu.posthog.com").replace(/\/+$/, "");
  const query = `
    select toString(toDate(timestamp)) as day,
           toString(properties.$ai_model) as model,
           count() as requests,
           sum(toIntOrZero(toString(properties.$ai_input_tokens))) as input,
           sum(toIntOrZero(toString(properties.$ai_cache_read_input_tokens))) as cached,
           sum(toIntOrZero(toString(properties.$ai_output_tokens))) as output,
           sum(toIntOrZero(toString(properties.$ai_reasoning_tokens))) as reasoning,
           uniq(properties.$ai_trace_id) as turns
      from events
     where event = '$ai_generation'
       and timestamp >= toDateTime('${since.toISOString().replace("T", " ").slice(0, 19)}')
       and timestamp < toDateTime('${until.toISOString().replace("T", " ").slice(0, 19)}')
     group by day, model
     order by day, model`;
  const response = await fetch(`${host}/api/projects/${process.env.POSTHOG_PROJECT_ID}/query/`, {
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    headers: {
      authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    console.error(`PostHog query failed: HTTP ${response.status} ${await response.text()}`);
    process.exit(2);
  }
  const payload = await response.json();
  const posthog = {};
  for (const [day, model, requests, input, cached, output, reasoning, turns] of payload.results ?? []) {
    const bucket = ((posthog[day] ??= {})[model] ??= empty());
    bucket.requests += Number(requests);
    bucket.turns = (bucket.turns ?? 0) + Number(turns);
    bucket.input += Number(input);
    bucket.cached += Number(cached);
    bucket.output += Number(output);
    bucket.reasoning += Number(reasoning);
  }
  sides.posthog = posthog;
} else {
  missing.push("posthog (POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID)");
}

// ---- 3. OpenAI ----------------------------------------------------------
if (process.env.OPENAI_ADMIN_KEY) {
  const headers = { authorization: `Bearer ${process.env.OPENAI_ADMIN_KEY}` };
  const start = Math.floor(since.getTime() / 1000);
  const end = Math.floor(until.getTime() / 1000);
  const openai = {};
  let page;
  do {
    const url = new URL("https://api.openai.com/v1/organization/usage/completions");
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("end_time", String(end));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.append("group_by", "model");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(`OpenAI usage query failed: HTTP ${response.status} ${await response.text()}`);
      process.exit(2);
    }
    const payload = await response.json();
    for (const bucket of payload.data ?? []) {
      const day = dayOf(bucket.start_time * 1000);
      for (const result of bucket.results ?? []) {
        const b = ((openai[day] ??= {})[result.model ?? "(unknown)"] ??= empty());
        b.requests += result.num_model_requests ?? 0;
        b.input += result.input_tokens ?? 0;
        b.cached += result.input_cached_tokens ?? 0;
        b.output += result.output_tokens ?? 0;
      }
    }
    page = payload.has_more ? payload.next_page : undefined;
  } while (page);
  // Dollars, from the costs endpoint: the number on the invoice.
  const costs = new URL("https://api.openai.com/v1/organization/costs");
  costs.searchParams.set("start_time", String(start));
  costs.searchParams.set("end_time", String(end));
  costs.searchParams.set("bucket_width", "1d");
  costs.searchParams.set("limit", "31");
  const costResponse = await fetch(costs, { headers });
  if (costResponse.ok) {
    const payload = await costResponse.json();
    for (const bucket of payload.data ?? []) {
      const day = dayOf(bucket.start_time * 1000);
      const micros = (bucket.results ?? []).reduce(
        (sum, r) => sum + Math.round((r.amount?.value ?? 0) * 1_000_000),
        0,
      );
      ((openai[day] ??= {})["(all models)"] ??= empty()).cost_micros += micros;
    }
  }
  sides.openai = openai;
} else {
  missing.push("openai (OPENAI_ADMIN_KEY — an org admin key, not the API key)");
}

// ---- compare ------------------------------------------------------------
const metrics = ["turns", "requests", "input", "cached", "output", "reasoning"];
const days = new Set();
const models = new Set();
for (const side of ["meter", "posthog", "openai"]) {
  for (const [day, byModel] of Object.entries(sides[side] ?? {})) {
    days.add(day);
    for (const model of Object.keys(byModel)) models.add(model);
  }
}
const report = [];
let disagreements = 0;
for (const day of [...days].sort()) {
  for (const model of [...models].sort()) {
    const meter = sides.meter?.[day]?.[model];
    const posthog = sides.posthog?.[day]?.[model];
    const openai = sides.openai?.[day]?.[model];
    if (!meter && !posthog && !openai) continue;
    const row = { day, model, meter, openai, posthog, deltas: {} };
    for (const other of ["posthog", "openai"]) {
      const theirs = row[other];
      if (!meter || !theirs) continue;
      for (const metric of metrics) {
        if (other === "openai" && (metric === "reasoning" || metric === "turns")) continue;
        const ours = meter[metric] ?? 0;
        if (theirs[metric] === undefined) continue;
        const delta = theirs[metric] - ours;
        const relative = ours === 0 ? (theirs[metric] === 0 ? 0 : 1) : Math.abs(delta) / ours;
        row.deltas[`${other}.${metric}`] = { delta, relative };
        if (relative > tolerance && Math.max(ours, theirs[metric]) >= 1000) disagreements += 1;
      }
    }
    report.push(row);
  }
}
const costDays = Object.entries(sides.openai ?? {})
  .map(([day, byModel]) => ({
    day,
    meter_cost_micros: Object.values(sides.meter?.[day] ?? {}).reduce((s, b) => s + b.cost_micros, 0),
    openai_cost_micros: byModel["(all models)"]?.cost_micros ?? 0,
  }))
  .filter((row) => row.openai_cost_micros > 0 || row.meter_cost_micros > 0);

if (json) {
  console.log(JSON.stringify({ costDays, disagreements, missing, report, since, until, surfaces: sides.meter_surfaces }, null, 2));
} else {
  console.log(`AI metering comparison, ${dayOf(since)} → ${dayOf(until)} (UTC, exclusive)`);
  if (missing.length) console.log(`Sides not available: ${missing.join("; ")}`);
  const fmt = (n) => (n === undefined ? "—" : String(n).padStart(9));
  for (const row of report) {
    console.log(`\n${row.day}  ${row.model}`);
    console.log(`  ${"".padEnd(10)}${metrics.map((m) => m.padStart(10)).join("")}`);
    for (const side of ["meter", "posthog", "openai"]) {
      const b = row[side];
      if (!b) continue;
      console.log(`  ${side.padEnd(10)}${metrics.map((m) => fmt(b[m]).padStart(10)).join("")}`);
    }
    const bad = Object.entries(row.deltas).filter(([, d]) => d.relative > tolerance);
    if (bad.length) console.log(`  disagrees: ${bad.map(([k, d]) => `${k} ${d.delta > 0 ? "+" : ""}${d.delta}`).join(", ")}`);
  }
  if (sides.meter_surfaces) {
    console.log("\nMeter turns by surface (own-key turns in brackets — PostHog does not see whose key):");
    for (const [surface, s] of Object.entries(sides.meter_surfaces)) {
      console.log(`  ${surface.padEnd(20)} ${String(s.turns).padStart(6)} (${s.own_key_turns})`);
    }
  }
  if (costDays.length) {
    console.log("\nProvider invoice vs metered cost (micro-USD):");
    for (const row of costDays) {
      console.log(`  ${row.day}  openai ${String(row.openai_cost_micros).padStart(12)}  meter ${String(row.meter_cost_micros).padStart(12)}`);
    }
  }
  console.log(`\n${disagreements} disagreement(s) above ${tolerance * 100}% on day/model buckets with volume.`);
}
process.exit(disagreements > 0 ? 1 : 0);
