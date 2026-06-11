const express = require('express');
const router  = express.Router();
const { verifyAI, logWaste, getMyLogs } = require('../controllers/wasteController');
const { verifyToken } = require('../middleware/authMiddleware');

router.post('/verify-ai', verifyToken, verifyAI);
router.post('/log',       verifyToken, logWaste);
router.get('/my-logs',    verifyToken, getMyLogs);

module.exports = router;
