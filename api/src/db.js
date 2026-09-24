import pg from "pg";

const { Pool } = pg;

export const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://graph-node:let-me-in@localhost:5432/dawabit?sslmode=disable",
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function checkDatabase() {
  const result = await db.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}
