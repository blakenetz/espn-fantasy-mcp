// Offline smoke test: stubs ESPN with fixture data and drives the MCP endpoint end to end.
import assert from "node:assert/strict";
import worker from "../src/index";

const env = {
  ESPN_S2: "s2", ESPN_SWID: "ABC", LEAGUE_ID: "1", TEAM_ID: "3", SEASON: "2026", CONNECTOR_SECRET: "sekrit",
};

const player = (id: number, name: string, pos: number, team: number, proj: number) => ({
  id, fullName: name, defaultPositionId: pos, proTeamId: team, injuryStatus: "ACTIVE",
  ownership: { percentOwned: 88.123, percentStarted: 70 },
  stats: [
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 9, appliedTotal: proj },
    { statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 101.5 },
  ],
});

const fixture = {
  scoringPeriodId: 9,
  status: { currentMatchupPeriod: 9 },
  settings: {
    name: "Test League", size: 10,
    scoringSettings: { scoringItems: [{ statId: 53, points: 1 }] },
    rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 1, 3: 0 } },
    acquisitionSettings: { isUsingAcquisitionBudget: true, acquisitionBudget: 100 },
    scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 },
  },
  teams: [
    { id: 3, name: "Blake's Team", playoffSeed: 2, record: { overall: { wins: 5, losses: 3, ties: 0, pointsFor: 900.456 } },
      roster: { entries: [
        { lineupSlotId: 0, playerPoolEntry: { player: player(1, "QB One", 1, 7, 20.4) } },
        { lineupSlotId: 20, playerPoolEntry: { player: player(2, "Bench RB", 2, 12, 8.1) } },
      ] } },
    { id: 5, name: "Rival", playoffSeed: 1,
      roster: { entries: [{ lineupSlotId: 4, playerPoolEntry: { player: player(3, "WR Rival", 3, 21, 15) } }] } },
  ],
  schedule: [{ matchupPeriodId: 9, home: { teamId: 3, totalPoints: 0 }, away: { teamId: 5, totalPoints: 0 } }],
  players: [{ status: "WAIVERS", player: player(9, "Waiver WR", 3, 8, 11.2) }],
};

const seen: { url: string; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (url: string, init: any) => {
  seen.push({ url, headers: init.headers });
  return new Response(JSON.stringify(fixture), { status: 200 });
}) as any;

async function rpc(method: string, params?: object, id: number | null = 1) {
  const res = await worker.fetch(
    new Request("https://x.dev/mcp/sekrit", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) }),
    env,
  );
  return res.status === 202 ? null : ((await res.json()) as any);
}
const call = async (name: string, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);

// Routing / auth
assert.equal((await worker.fetch(new Request("https://x.dev/mcp/wrong", { method: "POST", body: "{}" }), env)).status, 404);
assert.equal((await worker.fetch(new Request("https://x.dev/mcp/sekrit"), env)).status, 405);

// Protocol
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
assert.equal(init.result.protocolVersion, "2025-06-18");
assert.equal(await rpc("notifications/initialized", undefined, null), null);
const list = await rpc("tools/list");
assert.deepEqual(list.result.tools.map((t: any) => t.name), ["get_league", "get_roster", "get_matchup", "get_free_agents"]);

// Tools
const league = await call("get_league");
assert.equal(league.pointsPerReception, 1);
assert.equal(league.waivers.faabBudget, 100);
assert.equal(league.standings[0].name, "Rival");
assert.ok(!league.lineupSlots.some((s: any) => s.slot === "RB/WR"));
assert.equal(seen.at(-1)!.headers.Cookie, "espn_s2=s2; SWID={ABC}");

const roster = await call("get_roster");
assert.equal(roster.starters[0].name, "QB One");
assert.equal(roster.starters[0].proTeam, "DEN");
assert.equal(roster.bench[0].slot, "BE");
assert.equal(roster.projectedStarterTotal, 20.4);

const matchup = await call("get_matchup");
assert.equal(matchup.opponent.teamName, "Rival");

const fa = await call("get_free_agents", { position: "WR", limit: 5 });
assert.equal(fa.players[0].availability, "WAIVERS");
const filter = JSON.parse(seen.at(-1)!.headers["x-fantasy-filter"]);
assert.deepEqual(filter.players.filterSlotIds.value, [4]);

// Expired cookies surface as a tool error, not a crash
globalThis.fetch = (async () => new Response("no", { status: 401 })) as any;
const expired = await rpc("tools/call", { name: "get_league", arguments: {} });
assert.equal(expired.result.isError, true);
assert.match(expired.result.content[0].text, /expired/);

console.log("all smoke checks passed");
