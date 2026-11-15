import app, { ensureDb } from '../server.js';

export default async function handler(req, res) {
  try {
    await ensureDb();
    return app(req, res);
  } catch (err) {
    console.error('[Vercel Serverless Handler Error]', err);
    return res.status(500).json({ error: 'Serverless Execution Error: ' + err.message });
  }
}
