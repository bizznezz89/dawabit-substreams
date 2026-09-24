import Fastify from "fastify";
import cors from "@fastify/cors";
import { db, checkDatabase } from "./db.js";
import { registerTrendingRoute } from "./trending.js";
import { registerMarketRoutes } from "./markets.js";

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
});

registerTrendingRoute(app);
registerMarketRoutes(app);

app.get("/health", async () => {
  const database = await checkDatabase();

  return {
    ok: true,
    service: "dawabit-api",
    database,
  };
});

app.get("/v1/activity", async (request) => {
  const {
    market,
    token,
    event_type,
    market_stage,
    canonical_trade,
    limit = "50",
  } = request.query;

  const values = [];
  const where = [];

  const add = (column, value) => {
    values.push(value);
    where.push(`${column} = $${values.length}`);
  };

  if (market) add("market", market.toLowerCase());
  if (token) add("token", token.toLowerCase());
  if (event_type) add("event_type", event_type);
  if (market_stage) add("market_stage", market_stage);

  if (canonical_trade !== undefined) {
    add("canonical_trade", canonical_trade === "true");
  }

  const safeLimit = Math.min(
    Math.max(Number.parseInt(limit, 10) || 50, 1),
    500,
  );

  values.push(safeLimit);

  const sql = `
    SELECT
      event_id,
      market_stage,
      event_type,
      canonical_trade,
      market,
      curve,
      pair,
      token,
      quote_token,
      block_number,
      transaction_hash,
      ordinal,
      _block_timestamp_ AS block_timestamp
    FROM marketactivity
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY block_number DESC, ordinal DESC
    LIMIT $${values.length}
  `;

  const result = await db.query(sql, values);

  return {
    count: result.rowCount,
    activity: result.rows,
  };
});

app.get("/v1/activity/:eventId", async (request, reply) => {
  const { eventId } = request.params;

  const market = await db.query(
    `
      SELECT *
      FROM marketactivity
      WHERE event_id = $1
    `,
    [eventId],
  );

  if (!market.rowCount) {
    return reply.code(404).send({
      error: "activity_not_found",
    });
  }

  const row = market.rows[0];

  let details = null;

  if (row.market_stage === "CURVE") {
    const result = await db.query(
      "SELECT * FROM curveactivity WHERE event_id = $1",
      [eventId],
    );

    details = result.rows[0] ?? null;
  } else if (row.market_stage === "AMM") {
    const result = await db.query(
      "SELECT * FROM ammactivity WHERE event_id = $1",
      [eventId],
    );

    details = result.rows[0] ?? null;
  }

  return {
    activity: row,
    details,
  };
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({
  port,
  host,
});
