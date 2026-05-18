module.exports = function handler(req, res) {
  res.setHeader(
    'Set-Cookie',
    'dsi_mgr=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
  return res.status(200).json({ ok: true });
};
