const pool = require('../config/db');

// -- Get Dashboard Stats ------------------------------------------------------
exports.getDashboardStats = async (req, res) => {
  try {
    // Basic structural stats query example
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    
    return res.status(200).json({
      success: true,
      data: {
        usersCount: parseInt(totalUsers.rows[0].count || 0)
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
