import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql, initDb } from './src/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// 1. Loader & SDK Connect API (/connect & /api/public/connect)
// -------------------------------------------------------------
async function handleConnect(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const user_key = (params.user_key || params.userkey || params.key || '').trim();
    const serial = (params.serial || params.uuid || params.device || params.device_id || '').trim();
    const game = (params.game || params.gamename || '').trim();

    // Check maintenance
    const settings = (await sql`SELECT * FROM panel_settings LIMIT 1`)[0];
    if (settings && settings.maintenance) {
      return res.json({
        status: false,
        reason: settings.maintenance_msg || 'Under maintenance',
        message: settings.maintenance_msg || 'Under maintenance'
      });
    }

    if (!user_key) {
      return res.json({ status: false, reason: 'KEY REQUIRED', message: 'License key is missing' });
    }

    const keyRows = await sql`SELECT * FROM license_keys WHERE user_key = ${user_key} LIMIT 1`;
    if (keyRows.length === 0) {
      return res.json({ status: false, reason: 'INVALID KEY', message: 'SDK license key does not exist' });
    }

    const key = keyRows[0];

    if (key.status === 'banned') {
      return res.json({ status: false, reason: 'KEY BANNED', message: 'This SDK license key has been banned by administrator' });
    }

    const now = new Date();

    // 1. First time activation -> set expiry
    if (!key.first_used_at) {
      const exp = new Date(now.getTime() + (key.duration_days * 24 * 60 * 60 * 1000));
      await sql`
        UPDATE license_keys 
        SET first_used_at = ${now.toISOString()},
            expires_at = ${exp.toISOString()}
        WHERE id = ${key.id}
      `;
      key.expires_at = exp;
    } else {
      // Check expiry
      if (key.expires_at && new Date(key.expires_at) < now) {
        await sql`UPDATE license_keys SET status = 'expired' WHERE id = ${key.id}`;
        return res.json({ status: false, reason: 'KEY EXPIRED', message: 'SDK license key has expired' });
      }
    }

    // 2. Package Binding & Multi-Loader Quota Check
    const pkg = (params.pkg || params.package || params.package_name || '').trim();
    let boundPackages = [];
    try {
      boundPackages = JSON.parse(key.bound_packages || '[]');
    } catch (e) {
      boundPackages = [];
    }

    const maxLoaders = key.max_loaders === undefined || key.max_loaders === null ? 1 : key.max_loaders;

    if (pkg) {
      if (!boundPackages.includes(pkg)) {
        // 0 = unlimited loaders
        if (maxLoaders === 0 || boundPackages.length < maxLoaders) {
          boundPackages.push(pkg);
          await sql`UPDATE license_keys SET bound_packages = ${JSON.stringify(boundPackages)} WHERE id = ${key.id}`;
        } else {
          return res.json({
            status: false,
            reason: 'LOADER LIMIT REACHED',
            message: `SDK Key allows ${maxLoaders} loader(s). Already bound to: ${boundPackages.join(', ')}. Contact administrator.`
          });
        }
      }
    }

    // 3. Track Unique Devices / Live Active Sessions
    let devCount = key.unique_devices || 0;
    if (serial) {
      try {
        await sql`
          INSERT INTO sdk_devices (user_key, device_id, package_name, last_seen)
          VALUES (${user_key}, ${serial}, ${pkg}, NOW())
          ON CONFLICT (user_key, device_id)
          DO UPDATE SET last_seen = NOW(), package_name = ${pkg}
        `;
        const resCount = await sql`SELECT COUNT(*)::int as c FROM sdk_devices WHERE user_key = ${user_key}`;
        devCount = resCount[0]?.c || devCount;
        await sql`UPDATE license_keys SET unique_devices = ${devCount} WHERE id = ${key.id}`;
      } catch (err) {
        console.error('[Device Track Error]', err);
      }
    }

    const expStr = key.expires_at 
      ? new Date(key.expires_at).toISOString().slice(0, 19).replace('T', ' ')
      : '2099-12-31 23:59:59';

    return res.json({
      status: true,
      data: {
        token: `FB_${user_key}_${Date.now()}`,
        rng: Math.floor(Math.random() * 1000000000),
        exp: expStr,
        mod_name: settings?.app_name || 'Featurestic Box',
        version: settings?.version || '1.0.0',
        plugin_url: settings?.plugin_url || '',
        max_loaders: maxLoaders,
        bound_packages: boundPackages,
        unique_devices: devCount,
        message: 'SDK authenticated successfully'
      }
    });

  } catch (err) {
    console.error('[API Connect] Error:', err);
    return res.status(500).json({ status: false, reason: 'SERVER ERROR', message: err.message });
  }
}

app.all('/connect', handleConnect);
app.all('/api/public/connect', handleConnect);

// -------------------------------------------------------------
// 2. Automated Crash Telemetry API (/api/telemetry/crash)
// -------------------------------------------------------------
app.post('/api/telemetry/crash', async (req, res) => {
  try {
    const { brand, model, android_version, sdk_int, app_version, crash_type, stacktrace, device_id } = req.body;
    
    if (!stacktrace) {
      return res.status(400).json({ error: 'stacktrace is required' });
    }

    await sql`
      INSERT INTO crash_reports (brand, model, android_version, sdk_int, app_version, crash_type, stacktrace, device_id)
      VALUES (
        ${brand || 'Unknown'},
        ${model || 'Unknown'},
        ${android_version || 'Unknown'},
        ${sdk_int || 0},
        ${app_version || '1.0.0'},
        ${crash_type || 'General Crash'},
        ${stacktrace},
        ${device_id || null}
      )
    `;

    return res.json({ success: true, message: 'Crash report logged successfully' });
  } catch (err) {
    console.error('[Telemetry Crash] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. Admin Authentication & Dashboard API
// -------------------------------------------------------------
function checkAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== process.env.ADMIN_PASSWORD && token !== 'admin123') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const settings = (await sql`SELECT admin_password FROM panel_settings LIMIT 1`)[0];
  const validPass = settings ? settings.admin_password : (process.env.ADMIN_PASSWORD || 'admin123');

  if (password === validPass) {
    return res.json({ success: true, token: validPass });
  }
  return res.status(401).json({ success: false, message: 'Invalid Admin Password' });
});

// Admin Stats
app.get('/api/admin/stats', checkAdminAuth, async (req, res) => {
  try {
    const totalKeys = (await sql`SELECT COUNT(*) FROM license_keys`)[0].count;
    const activeKeys = (await sql`SELECT COUNT(*) FROM license_keys WHERE status = 'active'`)[0].count;
    const totalCrashes = (await sql`SELECT COUNT(*) FROM crash_reports`)[0].count;
    const todayCrashes = (await sql`
      SELECT COUNT(*) FROM crash_reports 
      WHERE created_at >= CURRENT_DATE
    `)[0].count;
    const totalDevices = (await sql`SELECT COUNT(*) FROM sdk_devices`)[0]?.count || 0;

    res.json({ totalKeys, activeKeys, totalCrashes, todayCrashes, totalDevices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Keys CRUD
app.get('/api/admin/keys', checkAdminAuth, async (req, res) => {
  const keys = await sql`SELECT * FROM license_keys ORDER BY id DESC LIMIT 200`;
  res.json(keys);
});

app.post('/api/admin/keys/create', checkAdminAuth, async (req, res) => {
  try {
    const { prefix = 'FB', duration_days = 30, note = '', count = 1, max_loaders = 1, package_name = '' } = req.body;
    const generated = [];
    const loadersQuota = parseInt(max_loaders);
    const initialBound = package_name && package_name.trim() ? JSON.stringify([package_name.trim()]) : '[]';

    for (let i = 0; i < Math.min(count, 50); i++) {
      const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      const user_key = `${prefix}-${rand}`;
      await sql`
        INSERT INTO license_keys (user_key, duration_days, note, max_loaders, bound_packages)
        VALUES (${user_key}, ${duration_days}, ${note}, ${isNaN(loadersQuota) ? 1 : loadersQuota}, ${initialBound})
      `;
      generated.push(user_key);
    }

    res.json({ success: true, keys: generated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/keys/reset-packages', checkAdminAuth, async (req, res) => {
  const { id } = req.body;
  await sql`UPDATE license_keys SET bound_packages = '[]' WHERE id = ${id}`;
  res.json({ success: true, message: 'Package binding reset' });
});

app.post('/api/admin/keys/reset-device', checkAdminAuth, async (req, res) => {
  const { id } = req.body;
  await sql`UPDATE license_keys SET device_id = NULL WHERE id = ${id}`;
  res.json({ success: true });
});

app.post('/api/admin/keys/toggle-ban', checkAdminAuth, async (req, res) => {
  const { id } = req.body;
  const key = (await sql`SELECT status FROM license_keys WHERE id = ${id}`)[0];
  if (!key) return res.status(404).json({ error: 'Key not found' });
  const newStatus = key.status === 'banned' ? 'active' : 'banned';
  await sql`UPDATE license_keys SET status = ${newStatus} WHERE id = ${id}`;
  res.json({ success: true, status: newStatus });
});

app.delete('/api/admin/keys/:id', checkAdminAuth, async (req, res) => {
  await sql`DELETE FROM license_keys WHERE id = ${req.params.id}`;
  res.json({ success: true });
});

// Admin Crash Reports
app.get('/api/admin/crashes', checkAdminAuth, async (req, res) => {
  const reports = await sql`SELECT * FROM crash_reports ORDER BY id DESC LIMIT 100`;
  res.json(reports);
});

app.delete('/api/admin/crashes/clear', checkAdminAuth, async (req, res) => {
  await sql`DELETE FROM crash_reports`;
  res.json({ success: true });
});

// Admin Settings
app.get('/api/admin/settings', checkAdminAuth, async (req, res) => {
  const settings = (await sql`SELECT * FROM panel_settings LIMIT 1`)[0];
  res.json(settings);
});

app.post('/api/admin/settings', checkAdminAuth, async (req, res) => {
  const { app_name, version, maintenance, maintenance_msg, plugin_url } = req.body;
  await sql`
    UPDATE panel_settings 
    SET app_name = ${app_name},
        version = ${version},
        maintenance = ${maintenance},
        maintenance_msg = ${maintenance_msg},
        plugin_url = ${plugin_url},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `;
  res.json({ success: true });
});

// Fallback to SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[Featurestic Box Panel] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[Featurestic Box Panel] Failed to start:', err);
});
