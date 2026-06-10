const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const wasteController = require('../controllers/wasteController');

// Standardized mapping to prevent [object Undefined] crash loops
router.post('/', auth, wasteController.createWasteRequest || ((req, res) => res.status(501).json({ message: "Not Implemented" })));
router.get('/', auth, wasteController.getWasteRequests || ((req, res) => res.status(501).json({ message: "Not Implemented" })));

module.exports = router;
