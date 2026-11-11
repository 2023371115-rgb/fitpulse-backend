const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function authMiddleware(req, res, next){
  const h = req.headers['authorization'];
  if(!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });
  const token = h.slice(7);
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    // Los ids son UUID (texto). Un sub numérico haría que MariaDB compare user_id = 0
    // convirtiendo el texto a número y coincidiría con otros usuarios (Práctica 12).
    if (typeof payload.sub !== 'string' || !payload.sub) return res.status(401).json({ error: 'invalid token' });
    req.user = { id: payload.sub, email: payload.email };
    return next();
  }catch(err){
    return res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = authMiddleware;
