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
        first_used_at TIMESTAMP DEFAULT NULL,
        expires_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 3. Crash Telemetry Table
    await sql`
      CREATE TABLE IF NOT EXISTS crash_reports (
        id SERIAL PRIMARY KEY,
        brand VARCHAR(64) DEFAULT 'Unknown',
        model VARCHAR(128) DEFAULT 'Unknown',
        android_version VARCHAR(32) DEFAULT 'Unknown',
        sdk_int INT DEFAULT 0,
        app_version VARCHAR(32) DEFAULT '1.0.0',
        crash_type VARCHAR(128) DEFAULT 'Unknown',
        stacktrace TEXT NOT NULL,
        device_id VARCHAR(256) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

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
