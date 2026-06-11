// utils/otpUtils.js
const pool = require('../config/database');
const { sendSMS } = require('../services/smsService');
const { sendEmail } = require('../services/emailService');

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

exports.sendOtp = async ({ phone, email, name = 'User', purpose = 'verification' }) => {
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
        `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)`,
        [phone, otp, expiresAt]
    );

    if (phone) {
        await sendSMS(phone, `Dear ${name}, your EcoWaste ${purpose} code is: ${otp}. Valid for 10 minutes.`);
        return { success: true, channel: 'sms', otp: process.env.NODE_ENV !== 'production' ? otp : undefined };
    } else if (email) {
        await sendEmail(email, 'EcoWaste Verification', `Your code is: ${otp}`);
        return { success: true, channel: 'email', otp: process.env.NODE_ENV !== 'production' ? otp : undefined };
    }
    return { success: false };
};

exports.verifyOtp = async ({ phone, email, code }) => {
    const result = await pool.query(
        `SELECT id FROM otp_codes 
     WHERE (phone = $1 OR email = $2) 
     AND code = $3 
     AND expires_at > NOW() 
     AND used = false`,
        [phone, email, code]
    );

    if (result.rows.length === 0) return false;

    await pool.query(`UPDATE otp_codes SET used = true WHERE id = $1`, [result.rows[0].id]);
    return true;
};