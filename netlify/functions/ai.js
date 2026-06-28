/* ════════════════════════════════════════════════════════════════════
   TERM TRACKER — AI proxy (Netlify Function)

   Runs server-side on Netlify. The NVIDIA API key lives ONLY in the
   environment (Netlify → Site settings → Environment variables), never in
   the browser. The front-end POSTs { action, payload } here.

   Required env var:
     NVIDIA_API_KEY   your NVIDIA build.nvidia.com key (nvapi-...)
   Optional env var:
     AI_MODEL         model id (default: meta/llama-3.1-70b-instruct)

   Actions: "estimate-mark" | "tips" | "flashcards"
   ════════════════════════════════════════════════════════════════════ */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
// Cheapest capable default — small, fast, low-cost. Override with AI_MODEL env var.
const DEFAULT_MODEL = 'meta/llama-3.1-8b-instruct';

const json = (statusCode, obj, extraHeaders) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(extraHeaders || {}) },
  body: JSON.stringify(obj),
});

/* ──────────────────────────────────────────────────────────────────
   Rate limiter — protects your NVIDIA key from runaway usage/cost.
   In-memory per warm instance (free, no external store). Tunable via env:
     RL_PER_MIN     max requests per IP per minute   (default 15)
     RL_GLOBAL_MIN  max requests per instance/minute (default 60)
   Note: limits are per function instance; for strict cross-instance
   limits add a shared store (e.g. Upstash) later. This stops the common
   abuse/runaway cases cheaply.
   ────────────────────────────────────────────────────────────────── */
const WINDOW_MS = 60000;
const PER_IP_MAX  = parseInt(process.env.RL_PER_MIN || '15', 10);
const GLOBAL_MAX  = parseInt(process.env.RL_GLOBAL_MIN || '60', 10);
const hits = new Map();        // ip -> [timestamps]
let globalHits = [];           // timestamps across all IPs

function rateLimit(ip) {
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < WINDOW_MS);
  if (globalHits.length >= GLOBAL_MAX) return { ok: false, retry: 60, scope: 'global' };
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= PER_IP_MAX) { hits.set(ip, arr); return { ok: false, retry: 60, scope: 'ip' }; }
  arr.push(now); hits.set(ip, arr); globalHits.push(now);
  // opportunistic cleanup so the Map can't grow unbounded
  if (hits.size > 5000) for (const [k, v] of hits) { if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k); }
  return { ok: true, remaining: PER_IP_MAX - arr.length };
}

function buildMessages(action, payload) {
  if (action === 'estimate-mark') {
    const text = (payload.text || '').slice(0, 12000);
    return [
      { role: 'system', content:
        'You are an experienced university exam marker. You receive raw text extracted from a student\'s marked or scanned script/answer. ' +
        'Estimate the overall percentage mark (0-100) as best you can from totals like "68/100", "72%", per-question marks that sum up, or grade indicators. ' +
        'If evidence is weak, lower your confidence. Reply with STRICT JSON only, no prose: ' +
        '{"mark": <number 0-100>, "confidence": "low"|"medium"|"high", "reasoning": "<one short sentence>"}.' },
      { role: 'user', content: 'Extracted script text:\n\n' + text },
    ];
  }
  if (action === 'tips') {
    const p = payload || {};
    return [
      { role: 'system', content:
        'You are a supportive academic coach for a university student. Given their modules, current marks, the topics they say they struggle with, and upcoming assessments, ' +
        'produce 3-5 specific, encouraging, actionable study tips. Reference their actual weak topics and marks. Keep each tip to 1-2 sentences. ' +
        'Reply with STRICT JSON only: {"tips": [{"title": "<short>", "body": "<1-2 sentences>"}]}.' },
      { role: 'user', content: 'Student context:\n' + JSON.stringify(p).slice(0, 6000) },
    ];
  }
  if (action === 'grade') {
    const p = payload || {};
    return [
      { role: 'system', content:
        `You are a strict but fair university exam marker${p.program ? ' for the ' + p.program + ' programme' : ''}. ` +
        'Grade the STUDENT ANSWER against the MEMO if given, otherwise against the QUESTION intent and standard marking conventions. ' +
        'Award marks per distinct criterion and be specific about what was missed. ' +
        'Reply with STRICT JSON only, no prose: ' +
        '{"totalEarned": <number>, "totalAvailable": <number>, "percentage": <number 0-100>, ' +
        '"grade": "Pass"|"Fail", "items": [{"criterion": <string>, "awarded": <number>, "available": <number>, "comment": <string>}], ' +
        '"summary": <string>, "fixes": [<string>, ...]}.' },
      { role: 'user', content:
        `Subject: ${(p.subject || '').slice(0,160)}\n\nQUESTION:\n${(p.question || '').slice(0,6000)}\n\n` +
        (p.memo ? `MEMO:\n${(p.memo).slice(0,6000)}\n\n` : '') +
        `STUDENT ANSWER:\n${(p.answer || '').slice(0,8000)}\n\nMark strictly and return the JSON.` },
    ];
  }
  if (action === 'flashcards') {
    const topic = (payload.topic || '').slice(0, 200);
    const module = (payload.module || '').slice(0, 120);
    const n = Math.min(8, Math.max(3, +payload.count || 5));
    return [
      { role: 'system', content:
        `You are a study-aid generator. Create ${n} active-recall flashcards for the given topic in the given module. ` +
        'Each card: a focused question on the front, a concise correct answer on the back. ' +
        'Reply with STRICT JSON only: {"cards": [{"front": "<question>", "back": "<answer>"}]}.' },
      { role: 'user', content: `Module: ${module}\nTopic: ${topic}` },
    ];
  }
  return null;
}

function extractJson(content) {
  if (!content) return null;
  // models sometimes wrap JSON in prose or ```json fences
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const key = process.env.NVIDIA_API_KEY;
  if (!key) return json(503, { error: 'AI is not configured', aiEnabled: false });

  // Throttle before spending any tokens
  const h = event.headers || {};
  const ip = (h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
  const rl = rateLimit(ip);
  if (!rl.ok) {
    return json(429, { error: 'Too many requests — please slow down and try again shortly.', scope: rl.scope },
      { 'Retry-After': String(rl.retry) });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
  const { action, payload } = body;
  const messages = buildMessages(action, payload || {});
  if (!messages) return json(400, { error: 'Unknown action: ' + action });

  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  try {
    const resp = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages,
        temperature: (action === 'estimate-mark' || action === 'grade') ? 0.1 : 0.5,
        top_p: 0.9,
        max_tokens: action === 'grade' ? 1400 : action === 'estimate-mark' ? 300 : 900,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return json(502, { error: 'AI upstream error', status: resp.status, detail: detail.slice(0, 500) });
    }
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = extractJson(content);
    if (!parsed) return json(200, { ok: true, raw: content, parsed: null });
    return json(200, { ok: true, ...parsed });
  } catch (e) {
    return json(500, { error: 'AI request failed', detail: String(e).slice(0, 300) });
  }
};
