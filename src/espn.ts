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

const SCORING_ENHANCEMENT: Record<string, string> = {
  WIN_BONUS_TOP_HALF:
    "Each week, teams that score in the top half of the league get an extra win, so records count two results per week.",
};

const TX_TYPES: Record<string, true> = { FREEAGENT: true, WAIVER: true, TRADE_ACCEPT: true, TRADE_UPHOLD: true, TRADE_PROPOSAL: true };

export interface PlayerSummary {
  playerId: number;
  name: string;
  position: string;
  proTeam: string;
  opponent?: string;
  byeWeek?: number;
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
const proTeam = (id: number) => PRO_TEAM[id] ?? `team${id}`;

// NFL schedule for the season: bye weeks and each team's game per scoring period.
export class ProSchedule {
  private teams: Map<number, any>;

  constructor(proTeams: any[]) {
    this.teams = new Map(proTeams.filter((t) => t.id !== 0).map((t) => [t.id, t]));
  }

  byeWeek(teamId: number): number | undefined {
    return this.teams.get(teamId)?.byeWeek || undefined;
  }

  game(teamId: number, week: number): any | undefined {
    return this.teams.get(teamId)?.proGamesByScoringPeriod?.[week]?.[0];
  }

  // "vs KC" (home), "@ KC" (away), "BYE", or undefined for unknown teams / free agents.
  opponent(teamId: number, week: number): string | undefined {
    if (!this.teams.has(teamId)) return undefined;
    const g = this.game(teamId, week);
    if (!g) return "BYE";
    return g.homeProTeamId === teamId ? `vs ${proTeam(g.awayProTeamId)}` : `@ ${proTeam(g.homeProTeamId)}`;
  }

  weekGames(week: number) {
    const seen = new Map<number, any>();
    for (const t of this.teams.values()) {
      for (const g of t.proGamesByScoringPeriod?.[week] ?? []) seen.set(g.id, g);
    }
    return [...seen.values()]
      .sort((a, b) => a.date - b.date)
      .map((g) => ({ away: proTeam(g.awayProTeamId), home: proTeam(g.homeProTeamId), kickoff: new Date(g.date).toISOString() }));
  }

  onBye(week: number): string[] {
    return [...this.teams.values()].filter((t) => !t.proGamesByScoringPeriod?.[week]).map((t) => proTeam(t.id)).sort();
  }

  byeWeeks(): Record<string, number> {
    return Object.fromEntries([...this.teams.values()].map((t) => [proTeam(t.id), t.byeWeek]).sort((a, b) => a[1] - b[1]));
  }
}

export function summarizePlayer(player: any, week: number, season: number, pro?: ProSchedule): PlayerSummary {
  const stats: any[] = player?.stats ?? [];
  // stats[] mixes seasons (e.g. last year's totals share source/split/period ids), so match the season too.
  const find = (source: number, split: number, period: number) =>
    stats.find(
      (s) => s.seasonId === season && s.statSourceId === source && s.statSplitTypeId === split && s.scoringPeriodId === period,
    );
  return {
    playerId: player.id,
    name: player.fullName,
    position: POSITION[player.defaultPositionId] ?? `pos${player.defaultPositionId}`,
    proTeam: proTeam(player.proTeamId),
    opponent: pro?.opponent(player.proTeamId, week),
    byeWeek: pro?.byeWeek(player.proTeamId),
    injuryStatus: player.injuryStatus ?? (player.injured ? "INJURED" : "ACTIVE"),
    percentOwned: round(player.ownership?.percentOwned),
    percentStarted: round(player.ownership?.percentStarted),
    projectedPoints: round(find(1, 1, week)?.appliedTotal),
    actualPoints: round(find(0, 1, week)?.appliedTotal),
    seasonPoints: round(find(0, 0, 0)?.appliedTotal),
    seasonProjectedPoints: round(find(1, 0, 0)?.appliedTotal),
  };
}

// Playoff matchups can span several NFL weeks, e.g. matchupPeriods { "16": [16, 17] }.
export function matchupPeriodFor(settings: any, week: number): { period: number; weeks: number[] } {
  for (const [period, weeks] of Object.entries(settings?.scheduleSettings?.matchupPeriods ?? {})) {
    if ((weeks as number[]).includes(week)) return { period: Number(period), weeks: weeks as number[] };
  }
  return { period: week, weeks: [week] };
}

const teamName = (t: any) => t.name ?? [t.location, t.nickname].filter(Boolean).join(" ");

export class EspnClient {
  constructor(private env: Env, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  get myTeamId(): number {
    return Number(this.env.TEAM_ID);
  }

  private get season(): number {
    return Number(this.env.SEASON);
  }

  private async get(params: [string, string][], headers: Record<string, string> = {}, path?: string): Promise<any> {
    for (const name of ["ESPN_S2", "ESPN_SWID", "LEAGUE_ID"] as const) {
      if (!this.env[name]?.trim()) throw new Error(`The ${name} Worker secret is not set. Run: npx wrangler secret put ${name}`);
    }
    const url = new URL(`${BASE}${path ?? `/seasons/${this.env.SEASON}/segments/0/leagues/${this.env.LEAGUE_ID.trim()}`}`);
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

  async proSchedule(): Promise<ProSchedule> {
    const d = await this.get([["view", "proTeamSchedules_wl"]], {}, `/seasons/${this.env.SEASON}`);
    return new ProSchedule(d.settings?.proTeams ?? []);
  }

  async getLeague() {
    const d = await this.get([["view", "mSettings"], ["view", "mTeam"], ["view", "mStatus"]]);
    const s = d.settings ?? {};
    const acq = s.acquisitionSettings ?? {};
    const usesFaab = acq.isUsingAcquisitionBudget ?? false;
    const ppr = s.scoringSettings?.scoringItems?.find((i: any) => i.statId === 53)?.points ?? 0;
    const enhancement = s.scoringSettings?.scoringEnhancementType;
    const slots = Object.entries(s.rosterSettings?.lineupSlotCounts ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([id, count]) => ({ slot: SLOT[Number(id)] ?? `slot${id}`, count }));
    const regularSeasonWeeks = s.scheduleSettings?.matchupPeriodCount;
    const playoffRounds = Object.entries(s.scheduleSettings?.matchupPeriods ?? {})
      .filter(([period]) => Number(period) > regularSeasonWeeks)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, weeks]) => weeks);
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
        faabSpent: usesFaab ? t.transactionCounter?.acquisitionBudgetSpent : undefined,
      }))
      .sort((a: any, b: any) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99));
    return {
      leagueName: s.name,
      season: this.season,
      currentWeek: d.scoringPeriodId,
      teamCount: s.size,
      pointsPerReception: ppr,
      scoringBonus: enhancement && enhancement !== "NONE" ? (SCORING_ENHANCEMENT[enhancement] ?? enhancement) : undefined,
      lineupSlots: slots,
      waivers: {
        type: acq.acquisitionType,
        usesFaab,
        faabBudget: usesFaab ? acq.acquisitionBudget : undefined,
        waiverHours: acq.waiverHours,
        processDays: acq.waiverProcessDays,
      },
      regularSeasonWeeks,
      playoffTeams: s.scheduleSettings?.playoffTeamCount,
      playoffRounds,
      playoffTiebreaker: s.scheduleSettings?.playoffSeedingRule,
      myTeamId: this.myTeamId,
      standings: teams,
    };
  }

  private roster(team: any, wk: number, pro: ProSchedule) {
    const players = (team.roster?.entries ?? []).map((e: any) => ({
      ...summarizePlayer(e.playerPoolEntry?.player ?? {}, wk, this.season, pro),
      slot: SLOT[e.lineupSlotId] ?? `slot${e.lineupSlotId}`,
      _slotId: e.lineupSlotId,
    }));
    const starters = players.filter((p: any) => !BENCH_SLOTS.has(p._slotId));
    const bench = players.filter((p: any) => BENCH_SLOTS.has(p._slotId));
    const strip = ({ _slotId, ...p }: any) => p;
    return {
      week: wk,
      teamId: team.id,
      teamName: teamName(team),
      projectedStarterTotal: round(starters.reduce((sum: number, p: any) => sum + (p.projectedPoints ?? 0), 0)),
      starters: starters.map(strip),
      bench: bench.map(strip),
    };
  }

  async getRoster(teamId = this.myTeamId, week?: number) {
    const wk = week ?? (await this.currentWeek());
    const [d, pro] = await Promise.all([
      this.get([["view", "mRoster"], ["view", "mTeam"], ["scoringPeriodId", String(wk)]]),
      this.proSchedule(),
    ]);
    const team = (d.teams ?? []).find((t: any) => t.id === teamId);
    if (!team) throw new Error(`No team with id ${teamId} in this league.`);
    return this.roster(team, wk, pro);
  }

  async getMatchup(week?: number, teamId = this.myTeamId) {
    const wk = week ?? (await this.currentWeek());
    const [d, pro] = await Promise.all([
      this.get([
        ["view", "mMatchupScore"], ["view", "mRoster"], ["view", "mTeam"], ["view", "mSettings"],
        ["scoringPeriodId", String(wk)],
      ]),
      this.proSchedule(),
    ]);
    const { period, weeks } = matchupPeriodFor(d.settings, wk);
    const game = (d.schedule ?? []).find(
      (g: any) => g.matchupPeriodId === period && (g.home?.teamId === teamId || g.away?.teamId === teamId),
    );
    if (!game) return { week: wk, teamId, note: "No matchup found for this week (bye or outside the schedule)." };
    const opponentId = game.home?.teamId === teamId ? game.away?.teamId : game.home?.teamId;
    const teamById = (id: number) => (d.teams ?? []).find((t: any) => t.id === id);
    const side = (id: number) => {
      const s = game.home?.teamId === id ? game.home : game.away;
      const team = teamById(id);
      if (!s || !team) return undefined;
      return {
        ...this.roster(team, wk, pro),
        pointsSoFar: round(s.totalPointsLive ?? s.totalPoints),
        projectedTotal: round(s.totalProjectedPointsLive ?? s.totalProjectedPoints),
        winProbability: round(s.winProbability),
      };
    };
    return {
      week: wk,
      matchupPeriod: period,
      matchupWeeks: weeks,
      playoffTier: game.playoffTierType,
      me: side(teamId),
      opponent: opponentId !== undefined ? side(opponentId) : undefined,
    };
  }

  async getFreeAgents(position = "ALL", limit = 25, week?: number) {
    const slotIds = POSITION_FILTER[position.toUpperCase()];
    if (!slotIds) throw new Error(`Unknown position "${position}". Use one of: ${Object.keys(POSITION_FILTER).join(", ")}.`);
    const wk = week ?? (await this.currentWeek());
    const filter = {
      players: {
        filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
        filterSlotIds: { value: slotIds },
        limit: Math.min(Math.max(limit, 1), 100),
        sortPercOwned: { sortPriority: 1, sortAsc: false },
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
      },
    };
    const [d, pro] = await Promise.all([
      this.get([["view", "kona_player_info"], ["scoringPeriodId", String(wk)]], { "x-fantasy-filter": JSON.stringify(filter) }),
      this.proSchedule(),
    ]);
    return {
      week: wk,
      position: position.toUpperCase(),
      players: (d.players ?? []).map((p: any) => ({
        ...summarizePlayer(p.player ?? {}, wk, this.season, pro),
        availability: p.status === "WAIVERS" ? "WAIVERS" : "FREE_AGENT",
      })),
    };
  }

  async getProSchedule(week?: number) {
    const [wk, pro] = await Promise.all([week ?? this.currentWeek(), this.proSchedule()]);
    return { week: wk, games: pro.weekGames(wk), onBye: pro.onBye(wk), byeWeeks: pro.byeWeeks() };
  }

  async getRecentTransactions(weeks = 2) {
    const wk = await this.currentWeek();
    const first = Math.max(1, wk - Math.min(Math.max(weeks, 1), 4) + 1);
    const pages = await Promise.all(
      Array.from({ length: wk - first + 1 }, (_, i) =>
        this.get([["view", "mTransactions2"], ["view", "mTeam"], ["scoringPeriodId", String(first + i)]]),
      ),
    );
    const teamNames = new Map<number, string>((pages[0]?.teams ?? []).map((t: any) => [t.id, teamName(t)]));
    // Trades can show up as several records (proposal, accept, upholding); keep one per set of moves.
    const seen = new Set<string>();
    const txs = pages
      .flatMap((p) => p.transactions ?? [])
      .filter((t: any) => t.status === "EXECUTED" && TX_TYPES[t.type])
      .map((t: any) => ({ ...t, items: (t.items ?? []).filter((i: any) => ["ADD", "DROP", "TRADE"].includes(i.type)) }))
      .filter((t: any) => {
        if (t.items.length === 0) return false;
        const key = t.items.map((i: any) => `${i.type}:${i.playerId}:${i.fromTeamId}>${i.toTeamId}`).sort().join(",");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a: any, b: any) => (b.processDate ?? b.proposedDate) - (a.processDate ?? a.proposedDate));

    const ids = [...new Set(txs.flatMap((t: any) => t.items.map((i: any) => i.playerId)))];
    const players = new Map<number, any>();
    if (ids.length > 0) {
      // filterIds lookups must not set a limit (ESPN then demands a sort).
      const d = await this.get([["view", "kona_player_info"]], { "x-fantasy-filter": JSON.stringify({ players: { filterIds: { value: ids } } }) });
      for (const p of d.players ?? []) players.set(p.id, p.player);
    }
    const describe = (id: number) => {
      const p = players.get(id);
      return p ? `${p.fullName} (${POSITION[p.defaultPositionId] ?? "?"}, ${proTeam(p.proTeamId)})` : `player ${id}`;
    };
    const team = (id: number) => teamNames.get(id) ?? `team ${id}`;

    return {
      weeks: [first, wk],
      transactions: txs.map((t: any) => ({
        week: t.scoringPeriodId,
        date: new Date(t.processDate ?? t.proposedDate).toISOString(),
        type: t.type === "FREEAGENT" ? "FREE_AGENT" : t.type === "WAIVER" ? "WAIVER" : "TRADE",
        team: t.type.startsWith("TRADE") ? undefined : team(t.teamId),
        moves: t.items.map((i: any) =>
          i.type === "ADD"
            ? { added: describe(i.playerId) }
            : i.type === "DROP"
              ? { dropped: describe(i.playerId) }
              : { traded: describe(i.playerId), from: team(i.fromTeamId), to: team(i.toTeamId) },
        ),
      })),
    };
  }
}
