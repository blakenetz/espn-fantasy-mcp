// Offline smoke test: serves recorded (scrubbed) ESPN responses from week 8 of the 2026 season
// and drives the MCP endpoint end to end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchupPeriodFor } from "../src/espn";
import worker from "../src/index";

const env = {
  ESPN_S2: "s2", ESPN_SWID: "ABC", LEAGUE_ID: "1", TEAM_ID: "3", SEASON: "2026", CONNECTOR_SECRET: "sekrit",
};

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const fixtures = {
  league: fixture("league"),
  matchup: fixture("matchup"),
  freeAgents: fixture("free-agents"),
  playersById: fixture("players-by-id"),
  proSchedule: fixture("pro-schedule"),
  transactions: fixture("transactions"),
};

// Route each request to the recorded response for that ESPN endpoint/view.
function respond(url: URL, headers: Record<string, string>) {
  const views = url.searchParams.getAll("view");
  if (url.pathname.endsWith("/seasons/2026")) return fixtures.proSchedule;
  if (views.includes("kona_player_info")) {
    return JSON.parse(headers["x-fantasy-filter"]).players.filterIds ? fixtures.playersById : fixtures.freeAgents;
  }
  if (views.includes("mTransactions2")) return fixtures.transactions;
  if (views.includes("mRoster") || views.includes("mMatchupScore")) return fixtures.matchup;
  return fixtures.league;
}

const seen: { url: URL; headers: Record<string, string> }[] = [];
const espnFixtures = (async (url: string, init: any) => {
  const u = new URL(url);
  seen.push({ url: u, headers: init.headers });
  return new Response(JSON.stringify(respond(u, init.headers)), { status: 200 });
}) as typeof fetch;
globalThis.fetch = espnFixtures;

async function rpc(method: string, params?: object, id: number | null = 1, e: Record<string, string> = env) {
  const res = await worker.fetch(
    new Request("https://x.dev/mcp/sekrit", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) }),
    e as any,
  );
  return res.status === 202 ? null : ((await res.json()) as any);
}
const call = async (name: string, args = {}) => {
  const res = (await rpc("tools/call", { name, arguments: args })).result;
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text);
};

// Routing / auth
assert.equal((await worker.fetch(new Request("https://x.dev/mcp/wrong", { method: "POST", body: "{}" }), env as any)).status, 404);
assert.equal((await worker.fetch(new Request("https://x.dev/mcp/sekrit"), env as any)).status, 405);

// Protocol
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
assert.equal(init.result.protocolVersion, "2025-06-18");
assert.equal(await rpc("notifications/initialized", undefined, null), null);
const list = await rpc("tools/list");
assert.deepEqual(
  list.result.tools.map((t: any) => t.name),
  ["get_league", "get_roster", "get_matchup", "get_free_agents", "get_pro_schedule", "get_recent_transactions"],
);

// get_league
const league = await call("get_league");
assert.equal(seen.at(-1)!.headers.Cookie, "espn_s2=s2; SWID={ABC}");
assert.equal(league.currentWeek, 8);
assert.equal(league.pointsPerReception, 1);
assert.match(league.scoringBonus, /top half/);
assert.equal(league.waivers.type, "WAIVERS_TRADITIONAL");
assert.equal(league.waivers.faabBudget, undefined, "FAAB budget is hidden when the league doesn't use FAAB");
assert.deepEqual(league.playoffRounds, [[15], [16, 17]]);
assert.equal(league.playoffTiebreaker, "TOTAL_POINTS_SCORED");
assert.deepEqual(league.standings.map((t: any) => t.playoffSeed), [1, 2, 3, 4, 5, 6, 7, 8]);
assert.equal(league.standings.find((t: any) => t.isMine).teamId, 3);
assert.ok(!league.lineupSlots.some((s: any) => s.slot === "RB/WR"), "zero-count slots are dropped");

// Two-week playoff matchups map back to their matchup period.
assert.deepEqual(matchupPeriodFor(fixtures.league.settings, 17), { period: 16, weeks: [16, 17] });
assert.deepEqual(matchupPeriodFor(fixtures.league.settings, 15), { period: 15, weeks: [15] });

// get_roster
const roster = await call("get_roster");
const players = [...roster.starters, ...roster.bench];
const byName = (n: string) => players.find((p: any) => p.name === n);
assert.equal(roster.week, 8);
assert.equal(byName("Joe Burrow").seasonPoints, 130.12, "season totals come from this season, not last");
assert.equal(byName("Joe Burrow").seasonProjectedPoints, 228.74);
assert.equal(byName("Joe Burrow").projectedPoints, 22.88);
assert.equal(byName("Joe Burrow").opponent, "vs TEN");
assert.equal(byName("Christian McCaffrey").opponent, "BYE");
assert.equal(byName("Christian McCaffrey").byeWeek, 8);
assert.equal(byName("Jalen Coker").slot, "FLEX");
assert.equal(byName("Jalen Coker").actualPoints, 9.6);
assert.ok(roster.bench.some((p: any) => p.slot === "IR"), "IR counts as bench");
assert.ok(players.every((p: any) => p.name && p.position && p.proTeam && p.slot && typeof p.projectedPoints === "number"));
const espnProjected = fixtures.matchup.schedule.find((g: any) => g.matchupPeriodId === 8 && g.home.teamId === 3).home.totalProjectedPoints;
assert.equal(roster.projectedStarterTotal, Math.round(espnProjected * 100) / 100, "starter total matches ESPN's own projection");

// get_matchup
const matchup = await call("get_matchup");
assert.deepEqual(matchup.matchupWeeks, [8]);
assert.equal(matchup.opponent.teamName, "Team 5");
assert.equal(matchup.me.pointsSoFar, 30.5, "uses live points while the week is in progress");
assert.equal(matchup.me.winProbability, 0.52);
const lastWeek = await call("get_matchup", { week: 7 });
assert.equal(lastWeek.me.pointsSoFar, 108.48);

// get_free_agents
const fa = await call("get_free_agents", { position: "FLEX", limit: 6 });
assert.deepEqual(JSON.parse(seen.findLast((r) => r.url.searchParams.get("view") === "kona_player_info")!.headers["x-fantasy-filter"]).players.filterSlotIds.value, [23]);
assert.ok(fa.players.length > 0);
assert.ok(fa.players.every((p: any) => ["RB", "WR", "TE"].includes(p.position) && typeof p.projectedPoints === "number" && p.availability === "FREE_AGENT"));
assert.equal(fa.players.find((p: any) => p.name === "Woody Marks").opponent, "BYE");

// get_pro_schedule
const sched = await call("get_pro_schedule");
assert.equal(sched.games.length, 14);
assert.deepEqual(sched.games[0], { away: "CAR", home: "GB", kickoff: "2026-10-30T00:15:00.000Z" });
assert.deepEqual(sched.onBye, ["HOU", "NO", "NYG", "SF"]);
assert.equal(sched.byeWeeks.SF, 8);
assert.equal(Object.keys(sched.byeWeeks).length, 32);

// get_recent_transactions: executed adds/drops/waivers only, lineup moves excluded, names resolved.
const tx = await call("get_recent_transactions", { weeks: 1 });
assert.deepEqual(tx.weeks, [8, 8]);
assert.deepEqual(tx.transactions.map((t: any) => t.type).sort(), ["FREE_AGENT", "FREE_AGENT", "WAIVER"]);
assert.deepEqual(tx.transactions.find((t: any) => t.type === "WAIVER"), {
  week: 8, date: tx.transactions.find((t: any) => t.type === "WAIVER").date, type: "WAIVER", team: "Team 5",
  moves: [{ added: "Jayden Daniels (QB, WSH)" }, { dropped: "Bryce Young (QB, CAR)" }],
});
const dates = tx.transactions.map((t: any) => t.date);
assert.deepEqual(dates, [...dates].sort().reverse(), "newest first");

// A trade can appear as several executed records; it is reported once. Pending claims are skipped.
const [waiver] = fixtures.transactions.transactions.filter((t: any) => t.type === "WAIVER");
const tradeItems = [
  { type: "TRADE", playerId: 4426348, fromTeamId: 5, toTeamId: 2 },
  { type: "TRADE", playerId: 4685720, fromTeamId: 2, toTeamId: 5 },
];
fixtures.transactions.transactions.push(
  { ...waiver, id: "t1", type: "TRADE_PROPOSAL", items: tradeItems },
  { ...waiver, id: "t2", type: "TRADE_ACCEPT", items: tradeItems },
  { ...waiver, id: "t3", status: "PENDING" },
);
const trades = (await call("get_recent_transactions", { weeks: 1 })).transactions.filter((t: any) => t.type === "TRADE");
assert.equal(trades.length, 1);
assert.deepEqual(trades[0].moves[0], { traded: "Jayden Daniels (QB, WSH)", from: "Team 5", to: "Team 2" });

// Missing secrets and expired cookies surface as tool errors, not crashes.
const missing = await rpc("tools/call", { name: "get_league", arguments: {} }, 1, { ...env, ESPN_S2: "" });
assert.equal(missing.result.isError, true);
assert.match(missing.result.content[0].text, /ESPN_S2 Worker secret is not set/);

globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
const expired = await rpc("tools/call", { name: "get_league", arguments: {} });
assert.equal(expired.result.isError, true);
assert.match(expired.result.content[0].text, /expired/);

console.log("all smoke checks passed");
