const db = require('../config/db');
const { sendSMS } = require('../services/smsService');
const { sendEmail } = require('../services/emailService');

exports.register = async (req, res) => {
    const { name, username, email, phone, password, vehicle_type } = req.body;

    // Uhakiki wa data za msingi
    if (!name || !username || !email || !phone || !password) {
        return res.status(400).json({
            success: false,
            message: "Tafadhali jaza sifa zote muhimu (name, username, email, phone, password)"
        });
    }

    try {
        // 1. Angalia kama mtumiaji tayari yupo
        const userExists = await db.query(
            'SELECT * FROM users WHERE email = $1 OR phone = $2 OR username = $3',
            [email, phone, username]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Mtumiaji mwenye Username, Email au Namba hii tayari yupo!"
            });
        }

        // 2. Tengeneza tarakimu 6 za OTP
        const otpToken = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // Inadumu kwa dakika 10

        // 3. Weka data kwenye database (Kutumia vehicle_type kwa usahihi)
        const newUser = await db.query(
            `INSERT INTO users (name, username, email, phone, password, vehicle_type, otp_token, otp_expires) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, username, email, phone, vehicle_type`,
            [name, username, email, phone, password, vehicle_type || 'NONE', otpToken, otpExpires]
        );

        // 4. Maandalizi ya Ujumbe wa OTP
        const smsMessage = `Karibu EcoWaste, ${name}! Code yako ya uhakiki (OTP) ni: ${otpToken}. Itadumu kwa dakika 10.`;

        // 5. Tuma kwa SMS na Email kwa pamoja
        try {
            await sendSMS(phone, smsMessage);
            await sendEmail(email, "Uhakiki wa Akaunti - EcoWaste", smsMessage);
            console.log(`[OTP Sent Successfully] Token: ${otpToken} kwenda ${phone} na ${email}`);
        } catch (sendError) {
            console.error("Ujumbe umefeli kutumwa lakini usajili umefanyika:", sendError);
        }

        // 6. Jibu la mafanikio kwenda Flutter
        return res.status(201).json({
            success: true,
            message: "Usajili umefanikiwa! OTP imetumwa kwenye SMS na Email yako.",
            user: newUser.rows[0]
        });

    } catch (error) {
        console.error("Error kwenye usajili wetu wa mfumo:", error);
        return res.status(500).json({
            success: false,
            message: "Hitilafu imetokea kwenye server",
            error: error.message
        });
    }
};