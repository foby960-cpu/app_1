require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ── Routes ────────────────────────────────────────────────────
const authRoutes = require('./routes/authRoutes');
const wasteRoutes = require('./routes/wasteRoutes');
const mapRoutes = require('./routes/mapRoutes');
const vehicleRoutes = require('./routes/vehicleRoutes');
const statsRoutes = require('./routes/statsRoutes');
const bookingRoutes = require('./routes/bookingRoutes');

// ── Services ───────────────────────────────────────────────────
const { sendSMS, sendOtpSMS, sendWelcomeSMS, sendBookingSMS } = require('./services/smsService');
const { sendEmail, sendWelcomeEmail, sendOtpEmail, sendBookingConfirmation } = require('./services/emailService');
const { sendNotification } = require('./services/notificationService');

const app = express();
const PORT = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════════

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS — allow all origins in dev, lock down in prod via env
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Global rate limiter (100 req / 15 min per IP) ────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);

// ── Stricter limiter for auth endpoints ──────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

// ── AI endpoint limiter (expensive calls) ────────────────────
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'AI rate limit reached. Wait 1 minute.' },
});

// ════════════════════════════════════════════════════════════════
// REQUEST LOGGER (dev only)
// ════════════════════════════════════════════════════════════════
if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const body = JSON.parse(JSON.stringify(req.body || {}));
      if (body.image_base64) body.image_base64 = '[base64 truncated]';
      if (body.photo) body.photo = '[binary truncated]';
      console.log(`  → body: ${JSON.stringify(body).substring(0, 300)}`);
    }
    next();
  });
}

// ════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════
app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: '✅ EcoWaste API is running',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

// ════════════════════════════════════════════════════════════════
// TEST ENDPOINTS FOR SMS & EMAIL
// ════════════════════════════════════════════════════════════════

// Test SMS endpoint
app.post('/api/test-sms', async (req, res) => {
  console.log('📱 Testing SMS endpoint...');
  console.log('Request body:', req.body);
  
  try {
    const { phone, message, otp, name } = req.body;
    
    if (!phone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number is required' 
      });
    }
    
    let finalMessage = message;
    if (otp) {
      finalMessage = `Dear ${name || 'Customer'}, your EcoWaste verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`;
    }
    
    const result = await sendSMS(phone, finalMessage || 'Test message from EcoWaste API');
    
    console.log('SMS result:', result);
    res.json({ 
      success: result.success, 
      result: result.data,
      error: result.error,
      sentTo: phone
    });
  } catch (error) {
    console.error('SMS test error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Test Email endpoint
app.post('/api/test-email', async (req, res) => {
  console.log('📧 Testing Email endpoint...');
  console.log('Request body:', req.body);
  
  try {
    const { email, subject, message, name } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email address is required' 
      });
    }
    
    let finalSubject = subject || 'EcoWaste Test Email';
    let finalMessage = message || 'This is a test email from EcoWaste API. Your email service is working correctly! 🌿';
    
    if (name) {
      finalMessage = `Hello ${name},\n\n${finalMessage}`;
    }
    
    const result = await sendEmail(email, finalSubject, finalMessage);
    
    console.log('Email result:', result);
    res.json({ 
      success: result.success, 
      messageId: result.messageId,
      error: result.error,
      sentTo: email
    });
  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Check configuration endpoint
app.get('/api/test-sms-config', (req, res) => {
  const config = {
    mambo_base_url: process.env.MAMBO_BASE_URL || 'NOT SET',
    mambo_sender_id: process.env.MAMBO_SENDER_ID || 'NOT SET',
    mambo_token_exists: !!process.env.MAMBO_TOKEN,
    mambo_token_preview: process.env.MAMBO_TOKEN ? 
      `${process.env.MAMBO_TOKEN.substring(0, 10)}...` : 'NOT SET',
    smtp_host: process.env.SMTP_HOST || 'NOT SET',
    smtp_user: process.env.SMTP_USER || 'NOT SET',
    smtp_from: process.env.SMTP_FROM || 'NOT SET',
    smtp_from_name: process.env.SMTP_FROM_NAME || 'NOT SET',
    node_env: process.env.NODE_ENV || 'development'
  };
  
  res.json({
    success: true,
    config: config,
    warning: !process.env.MAMBO_TOKEN ? '⚠️ MAMBO_TOKEN is not set in environment variables!' : '✅ MAMBO_TOKEN is set',
    email_warning: !process.env.SMTP_USER ? '⚠️ SMTP credentials not set!' : '✅ SMTP credentials are set'
  });
});

// Test combined notification endpoint
app.post('/api/test-notification', async (req, res) => {
  console.log('🔔 Testing combined notification...');
  
  try {
    const { phone, email, name, type } = req.body;
    
    const result = await sendNotification({
      phone: phone,
      email: email,
      name: name || 'Test User',
      type: type || 'welcome',
      otp: type === 'otp' ? '123456' : null
    });
    
    res.json({
      success: true,
      results: result
    });
  } catch (error) {
    console.error('Notification test error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/waste', wasteRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/bookings', bookingRoutes);

// AI verify endpoint gets its own tighter rate limit
app.use('/api/waste/verify-ai', aiLimiter);

// ════════════════════════════════════════════════════════════════
// 404 HANDLER
// ════════════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ════════════════════════════════════════════════════════════════
app.use((err, req, res, _next) => {
  console.error('─── Unhandled Error ───────────────────────────');
  console.error(`  ${req.method} ${req.path}`);
  console.error(`  ${err.message}`);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  console.error('───────────────────────────────────────────────');

  // Handle specific error types
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large. Max 10MB.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body too large.' });
  }

  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════════════════════
let server;

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  if (server) {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// ════════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════════
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server = app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const line = '═'.repeat(52);
  console.log(`\n${line}`);
  console.log(`  🌿  EcoWaste API v2.0.0`);
  console.log(`  ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(line);
  console.log(`  Local  : http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(line);
  console.log('  AUTH');
  console.log(`    POST   /api/auth/register`);
  console.log(`    POST   /api/auth/login`);
  console.log(`    GET    /api/auth/profile`);
  console.log(`    POST   /api/auth/send-otp`);
  console.log(`    POST   /api/auth/verify-otp`);
  console.log('  WASTE');
  console.log(`    POST   /api/waste/log`);
  console.log(`    GET    /api/waste/my-logs`);
  console.log(`    POST   /api/waste/verify-ai`);
  console.log('  MAP');
  console.log(`    GET    /api/map/collection-points`);
  console.log('  VEHICLES');
  console.log(`    GET    /api/vehicles/nearby`);
  console.log('  STATS');
  console.log(`    GET    /api/stats/me`);
  console.log(`    GET    /api/stats/leaderboard`);
  console.log('  BOOKINGS');
  console.log(`    GET    /api/bookings/centers`);
  console.log(`    GET    /api/bookings/mine`);
  console.log(`    GET    /api/bookings/:id`);
  console.log(`    POST   /api/bookings`);
  console.log(`    DELETE /api/bookings/:id`);
  console.log(`    PUT    /api/bookings/:id/complete`);
  console.log('  NOTIFICATIONS (TEST)');
  console.log(`    POST   /api/test-sms`);
  console.log(`    POST   /api/test-email`);
  console.log(`    GET    /api/test-sms-config`);
  console.log(`    POST   /api/test-notification`);
  console.log('  SYSTEM');
  console.log(`    GET    /`);
  console.log(`    GET    /health`);
  console.log(`${line}\n`);
  
  // Log configuration status
  console.log('📱 SMS Service:', process.env.MAMBO_TOKEN ? '✅ Configured' : '❌ Not configured');
  console.log('📧 Email Service:', process.env.SMTP_USER ? '✅ Configured' : '❌ Not configured');
  console.log('');
});

module.exports = app;