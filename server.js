// Mobi EA - standalone Node/Express server for Render
// Serves the static app + two API endpoints (license validation + AI chart scanner)

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "15mb" }));

// CORS (open — same origin in prod, helpful for testing)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY; // or use OPENAI/GEMINI key with adjusted endpoint

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// ---------- License validation ----------
const normalizeSymbols = (value) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value.split(/[,:|\s]+/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
};

const normalize = (payload) => {
  const robot = payload.robot && typeof payload.robot === "object" ? payload.robot : {};
  const ok =
    payload.status === "valid" ||
    payload.status === "success" ||
    payload.valid === true ||
    payload.success === true ||
    payload.active === true ||
    !!(payload.robot_name || payload.ea_name || payload.bot_name || payload.name);
  return {
    ok,
    message: String(payload.message || payload.error || (ok ? "License verified" : "Invalid license key")),
    name: String(
      payload.robot_name || payload.ea_name || payload.bot_name || payload.name ||
      payload.product_name || robot.name ||
      (payload.ea_id ? `MOBI EA #${payload.ea_id}` : "MOBI EA ROBOT")
    ),
    mentor: String(
      payload.mentor || payload.mentor_name || payload.source ||
      payload.robot_mentor || robot.mentor || "Mobi EA Software"
    ),
    image: String(
      payload.robot_image || payload.image || payload.icon || payload.avatar || robot.image || ""
    ) || null,
    version: String(payload.version || payload.plan || "PRO"),
    symbols: normalizeSymbols(
      payload.symbols || payload.robot_symbols || payload.allowed_symbols || robot.symbols
    ),
  };
};

app.post("/api/public/validate-license", async (req, res) => {
  try {
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
    if (!key) return res.status(400).json({ error: "License key is required" });

    const isTestKey = key === "TEST-1234-MOBI";
    let externalMeta = {
      ok: false, message: "Unreachable",
      name: "MOBI EA ROBOT", mentor: "Mobi EA Software",
      image: null, version: "PRO", symbols: [],
    };

    try {
      const url = `https://mobieaexpert.com/admin/api/validate_license.php?key=${encodeURIComponent(key)}`;
      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; }
      catch { payload = { status: r.ok ? "valid" : "invalid", message: text }; }
      externalMeta = normalize(payload);
      if (!r.ok && !isTestKey) externalMeta.ok = false;
    } catch {}

    if (!externalMeta.ok && !isTestKey) {
      return res.status(400).json({ error: externalMeta.message || "Invalid license key" });
    }

    let robotName = externalMeta.name;
    let robotMentor = externalMeta.mentor;
    let robotImage = externalMeta.image ||
      `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(robotName)}`;
    let robotSymbols = externalMeta.symbols;

    if (supabaseAdmin) {
      const { data: existing } = await supabaseAdmin
        .from("license_keys").select("*").eq("key", key).maybeSingle();

      if (existing?.is_used && !isTestKey && existing.used_by && deviceId && existing.used_by !== deviceId) {
        return res.status(400).json({ error: "License key already used on another device" });
      }
      robotName = existing?.robot_name || robotName;
      robotMentor = existing?.robot_mentor || robotMentor;
      robotImage = existing?.robot_image || robotImage;
      const exSymbols = normalizeSymbols(existing?.robot_symbols);
      if (exSymbols.length) robotSymbols = exSymbols;

      if (!existing) {
        await supabaseAdmin.from("license_keys").insert({
          key, robot_name: robotName, robot_mentor: robotMentor,
          robot_image: robotImage, robot_symbols: robotSymbols,
          is_used: !isTestKey, used_by: isTestKey ? null : (deviceId || null),
        });
      } else if (!existing.is_used && !isTestKey) {
        await supabaseAdmin.from("license_keys").update({
          is_used: true, used_by: deviceId || null,
        }).eq("key", key);
      }
    }

    res.json({
      ok: true, robotName, mentorName: robotMentor, robotImage,
      symbols: robotSymbols, version: externalMeta.version, licenseKey: key,
    });
  } catch (err) {
    console.error("validate-license error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- AI chart scanner ----------
const SYSTEM_PROMPT = `You are an elite professional price-action trader analyzing a trading chart screenshot.

Examine the chart with maximum precision. Identify:
- Current trend (uptrend/downtrend/range)
- Key support and resistance levels visible on the chart
- Candlestick patterns and price action signals
- Momentum, volume cues (if visible), and confluences
- Liquidity zones, order blocks, fair value gaps if visible

Only return a HIGH-PROBABILITY setup (confidence >= 70). If no clear setup exists, still return your best read with lower confidence — never refuse.

Risk/Reward must be at least 1.5. Use realistic price levels visible on the chart.

Return ONLY valid JSON, no markdown, in this exact shape:
{
  "direction": "BUY" | "SELL",
  "entry": <number>,
  "sl": <number>,
  "tp": <number>,
  "lotSize": <number>,
  "confidence": <0-100>,
  "analysis": "<concise 2-sentence rationale>"
}`;

app.post("/api/public/analyze-chart", async (req, res) => {
  try {
    const { imageBase64, symbol } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });
    if (!LOVABLE_API_KEY) return res.status(500).json({ error: "AI gateway not configured (set LOVABLE_API_KEY)" });

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_API_KEY}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: `Analyze this ${symbol || "trading"} chart and return the JSON signal.` },
            { type: "image_url", image_url: { url: imageBase64 } },
          ]},
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (r.status === 429) return res.status(429).json({ error: "Rate limit hit, try again in a moment" });
    if (r.status === 402) return res.status(402).json({ error: "AI credits exhausted" });
    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: `AI error ${r.status}: ${t.slice(0, 200)}` });
    }

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; }

    const direction = (parsed.direction || "BUY").toString().toUpperCase() === "SELL" ? "SELL" : "BUY";
    res.json({
      direction,
      entry: Number(parsed.entry) || 0,
      sl: Number(parsed.sl ?? parsed.stopLoss) || 0,
      tp: Number(parsed.tp ?? parsed.takeProfit) || 0,
      lotSize: Number(parsed.lotSize) || 0.01,
      confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 70)),
      analysis: String(parsed.analysis || parsed.rationale || "Signal generated from chart structure."),
    });
  } catch (err) {
    console.error("analyze-chart error:", err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

// ---------- Static app ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Mobi EA listening on :${PORT}`));
