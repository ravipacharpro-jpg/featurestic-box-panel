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

// Helper: Non-blocking Telegram Alerts
async function sendTelegramAlert(text, customBotToken = null, customChatId = null) {
  try {
    let token = '';
    let chat_id = '';
    if (customBotToken && customChatId) {
      token = customBotToken.trim();
      chat_id = customChatId.trim();
    } else {
      const settings = (await sql`SELECT telegram_alerts_enabled, telegram_bot_token, telegram_chat_id FROM panel_settings LIMIT 1`)[0];
      if (!settings || !settings.telegram_alerts_enabled || !settings.telegram_bot_token || !settings.telegram_chat_id) {
        return;
      }
      token = settings.telegram_bot_token.trim();
      chat_id = settings.telegram_chat_id.trim();
    }
    if (!token || !chat_id) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat_id,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(4000)
    }).catch(err => console.error('[Telegram Alert Error]', err.message));
  } catch (e) {
    console.error('[Telegram Alert Failed]', e.message);
  }
}

// Helper: System Audit & Error Logging
async function logSystem(action, message, level = 'info', details = {}, req = null, user_key = null, username = null) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '') : '';
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details);
    await sql`
      INSERT INTO system_logs (level, action, message, details, ip, user_key, username)
      VALUES (${level}, ${action}, ${message}, ${detailsStr}, ${String(ip).slice(0, 64)}, ${user_key}, ${username})
    `;
  } catch (e) {
    console.error('[logSystem Error]', e.message);
  }
}

// -------------------------------------------------------------
// 1. Loader & SDK Connect API (/connect & /api/public/connect)
// -------------------------------------------------------------
async function handleConnect(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const user_key = (params.user_key || params.userkey || params.license_key || params.key || '').trim();
    const serial = (params.serial || params.uuid || params.device || params.device_id || '').trim();
    const game = (params.game || params.gamename || '').trim();

    // 0. Global HWID Blacklist check
    if (serial) {
      const blacklisted = await sql`SELECT * FROM hwid_blacklist WHERE device_id = ${serial} LIMIT 1`;
      if (blacklisted.length > 0) {
        return res.json({
          status: false,
          reason: 'DEVICE_BANNED',
          message: `This device has been blacklisted: ${blacklisted[0].reason || 'Unauthorized security violation'}`
        });
      }
    }

    // Check maintenance
    const settings = (await sql`SELECT * FROM panel_settings LIMIT 1`)[0];
    if (settings && settings.maintenance) {
      return res.json({
        status: false,
        reason: settings.maintenance_msg || 'Under maintenance',
        message: settings.maintenance_msg || 'Under maintenance'
      });
    }

    // Emergency Safe Mode / Remote Kill Switch (freeze launches during game anti-cheat updates)
    if (settings && settings.emergency_safe_mode) {
      return res.json({
        status: false,
        reason: 'SAFE_MODE_ACTIVE',
        message: settings.emergency_safe_msg || 'Emergency Safe Mode is active due to a game security update. Please do not launch now.'
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

    // 2. Package Binding, Multi-Loader Quota & Per-Package Config Check
    const pkg = (params.pkg || params.package || params.package_name || '').trim();
    let packageConfigs = [];
    try {
      packageConfigs = JSON.parse(key.package_configs || '[]');
    } catch (e) {
      packageConfigs = [];
    }

    const maxLoaders = key.max_loaders === undefined || key.max_loaders === null ? 1 : key.max_loaders;
    const isBetaKey = key.account_type === 'beta' || (key.user_key && key.user_key.startsWith('FB-BETA-'));

    // Check if this is a Public Beta Key
    if (isBetaKey && !settings?.free_access_enabled) {
      return res.json({
        status: false,
        reason: 'BETA_CLOSED',
        message: 'Public Free Beta testing period has ended or is closed by the administrator.'
      });
    }

    let activePkgConfig = null;

    if (pkg) {
      if (isBetaKey) {
        // Public Beta Mode: Unlimited packages, auto-allow without restrictions
        activePkgConfig = packageConfigs.find(p => p.package_name && p.package_name.toLowerCase() === pkg.toLowerCase());
        if (!activePkgConfig) {
          activePkgConfig = {
            package_name: pkg,
            is_active: true,
            plugin_url: key.plugin_url || '',
            so_sha256: key.so_sha256 || '',
            update_apk_url: key.update_apk_url || '',
            update_version: key.update_version || '1.0.0'
          };
          packageConfigs.push(activePkgConfig);
          await sql`UPDATE license_keys SET package_configs = ${JSON.stringify(packageConfigs)} WHERE id = ${key.id}`;
        }
      } else if (packageConfigs.length > 0) {
        // Registered Client with structured package configs
        activePkgConfig = packageConfigs.find(p => p.package_name && p.package_name.toLowerCase() === pkg.toLowerCase());
        if (activePkgConfig) {
          if (!activePkgConfig.is_active) {
            return res.json({
              status: false,
              reason: 'PACKAGE_INACTIVE',
              message: `Package "${pkg}" is currently INACTIVE in your Client Portal. Please switch it to Active to run.`
            });
          }
        } else {
          // Package not found in client's package configs
          const activeCount = packageConfigs.filter(p => Boolean(p.is_active)).length;
          if (maxLoaders > 0 && activeCount >= maxLoaders) {
            return res.json({
              status: false,
              reason: 'LOADER LIMIT REACHED',
              message: `Active loader limit reached (${maxLoaders} package(s) allowed). Please manage your packages in your Client Portal.`
            });
          } else {
            // Under quota: auto-add as active
            activePkgConfig = {
              package_name: pkg,
              is_active: true,
              plugin_url: key.plugin_url || '',
              so_sha256: key.so_sha256 || '',
              update_apk_url: key.update_apk_url || '',
              update_version: key.update_version || '1.0.0'
            };
            packageConfigs.push(activePkgConfig);
            await sql`UPDATE license_keys SET package_configs = ${JSON.stringify(packageConfigs)} WHERE id = ${key.id}`;
          }
        }
      } else {
        // Fallback for legacy bound_packages
        let boundPackages = [];
        try { boundPackages = JSON.parse(key.bound_packages || '[]'); } catch(e) { boundPackages = []; }
        if (!boundPackages.includes(pkg)) {
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
        activePkgConfig = {
          package_name: pkg,
          is_active: true,
          plugin_url: key.plugin_url || '',
          so_sha256: key.so_sha256 || '',
          update_apk_url: key.update_apk_url || '',
          update_version: key.update_version || '1.0.0'
        };
        packageConfigs = [activePkgConfig];
        await sql`UPDATE license_keys SET package_configs = ${JSON.stringify(packageConfigs)} WHERE id = ${key.id}`;
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

    // Determine effective .so plugin URL:
    // Prioritize package-specific .so plugin URL -> Key plugin URL -> Global Admin (for internal keys only)
    let effectivePluginUrl = '';
    if (activePkgConfig && activePkgConfig.plugin_url && activePkgConfig.plugin_url.trim()) {
      effectivePluginUrl = activePkgConfig.plugin_url.trim();
    } else if (key.plugin_url && key.plugin_url.trim()) {
      effectivePluginUrl = key.plugin_url.trim();
    } else if (key.account_type === 'own' && settings?.plugin_url && settings.plugin_url.trim()) {
      effectivePluginUrl = settings.plugin_url.trim();
    }

    // Determine effective APK update URL & version (prioritize package-specific -> key -> settings)
    const effectiveApkUrl = (activePkgConfig && activePkgConfig.update_apk_url && activePkgConfig.update_apk_url.trim())
      ? activePkgConfig.update_apk_url.trim()
      : ((key.update_apk_url && key.update_apk_url.trim()) ? key.update_apk_url.trim() : (settings?.update_apk_url || ''));

    const effectiveApkVer = (activePkgConfig && activePkgConfig.update_version && activePkgConfig.update_version.trim())
      ? activePkgConfig.update_version.trim()
      : ((key.update_version && key.update_version.trim()) ? key.update_version.trim() : (settings?.update_version || '1.0.1'));

    const effectiveChangelog = (key.update_changelog && key.update_changelog.trim())
      ? key.update_changelog.trim()
      : (settings?.update_changelog || 'Latest performance updates & bug fixes');

    const hasApkUpdate = Boolean(effectiveApkUrl);

    // Determine .so SHA-256 Anti-Tamper Checksum (package-specific -> key -> settings)
    const effectiveSoSha256 = (activePkgConfig && activePkgConfig.so_sha256 && activePkgConfig.so_sha256.trim())
      ? activePkgConfig.so_sha256.trim()
      : ((key.so_sha256 && key.so_sha256.trim()) ? key.so_sha256.trim() : (key.account_type === 'own' ? (settings?.so_sha256 || '') : ''));

    // Developer Remote Config & Feature Flags
    let devConfig = {};
    try {
      devConfig = JSON.parse(key.developer_config || '{}');
    } catch(e) {
      devConfig = {};
    }

    // On-Screen Watermark for Beta Testing Keys
    const watermark = {
      enabled: Boolean(isBetaKey),
      text: isBetaKey ? 'FEATURESTIC BOX • FREE BETA VERSION' : '',
      subtext: isBetaKey ? 'Trial & Evaluation Only • Not For Resale' : '',
      position: 'top-center',
      color: '#00FF88',
      opacity: 0.85
    };

    if (isBetaKey) {
      devConfig.is_beta = true;
      devConfig.watermark_enabled = true;
      devConfig.watermark_text = 'FEATURESTIC BOX • FREE BETA VERSION';
    }

    // Log connection for audit
    await logSystem('CONNECT_SUCCESS', `Loader connected for key ${user_key} (${pkg || 'unknown pkg'})`, 'connect', {
      pkg, serial, is_beta: isBetaKey, effectivePluginUrl
    }, req, user_key, key.client_username);

    return res.json({
      status: true,
      data: {
        token: `FB_${user_key}_${Date.now()}`,
        rng: Math.floor(Math.random() * 1000000000),
        exp: expStr,
        mod_name: settings?.app_name || 'Featurestic Box',
        version: settings?.version || '1.0.0',
        plugin_url: effectivePluginUrl,
        so_sha256: effectiveSoSha256,
        so_token: `SO_${Buffer.from(user_key).toString('base64')}_${Date.now()}`,
        config: devConfig,
        watermark: watermark,
        is_beta: isBetaKey,
        max_loaders: maxLoaders,
        bound_packages: (activePkgConfig ? [activePkgConfig.package_name] : []),
        unique_devices: devCount,
        update: {
          has_update: hasApkUpdate,
          latest_version: effectiveApkVer,
          apk_url: effectiveApkUrl,
          changelog: effectiveChangelog,
          force_update: false
        },
        notice: {
          id: settings?.broadcast_notice_id || 0,
          message: settings?.broadcast_notice || ''
        },
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
//    Supports Java Exception Stacktraces & Native .so / Signal Offsets
// -------------------------------------------------------------
app.post('/api/telemetry/crash', async (req, res) => {
  try {
    const { 
      brand, model, android_version, sdk_int, app_version, 
      crash_type, stacktrace, device_id, user_key 
    } = req.body;
    
    if (!stacktrace) {
      return res.status(400).json({ error: 'stacktrace is required' });
    }

    const st = String(stacktrace);

    // Auto-detect Native .so Crashes vs Java Exception
    const isNativeSignal = /SIGSEGV|SIGBUS|SIGFPE|SIGILL|SIGABRT|signal 11|signal 7|fault addr|backtrace:/i.test(st);
    const crash_category = req.body.crash_category || (isNativeSignal ? 'native_so' : 'java');

    // Extract .so library name if present (e.g. libFeaturesticBox.so or custom.so)
    let so_name = req.body.so_name || null;
    if (!so_name) {
      const soMatch = st.match(/([\w\-\.]+\.so)/i);
      if (soMatch) so_name = soMatch[1];
    }

    // Extract crash fault offset / PC address (e.g. pc 00014a38 or +0x14a38)
    let fault_offset = req.body.fault_offset || null;
    if (!fault_offset) {
      const pcMatch = st.match(/(?:pc\s+([0-9a-fA-F]{4,16})|\+0x([0-9a-fA-F]{2,12}))/i);
      if (pcMatch) fault_offset = (pcMatch[1] || pcMatch[2]).toUpperCase();
    }

    // Look up client_username if key was provided
    let client_username = null;
    const finalKey = user_key ? String(user_key).trim() : null;
    if (finalKey) {
      const kRow = (await sql`SELECT client_username FROM license_keys WHERE user_key = ${finalKey} LIMIT 1`)[0];
      if (kRow) client_username = kRow.client_username;
    }

    await sql`
      INSERT INTO crash_reports (
        brand, model, android_version, sdk_int, app_version, 
        crash_type, crash_category, so_name, fault_offset, user_key, client_username,
        stacktrace, device_id
      )
      VALUES (
        ${brand || 'Unknown'},
        ${model || 'Unknown'},
        ${android_version || 'Unknown'},
        ${sdk_int || 0},
        ${app_version || '1.0.0'},
        ${crash_type || (isNativeSignal ? 'Native Signal Crash' : 'Java Crash')},
        ${crash_category},
        ${so_name},
        ${fault_offset},
        ${finalKey},
        ${client_username},
        ${stacktrace},
        ${device_id || null}
    `;

    // Non-blocking Telegram alert on native crash detection
    if (crash_category === 'native_so' || isNativeSignal) {
      sendTelegramAlert(
        `🚨 <b>Native Crash Telemetry (.so)</b>\n\n` +
        `<b>Library:</b> <code>${so_name || 'libFeaturesticBox.so'}</code>\n` +
        `<b>Offset:</b> <code>${fault_offset || 'N/A'}</code>\n` +
        `<b>Key:</b> <code>${finalKey || 'N/A'}</code>\n` +
        `<b>Client:</b> <code>${client_username || 'Admin/Own'}</code>\n` +
        `<b>Device:</b> ${brand || ''} ${model || ''} (SDK ${sdk_int || 'N/A'})\n\n` +
        `<b>Stacktrace:</b>\n<pre>${st.slice(0, 350)}</pre>`
      );
    }

    // Personal Telegram Alert for Developer/Client
    if (client_username && (crash_category === 'native_so' || isNativeSignal)) {
      try {
        const clientAcc = (await sql`
          SELECT telegram_bot_token, telegram_chat_id, telegram_alerts_enabled 
          FROM client_accounts 
          WHERE username = ${client_username} LIMIT 1
        `)[0];
        if (clientAcc && clientAcc.telegram_alerts_enabled && clientAcc.telegram_bot_token && clientAcc.telegram_chat_id) {
          sendTelegramAlert(
            `🚨 <b>Developer .so Crash Alert</b> 🚨\n━━━━━━━━━━━━━━━━━━━━\n` +
            `📦 <b>Library:</b> <code>${so_name || 'libFeaturesticBox.so'}</code>\n` +
            `⚡ <b>Offset:</b> <code>+${fault_offset || 'N/A'}</code> (Press G in IDA/Ghidra)\n` +
            `🛑 <b>Signal:</b> ${crash_type || 'SIGSEGV'}\n` +
            `📱 <b>Device:</b> ${brand || ''} ${model || ''} (Android ${android_version || '?'})\n` +
            `🔑 <b>Key:</b> <code>${finalKey || 'N/A'}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<pre>${st.slice(0, 300)}</pre>`,
            clientAcc.telegram_bot_token,
            clientAcc.telegram_chat_id
          );
        }
      } catch (err) {
        console.error('[Developer Telegram Alert Error]', err);
      }
    }

    return res.json({ 
      success: true, 
      message: 'Crash report logged successfully',
      category: crash_category,
      so_name,
      fault_offset
    });
  } catch (err) {
    console.error('[Telemetry Crash] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. Multi-Role Authentication (Master Admin + Client Portals)
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

async function checkClientAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];

  // Admin has master access to client routes too
  if (token === process.env.ADMIN_PASSWORD || token === 'admin123') {
    req.isAdmin = true;
    return next();
  }

  if (!token.startsWith('CLT_')) {
    return res.status(403).json({ error: 'Invalid client token' });
  }

  const tokenMatch = token.match(/^CLT_(.+)_\d+$/);
  if (!tokenMatch) {
    return res.status(403).json({ error: 'Invalid client token format' });
  }
  const username = tokenMatch[1];
  const clientRow = (await sql`SELECT * FROM client_accounts WHERE username = ${username} LIMIT 1`)[0];
  if (!clientRow) {
    return res.status(403).json({ error: 'Client account not found' });
  }

  req.client = clientRow;
  next();
}

// Unified Login Route (Admin & Client)
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const settings = (await sql`SELECT admin_password FROM panel_settings LIMIT 1`)[0];
  const adminPass = settings ? settings.admin_password : (process.env.ADMIN_PASSWORD || 'admin123');

  // Check Master Admin
  if (!username || username === 'admin') {
    if (password === adminPass) {
      return res.json({ success: true, role: 'admin', token: adminPass, username: 'admin' });
    }
  }

  // Check Client Account
  if (username) {
    const client = (await sql`SELECT * FROM client_accounts WHERE username = ${username.trim()} LIMIT 1`)[0];
    if (client && client.password === password) {
      const token = `CLT_${client.username}_${client.id}`;
      return res.json({ 
        success: true, 
        role: 'client', 
        token, 
        username: client.username,
        user_key: client.user_key
      });
    }
  }

  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// Backward compatibility admin login
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const settings = (await sql`SELECT admin_password FROM panel_settings LIMIT 1`)[0];
  const validPass = settings ? settings.admin_password : (process.env.ADMIN_PASSWORD || 'admin123');

  if (password === validPass) {
    return res.json({ success: true, role: 'admin', token: validPass });
  }
  return res.status(401).json({ success: false, message: 'Invalid Admin Password' });
});

// -------------------------------------------------------------
// Public Free Access & Self-Registration (Open Beta / Trial Testing)
// -------------------------------------------------------------
app.get('/api/public/free-access', async (req, res) => {
  try {
    const settings = (await sql`SELECT free_access_enabled, free_access_duration, free_access_max_loaders FROM panel_settings LIMIT 1`)[0];
    res.json({
      enabled: Boolean(settings?.free_access_enabled),
      duration_days: settings?.free_access_duration || 3,
      max_loaders: settings?.free_access_max_loaders || 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/register-free-tester', async (req, res) => {
  try {
    const settings = (await sql`SELECT free_access_enabled, free_access_duration, free_access_max_loaders FROM panel_settings LIMIT 1`)[0];
    if (!settings?.free_access_enabled) {
      return res.status(403).json({ success: false, message: 'Free beta testing registration is currently closed by the administrator.' });
    }

    const { username, password, trial_days } = req.body;
    const u = (username || '').trim();
    const p = (password || '').trim();

    if (!u || !p) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }
    if (u.length < 3 || p.length < 4) {
      return res.status(400).json({ success: false, message: 'Username min 3 characters, password min 4 characters' });
    }

    const existing = (await sql`SELECT id FROM client_accounts WHERE username = ${u} LIMIT 1`)[0];
    if (existing) {
      return res.status(400).json({ success: false, message: `Username "${u}" is already taken. Please choose another or login.` });
    }

    const maxAllowed = settings.free_access_duration || 3;
    const requestedDays = parseInt(trial_days);
    const finalDuration = (!isNaN(requestedDays) && requestedDays > 0 && requestedDays <= maxAllowed)
      ? requestedDays
      : maxAllowed;

    const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const user_key = `FB-FREE-${rand}`;
    const maxLoaders = settings.free_access_max_loaders || 1;

    await sql`
      INSERT INTO license_keys (
        user_key, duration_days, note, max_loaders, bound_packages, account_type, client_username
      )
      VALUES (
        ${user_key}, ${finalDuration}, 'Public Free Beta Tester', ${maxLoaders}, '[]', 'client', ${u}
      )
    `;

    const clientRow = (await sql`
      INSERT INTO client_accounts (username, password, user_key, note)
      VALUES (${u}, ${p}, ${user_key}, 'Public Free Beta Tester')
      RETURNING id
    `)[0];

    const token = `CLT_${u}_${clientRow.id}`;

    // Non-blocking Telegram alert on free tester registration
    sendTelegramAlert(
      `👤 <b>New Free Beta Tester Registered</b>\n\n` +
      `<b>Username:</b> <code>${u}</code>\n` +
      `<b>Assigned Key:</b> <code>${user_key}</code>\n` +
      `<b>Trial Duration:</b> ${finalDuration} Days\n` +
      `<b>Device Quota:</b> 1 Device`
    );

    return res.json({
      success: true,
      role: 'client',
      token,
      username: u,
      user_key,
      duration_days: finalDuration,
      message: 'Free tester account created successfully!'
    });
  } catch (err) {
    console.error('[Free Tester Register] Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
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
    const { 
      prefix = 'FB', 
      duration_days = 30, 
      note = '', 
      count = 1, 
      max_loaders = 1, 
      package_name = '',
      account_type = 'own',
      client_username = '',
      client_password = '',
      plugin_url = '',
      update_apk_url = '',
      update_version = '1.0.0',
      update_changelog = ''
    } = req.body;

    const loadersQuota = parseInt(max_loaders);
    const initialBound = package_name && package_name.trim() ? JSON.stringify([package_name.trim()]) : '[]';

    if (account_type === 'client') {
      const u = (client_username || '').trim();
      const p = (client_password || '').trim();
      if (!u) {
        return res.status(400).json({ error: 'Client username is required' });
      }

      const existing = (await sql`SELECT id, password FROM client_accounts WHERE username = ${u} LIMIT 1`)[0];
      let finalPassword = p;

      if (!existing) {
        if (!p) {
          return res.status(400).json({ error: 'Client password is required for new accounts' });
        }
      } else {
        finalPassword = p || existing.password;
      }

      const cleanPrefix = (prefix || 'FB').trim().toUpperCase();
      const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      const user_key = `${cleanPrefix}-${rand}`;

      const initialConfigs = package_name && package_name.trim() ? JSON.stringify([{
        package_name: package_name.trim(),
        is_active: true,
        plugin_url: plugin_url.trim(),
        so_sha256: (req.body.so_sha256 || '').trim(),
        update_apk_url: update_apk_url.trim(),
        update_version: update_version.trim()
      }]) : '[]';

      await sql`
        INSERT INTO license_keys (
          user_key, duration_days, note, max_loaders, bound_packages, package_configs,
          account_type, client_username, plugin_url, update_apk_url, update_version, update_changelog
        )
        VALUES (
          ${user_key}, ${duration_days}, ${note}, ${isNaN(loadersQuota) ? 1 : loadersQuota}, ${initialBound}, ${initialConfigs},
          'client', ${u}, ${plugin_url.trim()}, ${update_apk_url.trim()}, ${update_version.trim()}, ${update_changelog.trim()}
        )
      `;

      if (existing) {
        await sql`
          UPDATE client_accounts 
          SET user_key = ${user_key}, 
              password = ${finalPassword},
              note = ${note || ''}
          WHERE id = ${existing.id}
        `;
      } else {
        await sql`
          INSERT INTO client_accounts (username, password, user_key, note)
          VALUES (${u}, ${finalPassword}, ${user_key}, ${note})
        `;
      }

      return res.json({ 
        success: true, 
        keys: [user_key],
        client: { username: u, password: finalPassword, user_key, is_new: !existing } 
      });
    }

    // Default: 'own' key(s)
    const generated = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      const user_key = `${prefix}-${rand}`;
      await sql`
        INSERT INTO license_keys (
          user_key, duration_days, note, max_loaders, bound_packages, account_type
        )
        VALUES (
          ${user_key}, ${duration_days}, ${note}, ${isNaN(loadersQuota) ? 1 : loadersQuota}, ${initialBound}, 'own'
        )
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

// Admin Clients Management
app.get('/api/admin/clients', checkAdminAuth, async (req, res) => {
  try {
    const clients = await sql`
      SELECT ca.id, ca.username, ca.password, ca.user_key, ca.note, ca.created_at,
             lk.status as key_status, lk.expires_at, lk.unique_devices, lk.max_loaders, 
             lk.bound_packages, lk.plugin_url, lk.update_apk_url, lk.update_version
      FROM client_accounts ca
      LEFT JOIN license_keys lk ON ca.user_key = lk.user_key
      ORDER BY ca.id DESC
    `;
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/clients/:id', checkAdminAuth, async (req, res) => {
  try {
    const client = (await sql`SELECT user_key FROM client_accounts WHERE id = ${req.params.id}`)[0];
    if (client && client.user_key) {
      await sql`DELETE FROM license_keys WHERE user_key = ${client.user_key}`;
    }
    await sql`DELETE FROM client_accounts WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Regenerate Client Key
app.post('/api/admin/clients/:id/regenerate-key', checkAdminAuth, async (req, res) => {
  try {
    const client = (await sql`SELECT * FROM client_accounts WHERE id = ${req.params.id}`)[0];
    if (!client) return res.status(404).json({ error: 'Client account not found' });

    const oldKey = (await sql`SELECT * FROM license_keys WHERE user_key = ${client.user_key}`)[0];
    const prefix = req.body.prefix || 'FB';
    const cleanPrefix = prefix.trim().toUpperCase();
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${cleanPrefix}-${rand}`;

    const duration = oldKey ? oldKey.duration_days : 30;
    const loadersQuota = oldKey ? oldKey.max_loaders : 1;
    const pluginUrl = oldKey ? (oldKey.plugin_url || '') : '';
    const apkUrl = oldKey ? (oldKey.update_apk_url || '') : '';
    const apkVer = oldKey ? (oldKey.update_version || '1.0.0') : '1.0.0';
    const soSha = oldKey ? (oldKey.so_sha256 || '') : '';
    const note = client.note || oldKey?.note || 'Regenerated by Admin';

    if (oldKey) {
      await sql`DELETE FROM sdk_devices WHERE user_key = ${client.user_key}`;
      await sql`DELETE FROM license_keys WHERE user_key = ${client.user_key}`;
    }

    await sql`
      INSERT INTO license_keys (
        user_key, duration_days, note, max_loaders, bound_packages,
        account_type, client_username, plugin_url, update_apk_url, update_version, so_sha256
      )
      VALUES (
        ${newKey}, ${duration}, ${note}, ${loadersQuota}, '[]',
        'client', ${client.username}, ${pluginUrl}, ${apkUrl}, ${apkVer}, ${soSha}
      )
    `;

    await sql`UPDATE client_accounts SET user_key = ${newKey} WHERE id = ${client.id}`;

    res.json({ success: true, key: newKey, username: client.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Toggle Client Key Status (Active / Paused)
app.post('/api/admin/clients/:id/toggle-status', checkAdminAuth, async (req, res) => {
  try {
    const client = (await sql`SELECT * FROM client_accounts WHERE id = ${req.params.id}`)[0];
    if (!client || !client.user_key) return res.status(404).json({ error: 'Client or assigned key not found' });

    const key = (await sql`SELECT status FROM license_keys WHERE user_key = ${client.user_key}`)[0];
    if (!key) return res.status(404).json({ error: 'Assigned key not found' });

    const nextStatus = key.status === 'active' ? 'banned' : 'active';
    await sql`UPDATE license_keys SET status = ${nextStatus} WHERE user_key = ${client.user_key}`;

    res.json({ success: true, status: nextStatus, username: client.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Edit Client Account & Key Settings
app.post('/api/admin/clients/:id/edit', checkAdminAuth, async (req, res) => {
  try {
    const client = (await sql`SELECT * FROM client_accounts WHERE id = ${req.params.id}`)[0];
    if (!client) return res.status(404).json({ error: 'Client account not found' });

    const { 
      password, 
      note, 
      duration_days, 
      max_loaders, 
      plugin_url, 
      update_apk_url, 
      update_version,
      so_sha256 
    } = req.body;

    const newPassword = (password && password.trim()) ? password.trim() : client.password;
    const newNote = note !== undefined ? note.trim() : (client.note || '');

    await sql`
      UPDATE client_accounts 
      SET password = ${newPassword}, note = ${newNote}
      WHERE id = ${client.id}
    `;

    if (client.user_key) {
      const q = parseInt(max_loaders);
      const d = parseInt(duration_days);

      await sql`
        UPDATE license_keys 
        SET note = ${newNote},
            duration_days = ${isNaN(d) ? 30 : d},
            max_loaders = ${isNaN(q) ? 1 : q},
            plugin_url = ${plugin_url !== undefined ? plugin_url.trim() : ''},
            update_apk_url = ${update_apk_url !== undefined ? update_apk_url.trim() : ''},
            update_version = ${update_version !== undefined ? update_version.trim() : '1.0.0'},
            so_sha256 = ${so_sha256 !== undefined ? so_sha256.trim() : ''}
        WHERE user_key = ${client.user_key}
      `;
    }

    res.json({ success: true, message: 'Client details updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Crash Reports with Category and Client Filtering
app.get('/api/admin/crashes', checkAdminAuth, async (req, res) => {
  try {
    const { category, client } = req.query;
    let reports;
    if (category === 'native_so') {
      if (client === '__own__') {
        reports = await sql`SELECT * FROM crash_reports WHERE crash_category = 'native_so' AND (client_username IS NULL OR client_username = '') ORDER BY id DESC LIMIT 150`;
      } else if (client) {
        reports = await sql`SELECT * FROM crash_reports WHERE crash_category = 'native_so' AND client_username = ${client} ORDER BY id DESC LIMIT 150`;
      } else {
        reports = await sql`SELECT * FROM crash_reports WHERE crash_category = 'native_so' ORDER BY id DESC LIMIT 150`;
      }
    } else if (category === 'java') {
      if (client === '__own__') {
        reports = await sql`SELECT * FROM crash_reports WHERE (crash_category = 'java' OR crash_category IS NULL) AND (client_username IS NULL OR client_username = '') ORDER BY id DESC LIMIT 150`;
      } else if (client) {
        reports = await sql`SELECT * FROM crash_reports WHERE (crash_category = 'java' OR crash_category IS NULL) AND client_username = ${client} ORDER BY id DESC LIMIT 150`;
      } else {
        reports = await sql`SELECT * FROM crash_reports WHERE (crash_category = 'java' OR crash_category IS NULL) ORDER BY id DESC LIMIT 150`;
      }
    } else {
      if (client === '__own__') {
        reports = await sql`SELECT * FROM crash_reports WHERE (client_username IS NULL OR client_username = '') ORDER BY id DESC LIMIT 150`;
      } else if (client) {
        reports = await sql`SELECT * FROM crash_reports WHERE client_username = ${client} ORDER BY id DESC LIMIT 150`;
      } else {
        reports = await sql`SELECT * FROM crash_reports ORDER BY id DESC LIMIT 150`;
      }
    }
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { 
    app_name, version, maintenance, maintenance_msg, plugin_url,
    free_access_enabled, free_access_duration, free_access_max_loaders,
    emergency_safe_mode, emergency_safe_msg, broadcast_notice,
    telegram_bot_token, telegram_chat_id, telegram_alerts_enabled,
    so_sha256 = '', update_apk_url = '', update_version = '1.0.1', update_changelog = ''
  } = req.body;
  await sql`
    UPDATE panel_settings 
    SET app_name = ${app_name},
        version = ${version},
        maintenance = ${Boolean(maintenance)},
        maintenance_msg = ${maintenance_msg},
        plugin_url = ${plugin_url},
        so_sha256 = ${so_sha256.trim()},
        update_apk_url = ${update_apk_url.trim()},
        update_version = ${update_version.trim()},
        update_changelog = ${update_changelog.trim()},
        free_access_enabled = ${Boolean(free_access_enabled)},
        free_access_duration = ${parseInt(free_access_duration) || 3},
        free_access_max_loaders = ${parseInt(free_access_max_loaders) || 1},
        emergency_safe_mode = ${Boolean(emergency_safe_mode)},
        emergency_safe_msg = ${emergency_safe_msg || 'Service temporarily paused for game security update. Please do not play now.'},
        broadcast_notice = ${broadcast_notice || ''},
        telegram_bot_token = ${telegram_bot_token || ''},
        telegram_chat_id = ${telegram_chat_id || ''},
        telegram_alerts_enabled = ${Boolean(telegram_alerts_enabled)},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `;
  res.json({ success: true });
});

// 1-Click Fast Toggle for Public Free Beta / Trial Access
app.post('/api/admin/toggle-free-access', checkAdminAuth, async (req, res) => {
  try {
    const settings = (await sql`SELECT free_access_enabled FROM panel_settings LIMIT 1`)[0];
    const newStatus = !settings?.free_access_enabled;
    await sql`UPDATE panel_settings SET free_access_enabled = ${newStatus} WHERE id = 1`;
    res.json({ success: true, enabled: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1-Click Fast Toggle for Emergency Safe Mode (Game Anti-Cheat Kill Switch)
app.post('/api/admin/toggle-safe-mode', checkAdminAuth, async (req, res) => {
  try {
    const settings = (await sql`SELECT emergency_safe_mode, emergency_safe_msg FROM panel_settings LIMIT 1`)[0];
    const newStatus = !settings?.emergency_safe_mode;
    const msg = req.body.message || settings?.emergency_safe_msg || 'Service temporarily paused for game security update. Please do not play now.';
    await sql`UPDATE panel_settings SET emergency_safe_mode = ${newStatus}, emergency_safe_msg = ${msg} WHERE id = 1`;
    res.json({ success: true, emergency_safe_mode: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Broadcast Remote Notice (increments notice_id to notify all loaders)
app.post('/api/admin/broadcast-notice', checkAdminAuth, async (req, res) => {
  try {
    const { notice = '' } = req.body;
    await sql`
      UPDATE panel_settings 
      SET broadcast_notice = ${notice.trim()},
          broadcast_notice_id = broadcast_notice_id + 1
      WHERE id = 1
    `;
    const updated = (await sql`SELECT broadcast_notice, broadcast_notice_id FROM panel_settings LIMIT 1`)[0];
    res.json({ success: true, notice: updated.broadcast_notice, notice_id: updated.broadcast_notice_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global HWID Blacklist Endpoints
app.get('/api/admin/blacklist', checkAdminAuth, async (req, res) => {
  try {
    const list = await sql`SELECT * FROM hwid_blacklist ORDER BY id DESC LIMIT 200`;
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/blacklist/add', checkAdminAuth, async (req, res) => {
  try {
    const { device_id, reason = 'Unauthorized activity or leak attempt' } = req.body;
    if (!device_id || !device_id.trim()) {
      return res.status(400).json({ error: 'Device Hardware ID (HWID) is required' });
    }
    await sql`
      INSERT INTO hwid_blacklist (device_id, reason)
      VALUES (${device_id.trim()}, ${reason.trim()})
      ON CONFLICT (device_id) DO UPDATE SET reason = ${reason.trim()}
    `;
    res.json({ success: true, message: 'Device HWID blacklisted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/blacklist/:id', checkAdminAuth, async (req, res) => {
  try {
    await sql`DELETE FROM hwid_blacklist WHERE id = ${req.params.id}`;
    res.json({ success: true, message: 'Device HWID removed from blacklist' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Telegram Notification Test
app.post('/api/admin/telegram-test', checkAdminAuth, async (req, res) => {
  try {
    const settings = (await sql`SELECT telegram_bot_token, telegram_chat_id FROM panel_settings LIMIT 1`)[0];
    if (!settings?.telegram_bot_token || !settings?.telegram_chat_id) {
      return res.status(400).json({ error: 'Please enter and save both Telegram Bot Token and Chat ID first.' });
    }
    const token = settings.telegram_bot_token.trim();
    const chat_id = settings.telegram_chat_id.trim();
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat_id,
        text: '🟢 <b>Featurestic Box System Alert Test</b>\n\nTelegram webhook notifications are connected and working seamlessly!',
        parse_mode: 'HTML'
      }),
      signal: AbortSignal.timeout(5000)
    });
    const result = await resp.json();
    if (result.ok) {
      res.json({ success: true, message: 'Test message sent successfully to Telegram!' });
    } else {
      res.status(400).json({ error: result.description || 'Failed to send message via Telegram' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. Client Reseller & Buyer Portal Endpoints
// -------------------------------------------------------------

// Fetch Client Profile & Assigned Key
app.get('/api/client/me', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const clientAccount = (await sql`
      SELECT id, username, note, telegram_bot_token, telegram_chat_id, telegram_alerts_enabled 
      FROM client_accounts WHERE id = ${client.id} LIMIT 1
    `)[0] || client;

    const key = (await sql`SELECT * FROM license_keys WHERE user_key = ${client.user_key} LIMIT 1`)[0];
    const totalCrashes = (await sql`
      SELECT COUNT(*)::int as c FROM crash_reports 
      WHERE user_key = ${client.user_key} OR client_username = ${client.username}
    `)[0]?.c || 0;

    const nativeCrashes = (await sql`
      SELECT COUNT(*)::int as c FROM crash_reports 
      WHERE (user_key = ${client.user_key} OR client_username = ${client.username}) 
        AND crash_category = 'native_so'
    `)[0]?.c || 0;

    res.json({
      client: { 
        id: clientAccount.id, 
        username: clientAccount.username, 
        note: clientAccount.note,
        telegram_bot_token: clientAccount.telegram_bot_token || '',
        telegram_chat_id: clientAccount.telegram_chat_id || '',
        telegram_alerts_enabled: Boolean(clientAccount.telegram_alerts_enabled)
      },
      key: key || null,
      stats: {
        totalCrashes,
        nativeCrashes,
        uniqueDevices: key?.unique_devices || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Client Key (On / Off)
app.post('/api/client/toggle-status', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const key = (await sql`SELECT id, status FROM license_keys WHERE user_key = ${client.user_key} LIMIT 1`)[0];
    if (!key) return res.status(404).json({ error: 'License key not found' });

    const newStatus = key.status === 'banned' ? 'active' : 'banned';
    await sql`UPDATE license_keys SET status = ${newStatus} WHERE id = ${key.id}`;
    res.json({ success: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leak Protection: Regenerate Client Key (Preserves Exact Expiration & Quotas, Revokes Old Key & Devices)
app.post('/api/client/regenerate-key', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const key = (await sql`SELECT * FROM license_keys WHERE user_key = ${client.user_key} LIMIT 1`)[0];
    if (!key) return res.status(404).json({ error: 'Current license key not found' });

    const prefix = key.user_key.includes('-') ? key.user_key.split('-')[0] : 'FB';
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${prefix}-${rand}`;
    const oldKey = key.user_key;

    // Update key string in license_keys, preserving expires_at, quotas, and wiping cached device binding
    await sql`
      UPDATE license_keys 
      SET user_key = ${newKey}, device_id = NULL
      WHERE id = ${key.id}
    `;

    // Update client account record
    await sql`UPDATE client_accounts SET user_key = ${newKey} WHERE id = ${client.id}`;

    // Sever previous unauthorized device sessions
    await sql`DELETE FROM sdk_devices WHERE user_key = ${oldKey}`;

    // Update in-memory reference
    client.user_key = newKey;

    res.json({
      success: true,
      old_key: oldKey,
      new_key: newKey,
      expires_at: key.expires_at,
      message: 'Key successfully regenerated. Old key has been revoked and device sessions cleared.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Client Settings (.so URL, SHA-256 Checksum & In-App APK Auto Update config)
app.post('/api/client/settings', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const { 
      plugin_url = '', 
      update_apk_url = '', 
      update_version = '1.0.0', 
      update_changelog = '',
      so_sha256 = ''
    } = req.body;

    await sql`
      UPDATE license_keys 
      SET plugin_url = ${plugin_url.trim()},
          update_apk_url = ${update_apk_url.trim()},
          update_version = ${update_version.trim()},
          update_changelog = ${update_changelog.trim()},
          so_sha256 = ${so_sha256.trim()}
      WHERE user_key = ${client.user_key}
    `;

    res.json({ success: true, message: 'Client configuration updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Developer Personal Telegram Crash Alert Settings
app.post('/api/client/telegram', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const { bot_token = '', chat_id = '', enabled = false, send_test = false } = req.body;

    await sql`
      UPDATE client_accounts 
      SET telegram_bot_token = ${bot_token.trim()},
          telegram_chat_id = ${chat_id.trim()},
          telegram_alerts_enabled = ${Boolean(enabled)}
      WHERE id = ${client.id}
    `;

    if (send_test && bot_token && chat_id) {
      const resp = await fetch(`https://api.telegram.org/bot${bot_token.trim()}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat_id.trim(),
          text: `🟢 <b>Featurestic Box Developer Alert Connected</b>\n\nHello <b>@${client.username}</b>! Your Telegram crash alert bot is successfully active. You will receive live instant alerts whenever your .so crashes.`,
          parse_mode: 'HTML'
        }),
        signal: AbortSignal.timeout(5000)
      });
      const data = await resp.json();
      if (!data.ok) {
        return res.status(400).json({ error: data.description || 'Telegram test message delivery failed' });
      }
    }

    res.json({ success: true, message: send_test ? 'Telegram test message sent & settings saved!' : 'Telegram alert settings updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Developer Remote .so Config & Feature Flags
app.post('/api/client/config', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const { config = '{}' } = req.body;
    let parsed = {};
    try {
      parsed = typeof config === 'object' ? config : JSON.parse(config);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON format for remote config' });
    }
    const configStr = JSON.stringify(parsed, null, 2);
    await sql`UPDATE license_keys SET developer_config = ${configStr} WHERE user_key = ${client.user_key}`;
    res.json({ success: true, config: parsed, message: 'Remote .so config updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset Bound Package Names for Client
app.post('/api/client/reset-packages', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    await sql`UPDATE license_keys SET bound_packages = '[]' WHERE user_key = ${client.user_key}`;
    res.json({ success: true, message: 'Package bindings reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scoped Crash Telemetry for Client
app.get('/api/client/crashes', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const { category } = req.query;
    let reports;

    if (category === 'native_so') {
      reports = await sql`
        SELECT * FROM crash_reports 
        WHERE (user_key = ${client.user_key} OR client_username = ${client.username}) 
          AND crash_category = 'native_so'
        ORDER BY id DESC LIMIT 100
      `;
    } else if (category === 'java') {
      reports = await sql`
        SELECT * FROM crash_reports 
        WHERE (user_key = ${client.user_key} OR client_username = ${client.username}) 
          AND (crash_category = 'java' OR crash_category IS NULL)
        ORDER BY id DESC LIMIT 100
      `;
    } else {
      reports = await sql`
        SELECT * FROM crash_reports 
        WHERE (user_key = ${client.user_key} OR client_username = ${client.username})
        ORDER BY id DESC LIMIT 100
      `;
    }

    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Client Crashes
app.delete('/api/client/crashes/clear', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    await sql`DELETE FROM crash_reports WHERE user_key = ${client.user_key} OR client_username = ${client.username}`;
    res.json({ success: true, message: 'Crash logs cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PACKAGE CONFIGS MANAGEMENT (Per-Package .so & APK Update)
// =============================================================
app.get('/api/client/packages', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const key = (await sql`SELECT user_key, max_loaders, package_configs, plugin_url, update_apk_url, update_version, so_sha256 FROM license_keys WHERE user_key = ${client.user_key} LIMIT 1`)[0];
    if (!key) return res.status(404).json({ error: 'Assigned key not found' });

    let configs = [];
    try { configs = JSON.parse(key.package_configs || '[]'); } catch(e) { configs = []; }

    res.json({
      success: true,
      max_loaders: key.max_loaders === undefined ? 1 : key.max_loaders,
      packages: configs,
      default_plugin_url: key.plugin_url || '',
      default_apk_url: key.update_apk_url || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client/packages/save', checkClientAuth, async (req, res) => {
  try {
    const client = req.client;
    const key = (await sql`SELECT id, user_key, max_loaders FROM license_keys WHERE user_key = ${client.user_key} LIMIT 1`)[0];
    if (!key) return res.status(404).json({ error: 'Assigned key not found' });

    const packages = req.body.packages;
    if (!Array.isArray(packages)) {
      return res.status(400).json({ error: 'Packages must be an array' });
    }

    const maxLoaders = key.max_loaders === undefined ? 1 : key.max_loaders;
    let activeCount = packages.filter(p => Boolean(p.is_active)).length;

    // Enforce quota
    if (maxLoaders > 0 && activeCount > maxLoaders) {
      if (maxLoaders === 1) {
        let seen = false;
        for (let i = packages.length - 1; i >= 0; i--) {
          if (packages[i].is_active && !seen) {
            seen = true;
          } else if (packages[i].is_active && seen) {
            packages[i].is_active = false;
          }
        }
      } else {
        return res.status(400).json({ 
          error: `Quota exceeded: Your license key allows maximum ${maxLoaders} active loader package(s). Please deactivate one first.` 
        });
      }
    }

    const cleaned = packages.map(p => ({
      package_name: (p.package_name || '').trim(),
      is_active: Boolean(p.is_active),
      plugin_url: (p.plugin_url || '').trim(),
      so_sha256: (p.so_sha256 || '').trim(),
      update_apk_url: (p.update_apk_url || '').trim(),
      update_version: (p.update_version || '1.0.0').trim()
    })).filter(p => p.package_name.length > 0);

    const boundNames = cleaned.filter(p => p.is_active).map(p => p.package_name);

    await sql`
      UPDATE license_keys 
      SET package_configs = ${JSON.stringify(cleaned)},
          bound_packages = ${JSON.stringify(boundNames)}
      WHERE id = ${key.id}
    `;

    await logSystem('CLIENT_PACKAGES_UPDATED', `Client @${client.username} updated loader packages`, 'info', { active: boundNames }, req, client.user_key, client.username);

    res.json({ success: true, packages: cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Client Package Configs
app.get('/api/admin/clients/:id/packages', checkAdminAuth, async (req, res) => {
  try {
    const client = (await sql`SELECT * FROM client_accounts WHERE id = ${req.params.id}`)[0];
    if (!client) return res.status(404).json({ error: 'Client account not found' });
    const key = (await sql`SELECT * FROM license_keys WHERE user_key = ${client.user_key}`)[0];
    if (!key) return res.status(404).json({ error: 'Assigned key not found' });

    let configs = [];
    try { configs = JSON.parse(key.package_configs || '[]'); } catch(e) { configs = []; }
    res.json({ success: true, client, key, packages: configs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clients/:id/packages', checkAdminAuth, async (req, res) => {
  try {
    const client = (await sql`SELECT * FROM client_accounts WHERE id = ${req.params.id}`)[0];
    if (!client) return res.status(404).json({ error: 'Client account not found' });
    const key = (await sql`SELECT * FROM license_keys WHERE user_key = ${client.user_key}`)[0];
    if (!key) return res.status(404).json({ error: 'Assigned key not found' });

    const packages = req.body.packages;
    if (!Array.isArray(packages)) return res.status(400).json({ error: 'Packages must be an array' });

    const cleaned = packages.map(p => ({
      package_name: (p.package_name || '').trim(),
      is_active: Boolean(p.is_active),
      plugin_url: (p.plugin_url || '').trim(),
      so_sha256: (p.so_sha256 || '').trim(),
      update_apk_url: (p.update_apk_url || '').trim(),
      update_version: (p.update_version || '1.0.0').trim()
    })).filter(p => p.package_name.length > 0);

    const boundNames = cleaned.filter(p => p.is_active).map(p => p.package_name);

    await sql`
      UPDATE license_keys 
      SET package_configs = ${JSON.stringify(cleaned)},
          bound_packages = ${JSON.stringify(boundNames)}
      WHERE id = ${key.id}
    `;

    await logSystem('ADMIN_PACKAGES_UPDATED', `Admin updated packages for client @${client.username}`, 'info', { active: boundNames }, req, client.user_key, client.username);

    res.json({ success: true, packages: cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PUBLIC FREE BETA SYSTEM (Dedicated URL & 1-Click Key Claim)
// =============================================================
app.get('/api/public/beta-info', async (req, res) => {
  try {
    const settings = (await sql`SELECT free_access_enabled, free_access_duration, update_apk_url, update_version FROM panel_settings LIMIT 1`)[0];
    res.json({
      enabled: Boolean(settings?.free_access_enabled),
      duration_days: settings?.free_access_duration || 3,
      apk_url: settings?.update_apk_url || 'https://github.com/ravipacharpro-jpg/Fbox/releases/download/Floader/FeaturesticLoader-v1.0.1.apk',
      version: settings?.update_version || '1.0.1'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/claim-beta-key', async (req, res) => {
  try {
    const settings = (await sql`SELECT free_access_enabled, free_access_duration, update_apk_url, update_version FROM panel_settings LIMIT 1`)[0];
    if (!settings || !settings.free_access_enabled) {
      return res.status(403).json({
        success: false,
        message: 'Public Free Beta testing is currently closed by the administrator.'
      });
    }

    const duration = settings.free_access_duration || 3;
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const user_key = `FB-BETA-${rand}`;
    const now = new Date();
    const exp = new Date(now.getTime() + (duration * 24 * 60 * 60 * 1000));

    await sql`
      INSERT INTO license_keys (
        user_key, duration_days, note, max_loaders, bound_packages, package_configs, account_type,
        status, first_used_at, expires_at
      )
      VALUES (
        ${user_key}, ${duration}, 'Public Free Beta Key (Unlimited Loaders)', 0, '[]', '[]', 'beta',
        'active', ${now.toISOString()}, ${exp.toISOString()}
      )
    `;

    await logSystem('BETA_KEY_CLAIMED', `New Beta Key claimed: ${user_key}`, 'info', { duration, expires_at: exp }, req, user_key);

    res.json({
      success: true,
      key: user_key,
      duration_days: duration,
      expires_at: exp.toISOString(),
      max_loaders: 0,
      is_unlimited: true,
      apk_url: settings.update_apk_url || 'https://github.com/ravipacharpro-jpg/Fbox/releases/download/Floader/FeaturesticLoader-v1.0.1.apk',
      version: settings.update_version || '1.0.1'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================
// SYSTEM & AUDIT LOGS (Detect bugs & loader failures)
// =============================================================
app.get('/api/admin/logs', checkAdminAuth, async (req, res) => {
  try {
    const { level, limit = 150 } = req.query;
    let logs;
    const lim = Math.min(parseInt(limit) || 150, 300);
    if (level && level !== 'all') {
      logs = await sql`SELECT * FROM system_logs WHERE level = ${level} ORDER BY id DESC LIMIT ${lim}`;
    } else {
      logs = await sql`SELECT * FROM system_logs ORDER BY id DESC LIMIT ${lim}`;
    }
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/logs/clear', checkAdminAuth, async (req, res) => {
  try {
    await sql`TRUNCATE TABLE system_logs`;
    await logSystem('LOGS_CLEARED', 'System logs cleared by Admin', 'info', {}, req);
    res.json({ success: true, message: 'System logs cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
