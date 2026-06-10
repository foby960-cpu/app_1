const db = require('../config/db');
const { sendBookingNotification } = require('../services/notificationService');

// ════════════════════════════════════════════════════════════════
// GET /api/bookings/centers
// Returns recycling_centers table — used by Flutter booking screen
// ════════════════════════════════════════════════════════════════
const getCenters = async (req, res) => {
    try {
        const { waste_type } = req.query;

        let query = `
      SELECT
        id,
        name,
        address,
        lat,
        lng,
        distance_miles,
        accepted_types,
        closes_at,
        phone,
        status,
        created_at
      FROM recycling_centers
    `;
        const params = [];

        // Filter by waste type if provided
        if (waste_type) {
            query += ` WHERE $1 = ANY(accepted_types)`;
            params.push(waste_type);
        }

        query += ` ORDER BY name ASC`;

        const { rows } = await db.query(query, params);

        return res.json({
            success: true,
            centers: rows,
            count: rows.length,
        });
    } catch (err) {
        console.error('getCenters error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch centers.' });
    }
};

// ════════════════════════════════════════════════════════════════
// POST /api/bookings
// Create a new booking with notification
// ════════════════════════════════════════════════════════════════
const createBooking = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            center_id,
            booking_date,
            time_slot,
            waste_types = [],
            estimated_kg,
            notes,
        } = req.body;

        // Validate required fields
        if (!center_id || !booking_date || !time_slot) {
            return res.status(400).json({
                success: false,
                message: 'center_id, booking_date, and time_slot are required.',
            });
        }

        // Fetch center details to denormalize into booking row
        const centerRes = await db.query(
            `SELECT id, name, address, phone FROM recycling_centers WHERE id = $1`,
            [center_id]
        );
        if (centerRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Recycling center not found.' });
        }
        const center = centerRes.rows[0];

        // Fetch user details for notification
        const userRes = await db.query(
            `SELECT id, full_name, email, phone FROM users WHERE id = $1`,
            [userId]
        );
        const user = userRes.rows[0];

        // Build slot_time from booking_date + time_slot string
        let slotTime = null;
        try {
            slotTime = new Date(`${booking_date}T${time_slot.replace(' ', 'T')}`);
            if (isNaN(slotTime)) slotTime = null;
        } catch (_) { slotTime = null; }

        const { rows } = await db.query(
            `INSERT INTO bookings (
        user_id, center_id, center_name, center_address,
        booking_date, time_slot, slot_time,
        waste_types, estimated_kg, notes, status
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, 'pending'
      )
      RETURNING *`,
            [
                userId,
                center_id,
                center.name,
                center.address,
                booking_date,
                time_slot,
                slotTime,
                waste_types,
                estimated_kg || null,
                notes || null,
            ]
        );

        const booking = rows[0];

        // Log status history
        await db.query(
            `INSERT INTO booking_status_history
        (booking_id, old_status, new_status, changed_by)
       VALUES ($1, NULL, 'pending', 'user')`,
            [booking.id]
        );

        // Send notification to user (email and SMS)
        if (user && (user.email || user.phone)) {
            const notificationResult = await sendBookingNotification(
                {
                    email: user.email,
                    phone: user.phone,
                    full_name: user.full_name,
                    name: user.full_name
                },
                {
                    id: booking.id,
                    center_name: center.name,
                    center_address: center.address,
                    booking_date: booking_date,
                    time_slot: time_slot,
                    waste_types: waste_types,
                    estimated_kg: estimated_kg,
                    notes: notes
                }
            );

            console.log('Booking notification sent:', notificationResult);
        }

        return res.status(201).json({
            success: true,
            message: 'Booking created successfully. Confirmation sent to your email/phone.',
            booking,
        });
    } catch (err) {
        console.error('createBooking error:', err);
        return res.status(500).json({ success: false, message: 'Failed to create booking.' });
    }
};

// ════════════════════════════════════════════════════════════════
// GET /api/bookings/mine
// Get all bookings for the logged-in user
// ════════════════════════════════════════════════════════════════
const getMyBookings = async (req, res) => {
    try {
        const userId = req.user.id;
        const { status } = req.query;

        let query = `
      SELECT
        b.id,
        b.center_id,
        b.center_name,
        b.center_address,
        b.booking_date,
        b.time_slot,
        b.slot_time,
        b.waste_types,
        b.estimated_kg,
        b.actual_kg,
        b.notes,
        b.status,
        b.failure_reason,
        b.cancelled_at,
        b.completed_at,
        b.receipt_url,
        b.created_at,
        rc.lat,
        rc.lng,
        rc.phone,
        rc.closes_at
      FROM bookings b
      LEFT JOIN recycling_centers rc ON rc.id = b.center_id
      WHERE b.user_id = $1
    `;
        const params = [userId];

        if (status) {
            query += ` AND b.status = $2`;
            params.push(status);
        }

        query += ` ORDER BY b.created_at DESC`;

        const { rows } = await db.query(query, params);

        return res.json({
            success: true,
            bookings: rows,
            count: rows.length,
        });
    } catch (err) {
        console.error('getMyBookings error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch bookings.' });
    }
};

// ════════════════════════════════════════════════════════════════
// GET /api/bookings/:id
// Get single booking by ID (must belong to user)
// ════════════════════════════════════════════════════════════════
const getBookingById = async (req, res) => {
    try {
        const userId = req.user.id;
        const bookingId = parseInt(req.params.id);

        if (isNaN(bookingId)) {
            return res.status(400).json({ success: false, message: 'Invalid booking ID.' });
        }

        const { rows } = await db.query(
            `SELECT
        b.*,
        rc.lat, rc.lng, rc.phone, rc.closes_at, rc.accepted_types
       FROM bookings b
       LEFT JOIN recycling_centers rc ON rc.id = b.center_id
       WHERE b.id = $1 AND b.user_id = $2`,
            [bookingId, userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        // Also fetch status history
        const histRes = await db.query(
            `SELECT old_status, new_status, reason, changed_by, changed_at
       FROM booking_status_history
       WHERE booking_id = $1
       ORDER BY changed_at ASC`,
            [bookingId]
        );

        return res.json({
            success: true,
            booking: rows[0],
            history: histRes.rows,
        });
    } catch (err) {
        console.error('getBookingById error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch booking.' });
    }
};

// ════════════════════════════════════════════════════════════════
// DELETE /api/bookings/:id
// Cancel a booking (only if pending or confirmed) with notification
// ════════════════════════════════════════════════════════════════
const cancelBooking = async (req, res) => {
    try {
        const userId = req.user.id;
        const bookingId = parseInt(req.params.id);
        const { reason } = req.body;

        if (isNaN(bookingId)) {
            return res.status(400).json({ success: false, message: 'Invalid booking ID.' });
        }

        // Check booking exists and belongs to user
        const existing = await db.query(
            `SELECT b.id, b.status, b.center_name, b.booking_date, b.time_slot,
                    u.email, u.phone, u.full_name
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             WHERE b.id = $1 AND b.user_id = $2`,
            [bookingId, userId]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        const current = existing.rows[0];
        if (!['pending', 'confirmed'].includes(current.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel a booking with status "${current.status}".`,
            });
        }

        const oldStatus = current.status;

        await db.query(
            `UPDATE bookings
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = 'user',
           updated_at = NOW()
       WHERE id = $1`,
            [bookingId]
        );

        await db.query(
            `INSERT INTO booking_status_history
        (booking_id, old_status, new_status, reason, changed_by)
       VALUES ($1, $2, 'cancelled', $3, 'user')`,
            [bookingId, oldStatus, reason || null]
        );

        // Send cancellation notification
        const { email, phone, full_name } = current;
        if (email || phone) {
            const { sendNotification } = require('../services/notificationService');
            await sendNotification({
                email: email,
                phone: phone,
                name: full_name,
                type: 'booking_cancelled',
                data: {
                    center_name: current.center_name,
                    booking_date: current.booking_date,
                    reason: reason
                }
            }).catch(err => console.error('Cancellation notification failed:', err.message));
        }

        return res.json({
            success: true,
            message: 'Booking cancelled successfully. Confirmation sent to your email/phone.'
        });
    } catch (err) {
        console.error('cancelBooking error:', err);
        return res.status(500).json({ success: false, message: 'Failed to cancel booking.' });
    }
};

// ════════════════════════════════════════════════════════════════
// PUT /api/bookings/:id/complete
// Mark booking as completed (admin/system use) with notification
// ════════════════════════════════════════════════════════════════
const completeBooking = async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id);
        const { actual_kg, receipt_url } = req.body;

        if (isNaN(bookingId)) {
            return res.status(400).json({ success: false, message: 'Invalid booking ID.' });
        }

        const existing = await db.query(
            `SELECT b.id, b.status, b.user_id, b.center_name, b.booking_date,
                    u.email, u.phone, u.full_name
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             WHERE b.id = $1`,
            [bookingId]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        const current = existing.rows[0];
        if (current.status === 'completed') {
            return res.status(400).json({ success: false, message: 'Booking already completed.' });
        }

        const oldStatus = current.status;

        const { rows } = await db.query(
            `UPDATE bookings
       SET status       = 'completed',
           completed_at = NOW(),
           actual_kg    = COALESCE($2, actual_kg),
           receipt_url  = COALESCE($3, receipt_url),
           updated_at   = NOW()
       WHERE id = $1
       RETURNING *`,
            [bookingId, actual_kg || null, receipt_url || null]
        );

        await db.query(
            `INSERT INTO booking_status_history
        (booking_id, old_status, new_status, changed_by)
       VALUES ($1, $2, 'completed', 'system')`,
            [bookingId, oldStatus]
        );

        // Update user eco_points
        const pointsEarned = actual_kg ? Math.floor(actual_kg * 10) : 10;
        if (actual_kg) {
            await db.query(
                `UPDATE users
         SET eco_points = COALESCE(eco_points, 0) + $1,
             total_kg = COALESCE(total_kg, 0) + $2
         WHERE id = $3`,
                [pointsEarned, actual_kg, current.user_id]
            ).catch(() => { });
        }

        // Send completion notification with points earned
        const { email, phone, full_name } = current;
        if (email || phone) {
            const { sendNotification } = require('../services/notificationService');
            await sendNotification({
                email: email,
                phone: phone,
                name: full_name,
                type: 'points_earned',
                data: {
                    points: pointsEarned,
                    activity: `Waste collection at ${current.center_name}`,
                    totalPoints: pointsEarned
                }
            }).catch(err => console.error('Completion notification failed:', err.message));
        }

        return res.json({
            success: true,
            message: 'Booking completed successfully. Points awarded!',
            booking: rows[0],
            points_earned: pointsEarned
        });
    } catch (err) {
        console.error('completeBooking error:', err);
        return res.status(500).json({ success: false, message: 'Failed to complete booking.' });
    }
};

module.exports = {
    getCenters,
    createBooking,
    getMyBookings,
    getBookingById,
    cancelBooking,
    completeBooking,
};
