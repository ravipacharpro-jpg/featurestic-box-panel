import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL not set in .env');
  process.exit(1);
}

export const sql = neon(connectionString);

export async function initDb() {
  try {
    console.log('[DB] Connecting to Neon PostgreSQL...');
    
    // 1. Settings Table
    await sql`
      CREATE TABLE IF NOT EXISTS panel_settings (
        id SERIAL PRIMARY KEY,
        app_name VARCHAR(128) DEFAULT 'Featurestic Box',
        version VARCHAR(32) DEFAULT '1.0.0',
        maintenance BOOLEAN DEFAULT FALSE,
        maintenance_msg TEXT DEFAULT 'Server under maintenance, please try again later.',
        plugin_url TEXT DEFAULT 'https://github.com/ravipacharpro-jpg/Fbox/releases/download/Floader/FeaturesticBox.so',
        admin_password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 2. License Keys Table
    await sql`
      CREATE TABLE IF NOT EXISTS license_keys (
        id SERIAL PRIMARY KEY,
        user_key VARCHAR(64) UNIQUE NOT NULL,
        device_id VARCHAR(256) DEFAULT NULL,
        duration_days INT DEFAULT 30,
        status VARCHAR(16) DEFAULT 'active', -- active, expired, banned
        note VARCHAR(256) DEFAULT '',
        max_loaders INT DEFAULT 1, -- 1 = single loader, 3 = 3 loaders, 0 = unlimited
        bound_packages TEXT DEFAULT '[]', -- JSON array of bound package names
        unique_devices INT DEFAULT 0,
        first_used_at TIMESTAMP DEFAULT NULL,
        expires_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Ensure columns exist on already-created tables
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS max_loaders INT DEFAULT 1`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS bound_packages TEXT DEFAULT '[]'`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS unique_devices INT DEFAULT 0`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS account_type VARCHAR(16) DEFAULT 'own'`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS client_username VARCHAR(64) DEFAULT NULL`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS plugin_url TEXT DEFAULT ''`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS update_apk_url TEXT DEFAULT ''`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS update_version VARCHAR(32) DEFAULT '1.0.0'`;
    await sql`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS update_changelog TEXT DEFAULT ''`;

    // 3. Client Accounts Table (for Resellers & Buyers)
    await sql`
      CREATE TABLE IF NOT EXISTS client_accounts (
        id SERIAL PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        user_key VARCHAR(64) DEFAULT NULL,
        note VARCHAR(256) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Unique devices tracking table
    await sql`
      CREATE TABLE IF NOT EXISTS sdk_devices (
        id SERIAL PRIMARY KEY,
        user_key VARCHAR(64) NOT NULL,
        device_id VARCHAR(256) NOT NULL,
        package_name VARCHAR(128) DEFAULT '',
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_key, device_id)
      )
    `;

    // 4. Crash Telemetry Table (Java + Native .so / Offset Analysis)
    await sql`
      CREATE TABLE IF NOT EXISTS crash_reports (
        id SERIAL PRIMARY KEY,
        brand VARCHAR(64) DEFAULT 'Unknown',
        model VARCHAR(128) DEFAULT 'Unknown',
        android_version VARCHAR(32) DEFAULT 'Unknown',
        sdk_int INT DEFAULT 0,
        app_version VARCHAR(32) DEFAULT '1.0.0',
        crash_type VARCHAR(128) DEFAULT 'Unknown',
        crash_category VARCHAR(16) DEFAULT 'java', -- 'java' or 'native_so'
        so_name VARCHAR(128) DEFAULT NULL,
        fault_offset VARCHAR(64) DEFAULT NULL,
        user_key VARCHAR(64) DEFAULT NULL,
        client_username VARCHAR(64) DEFAULT NULL,
        stacktrace TEXT NOT NULL,
        device_id VARCHAR(256) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await sql`ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS crash_category VARCHAR(16) DEFAULT 'java'`;
    await sql`ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS so_name VARCHAR(128) DEFAULT NULL`;
    await sql`ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS fault_offset VARCHAR(64) DEFAULT NULL`;
    await sql`ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS user_key VARCHAR(64) DEFAULT NULL`;
    await sql`ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS client_username VARCHAR(64) DEFAULT NULL`;

    // 5. Free Public Beta / Open Testing Columns
    await sql`ALTER TABLE panel_settings ADD COLUMN IF NOT EXISTS free_access_enabled BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE panel_settings ADD COLUMN IF NOT EXISTS free_access_duration INT DEFAULT 3`;
    await sql`ALTER TABLE panel_settings ADD COLUMN IF NOT EXISTS free_access_max_loaders INT DEFAULT 1`;

    // 4. Initial Settings row
    const settings = await sql`SELECT * FROM panel_settings LIMIT 1`;
    if (settings.length === 0) {
      await sql`
        INSERT INTO panel_settings (admin_password) 
        VALUES (${process.env.ADMIN_PASSWORD || 'admin123'})
      `;
      console.log('[DB] Initial settings seeded.');
    }

    console.log('[DB] Neon Database initialized successfully with all tables.');
  } catch (err) {
    console.error('[DB] Database init error:', err);
    throw err;
  }
}
