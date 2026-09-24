import {
  readFile,
} from "node:fs/promises";

import {
  fileURLToPath,
} from "node:url";

import pg from "pg";

const {
  Pool,
} = pg;

const databaseUrl =
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required",
  );
}

const db =
  new Pool({
    connectionString:
      databaseUrl,
  });

try {
  const result =
    await db.query(
      `
        SELECT
          to_regclass(
            'public.marketactivity'
          ) AS marketactivity,

          to_regclass(
            'public.curveactivity'
          ) AS curveactivity,

          to_regclass(
            'public.ammactivity'
          ) AS ammactivity
      `,
    );

  const relations =
    result.rows[0];

  const historicalReady =
    Boolean(
      relations.marketactivity &&
      relations.curveactivity &&
      relations.ammactivity
    );

  const sqlFile =
    historicalReady
      ? "activity-views.sql"
      : "activity-views-rpc-only.sql";

  const sqlPath =
    fileURLToPath(
      new URL(
        `../sql/${sqlFile}`,
        import.meta.url,
      ),
    );

  const sql =
    await readFile(
      sqlPath,
      "utf8",
    );

  await db.query(
    sql,
  );

  console.log({
    activityViews:
      "ready",

    mode:
      historicalReady
        ? "substreams_plus_rpc"
        : "rpc_only",

    sqlFile,
  });
} finally {
  await db.end();
}
