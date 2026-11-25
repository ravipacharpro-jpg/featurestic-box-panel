import app, { ensureDb } from '../server.js';

let _warmed = false;

export default async function handler(req, res) {
  try {
    if (!_warmed) {
      // Non-blocking warm-up: do not stall the HTTP request on cold start schema verification
      ensureDb()
        .then(() => { _warmed = true; })
        .catch(err => console.error('[DB Warm Error]', err.message));
    }
    return app(req, res);
  } catch (err) {
    console.error('[Vercel Serverless Handler Error]', err);
    return res.status(500).json({ error: 'Serverless Execution Error: ' + err.message });
  }
}
