const express = require('express');
const router  = express.Router();
const { getMyStats, getLeaderboard } = require('../controllers/statsController');
const { verifyToken } = require('../middleware/authMiddleware');

router.get('/me',          verifyToken, getMyStats);
router.get('/leaderboard', verifyToken, getLeaderboard);

module.exports = router;
