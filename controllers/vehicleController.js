const pool = require('../config/db');

// ── GET /api/vehicles/nearby ──────────────────────────────────
const getNearbyVehicles = async (req, res) => {
  try {
    const { lat, lng, radius_km = 5 } = req.query;

    const result = await pool.query(
      `SELECT v.*, u.full_name AS driver_name, u.phone AS driver_phone
       FROM vehicles v
       LEFT JOIN users u ON v.driver_id = u.id
       WHERE v.status != 'offline'
       ORDER BY v.updated_at DESC`,
    );

    return res.status(200).json({ vehicles: result.rows });
  } catch (err) {
    console.error('Vehicles error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ── PUT /api/vehicles/:id/location ────────────────────────────
const updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, status, eta_minutes } = req.body;

    await pool.query(
      `UPDATE vehicles SET latitude=$1, longitude=$2, status=COALESCE($3,status),
       eta_minutes=COALESCE($4,eta_minutes), updated_at=NOW() WHERE id=$5`,
      [latitude, longitude, status || null, eta_minutes || null, id]
    );

    return res.status(200).json({ message: 'Location updated' });
  } catch (err) {
    console.error('Update location error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { getNearbyVehicles, updateLocation };
