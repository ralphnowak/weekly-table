// Vercel serverless function: proxies the browser's /api/claude calls
// to the Anthropic API, adding the key from the ANTHROPIC_API_KEY
// environment variable (set it in Vercel project settings).
// Same pattern as the Vet2Civ proxy.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "POST only" } });
  }
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: { message: e.message } });
  }
}
