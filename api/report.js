function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function upstashGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");

  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Upstash GET failed: ${r.status}`);
  return data?.result ?? null;
}

module.exports = async (req, res) => {
  try {
    const { id, token } = req.query || {};
    if (!id || !token) return res.status(400).send("Missing id/token");

    const raw = await upstashGet(`report:${id}`);
    if (!raw) return res.status(404).send("Report not found or expired.");

    const report = JSON.parse(raw);
    if (!report?.token || report.token !== token) return res.status(403).send("Invalid token.");

    const company = esc(report?.customer?.empresa || "Empresa");
    const name = esc(report?.customer?.nombre || "Cliente");
    const created = esc(report?.createdAtLocal || "");
    const globalScore = esc(report?.globalScore ?? "");
    const ai = esc(report?.aiAnalysis || "");

    const areas = report?.scoresByArea || {};
    const areaRows = Object.entries(areas)
      .map(([k, v]) => `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">${esc(k)}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700">${esc(v)}/100</td></tr>`)
      .join("");

    const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Reporte | ${company}</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f8fafc;margin:0;color:#0f172a}
.wrap{max-width:900px;margin:24px auto;padding:0 16px}
.card{background:white;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.05);overflow:hidden}
.head{padding:18px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.h1{font-size:18px;font-weight:900;margin:0}
.muted{font-size:12px;color:#64748b;margin-top:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px}
.box{border:1px solid #e2e8f0;border-radius:14px;padding:12px;background:#fff}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:13px;line-height:1.5}
table{width:100%;border-collapse:collapse;font-size:13px}
.btn{display:inline-block;background:#1e293b;color:white;text-decoration:none;padding:10px 12px;border-radius:12px;font-weight:800;font-size:13px}
@media (max-width:720px){.grid{grid-template-columns:1fr}}
@media print{body{background:white}.wrap{margin:0;max-width:none}}
</style></head>
<body><div class="wrap">
  <div class="card">
    <div class="head">
      <div>
        <p class="h1">Reporte Ejecutivo — Pre-diagnóstico Organizacional</p>
        <div class="muted">${company} · ${name} · ${created}</div>
      </div>
      <a class="btn" href="javascript:window.print()">Imprimir / Guardar PDF</a>
    </div>

    <div class="grid">
      <div class="box">
        <div style="font-size:12px;color:#64748b;font-weight:800">Puntuación global</div>
        <div style="font-size:36px;font-weight:950;margin-top:6px">${globalScore}/100</div>
      </div>
      <div class="box">
        <div style="font-size:12px;color:#64748b;font-weight:800;margin-bottom:8px">Puntuación por área</div>
        <table>${areaRows}</table>
      </div>
    </div>

    <div style="padding:18px;border-top:1px solid #e2e8f0">
      <div style="font-size:12px;color:#64748b;font-weight:800;margin-bottom:8px">Análisis con IA</div>
      <div class="box"><pre>${ai}</pre></div>
    </div>
  </div>
</div></body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (e) {
    return res.status(500).send(`Server error: ${e?.message || String(e)}`);
  }
};
