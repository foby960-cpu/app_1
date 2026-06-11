'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 📁 server.js  — EcoWaste API v2.0.0
//    Entry point for Render deployment
// ─────────────────────────────────────────────────────────────────────────────

// ── Force IPv4 DNS BEFORE anything else ──────────────────────────────────────
// Fixes ESOCKET / ECONNREFUSED on Render (IPv6 not routed to Hostinger SMTP)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

// ── Force NODE_ENV = production when running on Render ───────────────────────
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}
console.log(`NODE_ENV = ${process.env.NODE_ENV}`);

const express    = require('express');
const cors       = require('cors');
const os         = require('os');
const morgan     = require('morgan');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const axios      = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (required for express-rate-limit on Render) ──────────────────
app.set('trust proxy', 1);

// ═════════════════════════════════════════════════════════════════════════════
// POSTGRESQL
// ═════════════════════════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log('✅ Connected to Neon PostgreSQL successfully'))
  .catch(err => console.error('❌ DB connect error:', err.message));

// ═════════════════════════════════════════════════════════════════════════════
// JWT SECRET
// ═════════════════════════════════════════════════════════════════════════════
const JWT_SECRET = process.env.JWT_SECRET || 'ecowaste_secret_2024';

// ═════════════════════════════════════════════════════════════════════════════
// IN-MEMORY OTP STORE  { key → { otp, expires } }
// key = normalized phone or lowercase email
// ═════════════════════════════════════════════════════════════════════════════
const _otpStore = new Map();

function _storeOtp(key, otp) {
  _otpStore.set(key.toLowerCase().trim(), {
    otp,
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
}

function _verifyOtp(key, otp) {
  const rec = _otpStore.get(key.toLowerCase().trim());
  if (!rec) return false;
  if (Date.now() > rec.expires) { _otpStore.delete(key); return false; }
  if (rec.otp !== String(otp).trim()) return false;
  _otpStore.delete(key); // one-time use
  return true;
}

function _generateOtp() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

// ═════════════════════════════════════════════════════════════════════════════
// NODEMAILER TRANSPORTER
// Uses Hostinger SMTP. IPv4 is forced above via dns.setDefaultResultOrder.
// ═════════════════════════════════════════════════════════════════════════════
function _createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.hostinger.com',
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,            // STARTTLS on port 587
    auth: {
      user: process.env.SMTP_USER || process.env.SMTP_FROM || 'support@simuvote.com',
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
      minVersion:         'TLSv1.2',
    },
    // Force IPv4 socket connection
    family:            4,
    connectionTimeout: 20000,
    greetingTimeout:   15000,
    socketTimeout:     30000,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SMS SERVICE  (MamboSMS / Mambo)
// Supports both env var naming conventions:
//   MAMBOSMS_TOKEN  or  MAMBO_TOKEN
//   MAMBOSMS_SENDER or  MAMBO_SENDER_ID
// ═════════════════════════════════════════════════════════════════════════════
function _normalizePhone(phone) {
  const cleaned = String(phone).replace(/[\s\-()+ ]/g, '');
  if (cleaned.startsWith('255') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('0')   && cleaned.length === 10) return '255' + cleaned.slice(1);
  if (cleaned.length === 9)                                return '255' + cleaned;
  return cleaned;
}

async function sendSMS(phone, message) {
  const to       = _normalizePhone(phone);
  const token    = process.env.MAMBO_TOKEN    || process.env.MAMBOSMS_TOKEN;
  const senderId = process.env.MAMBO_SENDER_ID || process.env.MAMBOSMS_SENDER || 'EcoWaste';
  const baseUrl  = process.env.MAMBO_BASE_URL  || 'https://api.mambosms.co.tz';

  if (!token) {
    console.warn('[SMS] ⚠️  MAMBO_TOKEN not set — skipping SMS');
    return { success: false, error: 'MAMBO_TOKEN not configured' };
  }

  console.log(`[SMS] Sending to ${to}: ${message.substring(0, 60)}…`);

  try {
    const resp = await axios.post(
      `${baseUrl}/messages/sms`,
      { to, from: senderId, message },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    console.log('[SMS] ✅ Response:', resp.status, JSON.stringify(resp.data));
    return { success: true, data: resp.data };
  } catch (err) {
    const msg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error('[SMS] ❌ Error:', msg);
    return { success: false, error: msg };
  }
}

async function sendOtpSMS(phone, otp, name) {
  const msg =
    `Dear ${name || 'Customer'}, your EcoWaste verification code is: ${otp}. ` +
    `Valid for 10 minutes. Do not share this code.`;
  return sendSMS(phone, msg);
}

async function sendWelcomeSMS(phone, name) {
  const msg =
    `Karibu EcoWaste, ${name}! Akaunti yako imefanikiwa kusajiliwa. ` +
    `Sasa unaweza kurekodi taka na kupata pointi za mazingira.`;
  return sendSMS(phone, msg);
}

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL SERVICE
// ═════════════════════════════════════════════════════════════════════════════
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'EcoWaste Support';
const SMTP_FROM_ADDR = process.env.SMTP_FROM      || process.env.SMTP_USER || 'support@simuvote.com';

async function sendEmail(toEmail, subject, textOrHtml, isHtml = false) {
  try {
    const transporter = _createTransporter();
    await transporter.verify();
    const info = await transporter.sendMail({
      from:    `"${SMTP_FROM_NAME}" <${SMTP_FROM_ADDR}>`,
      to:      toEmail,
      subject,
      [isHtml ? 'html' : 'text']: textOrHtml,
    });
    console.log('[EMAIL] ✅ Sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EMAIL] ❌ Error:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendOtpEmail(toEmail, toName, otp) {
  const subject = `EcoWaste — Nambari ya Uthibitisho (${otp})`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;
                padding:36px;background:#ffffff;border-radius:16px;
                box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <h2 style="color:#1B5E20;margin-top:0;">🌿 EcoWaste — Uthibitisho</h2>
      <p style="font-size:15px;">Habari <strong>${toName || 'Mtumiaji'}</strong>,</p>
      <p style="font-size:15px;">Nambari yako ya uthibitisho ni:</p>
      <div style="background:#E8F5E9;border:2px dashed #2E7D32;border-radius:14px;
                  padding:24px;text-align:center;margin:24px 0;">
        <span style="font-size:44px;font-weight:bold;letter-spacing:12px;
                     color:#1B5E20;font-family:'Courier New',monospace;">${otp}</span>
      </div>
      <p style="color:#555;font-size:14px;">
        ⏳ Inatumika kwa <strong>dakika 10</strong> tu.<br>
        <strong style="color:#c0392b;">🔒 Usishirikishe nambari hii na mtu yeyote.</strong>
      </p>
      <hr style="border:none;border-top:1px solid #e8e8e8;margin:24px 0;">
      <p style="color:#aaa;font-size:11px;text-align:center;">
        © ${new Date().getFullYear()} EcoWaste. Ujumbe huu umetumwa kiotomatiki.
      </p>
    </div>`;
  return sendEmail(toEmail, subject, html, true);
}

async function sendWelcomeEmail(toEmail, toName) {
  const subject = `Karibu EcoWaste, ${toName}! 🌿`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;
                padding:36px;background:#ffffff;border-radius:16px;">
      <h2 style="color:#1B5E20;">🌿 Karibu EcoWaste!</h2>
      <p>Habari <strong>${toName}</strong>,</p>
      <p>Akaunti yako imefanikiwa kusajiliwa. Sasa unaweza:</p>
      <ul style="color:#333;line-height:1.8;">
        <li>Kurekodi taka na kupata <strong>Eco Points</strong></li>
        <li>Kupata taksi ya taka karibu nawe</li>
        <li>Kuona historia ya matumizi yako</li>
        <li>Kushiriki kwenye leaderboard ya jamii</li>
      </ul>
      <p style="color:#aaa;font-size:11px;">© ${new Date().getFullYear()} EcoWaste</p>
    </div>`;
  return sendEmail(toEmail, subject, html, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// NOTIFICATION SERVICE (combined)
// ═════════════════════════════════════════════════════════════════════════════
async function sendNotification({ phone, email, name, type, otp }) {
  const results = {};
  if (type === 'otp') {
    if (phone) results.sms   = await sendOtpSMS(phone, otp, name);
    if (email) results.email = await sendOtpEmail(email, name, otp);
  } else if (type === 'welcome') {
    if (phone) results.sms   = await sendWelcomeSMS(phone, name);
    if (email) results.email = await sendWelcomeEmail(email, name);
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═════════════════════════════════════════════════════════════════════════════
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RATE LIMITERS
// ═════════════════════════════════════════════════════════════════════════════
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'AI rate limit reached. Wait 1 minute.' },
});

// ═════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE STACK
// ═════════════════════════════════════════════════════════════════════════════
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

app.use(globalLimiter);

// Dev body logger
if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const body = JSON.parse(JSON.stringify(req.body || {}));
      if (body.image_base64) body.image_base64 = '[base64 truncated]';
      if (body.photo)        body.photo        = '[binary truncated]';
      console.log(`  → body: ${JSON.stringify(body).substring(0, 300)}`);
    }
    next();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═════════════════════════════════════════════════════════════════════════════
app.get('/', (_req, res) => {
  res.json({
    success:     true,
    message:     '✅ EcoWaste API is running',
    version:     '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp:   new Date().toISOString(),
  });
});

app.get('/health',     (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }));

// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /api/auth/send-otp ───────────────────────────────────────────────────
app.post('/api/auth/send-otp', authLimiter, async (req, res) => {
  const { phone, email, name = 'User' } = req.body;

  if (!phone && !email) {
    return res.status(400).json({ success: false, message: 'Provide phone or email' });
  }

  const otp = _generateOtp();
  console.log(`[OTP] Generated ${otp} for ${phone || email}`);

  const results = {};

  // ── Send via SMS ──────────────────────────────────────────────────────────
  if (phone) {
    _storeOtp(phone, otp);
    results.sms = await sendOtpSMS(phone, otp, name);
  }

  // ── Send via Email ────────────────────────────────────────────────────────
  if (email) {
    _storeOtp(email, otp);
    results.email = await sendOtpEmail(email, name, otp);
  }

  const anyOk = results.sms?.success || results.email?.success;

  // Expose OTP in response only in non-production (debug/dev)
  const isDebug = process.env.NODE_ENV !== 'production';

  return res.status(anyOk ? 200 : 500).json({
    success:   anyOk,
    message:   anyOk ? 'OTP imetumwa' : 'Imeshindwa kutuma OTP',
    delivered: anyOk,
    otp:       isDebug ? otp : undefined,
    results,
  });
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
app.post('/api/auth/verify-otp', authLimiter, (req, res) => {
  const { phone, email, otp } = req.body;
  if (!otp)          return res.status(400).json({ success: false, message: 'OTP inahitajika' });
  const key = phone || email;
  if (!key)          return res.status(400).json({ success: false, message: 'Phone au email inahitajika' });

  const ok = _verifyOtp(key, otp);
  if (ok) {
    return res.json({ success: true, verified: true, message: 'OTP imethibitishwa' });
  }
  return res.status(400).json({
    success:  false,
    verified: false,
    message:  'OTP si sahihi au imeisha muda wake',
  });
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const {
    full_name, username, phone, email,
    password, role = 'user',
    driver_license, vehicle_type,
  } = req.body;

  if (!full_name || !username || !password) {
    return res.status(400).json({ success: false, message: 'Jina, username, na password zinahitajika' });
  }

  try {
    const dup = await pool.query(
      'SELECT id FROM users WHERE username=$1 OR phone=$2',
      [username, phone || null]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Username au namba ya simu tayari imetumika' });
    }

    const hash   = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users
         (full_name, username, phone, email, password_hash,
          role, driver_license, vehicle_type, eco_points, total_kg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0)
       RETURNING id, full_name, username, phone, email, role, eco_points`,
      [full_name, username, phone || null, email || null,
       hash, role, driver_license || null, vehicle_type || null]
    );

    const user  = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Fire-and-forget welcome notifications
    sendNotification({ phone, email, name: full_name, type: 'welcome' }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'Akaunti imefunguliwa kikamilifu!',
      token,
      user,
    });
  } catch (err) {
    console.error('[REGISTER]', err.message);
    return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, phone, username, driver_id, password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, message: 'Password inahitajika' });
  }

  try {
    const identifier = email || phone || username || driver_id;
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Weka email, simu, au username' });
    }

    const result = await pool.query(
      `SELECT * FROM users
       WHERE email=$1 OR phone=$1 OR username=$1 OR driver_license=$1
       LIMIT 1`,
      [identifier]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Akaunti haikupatikana' });
    }

    const user = result.rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Nenosiri si sahihi' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const { password_hash, ...safeUser } = user;
    return res.json({ success: true, message: 'Umeingia', token, user: safeUser });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/auth/profile ─────────────────────────────────────────────────────
app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, full_name, username, phone, email, role,
              eco_points, total_kg, driver_license, vehicle_type
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// WASTE ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /api/waste/log ───────────────────────────────────────────────────────
app.post('/api/waste/log', authMiddleware, async (req, res) => {
  const {
    waste_type, container_count = 1, weight_kg,
    photo_url, ai_confidence, ai_detected_type,
    latitude, longitude, notes,
  } = req.body;

  if (!waste_type) {
    return res.status(400).json({ success: false, message: 'waste_type inahitajika' });
  }

  try {
    const eco_points = Math.round((weight_kg || 1) * 10);
    const r = await pool.query(
      `INSERT INTO waste_logs
         (user_id, waste_type, container_count, weight_kg,
          photo_url, ai_confidence, ai_detected_type,
          latitude, longitude, notes, eco_points)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.user.id, waste_type, container_count, weight_kg || null,
       photo_url || null, ai_confidence || null, ai_detected_type || null,
       latitude || null, longitude || null, notes || null, eco_points]
    );
    await pool.query(
      `UPDATE users SET
         eco_points = eco_points + $1,
         total_kg   = total_kg   + $2
       WHERE id=$3`,
      [eco_points, weight_kg || 0, req.user.id]
    );
    return res.status(201).json({
      success:    true,
      message:    'Rekodi imehifadhiwa',
      log:        r.rows[0],
      eco_points,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/waste/my-logs ────────────────────────────────────────────────────
app.get('/api/waste/my-logs', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM waste_logs WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json({ success: true, logs: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/waste/log/:id ─────────────────────────────────────────────────
app.delete('/api/waste/log/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM waste_logs WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    return res.json({ success: true, message: 'Imefutwa' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/waste/verify-ai  (AI-rate-limited placeholder) ─────────────────
app.post('/api/waste/verify-ai', authMiddleware, aiLimiter, async (req, res) => {
  // Implement your AI image classification logic here
  return res.json({
    success:        true,
    detected_type:  req.body.waste_type || 'unknown',
    confidence:     0.95,
    message:        'AI verification placeholder — implement your model here',
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MAP ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/map/collection-points ────────────────────────────────────────────
app.get('/api/map/collection-points', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, latitude, longitude, address, is_active
       FROM collection_points
       WHERE is_active = true
       ORDER BY name`
    ).catch(() => ({ rows: [] }));
    return res.json({ success: true, points: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// VEHICLE / COLLECTOR ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/vehicles/nearby  (also aliased as /api/collectors/nearby) ────────
app.get(['/api/vehicles/nearby', '/api/collectors/nearby'], async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, full_name, username, phone, vehicle_type,
              driver_license, latitude, longitude, is_online, eco_points
       FROM users
       WHERE role='collector' AND is_online=true
       LIMIT 20`
    );
    return res.json({ success: true, collectors: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/collectors/location ──────────────────────────────────────────────
app.put('/api/collectors/location', authMiddleware, async (req, res) => {
  const { latitude, longitude, is_online } = req.body;
  try {
    await pool.query(
      'UPDATE users SET latitude=$1, longitude=$2, is_online=$3 WHERE id=$4',
      [latitude, longitude, is_online ?? true, req.user.id]
    );
    return res.json({ success: true, message: 'Location updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STATS ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/stats/me ─────────────────────────────────────────────────────────
app.get('/api/stats/me', authMiddleware, async (req, res) => {
  try {
    const u = await pool.query(
      'SELECT eco_points, total_kg FROM users WHERE id=$1',
      [req.user.id]
    );
    const logs = await pool.query(
      'SELECT waste_type, COUNT(*) as count FROM waste_logs WHERE user_id=$1 GROUP BY waste_type',
      [req.user.id]
    );
    return res.json({
      success:    true,
      eco_points: u.rows[0]?.eco_points || 0,
      total_kg:   u.rows[0]?.total_kg   || 0,
      by_type:    logs.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/stats/leaderboard ────────────────────────────────────────────────
app.get('/api/stats/leaderboard', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT full_name, username, eco_points, total_kg
       FROM users ORDER BY eco_points DESC LIMIT 20`
    );
    return res.json({ success: true, leaderboard: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BOOKING ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/bookings/centers ─────────────────────────────────────────────────
app.get('/api/bookings/centers', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM booking_centers WHERE is_active=true ORDER BY name'
    ).catch(() => ({ rows: [] }));
    return res.json({ success: true, centers: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/bookings/mine ────────────────────────────────────────────────────
app.get('/api/bookings/mine', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM bookings WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ success: true, bookings: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/bookings/:id ─────────────────────────────────────────────────────
app.get('/api/bookings/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM bookings WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Booking not found' });
    return res.json({ success: true, booking: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/bookings ────────────────────────────────────────────────────────
app.post('/api/bookings', authMiddleware, async (req, res) => {
  const { center_id, waste_type, scheduled_date, notes } = req.body;
  if (!center_id || !waste_type || !scheduled_date) {
    return res.status(400).json({ success: false, message: 'center_id, waste_type, scheduled_date zinahitajika' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO bookings (user_id, center_id, waste_type, scheduled_date, notes, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [req.user.id, center_id, waste_type, scheduled_date, notes || null]
    );
    return res.status(201).json({ success: true, booking: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/bookings/:id ──────────────────────────────────────────────────
app.delete('/api/bookings/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM bookings WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    return res.json({ success: true, message: 'Booking imefutwa' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/bookings/:id/complete ────────────────────────────────────────────
app.put('/api/bookings/:id/complete', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE bookings SET status='completed', completed_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Booking not found' });
    return res.json({ success: true, booking: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NOTIFICATION ROUTES (stored in DB)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ success: true, notifications: r.rows });
  } catch {
    return res.json({ success: true, notifications: [] });
  }
});

// ── POST /api/notifications/sms ───────────────────────────────────────────────
app.post('/api/notifications/sms', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, message: 'to and message required' });
  }
  const result = await sendSMS(to, message);
  return res.status(result.success ? 200 : 500).json(result);
});

// ── POST /api/notifications/email ─────────────────────────────────────────────
app.post('/api/notifications/email', async (req, res) => {
  const { to_email, to_name, subject, body } = req.body;
  if (!to_email || !subject || !body) {
    return res.status(400).json({ success: false, message: 'to_email, subject, body required' });
  }
  const result = await sendEmail(to_email, subject, body, body.startsWith('<'));
  return res.status(result.success ? 200 : 500).json(result);
});

// ── POST /api/notifications/welcome ───────────────────────────────────────────
app.post('/api/notifications/welcome', async (req, res) => {
  const { name, phone, email } = req.body;
  const results = await sendNotification({ phone, email, name, type: 'welcome' });
  return res.json({ success: true, results });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST / DEBUG ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /api/test-sms ────────────────────────────────────────────────────────
app.post('/api/test-sms', async (req, res) => {
  console.log('📱 Testing SMS endpoint...');
  try {
    const { phone, message, otp, name } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    let finalMessage = message;
    if (otp) {
      finalMessage = `Dear ${name || 'Customer'}, your EcoWaste verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`;
    }
    const result = await sendSMS(phone, finalMessage || 'Test message from EcoWaste API');
    console.log('SMS result:', result);
    return res.json({ success: result.success, result: result.data, error: result.error, sentTo: phone });
  } catch (error) {
    console.error('SMS test error:', error);
    return res.status(500).json({
      success: false,
      error:   error.message,
      stack:   process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

// ── POST /api/test-email ──────────────────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  console.log('📧 Testing Email endpoint...');
  try {
    const { email, subject, message, name } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email address is required' });
    }
    const finalSubject = subject || 'EcoWaste Test Email';
    const finalMessage = name
      ? `Hello ${name},\n\n${message || 'This is a test email from EcoWaste API. 🌿'}`
      : (message || 'This is a test email from EcoWaste API. 🌿');
    const result = await sendEmail(email, finalSubject, finalMessage);
    console.log('Email result:', result);
    return res.json({ success: result.success, messageId: result.messageId, error: result.error, sentTo: email });
  } catch (error) {
    console.error('Email test error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/test-sms-config ──────────────────────────────────────────────────
app.get('/api/test-sms-config', (_req, res) => {
  const mamboToken = process.env.MAMBO_TOKEN || process.env.MAMBOSMS_TOKEN;
  const smtpUser   = process.env.SMTP_USER   || process.env.SMTP_FROM;
  res.json({
    success: true,
    config: {
      mambo_base_url:      process.env.MAMBO_BASE_URL     || 'https://api.mambosms.co.tz (default)',
      mambo_sender_id:     process.env.MAMBO_SENDER_ID    || process.env.MAMBOSMS_SENDER || 'NOT SET',
      mambo_token_exists:  !!mamboToken,
      mambo_token_preview: mamboToken ? `${mamboToken.substring(0, 10)}...` : 'NOT SET',
      smtp_host:           process.env.SMTP_HOST           || 'smtp.hostinger.com (default)',
      smtp_user:           smtpUser                        || 'NOT SET',
      smtp_from:           process.env.SMTP_FROM           || 'NOT SET',
      smtp_from_name:      process.env.SMTP_FROM_NAME      || 'EcoWaste Support (default)',
      node_env:            process.env.NODE_ENV            || 'development',
    },
    warning:       !mamboToken ? '⚠️  MAMBO_TOKEN is NOT set in environment variables!' : '✅ MAMBO_TOKEN is set',
    email_warning: !smtpUser   ? '⚠️  SMTP credentials NOT set!'                        : '✅ SMTP credentials are set',
  });
});

// ── POST /api/test-notification ───────────────────────────────────────────────
app.post('/api/test-notification', async (req, res) => {
  console.log('🔔 Testing combined notification...');
  try {
    const { phone, email, name, type } = req.body;
    const result = await sendNotification({
      phone, email,
      name: name || 'Test User',
      type: type || 'welcome',
      otp:  type === 'otp' ? '123456' : null,
    });
    return res.json({ success: true, results: result });
  } catch (error) {
    console.error('Notification test error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 404 HANDLER
// ═════════════════════════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═════════════════════════════════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('─── Unhandled Error ───────────────────────────');
  console.error(`  ${req.method} ${req.path}`);
  console.error(`  ${err.message}`);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  console.error('───────────────────────────────────────────────');

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
  if (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request too large. Max 10MB.' });
  }
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═════════════════════════════════════════════════════════════════════════════
let server;

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  if (server) server.close(() => { console.log('Server closed'); process.exit(0); });
  else process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// ═════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═════════════════════════════════════════════════════════════════════════════
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server = app.listen(PORT, '0.0.0.0', () => {
  const ip   = getLocalIP();
  const line = '═'.repeat(54);
  console.log(`\n${line}`);
  console.log(`  🌿  EcoWaste API v2.0.0`);
  console.log(`  ENV : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  PORT: ${PORT}`);
  console.log(line);
  console.log(`  Local  : http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(line);
  console.log('  AUTH');
  console.log(`    POST   /api/auth/register`);
  console.log(`    POST   /api/auth/login`);
  console.log(`    GET    /api/auth/profile         [protected]`);
  console.log(`    POST   /api/auth/send-otp`);
  console.log(`    POST   /api/auth/verify-otp`);
  console.log('  WASTE');
  console.log(`    POST   /api/waste/log             [protected]`);
  console.log(`    GET    /api/waste/my-logs         [protected]`);
  console.log(`    DELETE /api/waste/log/:id         [protected]`);
  console.log(`    POST   /api/waste/verify-ai       [protected]`);
  console.log('  MAP');
  console.log(`    GET    /api/map/collection-points`);
  console.log('  VEHICLES / COLLECTORS');
  console.log(`    GET    /api/vehicles/nearby`);
  console.log(`    GET    /api/collectors/nearby`);
  console.log(`    PUT    /api/collectors/location   [protected]`);
  console.log('  STATS');
  console.log(`    GET    /api/stats/me              [protected]`);
  console.log(`    GET    /api/stats/leaderboard`);
  console.log('  BOOKINGS');
  console.log(`    GET    /api/bookings/centers`);
  console.log(`    GET    /api/bookings/mine         [protected]`);
  console.log(`    GET    /api/bookings/:id          [protected]`);
  console.log(`    POST   /api/bookings              [protected]`);
  console.log(`    DELETE /api/bookings/:id          [protected]`);
  console.log(`    PUT    /api/bookings/:id/complete [protected]`);
  console.log('  NOTIFICATIONS');
  console.log(`    GET    /api/notifications         [protected]`);
  console.log(`    POST   /api/notifications/sms`);
  console.log(`    POST   /api/notifications/email`);
  console.log(`    POST   /api/notifications/welcome`);
  console.log('  TEST / DEBUG');
  console.log(`    POST   /api/test-sms`);
  console.log(`    POST   /api/test-email`);
  console.log(`    GET    /api/test-sms-config`);
  console.log(`    POST   /api/test-notification`);
  console.log('  SYSTEM');
  console.log(`    GET    /`);
  console.log(`    GET    /health`);
  console.log(`    GET    /api/health`);
  console.log(`${line}`);
  console.log('');
  console.log(`  📱 SMS Service  : ${(process.env.MAMBO_TOKEN || process.env.MAMBOSMS_TOKEN) ? '✅ Configured' : '❌ MAMBO_TOKEN not set'}`);
  console.log(`  📧 Email Service: ${(process.env.SMTP_USER || process.env.SMTP_FROM) ? '✅ Configured' : '❌ SMTP_USER not set'}`);
  console.log(`  🗄️  Database    : ${process.env.DATABASE_URL ? '✅ DATABASE_URL set' : '❌ DATABASE_URL not set'}`);
  console.log(`  🔑 JWT Secret   : ${process.env.JWT_SECRET ? '✅ Custom secret' : '⚠️  Using default (set JWT_SECRET!)'}`);
  console.log(`${line}\n`);
});

module.exports = app;