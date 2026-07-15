import React, { useState, useEffect } from "react";

/* ------------------------------------------------------------------ */
/*  The Weekly Table — AI meal planner (standalone build)               */
/*  Staged calls: menu -> recipes -> consolidated list                  */
/*  Differences from the Claude-artifact version:                       */
/*    - API calls go to /api/claude (Vite dev proxy or Vercel fn        */
/*      attaches the key server-side)                                   */
/*    - Persistence uses localStorage instead of window.storage         */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "weekly-table-current-plan";

const DIETS = [
  "Balanced",
  "Mediterranean",
  "Keto",
  "Low-fat",
  "High-protein",
  "Vegetarian",
  "Heart-healthy",
];

const DIET_NOTES = {
  "Heart-healthy":
    "This plan targets lowering triglycerides: NO added sugar, sugary sauces, or refined carbs (white rice, white bread, regular pasta); include oily fish (salmon, sardines, mackerel, trout) at least twice in the week; emphasize high-fiber vegetables, legumes, and whole grains; use unsaturated fats (olive oil, nuts, avocado) over saturated; lean proteins otherwise.",
};

const PREP_OPTIONS = [20, 30, 45, 60];

const CATEGORIES = [
  "Chicken",
  "Beef",
  "Pork",
  "Seafood",
  "Soup",
  "Pasta",
  "One-pan",
  "Air fryer",
  "Slow cooker",
  "Instant Pot",
  "Grill",
];

/* ---------------- API helpers ---------------- */

async function callClaude(prompt) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (data.error) throw new Error(data.error.message || `HTTP ${response.status}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // tolerate stray text/fences around the JSON object
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retry with backoff — handles rate limits and flaky parses
async function callClaudeRetry(prompt, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await callClaude(prompt);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

const JSON_RULES =
  "Respond with ONLY a valid, complete JSON object. No markdown, no backticks, no commentary before or after.";

function menuPrompt(f) {
  const cats =
    f.categories.length > 0
      ? `- Build the week around these (spread them across the meals; every dinner should fit at least one): ${f.categories.join(", ")}`
      : "- Vary proteins and cooking methods across the week";
  return `You are a practical home-cooking meal planner. Plan ${f.days} easy, healthy weeknight DINNERS (names only, no recipes yet).

Rules:
- Diet style: ${f.diet}${DIET_NOTES[f.diet] ? `\n- ${DIET_NOTES[f.diet]}` : ""}
${cats}
- Max total prep + cook time per meal: ${f.prepTime} minutes
- Avoid these ingredients entirely: ${f.avoid.trim() ? f.avoid : "none"}
- Common grocery-store ingredients only, easy weeknight cooking
- No repeated meals or near-duplicates
- Assign days starting Monday

${JSON_RULES} Schema:
{"meals":[{"id":"m1","day":"Monday","name":"Recipe name","blurb":"One enticing sentence.","prepMinutes":30}]}`;
}

function recipePrompt(f, meal) {
  return `Write a concise weeknight recipe for "${meal.name}" (${f.diet} style, ${f.servings} servings, max ${f.prepTime} minutes total, avoid: ${f.avoid.trim() ? f.avoid : "none"}).${DIET_NOTES[f.diet] ? ` ${DIET_NOTES[f.diet]}` : ""}

Keep it tight: at most 10 ingredients (skip salt, pepper, olive oil) and at most 7 short steps.

${JSON_RULES} Schema:
{"ingredients":[{"item":"chicken thighs","amount":"1.5 lb"}],"steps":["Step text..."]}`;
}

function listPrompt(meals) {
  const lines = meals
    .map((m) => m.ingredients.map((i) => `${i.amount} ${i.item}`).join("; "))
    .join("\n");
  return `Consolidate these recipe ingredients into one grocery shopping list. Merge duplicates into single line items with combined quantities. Group by aisle, using only these aisle names where needed: Produce, Meat & Seafood, Dairy & Eggs, Pantry, Frozen, Bakery, Spices.

Be extremely terse: item names max 3 words, quantities max 3 words, no descriptions, compact JSON with no extra whitespace.

Ingredients by recipe:
${lines}

${JSON_RULES} Schema:
{"shoppingList":[{"aisle":"Produce","items":[{"item":"garlic","quantity":"1 head"}]}]}`;
}

// client-side safety net if the consolidation call fails:
// simple merge by item name, single group
function fallbackList(meals) {
  const map = new Map();
  meals.forEach((m) =>
    (m.ingredients || []).forEach((ing) => {
      const k = ing.item.toLowerCase().trim();
      if (map.has(k)) {
        map.get(k).quantity += ` + ${ing.amount}`;
      } else {
        map.set(k, { item: ing.item, quantity: ing.amount });
      }
    })
  );
  return [{ aisle: "Everything", items: [...map.values()] }];
}

function swapPrompt(f, plan, mealToSwap) {
  const others = plan.meals.filter((m) => m.id !== mealToSwap.id);
  return `Replace one dinner in a weekly plan. Replace "${mealToSwap.name}". Do NOT duplicate the proteins or cuisines of these kept meals: ${others.map((m) => m.name).join("; ")}.

Rules: ${f.diet} style${DIET_NOTES[f.diet] ? ` (${DIET_NOTES[f.diet]})` : ""}${f.categories.length ? `, should fit one of: ${f.categories.join(", ")}` : ""}, ${f.servings} servings, max ${f.prepTime} minutes total, avoid: ${f.avoid.trim() ? f.avoid : "none"}, easy weeknight cooking. At most 10 ingredients (skip salt, pepper, olive oil) and at most 7 short steps.

${JSON_RULES} Schema:
{"id":"${mealToSwap.id}","day":"${mealToSwap.day}","name":"...","blurb":"One sentence.","prepMinutes":30,"ingredients":[{"item":"...","amount":"..."}],"steps":["..."]}`;
}

/* ---------------- persistence helpers (localStorage) ---------------- */

async function saveState(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    /* storage unavailable — app still works, just won't persist */
  }
}

async function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    /* nothing saved yet, or storage unavailable */
  }
  return null;
}

/* ---------------- component ---------------- */

export default function WeeklyTable() {
  const [filters, setFilters] = useState({
    diet: "Mediterranean",
    days: 5,
    servings: 4,
    prepTime: 30,
    avoid: "",
    categories: [],
  });
  const [plan, setPlan] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [swappingId, setSwappingId] = useState(null);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [checked, setChecked] = useState({});
  const [copied, setCopied] = useState(false);
  const [confirmFresh, setConfirmFresh] = useState(false);

  // Restore a saved plan (and the filters + checkmarks that go with it) on load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadState();
      if (!cancelled && saved?.plan?.meals?.length) {
        setPlan(saved.plan);
        if (saved.filters) setFilters(saved.filters);
        if (saved.checked) setChecked(saved.checked);
      }
      if (!cancelled) setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-save whenever the plan or shopping checkmarks change
  // (covers generate, swap, and checking off items — debounced so
  // rapid taps in the store don't spam storage)
  useEffect(() => {
    if (restoring || !plan) return;
    const t = setTimeout(() => {
      saveState({ plan, filters, checked, savedAt: Date.now() });
    }, 600);
    return () => clearTimeout(t);
  }, [plan, checked, restoring]); // eslint-disable-line react-hooks/exhaustive-deps

  const generatePlan = async () => {
    setLoading(true);
    setError(null);
    setExpandedId(null);
    // NOTE: we deliberately do NOT clear the existing plan here.
    // If generation fails partway, the saved week comes right back.
    let stage = "planning the menu";
    try {
      // Stage 1: the menu
      setProgress("Planning the menu…");
      const menu = await callClaudeRetry(menuPrompt(filters));
      if (!menu.meals?.length) throw new Error("empty menu");

      // Stage 2: recipes, one at a time (parallel calls can hit rate limits)
      stage = "writing recipes";
      const recipes = [];
      for (let i = 0; i < menu.meals.length; i++) {
        setProgress(`Writing recipes… ${i + 1} of ${menu.meals.length}`);
        const m = menu.meals[i];
        const r = await callClaudeRetry(recipePrompt(filters, m));
        recipes.push({ ...m, ingredients: r.ingredients || [], steps: r.steps || [] });
      }

      // Stage 3: the market list (with safety net)
      stage = "building the market list";
      setProgress("Building the market list…");
      let shoppingList;
      try {
        const listResult = await callClaudeRetry(listPrompt(recipes));
        shoppingList = listResult.shoppingList;
        if (!shoppingList?.length) throw new Error("empty list");
      } catch (e) {
        shoppingList = fallbackList(recipes);
      }

      // Only now — with a complete new week in hand — replace the old one.
      setChecked({});
      setPlan({ meals: recipes, shoppingList });
    } catch (e) {
      setError(
        `That batch didn't come out right while ${stage} (${e.message}). Your last saved week is untouched — give it another try.`
      );
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  // "Plan a fresh week" over an existing plan asks for a second tap,
  // so a mis-tap can't wipe the week
  const handlePlanClick = () => {
    if (plan && !confirmFresh) {
      setConfirmFresh(true);
      setTimeout(() => setConfirmFresh(false), 4000);
      return;
    }
    setConfirmFresh(false);
    generatePlan();
  };

  const swapMeal = async (meal) => {
    setSwappingId(meal.id);
    setError(null);
    try {
      const newMeal = await callClaudeRetry(swapPrompt(filters, plan, meal));
      const meals = plan.meals.map((m) => (m.id === meal.id ? newMeal : m));
      let shoppingList;
      try {
        const listResult = await callClaudeRetry(listPrompt(meals));
        shoppingList = listResult.shoppingList;
        if (!shoppingList?.length) throw new Error("empty list");
      } catch (e2) {
        shoppingList = fallbackList(meals);
      }
      setPlan({ meals, shoppingList });
      setChecked({});
    } catch (e) {
      setError(`Couldn't swap that one (${e.message}). Try again in a moment.`);
    } finally {
      setSwappingId(null);
    }
  };

  const toggleChecked = (key) =>
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));

  const copyList = async () => {
    if (!plan) return;
    const text = plan.shoppingList
      .map(
        (g) =>
          `${g.aisle.toUpperCase()}\n` +
          g.items.map((it) => `  • ${it.item} — ${it.quantity}`).join("\n")
      )
      .join("\n\n");
    try {
      await navigator.clipboard.writeText("MARKET LIST\n\n" + text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      /* clipboard unavailable */
    }
  };

  const set = (key, val) => setFilters((f) => ({ ...f, [key]: val }));

  const planBtnLabel = loading
    ? "Planning…"
    : confirmFresh
    ? "Replace this week? Tap again"
    : plan
    ? "Plan a fresh week"
    : "Plan my week";

  return (
    <div className="wt-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Karla:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap');

        .wt-root {
          --paper: #F6F3EA;
          --ink: #26312A;
          --herb: #3E6B4D;
          --herb-deep: #2C5039;
          --paprika: #C8552F;
          --kraft: #EFE6D2;
          --kraft-edge: #DCCFB2;
          --hair: #D9D2C2;
          --muted: #6E7A6F;
          font-family: 'Karla', system-ui, sans-serif;
          background: var(--paper);
          color: var(--ink);
          min-height: 100vh;
          padding: 0 0 64px;
        }
        .wt-shell { max-width: 1100px; margin: 0 auto; padding: 0 20px; }

        .wt-header { padding: 36px 0 8px; display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
        .wt-title { font-family: 'Fraunces', serif; font-weight: 700; font-size: clamp(30px, 5vw, 44px); letter-spacing: -0.01em; margin: 0; }
        .wt-title em { font-style: italic; color: var(--herb); }
        .wt-tag { color: var(--muted); font-size: 14px; }

        .wt-board { background: #FFFFFF; border: 1px solid var(--hair); border-radius: 16px; padding: 22px; margin-top: 16px; box-shadow: 0 2px 10px rgba(38,49,42,0.05); }
        .wt-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
        .wt-chips { display: flex; flex-wrap: wrap; gap: 8px; }
        .wt-chip { border: 1px solid var(--hair); background: var(--paper); color: var(--ink); border-radius: 999px; padding: 8px 16px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all .15s ease; font-family: inherit; }
        .wt-chip:hover { border-color: var(--herb); }
        .wt-chip.on { background: var(--herb); border-color: var(--herb); color: #fff; }
        .wt-chip:focus-visible, .wt-btn:focus-visible, .wt-check:focus-visible, .wt-mini:focus-visible { outline: 2px solid var(--paprika); outline-offset: 2px; }

        .wt-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 18px; margin-top: 20px; }
        .wt-stepper { display: flex; align-items: center; gap: 0; border: 1px solid var(--hair); border-radius: 10px; overflow: hidden; background: var(--paper); width: fit-content; }
        .wt-stepper button { border: none; background: transparent; font-size: 18px; width: 38px; height: 38px; cursor: pointer; color: var(--herb-deep); font-family: inherit; }
        .wt-stepper button:hover { background: var(--kraft); }
        .wt-stepper span { min-width: 64px; text-align: center; font-weight: 700; font-size: 15px; }
        .wt-input { width: 100%; border: 1px solid var(--hair); border-radius: 10px; background: var(--paper); padding: 10px 12px; font-family: inherit; font-size: 14px; color: var(--ink); box-sizing: border-box; }
        .wt-input:focus { outline: 2px solid var(--herb); border-color: var(--herb); }

        .wt-btn { margin-top: 22px; width: 100%; border: none; border-radius: 12px; background: var(--herb); color: #fff; font-family: 'Fraunces', serif; font-weight: 600; font-size: 18px; padding: 14px 20px; cursor: pointer; transition: background .15s ease; }
        .wt-btn:hover:not(:disabled) { background: var(--herb-deep); }
        .wt-btn:disabled { opacity: .65; cursor: wait; }
        .wt-btn.confirm { background: var(--paprika); }
        .wt-saved { text-align: center; color: var(--muted); font-size: 12px; margin: 10px 0 0; }

        .wt-error { margin-top: 14px; background: #FBEDE7; border: 1px solid #E8C4B3; color: #8A3A1E; border-radius: 10px; padding: 12px 14px; font-size: 14px; }

        .wt-plan { display: grid; grid-template-columns: 1fr 340px; gap: 24px; margin-top: 28px; align-items: start; }
        @media (max-width: 860px) { .wt-plan { grid-template-columns: 1fr; } }

        .wt-meals { display: flex; flex-direction: column; gap: 14px; }
        .wt-card { background: #fff; border: 1px solid var(--hair); border-radius: 14px; overflow: hidden; transition: box-shadow .15s ease; }
        .wt-card.open { box-shadow: 0 6px 22px rgba(38,49,42,0.10); }
        .wt-card-head { display: flex; align-items: center; gap: 14px; padding: 16px 18px; cursor: pointer; }
        .wt-day { font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--paprika); min-width: 44px; }
        .wt-meal-name { font-family: 'Fraunces', serif; font-size: 19px; font-weight: 600; margin: 0; }
        .wt-blurb { color: var(--muted); font-size: 13.5px; margin: 3px 0 0; }
        .wt-time { font-family: 'Space Mono', monospace; font-size: 12px; color: var(--muted); white-space: nowrap; margin-left: auto; }
        .wt-mini { border: 1px solid var(--hair); background: var(--paper); border-radius: 8px; font-size: 12px; padding: 6px 10px; cursor: pointer; font-family: inherit; color: var(--herb-deep); white-space: nowrap; }
        .wt-mini:hover { border-color: var(--herb); }
        .wt-mini:disabled { opacity: .5; cursor: wait; }

        .wt-recipe { border-top: 1px dashed var(--hair); padding: 18px; display: grid; grid-template-columns: 220px 1fr; gap: 22px; }
        @media (max-width: 640px) { .wt-recipe { grid-template-columns: 1fr; } }
        .wt-recipe h4 { font-family: 'Space Mono', monospace; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
        .wt-ing { list-style: none; padding: 0; margin: 0; font-size: 14px; }
        .wt-ing li { padding: 4px 0; border-bottom: 1px solid #F0EBDD; display: flex; justify-content: space-between; gap: 10px; }
        .wt-ing .amt { color: var(--herb-deep); font-weight: 700; white-space: nowrap; }
        .wt-steps { margin: 0; padding-left: 20px; font-size: 14.5px; line-height: 1.55; }
        .wt-steps li { margin-bottom: 8px; }
        .wt-steps li::marker { color: var(--paprika); font-weight: 700; }

        .wt-receipt { background: var(--kraft); border: 1px solid var(--kraft-edge); border-radius: 4px 4px 0 0; padding: 22px 20px 30px; font-family: 'Space Mono', monospace; position: sticky; top: 16px; box-shadow: 0 6px 18px rgba(38,49,42,0.10); }
        .wt-receipt-title { text-align: center; font-weight: 700; letter-spacing: .25em; font-size: 14px; margin: 0 0 4px; }
        .wt-receipt-sub { text-align: center; font-size: 10.5px; color: var(--muted); margin: 0 0 14px; }
        .wt-rule { border: none; border-top: 1.5px dashed var(--ink); opacity: .35; margin: 12px 0; }
        .wt-aisle { font-size: 11px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; margin: 14px 0 6px; color: var(--herb-deep); }
        .wt-check { display: flex; width: 100%; text-align: left; background: none; border: none; font-family: inherit; font-size: 12.5px; color: var(--ink); padding: 4px 0; cursor: pointer; gap: 8px; align-items: baseline; }
        .wt-check .box { display: inline-block; min-width: 12px; }
        .wt-check.done { color: var(--muted); text-decoration: line-through; }
        .wt-check .qty { margin-left: auto; white-space: nowrap; color: var(--herb-deep); }
        .wt-check.done .qty { color: var(--muted); }
        .wt-copy { display: block; width: 100%; margin-top: 16px; border: 1.5px dashed var(--ink); background: transparent; font-family: 'Space Mono', monospace; font-size: 12px; font-weight: 700; letter-spacing: .08em; padding: 9px; cursor: pointer; border-radius: 4px; color: var(--ink); }
        .wt-copy:hover { background: rgba(62,107,77,0.08); }

        .wt-loading { margin-top: 60px; text-align: center; color: var(--muted); }
        .wt-pot { font-size: 40px; display: inline-block; animation: wt-bob 1.4s ease-in-out infinite; }
        @keyframes wt-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
        .wt-loading p { font-family: 'Fraunces', serif; font-style: italic; font-size: 18px; margin-top: 10px; }
        @media (prefers-reduced-motion: reduce) { .wt-pot { animation: none; } }
        .wt-empty { margin-top: 56px; text-align: center; color: var(--muted); font-size: 15px; }
        .wt-empty .big { font-family: 'Fraunces', serif; font-size: 22px; color: var(--ink); display: block; margin-bottom: 6px; }
      `}</style>

      <div className="wt-shell">
        <header className="wt-header">
          <h1 className="wt-title">
            The Weekly <em>Table</em>
          </h1>
          <span className="wt-tag">Easy, healthy dinners — planned in one tap</span>
        </header>

        <section className="wt-board" aria-label="Plan settings">
          <span className="wt-label">Style of cooking</span>
          <div className="wt-chips">
            {DIETS.map((d) => (
              <button
                key={d}
                className={`wt-chip ${filters.diet === d ? "on" : ""}`}
                onClick={() => set("diet", d)}
              >
                {d}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 20 }}>
            <span className="wt-label">What sounds good? (optional — pick any)</span>
            <div className="wt-chips">
              {CATEGORIES.map((c) => {
                const on = filters.categories.includes(c);
                return (
                  <button
                    key={c}
                    className={`wt-chip ${on ? "on" : ""}`}
                    onClick={() =>
                      set(
                        "categories",
                        on
                          ? filters.categories.filter((x) => x !== c)
                          : [...filters.categories, c]
                      )
                    }
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="wt-row">
            <div>
              <span className="wt-label">Dinners this week</span>
              <div className="wt-stepper">
                <button onClick={() => set("days", Math.max(2, filters.days - 1))} aria-label="Fewer dinners">−</button>
                <span>{filters.days}</span>
                <button onClick={() => set("days", Math.min(7, filters.days + 1))} aria-label="More dinners">+</button>
              </div>
            </div>
            <div>
              <span className="wt-label">Servings</span>
              <div className="wt-stepper">
                <button onClick={() => set("servings", Math.max(1, filters.servings - 1))} aria-label="Fewer servings">−</button>
                <span>{filters.servings}</span>
                <button onClick={() => set("servings", Math.min(8, filters.servings + 1))} aria-label="More servings">+</button>
              </div>
            </div>
            <div>
              <span className="wt-label">Time per meal</span>
              <div className="wt-chips">
                {PREP_OPTIONS.map((p) => (
                  <button
                    key={p}
                    className={`wt-chip ${filters.prepTime === p ? "on" : ""}`}
                    onClick={() => set("prepTime", p)}
                  >
                    {p} min
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <span className="wt-label">Skip these ingredients (optional)</span>
            <input
              className="wt-input"
              placeholder="e.g. mushrooms, shellfish, cilantro"
              value={filters.avoid}
              onChange={(e) => set("avoid", e.target.value)}
            />
          </div>

          <button
            className={`wt-btn ${confirmFresh ? "confirm" : ""}`}
            onClick={handlePlanClick}
            disabled={loading || restoring}
          >
            {planBtnLabel}
          </button>
          {plan && !loading && (
            <p className="wt-saved">
              Auto-saved — this week will be here when you come back.
            </p>
          )}

          {error && <div className="wt-error">{error}</div>}
        </section>

        {(loading || restoring) && (
          <div className="wt-loading">
            <span className="wt-pot" role="img" aria-label="cooking pot">🍲</span>
            <p>{restoring ? "Setting the table…" : progress}</p>
          </div>
        )}

        {!loading && !restoring && !plan && (
          <div className="wt-empty">
            <span className="big">Nothing on the menu yet.</span>
            Pick a style above and tap “Plan my week” — recipes and the market list arrive together.
          </div>
        )}

        {!loading && !restoring && plan && (
          <div className="wt-plan">
            <div className="wt-meals">
              {plan.meals.map((meal) => {
                const open = expandedId === meal.id;
                return (
                  <article key={meal.id} className={`wt-card ${open ? "open" : ""}`}>
                    <div
                      className="wt-card-head"
                      onClick={() => setExpandedId(open ? null : meal.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && setExpandedId(open ? null : meal.id)}
                    >
                      <span className="wt-day">{meal.day?.slice(0, 3)}</span>
                      <div>
                        <h3 className="wt-meal-name">{meal.name}</h3>
                        <p className="wt-blurb">{meal.blurb}</p>
                      </div>
                      <span className="wt-time">{meal.prepMinutes} min</span>
                      <button
                        className="wt-mini"
                        disabled={swappingId !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          swapMeal(meal);
                        }}
                      >
                        {swappingId === meal.id ? "Swapping…" : "↻ Swap"}
                      </button>
                    </div>
                    {open && (
                      <div className="wt-recipe">
                        <div>
                          <h4>Ingredients · serves {filters.servings}</h4>
                          <ul className="wt-ing">
                            {meal.ingredients.map((ing, i) => (
                              <li key={i}>
                                <span>{ing.item}</span>
                                <span className="amt">{ing.amount}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <h4>How to make it</h4>
                          <ol className="wt-steps">
                            {meal.steps.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            <aside className="wt-receipt" aria-label="Shopping list">
              <p className="wt-receipt-title">MARKET LIST</p>
              <p className="wt-receipt-sub">
                {plan.meals.length} dinners · {filters.diet.toLowerCase()} · serves {filters.servings}
              </p>
              <hr className="wt-rule" />
              {plan.shoppingList.map((group) => (
                <div key={group.aisle}>
                  <p className="wt-aisle">{group.aisle}</p>
                  {group.items.map((it, i) => {
                    const key = `${group.aisle}-${it.item}-${i}`;
                    const done = !!checked[key];
                    return (
                      <button
                        key={key}
                        className={`wt-check ${done ? "done" : ""}`}
                        onClick={() => toggleChecked(key)}
                      >
                        <span className="box">{done ? "▣" : "☐"}</span>
                        <span>{it.item}</span>
                        <span className="qty">{it.quantity}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
              <hr className="wt-rule" />
              <button className="wt-copy" onClick={copyList}>
                {copied ? "COPIED ✓" : "COPY LIST"}
              </button>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
