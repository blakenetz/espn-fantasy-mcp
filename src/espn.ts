// Read-only client for ESPN's (unofficial) fantasy football league API.
// Private leagues are authenticated with the espn_s2 + SWID cookies from a signed-in browser.

export interface Env {
  ESPN_S2: string;
  ESPN_SWID: string;
  LEAGUE_ID: string;
  TEAM_ID: string;
  SEASON: string;
  CONNECTOR_SECRET: string;
}

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

export const POSITION: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

export const SLOT: Record<number, string> = {
  0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  16: "D/ST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX",
};

const BENCH_SLOTS = new Set([20, 21]);

// Lineup-slot ids used to filter the free-agent pool by position.
const POSITION_FILTER: Record<string, number[]> = {
  QB: [0], RB: [2], WR: [4], TE: [6], K: [17], "D/ST": [16], FLEX: [23],
  ALL: [0, 2, 4, 6, 17, 16],
};

export const PRO_TEAM: Record<number, string> = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

export interface PlayerSummary {
  playerId: number;
  name: string;
  position: string;
  proTeam: string;
  injuryStatus: string;
  percentOwned?: number;
  percentStarted?: number;
  projectedPoints?: number;
  actualPoints?: number;
  seasonPoints?: number;
  seasonProjectedPoints?: number;
  slot?: string;
  availability?: string;
}

const round = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : undefined);

export function summarizePlayer(player: any, week: number): PlayerSummary {
  const stats: any[] = player?.stats ?? [];
  const find = (source: number, split: number, period: number) =>
    stats.find((s) => s.statSourceId === source && s.statSplitTypeId === split && s.scoringPeriodId === period);
  return {
    playerId: player.id,
    name: player.fullName,
    position: POSITION[player.defaultPositionId] ?? `pos${player.defaultPositionId}`,
    proTeam: PRO_TEAM[player.proTeamId] ?? `team${player.proTeamId}`,
    injuryStatus: player.injuryStatus ?? (player.injured ? "INJURED" : "ACTIVE"),
    percentOwned: round(player.ownership?.percentOwned),
    percentStarted: round(player.ownership?.percentStarted),
    projectedPoints: round(find(1, 1, week)?.appliedTotal),
    actualPoints: round(find(0, 1, week)?.appliedTotal),
    seasonPoints: round(find(0, 0, 0)?.appliedTotal),
    seasonProjectedPoints: round(find(1, 0, 0)?.appliedTotal),
  };
}

const teamName = (t: any) => t.name ?? [t.location, t.nickname].filter(Boolean).join(" ");

export class EspnClient {
  constructor(private env: Env, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  get myTeamId(): number {
    return Number(this.env.TEAM_ID);
  }

  private async get(params: [string, string][], headers: Record<string, string> = {}): Promise<any> {
    const url = new URL(`${BASE}/seasons/${this.env.SEASON}/segments/0/leagues/${this.env.LEAGUE_ID}`);
    for (const [k, v] of params) url.searchParams.append(k, v);
    const swid = this.env.ESPN_SWID.trim();
    const res = await this.fetchImpl(url.toString(), {
      headers: {
        Cookie: `espn_s2=${this.env.ESPN_S2.trim()}; SWID=${swid.startsWith("{") ? swid : `{${swid}}`}`,
        Accept: "application/json",
        ...headers,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `ESPN rejected the login cookies (HTTP ${res.status}). espn_s2 has probably expired: copy fresh espn_s2 and SWID cookies from a signed-in browser and update the Worker secrets.`,
      );
    }
    if (!res.ok) throw new Error(`ESPN request failed: HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("ESPN returned a non-JSON response (likely a login page). Refresh the espn_s2/SWID secrets.");
    }
  }

  async currentWeek(): Promise<number> {
    const d = await this.get([["view", "mStatus"]]);
    return d.scoringPeriodId ?? d.status?.currentMatchupPeriod;
  }

  async getLeague() {
    const d = await this.get([["view", "mSettings"], ["view", "mTeam"], ["view", "mStatus"]]);
    const s = d.settings ?? {};
    const ppr = s.scoringSettings?.scoringItems?.find((i: any) => i.statId === 53)?.points ?? 0;
    const slots = Object.entries(s.rosterSettings?.lineupSlotCounts ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([id, count]) => ({ slot: SLOT[Number(id)] ?? `slot${id}`, count }));
    const teams = (d.teams ?? [])
      .map((t: any) => ({
        teamId: t.id,
        name: teamName(t),
        isMine: t.id === this.myTeamId,
        record: t.record?.overall
          ? {
              wins: t.record.overall.wins,
              losses: t.record.overall.losses,
              ties: t.record.overall.ties,
              pointsFor: round(t.record.overall.pointsFor),
              pointsAgainst: round(t.record.overall.pointsAgainst),
            }
          : undefined,
        playoffSeed: t.playoffSeed,
        waiverRank: t.waiverRank,
        faabSpent: t.transactionCounter?.acquisitionBudgetSpent,
      }))
      .sort((a: any, b: any) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99));
    return {
      leagueName: s.name,
      season: Number(this.env.SEASON),
      currentWeek: d.scoringPeriodId,
      teamCount: s.size,
      pointsPerReception: ppr,
      lineupSlots: slots,
      waivers: {
        usesFaab: s.acquisitionSettings?.isUsingAcquisitionBudget ?? false,
        faabBudget: s.acquisitionSettings?.acquisitionBudget,
        waiverHours: s.acquisitionSettings?.waiverHours,
        processDays: s.acquisitionSettings?.waiverProcessDays,
      },
      regularSeasonWeeks: s.scheduleSettings?.matchupPeriodCount,
      playoffTeams: s.scheduleSettings?.playoffTeamCount,
      myTeamId: this.myTeamId,
      standings: teams,
    };
  }

  async getRoster(teamId = this.myTeamId, week?: number) {
    const wk = week ?? (await this.currentWeek());
    const d = await this.get([["view", "mRoster"], ["view", "mTeam"], ["scoringPeriodId", String(wk)]]);
    const team = (d.teams ?? []).find((t: any) => t.id === teamId);
    if (!team) throw new Error(`No team with id ${teamId} in this league.`);
    const players = (team.roster?.entries ?? []).map((e: any) => ({
      ...summarizePlayer(e.playerPoolEntry?.player ?? {}, wk),
      slot: SLOT[e.lineupSlotId] ?? `slot${e.lineupSlotId}`,
      _slotId: e.lineupSlotId,
    }));
    const starters = players.filter((p: any) => !BENCH_SLOTS.has(p._slotId));
    const bench = players.filter((p: any) => BENCH_SLOTS.has(p._slotId));
    const strip = ({ _slotId, ...p }: any) => p;
    return {
      week: wk,
      teamId,
      teamName: teamName(team),
      projectedStarterTotal: round(starters.reduce((sum: number, p: any) => sum + (p.projectedPoints ?? 0), 0)),
      starters: starters.map(strip),
      bench: bench.map(strip),
    };
  }

  async getMatchup(week?: number, teamId = this.myTeamId) {
    const wk = week ?? (await this.currentWeek());
    const d = await this.get([["view", "mMatchupScore"], ["view", "mTeam"], ["scoringPeriodId", String(wk)]]);
    const game = (d.schedule ?? []).find(
      (g: any) => g.matchupPeriodId === wk && (g.home?.teamId === teamId || g.away?.teamId === teamId),
    );
    if (!game) return { week: wk, teamId, note: "No matchup found for this week (bye or outside the schedule)." };
    const opponentId = game.home?.teamId === teamId ? game.away?.teamId : game.home?.teamId;
    const [mine, theirs] = await Promise.all([
      this.getRoster(teamId, wk),
      opponentId !== undefined ? this.getRoster(opponentId, wk) : Promise.resolve(undefined),
    ]);
    const side = (id: number) => (game.home?.teamId === id ? game.home : game.away);
    return {
      week: wk,
      playoffTier: game.playoffTierType,
      me: { ...mine, pointsSoFar: round(side(teamId)?.totalPoints) },
      opponent: theirs ? { ...theirs, pointsSoFar: round(side(opponentId)?.totalPoints) } : undefined,
    };
  }

  async getFreeAgents(position = "ALL", limit = 25, week?: number) {
    const wk = week ?? (await this.currentWeek());
    const slotIds = POSITION_FILTER[position.toUpperCase()];
    if (!slotIds) throw new Error(`Unknown position "${position}". Use one of: ${Object.keys(POSITION_FILTER).join(", ")}.`);
    const filter = {
      players: {
        filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
        filterSlotIds: { value: slotIds },
        limit: Math.min(Math.max(limit, 1), 100),
        sortPercOwned: { sortPriority: 1, sortAsc: false },
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
      },
    };
    const d = await this.get(
      [["view", "kona_player_info"], ["scoringPeriodId", String(wk)]],
      { "x-fantasy-filter": JSON.stringify(filter) },
    );
    return {
      week: wk,
      position: position.toUpperCase(),
      players: (d.players ?? []).map((p: any) => ({
        ...summarizePlayer(p.player ?? {}, wk),
        availability: p.status === "WAIVERS" ? "WAIVERS" : "FREE_AGENT",
      })),
    };
  }
}
