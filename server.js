'use strict';

// -----------------------------------------------------------------------------
// AcoWaste API v2.1.0
//    Entry point for Render deployment
//    Rewritten to match the live schema: users / scans / pickup_requests
//    (previously this file targeted username/full_name/waste_logs/bookings —
//     those columns and tables no longer exist and have been removed below)
// -----------------------------------------------------------------------------

// -- Force IPv4 DNS BEFORE anything else --------------------------------------
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}
console.log(`NODE_ENV = ${process.env.NODE_ENV}`);

const express = require('express');
const cors = require('cors');
const os = require('os');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// POSTGRESQL
// -----------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log('Connected to Neon PostgreSQL successfully'))
  .catch(err => console.error('DB connect error:', err.message));

// -----------------------------------------------------------------------------
// JWT SECRET
// -----------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || 'ecowaste_secret_2024';

// -----------------------------------------------------------------------------
// IN-MEMORY OTP STORE
// -----------------------------------------------------------------------------
const _otpStore = new Map();

function _storeOtp(key, otp) {
  _otpStore.set(key.toLowerCase().trim(), {
    otp,
    expires: Date.now() + 10 * 60 * 1000,
  });
}

function _verifyOtp(key, otp) {
  const rec = _otpStore.get(key.toLowerCase().trim());
  if (!rec) return false;
  if (Date.now() > rec.expires) { _otpStore.delete(key); return false; }
  if (rec.otp !== String(otp).trim()) return false;
  _otpStore.delete(key);
  return true;
}

function _generateOtp() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

// -----------------------------------------------------------------------------
// NODEMAILER TRANSPORTER
// -----------------------------------------------------------------------------
function _createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || process.env.SMTP_FROM || 'support@simuvote.com',
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
    family: 4,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

// -----------------------------------------------------------------------------
// SMS SERVICE  (MamboSMS / Mambo)
// -----------------------------------------------------------------------------
function _normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0') && (cleaned.startsWith('06') || cleaned.startsWith('07'))) {
    cleaned = '255' + cleaned.substring(1);
  }
  if ((cleaned.startsWith('6') || cleaned.startsWith('7')) && cleaned.length === 9) {
    cleaned = '255' + cleaned;
  }
  return cleaned;
}

async function sendSMS(phone, message) {
  const to = _normalizePhone(phone);
  const token = process.env.MAMBO_TOKEN || process.env.MAMBOSMS_TOKEN;
  const senderId = process.env.MAMBO_SENDER_ID || process.env.MAMBOSMS_SENDER || 'AcoWaste';
  const baseUrl = process.env.MAMBO_BASE_URL || 'https://mambosms.co.tz/api/v1/sms/single';
  const finalizedText = message || 'Kodi yako ya uhakiki ya AcoWaste ni 1234';

  if (!to || to.length !== 12 || !to.startsWith('255')) {
    console.error(`[SMS] Invalid Tanzania phone number format: ${phone}`);
    return { success: false, error: 'Invalid Tanzania phone number format' };
  }

  if (!token) {
    console.warn('[SMS] MAMBO_TOKEN not set - skipping SMS');
    return { success: false, error: 'MAMBO_TOKEN not configured' };
  }

  console.log(`[SMS] Sending to ${to}: ${finalizedText.substring(0, 60)}...`);

  try {
    const resp = await axios.post(
      baseUrl,
      { mobile: to, sender_id: senderId, text: finalizedText, message: finalizedText },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    console.log('[SMS] Response:', resp.status, JSON.stringify(resp.data));
    return { success: true, data: resp.data };
  } catch (err) {
    const msg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error('[SMS] Error:', msg);
    return { success: false, error: msg };
  }
}

async function sendOtpSMS(phone, otp, name) {
  const msg =
    `Dear ${name || 'Customer'}, your AcoWaste verification code is: ${otp}. ` +
    `Valid for 10 minutes. Do not share this code.`;
  return sendSMS(phone, msg);
}

async function sendWelcomeSMS(phone, name) {
  const msg =
    `Karibu AcoWaste, ${name}! Akaunti yako imefanikiwa kusajiliwa. ` +
    `Sasa unaweza kurekodi taka na kuomba kuokotwa.`;
  return sendSMS(phone, msg);
}

// -----------------------------------------------------------------------------
// EMAIL SERVICE
// -----------------------------------------------------------------------------
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'AcoWaste Support';
const SMTP_FROM_ADDR = process.env.SMTP_FROM || process.env.SMTP_USER || 'support@simuvote.com';

async function sendEmail(toEmail, subject, textOrHtml, isHtml = false) {
  try {
    const transporter = _createTransporter();
    await transporter.verify();
    const info = await transporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_ADDR}>`,
      to: toEmail,
      subject,
      [isHtml ? 'html' : 'text']: textOrHtml,
    });
    console.log('[EMAIL] Sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EMAIL] Error:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendOtpEmail(toEmail, toName, otp) {
  const subject = `AcoWaste - Nambari ya Uthibitisho (${otp})`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;
                padding:36px;background:#ffffff;border-radius:16px;
                box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <h2 style="color:#1B5E20;margin-top:0;">AcoWaste - Uthibitisho</h2>
      <p style="font-size:15px;">Habari <strong>${toName || 'Mtumiaji'}</strong>,</p>
      <p style="font-size:15px;">Nambari yako ya uthibitisho ni:</p>
      <div style="background:#E8F5E9;border:2px dashed #2E7D32;border-radius:14px;
                  padding:24px;text-align:center;margin:24px 0;">
        <span style="font-size:44px;font-weight:bold;letter-spacing:12px;
                     color:#1B5E20;font-family:'Courier New',monospace;">${otp}</span>
      </div>
      <p style="color:#555;font-size:14px;">
        Inatumika kwa <strong>dakika 10</strong> tu.<br>
        <strong style="color:#c0392b;">Usishirikishe nambari hii na mtu yeyote.</strong>
      </p>
      <hr style="border:none;border-top:1px solid #e8e8e8;margin:24px 0;">
      <p style="color:#aaa;font-size:11px;text-align:center;">
        (c) ${new Date().getFullYear()} AcoWaste. Ujumbe huu umetumwa kiotomatiki.
      </p>
    </div>`;
  return sendEmail(toEmail, subject, html, true);
}

async function sendWelcomeEmail(toEmail, toName) {
  const subject = `Karibu AcoWaste, ${toName}!`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;
                padding:36px;background:#ffffff;border-radius:16px;">
      <h2 style="color:#1B5E20;">Karibu AcoWaste!</h2>
      <p>Habari <strong>${toName}</strong>,</p>
      <p>Akaunti yako imefanikiwa kusajiliwa. Sasa unaweza:</p>
      <ul style="color:#333;line-height:1.8;">
        <li>Kurekodi/kuchanganua taka (scan)</li>
        <li>Kuomba mkusanyaji wa taka karibu nawe</li>
        <li>Kuona historia ya maombi yako</li>
      </ul>
      <p style="color:#aaa;font-size:11px;">(c) ${new Date().getFullYear()} AcoWaste</p>
    </div>`;
  return sendEmail(toEmail, subject, html, true);
}

// -----------------------------------------------------------------------------
// NOTIFICATION SERVICE (combined)
// -----------------------------------------------------------------------------
async function sendNotification({ phone, email, name, type, otp }) {
  const results = {};
  if (type === 'otp') {
    if (phone) results.sms = await sendOtpSMS(phone, otp, name);
    if (email) results.email = await sendOtpEmail(email, name, otp);
  } else if (type === 'welcome') {
    if (phone) results.sms = await sendWelcomeSMS(phone, name);
    if (email) results.email = await sendWelcomeEmail(email, name);
  }
  return results;
}

// -----------------------------------------------------------------------------
// AUTH MIDDLEWARE
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// RATE LIMITERS
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// MIDDLEWARE STACK
// -----------------------------------------------------------------------------
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

if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const body = JSON.parse(JSON.stringify(req.body || {}));
      if (body.image_base64) body.image_base64 = '[base64 truncated]';
      if (body.photo) body.photo = '[binary truncated]';
      console.log(`  body: ${JSON.stringify(body).substring(0, 300)}`);
    }
    next();
  });
}

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'AcoWaste API is running',
    version: '2.1.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }));

// -----------------------------------------------------------------------------
// AUTH ROUTES
// users table: id, name, email, password_hash, role, phone, vehicle_reg,
//              status, latitude, longitude, location_detail, last_seen,
//              created_at, updated_at
// -----------------------------------------------------------------------------

app.post('/api/auth/send-otp', authLimiter, async (req, res) => {
  const { phone, email, name = 'User' } = req.body;

  if (!phone && !email) {
    return res.status(400).json({ success: false, message: 'Provide phone or email' });
  }

  const otp = _generateOtp();
  console.log(`[OTP] Generated ${otp} for ${phone || email}`);

  const results = {};

  if (phone) {
    _storeOtp(phone, otp);
    results.sms = await sendOtpSMS(phone, otp, name);
  }

  if (email) {
    _storeOtp(email, otp);
    results.email = await sendOtpEmail(email, name, otp);
  }

  const anyOk = results.sms?.success || results.email?.success;
  const isDebug = process.env.NODE_ENV !== 'production';

  return res.status(200).json({
    success: anyOk,
    message: anyOk ? 'OTP imetumwa' : 'Imeshindwa kutuma OTP',
    delivered: anyOk,
    otp: isDebug ? otp : undefined,
    results,
  });
});

app.post('/api/auth/verify-otp', authLimiter, (req, res) => {
  const { phone, email, otp } = req.body;
  if (!otp) return res.status(400).json({ success: false, message: 'OTP inahitajika' });
  const key = phone || email;
  if (!key) return res.status(400).json({ success: false, message: 'Phone au email inahitajika' });

  const ok = _verifyOtp(key, otp);
  if (ok) {
    return res.json({ success: true, verified: true, message: 'OTP imethibitishwa' });
  }
  return res.status(400).json({
    success: false,
    verified: false,
    message: 'OTP si sahihi au imeisha muda wake',
  });
});

// Matches register_screen.dart -> ApiService.register(name, email, password,
// role, phone, vehicleReg). JSON body uses snake_case: vehicle_reg.
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const {
    name, email, password,
    role = 'user',
    phone, vehicle_reg,
  } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'Jina, email, na password zinahitajika' });
  }

  const allowedRoles = ['user', 'collector', 'coordinator'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Role si sahihi' });
  }

  if (role === 'collector' && !vehicle_reg) {
    return res.status(400).json({ success: false, message: 'Namba ya gari inahitajika kwa collector' });
  }

  try {
    const dup = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Email tayari imetumika' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users
         (name, email, password_hash, role, phone, vehicle_reg, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, email, role, phone, vehicle_reg, status, created_at`,
      [name, email, hash, role, phone || null, vehicle_reg || null,
        role === 'collector' ? 'offline' : null]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    sendNotification({ phone, email, name, type: 'welcome' }).catch(() => { });

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

// Matches login_screen.dart -> ApiService.login(email, password) -> user['role']
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email na password zinahitajika' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Akaunti haikupatikana' });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Nenosiri si sahihi' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
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

app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, email, role, phone, vehicle_reg, status,
              latitude, longitude, location_detail, last_seen, created_at
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// SCAN ROUTES  (replaces the old /api/waste/* routes -> waste_logs table)
// scans table: id, user_id, label, description, material_input,
//              weight_min_kg, weight_max_kg, weight_category,
//              fee_min_tzs, fee_max_tzs, latitude, longitude, created_at
// -----------------------------------------------------------------------------

app.post('/api/scans', authMiddleware, async (req, res) => {
  const {
    label, description, material_input,
    weight_min_kg, weight_max_kg, weight_category,
    fee_min_tzs, fee_max_tzs,
    latitude, longitude,
  } = req.body;

  try {
    const r = await pool.query(
      `INSERT INTO scans
         (user_id, label, description, material_input,
          weight_min_kg, weight_max_kg, weight_category,
          fee_min_tzs, fee_max_tzs, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.user.id, label || null, description || null, material_input || null,
      weight_min_kg || null, weight_max_kg || null, weight_category || null,
      fee_min_tzs || null, fee_max_tzs || null, latitude || null, longitude || null]
    );
    return res.status(201).json({ success: true, message: 'Scan imehifadhiwa', scan: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/scans/mine', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM scans WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json({ success: true, scans: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/scans/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM scans WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    return res.json({ success: true, message: 'Imefutwa' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// AI detection placeholder — same behavior as before, kept under /api/scans
app.post('/api/scans/verify-ai', authMiddleware, aiLimiter, async (req, res) => {
  return res.json({
    success: true,
    detected_type: req.body.material_input || 'unknown',
    confidence: 0.95,
    message: 'AI verification placeholder - implement your model here',
  });
});

// -----------------------------------------------------------------------------
// COLLECTOR ROUTES
// Uses users.status / users.latitude / users.longitude (no is_online column)
// -----------------------------------------------------------------------------

// Accepts optional ?lat=..&lng=.. to compute distance_km (Haversine, via
// Postgres) and sort nearest-first. Without them, returns online collectors
// unsorted with distance_km = null.
app.get('/api/collectors/nearby', async (req, res) => {
  const lat = req.query.lat !== undefined ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng !== undefined ? parseFloat(req.query.lng) : null;
  const hasOrigin = lat !== null && lng !== null && !Number.isNaN(lat) && !Number.isNaN(lng);

  try {
    let r;
    if (hasOrigin) {
      r = await pool.query(
        `SELECT id, name, phone, vehicle_reg, status, latitude, longitude, location_detail,
                (6371 * acos(
                   GREATEST(-1, LEAST(1,
                     cos(radians($1)) * cos(radians(latitude)) *
                     cos(radians(longitude) - radians($2)) +
                     sin(radians($1)) * sin(radians(latitude))
                   ))
                 ))::numeric(10,2) AS distance_km
         FROM users
         WHERE role='collector' AND status='online'
               AND latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY distance_km ASC
         LIMIT 20`,
        [lat, lng]
      );
    } else {
      r = await pool.query(
        `SELECT id, name, phone, vehicle_reg, status, latitude, longitude, location_detail,
                NULL::numeric AS distance_km
         FROM users
         WHERE role='collector' AND status='online'
         LIMIT 20`
      );
    }
    return res.json({ success: true, collectors: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/collectors/location', authMiddleware, async (req, res) => {
  const { latitude, longitude, status, location_detail, vehicle_reg } = req.body;
  const allowedStatus = ['online', 'idle', 'offline'];

  try {
    const r = await pool.query(
      `UPDATE users SET
         latitude = $1,
         longitude = $2,
         status = $3,
         location_detail = COALESCE($4, location_detail),
         vehicle_reg = COALESCE($5, vehicle_reg),
         last_seen = now()
       WHERE id = $6
       RETURNING id, name, email, role, phone, vehicle_reg, status,
                 latitude, longitude, location_detail, last_seen`,
      [latitude ?? null, longitude ?? null,
      allowedStatus.includes(status) ? status : 'online',
      location_detail || null, vehicle_reg || null, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, message: 'Location updated', user: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// PICKUP REQUEST ROUTES  (replaces the old /api/bookings/* routes)
// pickup_requests table: id, requester_id, collector_id, scan_id, status,
//                        created_at, updated_at
// -----------------------------------------------------------------------------

// Create a pickup request. requester = logged-in user. collector_id is
// optional: if provided, this is a direct "order this collector" request
// (tapped from the map/radar); if omitted, it's an open request any
// collector can later claim via /accept. scan_id is also optional — a
// user can order a collector with no prior waste scan.
app.post('/api/pickup-requests', authMiddleware, async (req, res) => {
  const { scan_id, collector_id } = req.body;

  if (!scan_id && !collector_id) {
    return res.status(400).json({ success: false, message: 'scan_id au collector_id inahitajika' });
  }

  try {
    if (collector_id) {
      const c = await pool.query(
        `SELECT id FROM users WHERE id=$1 AND role='collector'`,
        [collector_id]
      );
      if (c.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Collector hajapatikana' });
      }
    }

    const r = await pool.query(
      `INSERT INTO pickup_requests (requester_id, collector_id, scan_id, status)
       VALUES ($1,$2,$3,'pending') RETURNING *`,
      [req.user.id, collector_id || null, scan_id || null]
    );
    return res.status(201).json({ success: true, request: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Requests made by the logged-in user
app.get('/api/pickup-requests/mine', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM pickup_requests WHERE requester_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json({ success: true, requests: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Direct orders sent to the logged-in collector (collector_id was set at
// creation time, i.e. tapped from the map) — distinct from the open
// /pending pool which has no collector assigned yet. This is what
// CollectorHomeScreen's "incoming requests" list should poll.
app.get('/api/pickup-requests/incoming', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pr.*, u.name AS requester_name, u.phone AS requester_phone
       FROM pickup_requests pr
       JOIN users u ON u.id = pr.requester_id
       WHERE pr.collector_id = $1 AND pr.status = 'pending'
       ORDER BY pr.created_at ASC`,
      [req.user.id]
    );
    return res.json({ success: true, requests: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// All pending requests, for coordinators/collectors to act on
app.get('/api/pickup-requests/pending', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pr.*, s.label, s.weight_min_kg, s.weight_max_kg, s.fee_min_tzs, s.fee_max_tzs,
              u.name AS requester_name, u.phone AS requester_phone
       FROM pickup_requests pr
       LEFT JOIN scans s ON s.id = pr.scan_id
       JOIN users u ON u.id = pr.requester_id
       WHERE pr.status = 'pending' AND pr.collector_id IS NULL
       ORDER BY pr.created_at ASC`
    );
    return res.json({ success: true, requests: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Collector accepts a request — works for both the open pool (collector_id
// was null, gets claimed here) and a direct order (collector_id was already
// set to this collector when the user tapped them on the map).
app.put('/api/pickup-requests/:id/accept', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE pickup_requests
       SET collector_id=$1, status='accepted'
       WHERE id=$2 AND status='pending'
             AND (collector_id IS NULL OR collector_id=$1)
       RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!r.rows[0]) return res.status(409).json({ success: false, message: 'Request haipo, tayari imeshughulikiwa, au imeagizwa kwa collector mwingine' });
    return res.json({ success: true, request: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/pickup-requests/:id/complete', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE pickup_requests SET status='completed'
       WHERE id=$1 AND collector_id=$2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Request not found' });
    return res.json({ success: true, request: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/pickup-requests/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE pickup_requests SET status='cancelled'
       WHERE id=$1 AND requester_id=$2`,
      [req.params.id, req.user.id]
    );
    return res.json({ success: true, message: 'Request imefutwa' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// COORDINATOR ROUTES  (for CoordinatorDashboardScreen)
// -----------------------------------------------------------------------------

// "Leaderboard" ranked by scan count — there is no points/eco_points column
// in this schema, so ranking is based on activity (number of scans logged).
app.get('/api/coordinator/leaderboard', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.name, COUNT(s.id) AS scan_count
       FROM users u
       LEFT JOIN scans s ON s.user_id = u.id
       WHERE u.role = 'user'
       GROUP BY u.id, u.name
       ORDER BY scan_count DESC, u.name ASC
       LIMIT 20`
    );
    const leaderboard = r.rows.map(row => ({
      ...row,
      scan_count: Number(row.scan_count),
    }));
    return res.json({ success: true, leaderboard });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/coordinator/overview', authMiddleware, async (req, res) => {
  if (req.user.role !== 'coordinator') {
    return res.status(403).json({ success: false, message: 'Coordinator only' });
  }
  try {
    const counts = await pool.query(
      `SELECT status, COUNT(*) AS count FROM pickup_requests GROUP BY status`
    );
    const onlineCollectors = await pool.query(
      `SELECT COUNT(*) AS count FROM users WHERE role='collector' AND status='online'`
    );
    return res.json({
      success: true,
      pickup_requests_by_status: counts.rows,
      online_collectors: Number(onlineCollectors.rows[0]?.count || 0),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// NOTIFICATION ROUTES
// (no notifications table in the current schema — kept as direct send-only
//  endpoints; add a notifications table later if you need persisted history)
// -----------------------------------------------------------------------------

app.post('/api/notifications/sms', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, message: 'to and message required' });
  }
  const result = await sendSMS(to, message);
  return res.status(result.success ? 200 : 500).json(result);
});

app.post('/api/notifications/email', async (req, res) => {
  const { to_email, to_name, subject, body } = req.body;
  if (!to_email || !subject || !body) {
    return res.status(400).json({ success: false, message: 'to_email, subject, body required' });
  }
  const result = await sendEmail(to_email, subject, body, body.startsWith('<'));
  return res.status(result.success ? 200 : 500).json(result);
});

app.post('/api/notifications/welcome', async (req, res) => {
  const { name, phone, email } = req.body;
  const results = await sendNotification({ phone, email, name, type: 'welcome' });
  return res.json({ success: true, results });
});

// -----------------------------------------------------------------------------
// TEST / DEBUG ROUTES
// -----------------------------------------------------------------------------

app.post('/api/test-sms', async (req, res) => {
  console.log('Testing SMS endpoint...');
  try {
    const { phone, message, otp, name } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    let finalMessage = message;
    if (otp) {
      finalMessage = `Dear ${name || 'Customer'}, your AcoWaste verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`;
    }
    const result = await sendSMS(phone, finalMessage || 'Test message from AcoWaste API');
    console.log('SMS result:', result);
    return res.json({ success: result.success, result: result.data, error: result.error, sentTo: phone });
  } catch (error) {
    console.error('SMS test error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

app.post('/api/test-email', async (req, res) => {
  console.log('Testing Email endpoint...');
  try {
    const { email, subject, message, name } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email address is required' });
    }
    const finalSubject = subject || 'AcoWaste Test Email';
    const finalMessage = name
      ? `Hello ${name},\n\n${message || 'This is a test email from AcoWaste API.'}`
      : (message || 'This is a test email from AcoWaste API.');
    const result = await sendEmail(email, finalSubject, finalMessage);
    console.log('Email result:', result);
    return res.json({ success: result.success, messageId: result.messageId, error: result.error, sentTo: email });
  } catch (error) {
    console.error('Email test error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test-sms-config', (_req, res) => {
  const mamboToken = process.env.MAMBO_TOKEN || process.env.MAMBOSMS_TOKEN;
  const smtpUser = process.env.SMTP_USER || process.env.SMTP_FROM;
  res.json({
    success: true,
    config: {
      mambo_base_url: process.env.MAMBO_BASE_URL || 'https://mambosms.co.tz (default)',
      mambo_sender_id: process.env.MAMBO_SENDER_ID || process.env.MAMBOSMS_SENDER || 'NOT SET',
      mambo_token_exists: !!mamboToken,
      mambo_token_preview: mamboToken ? `${mamboToken.substring(0, 10)}...` : 'NOT SET',
      smtp_host: process.env.SMTP_HOST || 'smtp.hostinger.com (default)',
      smtp_user: smtpUser || 'NOT SET',
      smtp_from: process.env.SMTP_FROM || 'NOT SET',
      smtp_from_name: process.env.SMTP_FROM_NAME || 'AcoWaste Support (default)',
      node_env: process.env.NODE_ENV || 'development',
    },
    warning: !mamboToken ? 'MAMBO_TOKEN is NOT set in environment variables!' : 'MAMBO_TOKEN is set',
    email_warning: !smtpUser ? 'SMTP credentials NOT set!' : 'SMTP credentials are set',
  });
});

app.post('/api/test-notification', async (req, res) => {
  console.log('Testing combined notification...');
  try {
    const { phone, email, name, type } = req.body;
    const result = await sendNotification({
      phone, email,
      name: name || 'Test User',
      type: type || 'welcome',
      otp: type === 'otp' ? '123456' : null,
    });
    return res.json({ success: true, results: result });
  } catch (error) {
    console.error('Notification test error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 404 HANDLER
// -----------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// -----------------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// -----------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('--- Unhandled Error ---------------------------');
  console.error(`  ${req.method} ${req.path}`);
  console.error(`  ${err.message}`);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  console.error('-----------------------------------------------');

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

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// -----------------------------------------------------------------------------
let server;

process.on('SIGTERM', () => {
  console.log('SIGTERM received - shutting down gracefully');
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

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
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
  const ip = getLocalIP();
  const line = '-'.repeat(54);
  console.log(`\n${line}`);
  console.log(`  AcoWaste API v2.1.0`);
  console.log(`  ENV : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  PORT: ${PORT}`);
  console.log(line);
  console.log(`  Local  : http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(line);
  console.log('  AUTH');
  console.log(`    POST   /api/auth/register`);
  console.log(`    POST   /api/auth/login`);
  console.log(`    GET    /api/auth/profile           [protected]`);
  console.log(`    POST   /api/auth/send-otp`);
  console.log(`    POST   /api/auth/verify-otp`);
  console.log('  SCANS');
  console.log(`    POST   /api/scans                  [protected]`);
  console.log(`    GET    /api/scans/mine             [protected]`);
  console.log(`    DELETE /api/scans/:id              [protected]`);
  console.log(`    POST   /api/scans/verify-ai        [protected]`);
  console.log('  COLLECTORS');
  console.log(`    GET    /api/collectors/nearby`);
  console.log(`    PUT    /api/collectors/location    [protected]`);
  console.log('  PICKUP REQUESTS');
  console.log(`    POST   /api/pickup-requests               [protected]`);
  console.log(`    GET    /api/pickup-requests/mine          [protected]`);
  console.log(`    GET    /api/pickup-requests/incoming      [protected]`);
  console.log(`    GET    /api/pickup-requests/pending        [protected]`);
  console.log(`    PUT    /api/pickup-requests/:id/accept     [protected]`);
  console.log(`    PUT    /api/pickup-requests/:id/complete   [protected]`);
  console.log(`    DELETE /api/pickup-requests/:id            [protected]`);
  console.log('  COORDINATOR');
  console.log(`    GET    /api/coordinator/leaderboard [protected]`);
  console.log(`    GET    /api/coordinator/overview   [protected, coordinator]`);
  console.log('  NOTIFICATIONS');
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
  console.log(`  SMS Service  : ${(process.env.MAMBO_TOKEN || process.env.MAMBOSMS_TOKEN) ? 'Configured' : 'MAMBO_TOKEN not set'}`);
  console.log(`  Email Service: ${(process.env.SMTP_USER || process.env.SMTP_FROM) ? 'Configured' : 'SMTP_USER not set'}`);
  console.log(`  Database    : ${process.env.DATABASE_URL ? 'DATABASE_URL set' : 'DATABASE_URL not set'}`);
  console.log(`  JWT Secret   : ${process.env.JWT_SECRET ? 'Custom secret' : 'Using default (set JWT_SECRET!)'}`);
  console.log(`${line}\n`);
});

module.exports = app;