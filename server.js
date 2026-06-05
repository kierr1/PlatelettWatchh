require('dotenv').config();
const express     = require('express');
const fetch       = require('node-fetch');
const path        = require('path');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { exec }    = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Render's proxy — required for express-rate-limit to work correctly
app.set('trust proxy', 1);

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
  const { image, mediaType, zoom, confidence } = req.body;

  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid image data.' });
  }
  if (image.length > 8_000_000) {
    return res.status(413).json({ error: 'Image too large. Please use an image under 6 MB.' });
  }

  // Check inference server is reachable — retry up to 3x to handle HF Space cold starts
  let hfReady = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const health = await fetch(`${INFERENCE_URL}/health`, { signal: AbortSignal.timeout(15000) });
      if (health.ok) { hfReady = true; break; }
    } catch {
      console.log(`Health check attempt ${attempt}/3 failed. Retrying...`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000)); // wait 5s before retry
    }
  }
  if (!hfReady) {
    return res.status(503).json({
      error: 'Inference server is waking up. Please wait 20–30 seconds and try again.'
    });
  }

  try {
    const response = await fetch(`${INFERENCE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, confidence: confidence || 0.15, zoom: zoom || '100x' }),
      signal: AbortSignal.timeout(60000), // 60s timeout — HF free tier needs time to wake
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.detail || 'Inference failed.' });
    }

    const data = await response.json();

    // Inference server returns: { platelets, rbc, wbc, est_per_ul, severity, detections, ... }
    // Pass through directly — the inference server already calculates est_per_ul and severity
    const platelets = data.platelets  || 0;
    const rbc       = data.rbc        || 0;
    const wbc       = data.wbc        || 0;
    const estPerUl  = data.est_per_ul || 0;
    const severity  = data.severity   || 'UNKNOWN';

    res.json({
      platelets,
      rbc,
      wbc,
      est_per_ul:     estPerUl,
      severity,
      severity_label: data.severity_label || '',
      severity_color: data.severity_color || '',
      clinical_note:  data.clinical_note  || '',
      zoom:           data.zoom           || zoom || '100x',
      zoom_note:      data.zoom_note      || '',
      calib_factor:   data.calib_factor   || 100000,
      detections:     data.detections     || [],
      note: data.note || (platelets > 0
        ? `YOLOv8 detected ${platelets} platelet(s) in this field of view.`
        : `No platelets detected. Try a clearer 40×–100× image or adjust microscope focus.`),
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
