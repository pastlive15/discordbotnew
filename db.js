// db.js
const { Pool } = require('pg');

// Prefer a single DATABASE_URL; else fall back to individual PG_* vars
const {
  DATABASE_URL,
  PG_USER,
  PG_HOST,
  PG_DATABASE,
  PG_PASSWORD,
  PG_PORT = 5432,
  PGSSL,
} = process.env;

const config = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      ssl: PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
    }
  : {
      user: PG_USER,
      host: PG_HOST,
      database: PG_DATABASE,
      password: PG_PASSWORD,
      port: Number(PG_PORT) || 5432,
      ssl: PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
    };

const pool = new Pool(config);

module.exports = pool;
