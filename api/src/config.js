const DEFAULT_DATABASE_URL =
  "postgres://graph-node:let-me-in@localhost:5432/dawabit?sslmode=disable";

const DEFAULT_RHC_RPC_URL =
  "https://rpc.mainnet.chain.robinhood.com";

const DEFAULT_RELAUNCH_TRADE_ROUTER =
  "0x48AcF9c62384A6C15cCA80F6307cc29a5be2580B";

const nodeEnv =
  (
    process.env.NODE_ENV ??
    "development"
  ).trim();

const isProduction =
  nodeEnv ===
  "production";

function envValue(
  name,
) {
  const value =
    process.env[name];

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const trimmed =
    value.trim();

  return trimmed.length
    ? trimmed
    : null;
}

function requiredInProduction(
  name,
  developmentFallback,
) {
  const value =
    envValue(
      name,
    );

  if (value) {
    return {
      value,
      source:
        "environment",
    };
  }

  if (isProduction) {
    throw new Error(
      `[config] ${name} is required when NODE_ENV=production`,
    );
  }

  return {
    value:
      developmentFallback,

    source:
      "development_default",
  };
}

function integerEnv(
  name,
  fallback,
  {
    min = 0,
    max =
      Number.MAX_SAFE_INTEGER,
  } = {},
) {
  const raw =
    envValue(
      name,
    );

  if (!raw) {
    return fallback;
  }

  if (
    !/^[0-9]+$/.test(
      raw,
    )
  ) {
    throw new Error(
      `[config] ${name} must be an integer`,
    );
  }

  const value =
    Number.parseInt(
      raw,
      10,
    );

  if (
    !Number.isSafeInteger(
      value,
    ) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `[config] ${name} must be between ${min} and ${max}`,
    );
  }

  return value;
}

function validateHttpUrl(
  name,
  value,
) {
  let parsed;

  try {
    parsed =
      new URL(
        value,
      );
  } catch {
    throw new Error(
      `[config] ${name} must be a valid URL`,
    );
  }

  if (
    parsed.protocol !==
      "http:" &&
    parsed.protocol !==
      "https:"
  ) {
    throw new Error(
      `[config] ${name} must use http:// or https://`,
    );
  }

  return value;
}

function validateAddress(
  name,
  value,
) {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(
      value,
    )
  ) {
    throw new Error(
      `[config] ${name} must be a 20-byte EVM address`,
    );
  }

  return value;
}

/*
 * Fastify's trustProxy option changes whether forwarded
 * client-IP headers are trusted.
 *
 * We deliberately do NOT accept:
 *
 *   TRUST_PROXY_CIDRS=true
 *   TRUST_PROXY_CIDRS=*
 *
 * because either setting could allow spoofed
 * X-Forwarded-For data if the API becomes directly
 * reachable from the Internet.
 *
 * When the production proxy topology is known, configure
 * specific addresses/CIDRs such as:
 *
 *   TRUST_PROXY_CIDRS=127.0.0.1/32,172.18.0.0/16
 */
function parseTrustProxy() {
  const raw =
    envValue(
      "TRUST_PROXY_CIDRS",
    );

  if (!raw) {
    return false;
  }

  const entries =
    raw
      .split(",")
      .map(
        (value) =>
          value.trim(),
      )
      .filter(
        Boolean,
      );

  if (
    !entries.length
  ) {
    return false;
  }

  for (
    const entry of
    entries
  ) {
    const lowered =
      entry.toLowerCase();

    if (
      lowered === "true" ||
      lowered === "*" ||
      lowered === "0.0.0.0/0" ||
      lowered === "::/0"
    ) {
      throw new Error(
        "[config] TRUST_PROXY_CIDRS must contain specific trusted proxy addresses/CIDRs; unrestricted proxy trust is rejected",
      );
    }
  }

  return entries.length ===
    1
    ? entries[0]
    : entries;
}

const database =
  requiredInProduction(
    "DATABASE_URL",
    DEFAULT_DATABASE_URL,
  );

const rhcRpc =
  requiredInProduction(
    "RHC_RPC_URL",
    DEFAULT_RHC_RPC_URL,
  );

const tradeRouter =
  envValue(
    "RELAUNCH_TRADE_ROUTER",
  ) ??
  DEFAULT_RELAUNCH_TRADE_ROUTER;

export const config =
  Object.freeze({
    nodeEnv,

    isProduction,

    host:
      envValue(
        "HOST",
      ) ??
      "0.0.0.0",

    port:
      integerEnv(
        "PORT",
        3000,
        {
          min:
            1,

          max:
            65535,
        },
      ),

    databaseUrl:
      database.value,

    databaseSource:
      database.source,

    dbPoolMax:
      integerEnv(
        "DB_POOL_MAX",
        10,
        {
          min:
            1,

          max:
            100,
        },
      ),

    rhcRpcUrl:
      validateHttpUrl(
        "RHC_RPC_URL",
        rhcRpc.value,
      ),

    rhcRpcSource:
      rhcRpc.source,

    relaunchTradeRouter:
      validateAddress(
        "RELAUNCH_TRADE_ROUTER",
        tradeRouter,
      ),

    executionCacheTtlMs:
      integerEnv(
        "EXECUTION_CACHE_TTL_MS",
        10_000,
        {
          min:
            1_000,

          max:
            300_000,
        },
      ),

    rateLimit:
      Object.freeze({
        windowMs:
          integerEnv(
            "RATE_LIMIT_WINDOW_MS",
            60_000,
            {
              min:
                1_000,

              max:
                3_600_000,
            },
          ),

        globalMax:
          integerEnv(
            "RATE_LIMIT_GLOBAL_MAX",
            120,
            {
              min:
                1,

              max:
                100_000,
            },
          ),

        quoteMax:
          integerEnv(
            "RATE_LIMIT_QUOTE_MAX",
            30,
            {
              min:
                1,

              max:
                100_000,
            },
          ),
      }),

    trustProxy:
      parseTrustProxy(),
  });
