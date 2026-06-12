const db = require('../db'); // Hakikisha njia (path) ya db yako iko sahihi
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const smsService = require('../services/smsService');
// const emailService = require('../services/emailService'); // Ondoa comment kama unatumia pia email

// 1. REGISTER LOGIC WITH AUTOMATIC OTP
exports.register = async (req, res) => {
    const { username, email, password, phone, fullName, vehicleType, role } = req.body;

    try {
        // Uhakiki wa msingi
        if (!username || !email || !password || !phone) {
            return res.status(400).json({ error: 'Tafadhali jaza username, email, neno la siri na namba ya simu.' });
        }

        // Angalia kama mtumiaji tayari yupo
        const userExists = await db.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (userExists.rows.length > 0) {
            return res.status(409).json({ error: 'Mtumiaji mwenye Username au Email hii tayari yupo.' });
        }

        // Funga neno la siri (Hash password)
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Ingiza mtumiaji kwenye database (Kumbuka vehicle_type na role sasa zipo!)
        const newUser = await db.query(
            'INSERT INTO users (username, email, password_hash, phone, full_name, vehicle_type, role) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username, email, phone',
            [username, email, hashedPassword, phone, fullName, vehicleType || 'none', role || 'user']
        );

        const userId = newUser.rows[0].id;

        // ---- LOGIC YA OTP INAANZA HAPA ----
        // Tengeneza namba 6 za random
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // Inakwisha muda baada ya dakika 10

        // Hifadhi OTP kwenye meza ya otp_codes
        await db.query(
            'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
            [phone, otpCode, expiresAt]
        );

        // Tuma OTP kupitia SMS (Mambo SMS)
        let smsSent = false;
        try {
            const smsMessage = `Habari ${fullName || username}, namba yako ya uhakiki wa akaunti ya EcoWaste ni: ${otpCode}. Inaisha baada ya dakika 10.`;
            await smsService.sendSMS(phone, smsMessage);
            smsSent = true;
        } catch (smsError) {
            console.error('Kosa la kutuma SMS ya OTP:', smsError.message);
        }

        // Rudisha majibu kwenda kwenye App ya Flutter
        return res.status(201).json({
            message: 'Usajili umefanikiwa! OTP imetumwa kwenye simu yako.',
            user: newUser.rows[0],
            otp_sent: smsSent
        });

    } catch (error) {
        console.error('Register Error:', error);
        return res.status(500).json({ error: 'Kuna kitu kimeharibika kwenye server.' });
    }
};

// 2. VERIFY OTP LOGIC
exports.verifyOTP = async (req, res) => {
    const { phone, code } = req.body;

    try {
        if (!phone || !code) {
            return res.status(400).json({ error: 'Tafadhali weka namba ya simu na namba ya OTP.' });
        }

        // Tafuta OTP ya hivi karibuni ambayo haijatumiwa bado
        const otpCheck = await db.query(
            'SELECT * FROM otp_codes WHERE phone = $1 AND code = $2 AND used = false ORDER BY created_at DESC LIMIT 1',
            [phone, code]
        );

        if (otpCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Namba za OTP si sahihi au zimeshatumika.' });
        }

        const otpRecord = otpCheck.rows[0];

        // Angalia kama muda umekwisha (Expired)
        if (new Date() > new Date(otpRecord.expires_at)) {
            return res.status(400).json({ error: 'Muda wa OTP hii umekwisha. Tafadhali omba nyingine.' });
        }

        // Weka alama kuwa OTP imeshatumika
        await db.query('UPDATE otp_codes SET used = true WHERE id = $1', [otpRecord.id]);

        // Weka alama kwenye meza ya users kuwa simu imehakikiwa (is_phone_verified = true)
        await db.query('UPDATE users SET is_phone_verified = true WHERE phone = $1', [phone]);

        return res.status(200).json({ message: 'Uhakiki wa namba ya simu umefanikiwa kikamilifu!' });

    } catch (error) {
        console.error('Verify OTP Error:', error);
        return res.status(500).json({ error: 'Kuna kitu kimeharibika kwenye server.' });
    }
};

// 3. LOGIN LOGIC
exports.login = async (req, res) => {
    const { email, password } = req.body;

    try {
        if (!email || !password) {
            return res.status(400).json({ error: 'Tafadhali jaza email na neno la siri.' });
        }

        // Tafuta mtumiaji kwa email
        const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userRes.rows.length === 0) {
            return res.status(401).json({ error: 'Email au Neno la siri si sahihi.' });
        }

        const user = userRes.rows[0];

        // Linganisha neno la siri lililofungwa (Bcrypt)
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Email au Neno la siri si sahihi.' });
        }

        // Angalia kama amehakiki simu yake
        if (!user.is_phone_verified) {
            return res.status(403).json({
                error: 'Akaunti yako bado haijahakikiwa. Tafadhali thibitisha namba yako ya simu kwa kutumia OTP.',
                requires_verification: true,
                phone: user.phone
            });
        }

        // Tengeneza JWT Token
        const token = jwt.sign(
            { id: user.id, role: user.role, username: user.username },
            process.env.JWT_SECRET || 'custom_secret_key',
            { expiresIn: '24h' }
        );

        // Ondoa password kabla ya kurudisha data kwenda kwenye app
        delete user.password_hash;

        return res.status(200).json({
            message: 'Kuingia kumefanikiwa!',
            token,
            user
        });

    } catch (error) {
        console.error('Login Error:', error);
        return res.status(500).json({ error: 'Kuna kitu kimeharibika kwenye server.' });
    }
};