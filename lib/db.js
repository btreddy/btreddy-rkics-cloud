const { Pool } = require('pg');

// Supabase gives you this connection string from Project Settings ->
// Database -> Connection string (use the "Transaction" pooler one for
// serverless — it handles many short-lived connections well, which is
// exactly what Vercel functions create).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;
