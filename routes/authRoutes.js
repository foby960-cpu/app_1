// ── routes/authRoutes.js ──────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const { register, login, sendOtp, verifyOtp, getProfile } = require('../controllers/authController');
const { verifyToken } = require('../middleware/authMiddleware');

router.post('/register',    register);
router.post('/login',       login);
router.post('/send-otp',    sendOtp);
router.post('/verify-otp',  verifyOtp);
router.get('/profile',      verifyToken, getProfile);

module.exports = router;
