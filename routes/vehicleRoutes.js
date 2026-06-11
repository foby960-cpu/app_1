const express = require('express');
const router  = express.Router();
const { getNearbyVehicles, updateLocation } = require('../controllers/vehicleController');
const { verifyToken } = require('../middleware/authMiddleware');

router.get('/nearby',           verifyToken, getNearbyVehicles);
router.put('/:id/location',     verifyToken, updateLocation);

module.exports = router;
