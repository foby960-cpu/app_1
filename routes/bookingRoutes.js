// ─────────────────────────────────────────────────────────────────────────────
// 📁 SAVE TO: routes/bookingRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const {
    getCenters,
    createBooking,
    getMyBookings,
    getBookingById,
    cancelBooking,
    completeBooking,
} = require('../controllers/bookingController');

// ── Public ────────────────────────────────────────────────────────────────────
// GET /api/bookings/centers?waste_type=Plastic
router.get('/centers', getCenters);

// ── Protected (requires JWT) ──────────────────────────────────────────────────
// GET  /api/bookings/mine?status=pending&page=1
router.get('/mine', auth, getMyBookings);

// GET  /api/bookings/:id
router.get('/:id', auth, getBookingById);

// POST /api/bookings
router.post('/', auth, createBooking);

// DELETE /api/bookings/:id  (cancel)
router.delete('/:id', auth, cancelBooking);

// PUT /api/bookings/:id/complete
router.put('/:id/complete', auth, completeBooking);

module.exports = router;
