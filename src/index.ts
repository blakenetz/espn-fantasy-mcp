// Minimal, stateless MCP server (Streamable HTTP, JSON responses) on Cloudflare Workers.
// Endpoint: POST /mcp/<CONNECTOR_SECRET>

import { EspnClient, type Env } from "./espn";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, any>;

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run: (espn: EspnClient, args: Args) => Promise<unknown>;
}

const week = { type: "integer", minimum: 1, maximum: 18, description: "NFL week (scoring period). Defaults to the current week." };

const TOOLS: Tool[] = [
  {
    name: "get_league",
    description:
      "League settings and standings: scoring (points per reception), lineup slots, waiver/FAAB rules, current week, and every team's record, seed, waiver rank and FAAB spent. Marks which team is mine.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (espn) => espn.getLeague(),
  },
  {
    name: "get_roster",
    description:
      "A team's roster for a week, split into starters and bench, with each player's slot, position, NFL team, injury status, ESPN projection, actual points and % owned/started. Defaults to my team.",
    inputSchema: {
      type: "object",
      properties: { team_id: { type: "integer", description: "Team id (from get_league). Defaults to my team." }, week },
      additionalProperties: false,
    },
    run: (espn, a) => espn.getRoster(a.team_id ?? espn.myTeamId, a.week),
  },
  {
    name: "get_matchup",
    description: "My head-to-head matchup for a week: both full rosters with projections, plus points scored so far.",
    inputSchema: { type: "object", properties: { week }, additionalProperties: false },
    run: (espn, a) => espn.getMatchup(a.week),
  },
  {
    name: "get_free_agents",
    description:
      "Best available players (free agents and players on waivers), sorted by % owned, with projections and injury status.",
    inputSchema: {
      type: "object",
      properties: {
        position: { type: "string", enum: ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "D/ST"], default: "ALL" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        week,
      },
      additionalProperties: false,
    },
    run: (espn, a) => espn.getFreeAgents(a.position ?? "ALL", a.limit ?? 25, a.week),
  },
];

const INSTRUCTIONS =
  "Read-only access to one ESPN fantasy football league. Start with get_league for scoring and rules, then get_roster / get_matchup for my team and get_free_agents for waiver targets. Projections are ESPN's; combine with outside research.";

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const ok = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: RpcMessage, env: Env) {
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "espn-fantasy", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const result = await tool.run(new EspnClient(env), msg.params?.arguments ?? {});
        return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok(msg.id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return new Response("espn-fantasy-mcp ok");
    if (!env.CONNECTOR_SECRET || pathname !== `/mcp/${env.CONNECTOR_SECRET}`) {
      return new Response("Not found", { status: 404 });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

    let body: RpcMessage | RpcMessage[];
    try {
      body = await req.json();
    } catch {
      return Response.json(fail(null, -32700, "Parse error"), { status: 400 });
    }
    const batch = Array.isArray(body);
    const messages = batch ? (body as RpcMessage[]) : [body as RpcMessage];
    const responses = [];
    for (const m of messages) {
      if (m.id === undefined || m.id === null) continue; // notifications get no response
      responses.push(await handle(m, env));
    }
    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(batch ? responses : responses[0]);
  },
};
