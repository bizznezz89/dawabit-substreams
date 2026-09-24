import {
  formatUnits,
  getAddress,
  isAddress,
} from "viem";

import { db } from "./db.js";

import {
  quoteExactInput,
  quoteExactOutput,
} from "./market-execution.js";

const VENUE = {
  0: "UNAVAILABLE",
  1: "CURVE",
  2: "AMM",
};

function parseRawAmount(
  value,
) {
  if (
    typeof value !== "string" ||
    !/^[0-9]+$/.test(value)
  ) {
    return null;
  }

  try {
    const amount =
      BigInt(value);

    return amount > 0n
      ? amount
      : null;
  } catch {
    return null;
  }
}

function normalizedAmount(
  raw,
  decimals,
) {
  if (
    raw === null ||
    raw === undefined ||
    decimals === null ||
    decimals === undefined
  ) {
    return null;
  }

  return formatUnits(
    BigInt(raw),
    Number(decimals),
  );
}

function compactError(
  error,
) {
  const message =
    error?.shortMessage ??
    error?.message ??
    String(error);

  return String(message)
    .split("\n")[0]
    .slice(0, 500);
}

async function loadMetadata(
  addresses,
) {
  const result =
    await db.query(
      `
        SELECT
          LOWER(address) AS address,
          symbol,
          name,
          decimals

        FROM token_metadata

        WHERE
          LOWER(address) =
          ANY($1::text[])
      `,
      [
        addresses.map(
          (address) =>
            address.toLowerCase(),
        ),
      ],
    );

  return new Map(
    result.rows.map(
      (row) => [
        row.address,

        {
          symbol:
            row.symbol ??
            null,

          name:
            row.name ??
            null,

          decimals:
            row.decimals !== null &&
            row.decimals !== undefined
              ? Number(
                  row.decimals,
                )
              : null,
        },
      ],
    ),
  );
}

async function loadMarket(
  tokenIn,
  tokenOut,
) {
  const result =
    await db.query(
      `
        SELECT
          LOWER(curve) AS curve,
          LOWER(token) AS token,
          LOWER(quote_token) AS quote_token,
          creator

        FROM market_config

        WHERE
          (
            LOWER(token) = $1
            AND
            LOWER(quote_token) = $2
          )

          OR

          (
            LOWER(token) = $2
            AND
            LOWER(quote_token) = $1
          )

        LIMIT 1
      `,
      [
        tokenIn.toLowerCase(),
        tokenOut.toLowerCase(),
      ],
    );

  return (
    result.rows[0] ??
    null
  );
}

function tokenDescriptor(
  address,
  metadata,
) {
  return {
    address,

    symbol:
      metadata?.symbol ??
      null,

    name:
      metadata?.name ??
      null,

    decimals:
      metadata?.decimals ??
      null,
  };
}

export function registerQuoteRoute(
  app,
) {
  app.get(
    "/v1/quote",

    async (
      request,
      reply,
    ) => {
      const tokenInRaw =
        request.query.token_in;

      const tokenOutRaw =
        request.query.token_out;

      if (
        !isAddress(
          tokenInRaw ?? "",
        ) ||
        !isAddress(
          tokenOutRaw ?? "",
        )
      ) {
        return reply
          .code(400)
          .send({
            error:
              "invalid_token_address",

            required: [
              "token_in",
              "token_out",
            ],
          });
      }

      const tokenIn =
        getAddress(
          tokenInRaw,
        );

      const tokenOut =
        getAddress(
          tokenOutRaw,
        );

      if (
        tokenIn.toLowerCase() ===
        tokenOut.toLowerCase()
      ) {
        return reply
          .code(400)
          .send({
            error:
              "token_in_equals_token_out",
          });
      }

      const amountInParam =
        request.query
          .amount_in_raw ??
        null;

      const amountOutParam =
        request.query
          .amount_out_raw ??
        null;

      if (
        (
          amountInParam === null &&
          amountOutParam === null
        ) ||
        (
          amountInParam !== null &&
          amountOutParam !== null
        )
      ) {
        return reply
          .code(400)
          .send({
            error:
              "invalid_quote_mode",

            message:
              "Provide exactly one of amount_in_raw or amount_out_raw.",
          });
      }

      const exactInput =
        amountInParam !==
        null;

      const requestedAmount =
        parseRawAmount(
          exactInput
            ? amountInParam
            : amountOutParam,
        );

      if (
        requestedAmount ===
        null
      ) {
        return reply
          .code(400)
          .send({
            error:
              "invalid_amount",

            message:
              "Amount must be a positive base-10 integer in raw token units.",
          });
      }

      const [
        metadata,
        market,
      ] =
        await Promise.all([
          loadMetadata([
            tokenIn,
            tokenOut,
          ]),

          loadMarket(
            tokenIn,
            tokenOut,
          ),
        ]);

      if (!market) {
        return reply
          .code(404)
          .send({
            error:
              "unknown_market",

            token_in:
              tokenIn,

            token_out:
              tokenOut,
          });
      }

      const tokenInMetadata =
        metadata.get(
          tokenIn.toLowerCase(),
        ) ??
        null;

      const tokenOutMetadata =
        metadata.get(
          tokenOut.toLowerCase(),
        ) ??
        null;

      try {
        if (exactInput) {
          const quote =
            await quoteExactInput(
              tokenIn,
              tokenOut,
              requestedAmount,
            );

          const venue =
            VENUE[
              quote.venue
            ] ??
            "UNKNOWN";

          return {
            schema_version:
              "1.0",

            generated_at:
              new Date()
                .toISOString(),

            quote_source:
              "ReLaunchTradeRouter",

            mode:
              "EXACT_INPUT",

            venue,

            curve:
              market.curve,

            canonical_token:
              market.token,

            canonical_quote_token:
              market.quote_token,

            token_in:
              tokenDescriptor(
                tokenIn,
                tokenInMetadata,
              ),

            token_out:
              tokenDescriptor(
                tokenOut,
                tokenOutMetadata,
              ),

            request: {
              amount_in_raw:
                requestedAmount
                  .toString(),

              amount_in:
                normalizedAmount(
                  requestedAmount,
                  tokenInMetadata
                    ?.decimals,
                ),
            },

            result: {
              amount_in_used_raw:
                quote
                  .amount_in_used
                  .toString(),

              amount_in_used:
                normalizedAmount(
                  quote
                    .amount_in_used,

                  tokenInMetadata
                    ?.decimals,
                ),

              amount_out_raw:
                quote
                  .amount_out
                  .toString(),

              amount_out:
                normalizedAmount(
                  quote
                    .amount_out,

                  tokenOutMetadata
                    ?.decimals,
                ),

              refund_raw:
                quote
                  .refund
                  .toString(),

              refund:
                normalizedAmount(
                  quote
                    .refund,

                  tokenInMetadata
                    ?.decimals,
                ),

              partial_fill:
                quote.refund >
                0n,
            },
          };
        }

        const quote =
          await quoteExactOutput(
            tokenIn,
            tokenOut,
            requestedAmount,
          );

        const venue =
          VENUE[
            quote.venue
          ] ??
          "UNKNOWN";

        return {
          schema_version:
            "1.0",

          generated_at:
            new Date()
              .toISOString(),

          quote_source:
            "ReLaunchTradeRouter",

          mode:
            "EXACT_OUTPUT",

          venue,

          curve:
            market.curve,

          canonical_token:
            market.token,

          canonical_quote_token:
            market.quote_token,

          token_in:
            tokenDescriptor(
              tokenIn,
              tokenInMetadata,
            ),

          token_out:
            tokenDescriptor(
              tokenOut,
              tokenOutMetadata,
            ),

          request: {
            amount_out_raw:
              requestedAmount
                .toString(),

            amount_out:
              normalizedAmount(
                requestedAmount,
                tokenOutMetadata
                  ?.decimals,
              ),
          },

          result: {
            amount_in_raw:
              quote
                .amount_in
                .toString(),

            amount_in:
              normalizedAmount(
                quote
                  .amount_in,

                tokenInMetadata
                  ?.decimals,
              ),

            amount_out_requested_raw:
              requestedAmount
                .toString(),

            amount_out_requested:
              normalizedAmount(
                requestedAmount,
                tokenOutMetadata
                  ?.decimals,
              ),

            output_surplus_raw:
              quote
                .output_surplus
                .toString(),

            output_surplus:
              normalizedAmount(
                quote
                  .output_surplus,

                tokenOutMetadata
                  ?.decimals,
              ),
          },
        };
      } catch (
        error
      ) {
        request.log.warn(
          {
            err:
              error,

            tokenIn,
            tokenOut,

            mode:
              exactInput
                ? "EXACT_INPUT"
                : "EXACT_OUTPUT",
          },

          "quote unavailable",
        );

        return reply
          .code(422)
          .send({
            error:
              "quote_unavailable",

            mode:
              exactInput
                ? "EXACT_INPUT"
                : "EXACT_OUTPUT",

            token_in:
              tokenIn,

            token_out:
              tokenOut,

            detail:
              compactError(
                error,
              ),
          });
      }
    },
  );
}
