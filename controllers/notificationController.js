// ─────────────────────────────────────────────────────────────────────────────
// 📁 SAVE TO: controllers/notificationController.js
//
// Credentials live HERE on the server — never in the Flutter app.
// Required .env variables:
//   MAMBO_SMS_TOKEN=283|dFKiY0y5...
//   MAMBO_SMS_SENDER=ECOWASTE
//   SMTP_HOST=smtp.hostinger.com
//   SMTP_PORT=587
//   SMTP_USER=support@simuvote.com
//   SMTP_PASS=your_smtp_password
// ─────────────────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');

// ── SMTP transporter (reused across requests) ─────────────────────────────────
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // STARTTLS on 587
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
    tls: {
        rejectUnauthorized: false, // needed for some Hostinger configs
    },
});

// ── POST /api/notifications/sms ───────────────────────────────────────────────
const sendSms = async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, message: 'to and message are required' });
    }

    // Normalize Tanzanian number to 255XXXXXXXXX
    const normalized = normalizePhone(to);

    try {
        const response = await fetch('https://mambosms.co.tz/api/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.MAMBO_SMS_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                to: normalized,
                from: process.env.MAMBO_SMS_SENDER || 'ECOWASTE',
                message: message,
            }),
        });

        const data = await response.json();

        if (response.ok) {
            console.log(`[SMS] ✓ Sent to ${normalized}`);
            return res.json({
                success: true,
                message: 'SMS imepelekwa',
                message_id: data.message_id ?? data.id ?? '',
            });
        } else {
            console.error(`[SMS] ✗ MamboSMS error:`, data);
            return res.status(502).json({
                success: false,
                message: data.message ?? data.error ?? 'MamboSMS ilikataa ombi',
            });
        }
    } catch (err) {
        console.error('[SMS] ✗ Network/fetch error:', err.message);
        return res.status(500).json({ success: false, message: `SMS imeshindwa: ${err.message}` });
    }
};

// ── POST /api/notifications/email ─────────────────────────────────────────────
const sendEmail = async (req, res) => {
    const {
        to_email,
        to_name,
        subject,
        body,
        is_html = true,
        from_email = process.env.SMTP_USER,
        from_name = 'EcoWaste Support',
    } = req.body;

    if (!to_email || !subject || !body) {
        return res.status(400).json({
            success: false,
            message: 'to_email, subject, and body are required',
        });
    }

    try {
        const mailOptions = {
            from: `"${from_name}" <${from_email}>`,
            to: to_name ? `"${to_name}" <${to_email}>` : to_email,
            subject: subject,
            ...(is_html ? { html: body } : { text: body }),
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] ✓ Sent to ${to_email} — messageId: ${info.messageId}`);

        return res.json({
            success: true,
            message: 'Barua pepe imetumwa',
            message_id: info.messageId,
        });
    } catch (err) {
        console.error('[Email] ✗ SMTP error:', err.message);
        return res.status(500).json({ success: false, message: `Email imeshindwa: ${err.message}` });
    }
};

// ── HELPER ────────────────────────────────────────────────────────────────────
function normalizePhone(phone) {
    const cleaned = phone.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+255')) return cleaned.slice(1);
    if (cleaned.startsWith('255')) return cleaned;
    if (cleaned.startsWith('0')) return '255' + cleaned.slice(1);
    return '255' + cleaned;
}

module.exports = { sendSms, sendEmail };