import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function installAdmin(app, password) {
  const sessions = new Map();
  const attempts = new Map();
  const lifetime = 8 * 60 * 60 * 1000;
  const digest = value => createHash('sha256').update(value).digest();
  const expected = password ? digest(password) : null;
  const token = req => /(?:^|;\s*)voicesite_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const prune = () => {
    for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= Date.now()) attempts.delete(key);
  };
  const sameOrigin = (req, res, next) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error: 'Cross-origin admin requests are not allowed.'});
    next();
  };
  const cookieOptions = req => ({httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', path: '/api'});
  app.use('/api/admin', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.post('/api/admin/login', sameOrigin, (req, res) => {
    prune();
    if (!expected) return res.status(503).json({error: 'Admin access is not configured. Set ADMIN_PASSWORD on the server.'});
    const key = req.socket.remoteAddress;
    const attempt = attempts.get(key) || {count: 0, until: Date.now() + 15 * 60 * 1000};
    if (attempt.count >= 10) return res.status(429).json({error: 'Too many sign-in attempts. Try again in 15 minutes.'});
    if (typeof req.body?.password !== 'string' || !timingSafeEqual(digest(req.body.password), expected)) {
      attempt.count++; attempts.set(key, attempt);
      return res.status(401).json({error: 'Incorrect admin password.'});
    }
    attempts.delete(key);
    sessions.delete(token(req));
    const session = randomBytes(32).toString('hex');
    sessions.set(session, Date.now() + lifetime);
    res.cookie('voicesite_admin', session, {...cookieOptions(req), maxAge: lifetime}).json({ok: true});
  });
  app.post('/api/admin/logout', sameOrigin, (req, res) => {
    sessions.delete(token(req));
    res.clearCookie('voicesite_admin', cookieOptions(req)).json({ok: true});
  });
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    prune();
    if (!expected || !sessions.has(token(req))) return res.status(401).json({error: 'Sign in with the admin password to view the global archive.'});
    next();
  };
}
