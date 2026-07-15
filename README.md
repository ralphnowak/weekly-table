# The Weekly Table

AI-powered weekly dinner planner. React + Vite, Anthropic API behind a
server-side proxy, plans persist in localStorage.

## Run locally

1. Install Node.js 18+ if you don't have it (you do — Goose runs on it).
2. Get an Anthropic API key at https://console.anthropic.com
   (Settings -> API keys). Note: the API is pay-per-use and billed
   separately from a Claude Pro subscription.
3. In this folder:

   ```
   copy .env.example .env      (Windows)
   # then edit .env and paste your real key

   npm install
   npm run dev
   ```

4. Open http://localhost:5173

The Vite dev server proxies `/api/claude` to the Anthropic API and
attaches your key server-side, so the key never appears in browser code.

## Deploy to Vercel (optional)

Same pattern as Vet2Civ:

1. Push this folder to a GitHub repo.
2. Import it in Vercel (framework preset: Vite).
3. In Vercel project settings -> Environment Variables, add
   `ANTHROPIC_API_KEY`.
4. Deploy. `api/claude.js` becomes the serverless proxy automatically.

A deployed URL is also the easiest way to share with your wife — no
Claude account needed, unlike shared artifacts. Each browser keeps its
own saved plan (localStorage is per-device).

## Costs

Each "Plan my week" run makes days+2 small API calls (menu, one per
recipe, shopping list) — a 5-dinner week is 7 calls of ~1000 tokens
each, so pennies per plan on current Sonnet pricing.
