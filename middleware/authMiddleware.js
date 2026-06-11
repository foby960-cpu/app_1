const jwt = require('jsonwebtoken');

// ── Middleware: verify Bearer JWT token ───────────────────────────────────────
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  // Expect header: "Authorization: Bearer <token>"
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Access token required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, username, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Token has expired, please log in again' });
    }
    return res.status(403).json({ message: 'Invalid token' });
  }
};

module.exports = { verifyToken };
