const pool = require('../config/db');

// ── GET /api/stats/me ─────────────────────────────────────────
const getMyStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query(
      'SELECT eco_points, total_kg FROM users WHERE id = $1',
      [userId]
    );

    const weekStart  = getWeekStart();
    const weekResult = await pool.query(
      'SELECT * FROM weekly_stats WHERE user_id=$1 AND week_start=$2',
      [userId, weekStart]
    );

    const totalLogs = await pool.query(
      'SELECT COUNT(*) AS trips, SUM(weight_kg) AS total_kg FROM waste_logs WHERE user_id=$1',
      [userId]
    );

    // Get user rank in current week
    const rankResult = await pool.query(
      `SELECT rank FROM (
         SELECT user_id, RANK() OVER (ORDER BY eco_points DESC) AS rank
         FROM weekly_stats WHERE week_start = $1
       ) ranked WHERE user_id = $2`,
      [weekStart, userId]
    );

    return res.status(200).json({
      total_eco_points: userResult.rows[0]?.eco_points || 0,
      total_kg:         parseFloat(userResult.rows[0]?.total_kg || 0).toFixed(2),
      total_trips:      parseInt(totalLogs.rows[0]?.trips || 0),
      this_week: {
        kg_collected: parseFloat(weekResult.rows[0]?.kg_collected || 0).toFixed(2),
        trips_made:   weekResult.rows[0]?.trips_made || 0,
        eco_points:   weekResult.rows[0]?.eco_points || 0,
        rank:         rankResult.rows[0]?.rank || null,
      },
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ── GET /api/stats/leaderboard ────────────────────────────────
const getLeaderboard = async (req, res) => {
  try {
    const weekStart = getWeekStart();
    const result = await pool.query(
      `SELECT ws.user_id, u.username, u.full_name, u.avatar_url,
              ws.eco_points, ws.kg_collected, ws.trips_made,
              RANK() OVER (ORDER BY ws.eco_points DESC) AS rank
       FROM weekly_stats ws
       JOIN users u ON ws.user_id = u.id
       WHERE ws.week_start = $1
       ORDER BY ws.eco_points DESC
       LIMIT 50`,
      [weekStart]
    );
    return res.status(200).json({ leaderboard: result.rows, week_start: weekStart });
  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

function getWeekStart() {
  const now  = new Date();
  const day  = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const mon  = new Date(now.setDate(diff));
  return mon.toISOString().split('T')[0];
}

module.exports = { getMyStats, getLeaderboard };
