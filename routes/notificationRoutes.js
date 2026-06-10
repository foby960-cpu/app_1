// ─────────────────────────────────────────────────────────────────────────────
// 📁 SAVE TO: routes/notificationRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const {
    sendSms,
    sendEmail,
} = require('../controllers/notificationController');

// POST /api/notifications/sms
// Body: { to: "255755XXXXXX", message: "Your OTP is 123456" }
router.post('/sms', sendSms);

// POST /api/notifications/email
// Body: { to_email, to_name, subject, body, is_html, from_email, from_name }
router.post('/email', sendEmail);

module.exports = router;