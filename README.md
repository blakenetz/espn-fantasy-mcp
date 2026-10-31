# espn-fantasy-mcp

Read-only MCP connector for one private ESPN fantasy football league, running on Cloudflare Workers (free tier). No dependencies at runtime: a stateless Streamable-HTTP MCP endpoint plus a thin client for ESPN's league API.

**Tools:** `get_league` (scoring, lineup slots, waivers, playoff format, standings) · `get_roster` · `get_matchup` (live points, win probability) · `get_free_agents` · `get_pro_schedule` (NFL games and byes) · `get_recent_transactions` (adds, drops, waivers, trades). Player summaries include the NFL opponent for the week and the bye week.

Team `3` and season `2026` are set in `wrangler.toml`; the league id is a Worker secret.

## Setup (~10 min)

1. **Get your ESPN cookies.** In Helium, signed in at fantasy.espn.com: DevTools → Application → Cookies → `https://fantasy.espn.com` (or `.espn.com`). Copy the values of `espn_s2` and `SWID` (SWID includes the `{}` braces).

2. **Install and deploy:**
   ```sh
   npm install
   npx wrangler login
   npx wrangler secret put LEAGUE_ID   # leagueId= value from your league URL
   npx wrangler secret put ESPN_S2
   npx wrangler secret put ESPN_SWID
   openssl rand -hex 24          # copy this output…
   npx wrangler secret put CONNECTOR_SECRET   # …and paste it here
   npm run deploy
   ```

3. **Check it works against the real league:**
   ```sh
   curl -s https://espn-fantasy-mcp.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET> \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_league","arguments":{}}}'
   ```

4. **Add to Claude** as a custom connector with the URL
   `https://espn-fantasy-mcp.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET>` (no auth).

## Notes

- **Security:** the secret path is the only gate, so treat the URL like a password. The server is read-only and can't change your lineup or make claims.
- **Cookie expiry:** when `espn_s2` expires, tools return an error that says so. Copy fresh cookies and re-run `wrangler secret put ESPN_S2` (and `ESPN_SWID`).
- **Next season:** bump `SEASON` in `wrangler.toml` and redeploy.
- **Local dev:** put the four secrets in `.dev.vars` (gitignored) as `NAME="value"` lines; `npm run dev` then serves the connector on `localhost:8787` against the real league.
- `npm test` runs an offline smoke test against recorded, scrubbed ESPN responses in `test/fixtures/` (week 8 of 2026); `npm run typecheck` runs tsc.
