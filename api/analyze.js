const crypto = require("crypto");

function nowLocal() {
  const dt = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

async function safeFetch(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (e) {
    throw new Error(`${label} fetch failed (${url}): ${e?.message || String(e)}`);
  }
}

// ===== Vercel KV via /pipeline (evita límites de URL) =====
async function kvPipeline(commands) {
  const url = process.env.KV2_KV_REST_API_URL;
  const token = process.env.KV2_KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing KV_REST_API_URL / KV_REST_API_TOKEN");

  const r = await safeFetch(
    `${url}/pipeline`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    },
    "KV"
  );

  const txt = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`KV error ${r.status}: ${txt.slice(0, 800)}`);

  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    data = null;
  }

  if (Array.isArray(data)) {
    const first = data[0];
    if (first?.error) throw new Error(`KV command error: ${first.error}`);
    return first?.result ?? null;
  }

  return data?.result ?? null;
}

async function kvSetEx(key, ttlSeconds, value) {
  await kvPipeline([["SETEX", key, String(ttlSeconds), value]]);
}

// ===== SendGrid =====
async function sendSendGridEmail({ to, subject, text, html }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.FROM_EMAIL;
  if (!apiKey) throw new Error("Missing SENDGRID_API_KEY");
  if (!from) throw new Error("Missing FROM_EMAIL");

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from },
    subject,
    content: [
      { type: "text/plain", value: text || "" },
      ...(html ? [{ type: "text/html", value: html }] : []),
    ],
  };

  const r = await safeFetch(
    "https://api.sendgrid.com/v3/mail/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    "SendGrid"
  );

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`SendGrid error ${r.status}: ${detail.slice(0, 800)}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const adminEmail = process.env.ADMIN_EMAIL;
    const baseUrl = process.env.PUBLIC_BASE_URL;

    if (!anthropicKey) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });
    if (!adminEmail) return res.status(500).json({ error: "Missing ADMIN_EMAIL" });
    if (!baseUrl) return res.status(500).json({ error: "Missing PUBLIC_BASE_URL" });

    const ttlDays = parseInt(process.env.REPORT_TTL_DAYS || "7", 10);
    const ttlSeconds = Math.max(1, ttlDays) * 24 * 60 * 60;

    const { prompt, customer, scoresByArea, globalScore } = req.body || {};
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 20) {
      return res.status(400).json({ error: "Missing or invalid prompt" });
    }

    // 1) Anthropic
    const a = await safeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1600,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      "Anthropic"
    );

    if (!a.ok) {
      const detail = await a.text().catch(() => "");
      return res.status(a.status).json({ error: "Anthropic error", detail: detail.slice(0, 1200) });
    }

    const aData = await a.json();
    const aiText =
      (aData?.content || [])
        .map((b) => (b?.type === "text" ? b.text : ""))
        .join("\n")
        .trim() || "";

    if (!aiText) return res.status(500).json({ error: "Empty AI response" });

    // 2) Report URL
    const id = crypto.randomBytes(12).toString("hex");
    const token = crypto.randomBytes(18).toString("hex");
    const cleanBase = String(baseUrl).replace(/\/$/, "");
    const reportUrl = `${cleanBase}/api/report?id=${id}&token=${token}`;

    // 3) Guardar en KV
    const report = {
      id,
      token,
      createdAt: new Date().toISOString(),
      createdAtLocal: nowLocal(),
      customer: customer || {},
      scoresByArea: scoresByArea || {},
      globalScore: typeof globalScore === "number" ? globalScore : null,
      aiAnalysis: aiText,
    };

    await kvSetEx(`report:${id}`, ttlSeconds, JSON.stringify(report));

    // 4) Emails
    const userEmail = (customer?.email || "").trim();
    const company = (customer?.empresa || "Empresa").trim();
    const person = (customer?.nombre || "Cliente").trim();

    if (userEmail) {
      await sendSendGridEmail({
        to: userEmail,
        subject: `Tu reporte de pre-diagnóstico — ${company}`,
        text: `Hola ${person}\n\nTu reporte está listo:\n${reportUrl}\n\nExpira en ${ttlDays} día(s).`,
        html: `<div style="font-family:Arial,sans-serif;color:#0f172a">
          <h2>Reporte de pre-diagnóstico</h2>
          <p>Hola <b>${person}</b>,</p>
          <p>Tu reporte está listo. Ábrelo aquí (link único):</p>
          <p><a href="${reportUrl}">${reportUrl}</a></p>
          <p style="color:#64748b;font-size:12px">Expira en ${ttlDays} día(s).</p>
        </div>`,
      });
    }

    await sendSendGridEmail({
      to: adminEmail,
      subject: `Copia interna — Reporte ${company} (${person})`,
      text:
        `Nuevo reporte generado.\n\nEmpresa: ${company}\nCliente: ${person}\nEmail: ${userEmail || "-"}\n\nLink:\n${reportUrl}\n\n--- AI ---\n\n` +
        aiText,
    });

    return res.status(200).json({
  ok: true,
  report_url: reportUrl,
  expires_days: ttlDays,

  // 👇 Compatibilidad con tu front (para que no diga "vacío")
  analysis: aiText,
  aiText: aiText,
  aiAnalysis: aiText,
});
    return res.status(500).json({ error: "Server error", detail: e?.message || String(e) });
  }
};


