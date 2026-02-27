const crypto = require("crypto");

function nowLocal() {
  const dt = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// ===== Vercel KV (REST) =====
async function kvSetEx(key, ttlSeconds, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing KV_REST_API_URL / KV_REST_API_TOKEN");

  // Upstash/Vercel KV REST supports: SETEX key ttl value
  const r = await fetch(`${url}/setex/${encodeURIComponent(key)}/${ttlSeconds}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `KV SETEX failed: ${r.status}`);
}

// ===== SendGrid Mail Send =====
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

  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`SendGrid error: ${r.status} ${detail}`);
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
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "Anthropic error", detail });
    }

    const data = await r.json();
    const aiText =
      (data?.content || [])
        .map((b) => (b?.type === "text" ? b.text : ""))
        .join("\n")
        .trim() || "";

    if (!aiText) return res.status(500).json({ error: "Empty AI response" });

    // 2) Guardar reporte con link único
    const id = crypto.randomBytes(12).toString("hex");
    const token = crypto.randomBytes(18).toString("hex");
    const cleanBase = String(baseUrl).replace(/\/$/, "");
    const reportUrl = `${cleanBase}/api/report?id=${id}&token=${token}`;

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

    // 3) Enviar correos
    const userEmail = (customer?.email || "").trim();
    const company = (customer?.empresa || "Empresa").trim();
    const person = (customer?.nombre || "Cliente").trim();

    if (userEmail) {
      const subject = `Tu reporte de pre-diagnóstico — ${company}`;
      const text = `Hola ${person},

Tu reporte está listo. Link único:
${reportUrl}

Expira en ${ttlDays} día(s).`;

      const html = `
        <div style="font-family:Arial,sans-serif;color:#0f172a">
          <h2>Reporte de pre-diagnóstico</h2>
          <p>Hola <b>${person}</b>,</p>
          <p>Tu reporte está listo. Ábrelo aquí (link único):</p>
          <p><a href="${reportUrl}">${reportUrl}</a></p>
          <p style="color:#64748b;font-size:12px">Expira en ${ttlDays} día(s).</p>
        </div>`;

      await sendSendGridEmail({ to: userEmail, subject, text, html });
    }

    // Copia interna (a ti)
    {
      const subject = `Copia interna — Reporte ${company} (${person})`;
      const text =
        `Nuevo reporte generado.\n\nEmpresa: ${company}\nCliente: ${person}\nEmail: ${userEmail || "-"}\n\nLink:\n${reportUrl}\n\n--- AI ---\n\n` +
        aiText;

      await sendSendGridEmail({ to: adminEmail, subject, text });
    }

    return res.status(200).json({
      ok: true,
      report_url: reportUrl,
      expires_days: ttlDays,
      message: "Report generated and emailed.",
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: e?.message || String(e) });
  }
};
