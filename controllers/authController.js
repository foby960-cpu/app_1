const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserModel = require('../models/userModel');
const pool = require('../config/db');
const { sendOTP, sendWelcomeNotification } = require('../services/notificationService');

// ── Helper: sign JWT ──────────────────────────────────────────
const signToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

// ── POST /api/auth/register ───────────────────────────────────
const register = async (req, res) => {
  try {
    const { full_name, username, email, phone, driver_license, password } = req.body;

    // Validation
    if (!full_name || !username || !email || !password) {
      return res.status(400).json({ 
        success: false,
        message: 'full_name, username, email, and password are required' 
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false,
        message: 'Enter a valid email address' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        success: false,
        message: 'Password must be at least 6 characters' 
      });
    }

    // Check existing users
    if (await UserModel.findByEmail(email)) {
      return res.status(409).json({ 
        success: false,
        message: 'Email is already registered' 
      });
    }
    if (await UserModel.findByUsername(username)) {
      return res.status(409).json({ 
        success: false,
        message: 'Username is already taken' 
      });
    }
    if (driver_license && await UserModel.findByDriverLicense(driver_license)) {
      return res.status(409).json({ 
        success: false,
        message: 'Driver license already registered' 
      });
    }

    // Hash password and create user
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = await UserModel.createUser(
      full_name, 
      username, 
      email.toLowerCase(), 
      phone || null, 
      driver_license || null, 
      passwordHash
    );
    
    const token = signToken(user);

    // Send welcome notification via email and SMS (async, don't await)
    if (email || phone) {
      sendWelcomeNotification({
        email: email,
        phone: phone,
        name: full_name
      }).catch(err => console.error('Welcome notification failed:', err.message));
    }

    return res.status(201).json({
      success: true,
      message: 'Registration successful! Welcome to EcoWaste 🌿',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        driver_license: user.driver_license,
        eco_points: user.eco_points || 0,
        total_kg: user.total_kg || 0,
        is_phone_verified: user.is_phone_verified || false
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Internal server error' 
    });
  }
};

// ── POST /api/auth/login ──────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, driver_id, phone, password } = req.body;

    // Accept email, driver_id, or phone
    let user = null;
    if (email) {
      user = await UserModel.findByEmail(email.toLowerCase());
    } else if (driver_id) {
      user = await UserModel.findByDriverLicense(driver_id);
    } else if (phone) {
      user = await UserModel.findByPhone(phone);
    } else {
      return res.status(400).json({ 
        success: false,
        message: 'Email, Phone, or Driver ID and password are required' 
      });
    }

    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid credentials' 
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid credentials' 
      });
    }

    const token = signToken(user);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        driver_license: user.driver_license,
        eco_points: user.eco_points || 0,
        total_kg: user.total_kg || 0,
        is_phone_verified: user.is_phone_verified || false
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Internal server error' 
    });
  }
};

// ── POST /api/auth/send-otp ───────────────────────────────────
const sendOtp = async (req, res) => {
  try {
    const { phone, email, name = 'User' } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ 
        success: false,
        message: 'Either phone number or email is required' 
      });
    }

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in database
    const identifier = phone || email;
    
    // First, invalidate any existing unused OTPs for this identifier
    await pool.query(
      'UPDATE otp_codes SET used = TRUE WHERE phone = $1 AND used = FALSE',
      [identifier]
    );

    // Store new OTP
    await pool.query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
      [identifier, code, expiresAt]
    );

    // Determine channel and send OTP
    let result = null;
    let channel = '';

    if (phone) {
      channel = 'sms';
      result = await sendOTP(phone, code, name, 'sms');
    } else if (email) {
      channel = 'email';
      result = await sendOTP(email, code, name, 'email');
    }

    if (result && result.success) {
      return res.status(200).json({
        success: true,
        message: `OTP sent successfully via ${result.channelUsed || channel}`,
        sentTo: identifier,
        channel: result.channelUsed || channel,
        // Include OTP in development mode for testing
        otp: process.env.NODE_ENV === 'development' ? code : undefined,
        devOtp: result.devOtp
      });
    } else {
      // Log OTP for debugging
      console.log(`⚠️ OTP delivery failed. OTP for ${identifier}: ${code}`);
      
      return res.status(200).json({
        success: true, // Still return success to not break UX
        message: 'OTP generated. In development, check server logs.',
        sentTo: identifier,
        channel: channel,
        // Always include OTP in development
        otp: process.env.NODE_ENV === 'development' ? code : undefined,
        devOtp: code
      });
    }
  } catch (err) {
    console.error('Send OTP error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to send OTP. Please try again.' 
    });
  }
};

// ── POST /api/auth/verify-otp ─────────────────────────────────
const verifyOtp = async (req, res) => {
  try {
    const { phone, email, code } = req.body;
    const identifier = phone || email;

    if (!identifier || !code) {
      return res.status(400).json({ 
        success: false,
        message: 'Identifier and code are required' 
      });
    }

    // Find valid OTP
    const result = await pool.query(
      `SELECT * FROM otp_codes 
       WHERE phone = $1 AND code = $2 AND used = FALSE AND expires_at > NOW() 
       ORDER BY created_at DESC LIMIT 1`,
      [identifier, code]
    );

    if (!result.rows[0]) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid or expired OTP. Please request a new one.' 
      });
    }

    // Mark OTP as used
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    // If verifying phone for existing user (logged in), update user record
    if (phone && req.user && req.user.id) {
      await pool.query(
        'UPDATE users SET is_phone_verified = TRUE, phone = $1 WHERE id = $2',
        [phone, req.user.id]
      );
    }

    return res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      verified: true,
      identifier: identifier
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Internal server error' 
    });
  }
};

// ── POST /api/auth/resend-otp ─────────────────────────────────
const resendOtp = async (req, res) => {
  try {
    const { phone, email, name = 'User' } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ 
        success: false,
        message: 'Either phone number or email is required' 
      });
    }

    const identifier = phone || email;

    // Check rate limiting - prevent spam (optional: check last request time)
    const lastOtp = await pool.query(
      'SELECT created_at FROM otp_codes WHERE phone = $1 ORDER BY created_at DESC LIMIT 1',
      [identifier]
    );

    if (lastOtp.rows[0]) {
      const lastTime = new Date(lastOtp.rows[0].created_at);
      const now = new Date();
      const diffSeconds = (now - lastTime) / 1000;
      
      if (diffSeconds < 30) {
        return res.status(429).json({
          success: false,
          message: 'Please wait 30 seconds before requesting another OTP'
        });
      }
    }

    // Generate new OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate old unused OTPs
    await pool.query(
      'UPDATE otp_codes SET used = TRUE WHERE phone = $1 AND used = FALSE',
      [identifier]
    );

    // Store new OTP
    await pool.query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
      [identifier, code, expiresAt]
    );

    // Resend OTP
    let result = null;
    let channel = '';

    if (phone) {
      channel = 'sms';
      result = await sendOTP(phone, code, name, 'sms');
    } else if (email) {
      channel = 'email';
      result = await sendOTP(email, code, name, 'email');
    }

    if (result && result.success) {
      return res.status(200).json({
        success: true,
        message: `OTP resent successfully via ${result.channelUsed || channel}`,
        sentTo: identifier,
        channel: result.channelUsed || channel,
        otp: process.env.NODE_ENV === 'development' ? code : undefined
      });
    } else {
      console.log(`Resent OTP for ${identifier}: ${code}`);
      return res.status(200).json({
        success: true,
        message: 'OTP resent (check logs for code in development)',
        sentTo: identifier,
        otp: process.env.NODE_ENV === 'development' ? code : undefined
      });
    }
  } catch (err) {
    console.error('Resend OTP error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to resend OTP' 
    });
  }
};

// ── GET /api/auth/profile ─────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }
    
    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        driver_license: user.driver_license,
        eco_points: user.eco_points || 0,
        total_kg: user.total_kg || 0,
        is_phone_verified: user.is_phone_verified || false,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('Profile error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Internal server error' 
    });
  }
};

// ── PUT /api/auth/profile/phone ───────────────────────────────
const updatePhoneNumber = async (req, res) => {
  try {
    const { phone } = req.body;
    const userId = req.user.id;

    if (!phone) {
      return res.status(400).json({ 
        success: false,
        message: 'Phone number is required' 
      });
    }

    // Validate phone format (Tanzanian)
    const phoneRegex = /^(0|255|\+255)[0-9]{9}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid phone number format. Use 0755XXXXXX or 255755XXXXXX' 
      });
    }

    // Check if phone already exists for another user
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE phone = $1 AND id != $2',
      [phone, userId]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ 
        success: false,
        message: 'Phone number already registered to another account' 
      });
    }

    await pool.query(
      'UPDATE users SET phone = $1, is_phone_verified = FALSE WHERE id = $2',
      [phone, userId]
    );

    return res.status(200).json({
      success: true,
      message: 'Phone number updated. Please verify your new number.',
      phone: phone,
      is_phone_verified: false
    });
  } catch (err) {
    console.error('Update phone error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to update phone number' 
    });
  }
};

// ── POST /api/auth/logout ─────────────────────────────────────
const logout = async (req, res) => {
  try {
    // Client-side token removal, but we can blacklist if needed
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Internal server error' 
    });
  }
};

module.exports = {
  register,
  login,
  sendOtp,
  verifyOtp,
  resendOtp,
  getProfile,
  updatePhoneNumber,
  logout
};