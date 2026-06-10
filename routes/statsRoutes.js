const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const statsController = require('../controllers/statsController');

// Clean, explicit reference mapping to protect against [object Undefined]
router.get('/', auth, statsController.getDashboardStats || ((req, res) => res.status(501).json({ message: "Not Implemented" })));

module.exports = router;
