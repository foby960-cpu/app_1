const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const { getCenters, createBooking, getMyBookings, getBookingById, cancelBooking, completeBooking } = require('../controllers/bookingController');

router.get('/centers', auth, getCenters);
router.post('/', auth, createBooking);
router.get('/mine', auth, getMyBookings);
router.get('/:id', auth, getBookingById);
router.delete('/:id', auth, cancelBooking);
router.put('/:id/complete', auth, completeBooking);

module.exports = router;
