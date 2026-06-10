const express = require('express');
const router = express.Router();
const { verifyAI, logWaste, getMyLogs } = require('../controllers/wasteController');
// Fixed: Imported directly without curly braces to match the direct export
const verifyToken = require('../middleware/authMiddleware');

// All waste logs endpoints secured with the verifyToken middleware function
router.post('/verify-ai', verifyToken, verifyAI);
router.post('/log', verifyToken, logWaste);
router.get('/my-logs', verifyToken, getMyLogs);

module.exports = router;