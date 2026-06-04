require('dotenv').config();
const express     = require('express');
const fetch       = require('node-fetch');
const path        = require('path');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { exec }    = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security Headers ──────────────────────────────────────────────────
// CSP is disabled because the app uses inline onclick handlers and inline
// scripts throughout the HTML. Helmet still adds all other security headers:
// X-Frame-Options, X-Content-Type-Options, Referrer-Policy, etc.
app.use(helmet({
  contentSecurityPolicy: false,  // would break inline onclick handlers in HTML
  crossOriginEmbedderPolicy: false,
}));

// ── Block ONLY the .env file — nothing else ───────────────────────────
// supabase.config.js is intentionally served (it's a public anon key)
app.use((req, res, next) => {
  const basename = path.basename(req.path);
  if (basename === '.env' || basename === '_env') {
    return res.status(403).send('Forbidden');
  }
  next();
});

// ── Static files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));
app.use(express.json({ limit: '10mb' }));

// ── Rate Limiters ─────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request limit reached. Please wait before trying again.' },
});

app.use('/api/', generalLimiter);

// ── Input validation helper ───────────────────────────────────────────
function requireApiKey(res) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('YOUR-KEY')) {
    res.status(500).json({ error: 'OPENROUTER_API_KEY is not configured on the server.' });
    return null;
  }
  return apiKey;
}

// ── Test route ────────────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  const apiKey = requireApiKey(res);
  if (!apiKey) return;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  process.env.SITE_URL || 'http://localhost:3000',
        'X-Title':       'PlateletWatch',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash:free',
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── YOLOv8 Image Analysis (local inference server on port 8000) ───────
// Requires inference_server.py to be running: python inference_server.py
const INFERENCE_URL = process.env.INFERENCE_URL || 'http://localhost:8000';

app.post('/api/analyze-image', aiLimiter, async (req, res) => {
  const { image, mediaType } = req.body;

  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid image data.' });
  }
  if (image.length > 8_000_000) {
    return res.status(413).json({ error: 'Image too large. Please use an image under 6 MB.' });
  }

  // Check inference server is reachable first
  try {
    const health = await fetch(`${INFERENCE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error('Inference server not healthy');
  } catch {
    return res.status(503).json({
      error: 'YOLOv8 inference server is not running. Start it with: python inference_server.py'
    });
  }

  try {
    const response = await fetch(`${INFERENCE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, confidence: 0.25 }),
      signal: AbortSignal.timeout(30000), // 30s timeout for large images
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.detail || 'Inference failed.' });
    }

    const data = await response.json();

    // data shape: { platelet_count, rbc_count, wbc_count, risk_level, detections }
    // Estimate /µL: platelets per field × 500 (standard calibration factor)
    const estPerUl = (data.platelet_count || 0) * 500;

    // Map risk_level from YOLOv8 server → severity labels used in the frontend
    const riskMap = { NORMAL: 'NORMAL', LOW: 'LOW', CRITICAL: 'CRITICAL', UNKNOWN: 'UNKNOWN' };
    const severity = riskMap[data.risk_level] || 'UNKNOWN';

    // WHO dengue severity override based on estimated /µL.
    // Only apply when at least one platelet was detected — a count of 0 means
    // the model found nothing (bad image / model confidence issue), which is
    // different from true thrombocytopenia, and should not auto-report CRITICAL.
    let finalSeverity = severity;
    if (data.platelet_count > 0) {
      if (estPerUl < 20000)       finalSeverity = 'CRITICAL';
      else if (estPerUl < 50000)  finalSeverity = 'DANGER';
      else if (estPerUl < 150000) finalSeverity = 'LOW';
      else                        finalSeverity = 'NORMAL';
    }

    res.json({
      platelets:   data.platelet_count  || 0,
      rbc:         data.rbc_count       || 0,
      wbc:         data.wbc_count       || 0,
      est_per_ul:  estPerUl,
      severity:    finalSeverity,
      detections:  data.detections      || [],
      note: data.platelet_count > 0
        ? `YOLOv8 detected ${data.platelet_count} platelet(s) in this field of view.`
        : `No platelets detected. Try a clearer 40×–100× image or adjust microscope focus.`,
    });

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: 'Image analysis failed. Please try again.' });
  }
});

// ── Main Chat Proxy ───────────────────────────────────────────────────
app.post('/api/chat', aiLimiter, async (req, res) => {
  const apiKey = requireApiKey(res);
  if (!apiKey) return;

  const { model, messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid messages array.' });
  }
  if (messages.length > 50) {
    return res.status(400).json({ error: 'Too many messages in conversation.' });
  }

  const allowedModels = [
    'deepseek/deepseek-v4-flash:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'meta-llama/llama-3.1-8b-instruct:free',
  ];
  const safeModel = allowedModels.includes(model) ? model : allowedModels[0];

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  process.env.SITE_URL || 'http://localhost:3000',
        'X-Title':       'PlateletWatch',
      },
      body: JSON.stringify({ ...req.body, model: safeModel }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat request failed. Please try again.' });
  }
});

// ── 404 fallback ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  // Find local LAN IP for phone access
  let lanIp = 'localhost';
  try {
    const nets = os.networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) { lanIp = iface.address; break; }
      }
      if (lanIp !== 'localhost') break;
    }
  } catch (_) {}

  console.log(`\n✅  PlateletWatch is running!\n`);
  console.log(`   💻  Laptop  →  http://localhost:${PORT}/all-tab.html`);
  console.log(`   📱  Phone   →  http://${lanIp}:${PORT}/all-tab.html`);
  console.log(`   🔬  AI API  →  http://localhost:${PORT}/api/test\n`);

  // Auto-open browser (cross-platform)
  const url = `http://localhost:${PORT}/all-tab.html`;
  const opener =
    process.platform === 'win32'  ? `start ""  "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  exec(opener, err => {
    if (err) console.log(`   ℹ️   Could not auto-open browser. Open manually: ${url}`);
  });
});