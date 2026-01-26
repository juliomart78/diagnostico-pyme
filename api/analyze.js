export default async function handler(req, res) {
  // Solo POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // API Key desde Variables de Entorno (Vercel)
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Missing ANTHROPIC_API_KEY env var",
        hint: "Configura ANTHROPIC_API_KEY en Vercel > Project > Settings > Environment Variables",
      });
    }

    // Espera: { prompt: "..." }
    const body = req.body || {};
    const prompt = body.prompt;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 20) {
      return res.status(400).json({
        error: "Missing or invalid prompt",
        hint: "Envía JSON con { prompt: string }",
      });
    }

    const payload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1600,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status).json({
        error: "Anthropic error",
        detail,
      });
    }

    const data = await r.json();

    const text =
      (data?.content || [])
        .map((b) => (b?.type === "text" ? b.text : ""))
        .join("\n")
        .trim() || "";

    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: e?.message || String(e),
    });
  }
}
