# paystack-mcp

MCP connector for the [Paystack API](https://paystack.com/docs/api/) aimed at the Accounts Team bots: Payment Matcher, Invoice Desk, Collections Desk, and Billing Support.

Paystack's official MCP (`@paystack/mcp-server`) is a public preview. It exposes two generic tools and **rejects `sk_live_` at startup**. This connector is built for production use with live keys, but only after an explicit opt-in, and it still refuses to move money unless two further switches are on.

Read-only by default. Writes are dry-run previews until `confirm: true` and `PAYSTACK_ALLOW_WRITES=true`. Money actions also need `PAYSTACK_ALLOW_MONEY_MOVEMENT=true`. Nothing is retried.

## Setup

```bash
cd paystack
npm ci
npm run build
```

stdio (what a Grok Bot or other MCP client launches):

```json
{
  "mcpServers": {
    "paystack": {
      "command": "node",
      "args": ["/absolute/path/paystack/dist/index.js"],
      "env": {
        "PAYSTACK_SECRET_KEY": "sk_test_..."
      }
    }
  }
}
```

Put the secret in the MCP client's env block, not in chat. Leave the write and money switches unset until the owner has said yes.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PAYSTACK_SECRET_KEY` | yes | | `sk_test_…` or, with the opt-in below, `sk_live_…`. `pk_` public keys are refused. `rk_` restricted keys are refused in this version. |
| `PAYSTACK_ALLOW_LIVE_KEY` | no | off | Must be the exact string `true` before an `sk_live_` key is accepted. |
| `PAYSTACK_BASE_URL` | no | `https://api.paystack.co` | Origin only. `http` is allowed solely for a loopback host. |
| `PAYSTACK_ALLOW_WRITES` | no | off | Exact `true` or every write and money action is a preview. |
| `PAYSTACK_ALLOW_MONEY_MOVEMENT` | no | off | Exact `true` or money actions stay a preview even when writes are on. |
| `PAYSTACK_PER_MINUTE` | no | 60 | Local cap. Paystack `429` is returned to the caller and not retried. |
| `PAYSTACK_TIMEOUT_MS` | no | 20000 | Per request. |
| `PAYSTACK_CACHE_TTL_SEC` | no | 0 | Cache GET responses. Payments stay uncached unless you set this. |
| `PAYSTACK_CONTACT` | no | | Contact string in the User-Agent. |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http`. `--http` selects HTTP. |
| `PORT` | no | 3000 | HTTP listen port when transport is `http`. |

`1`, `yes`, and `TRUE` do not enable a switch.

### Live keys

- `sk_test_…` is accepted with no extra flag.
- `sk_live_…` is refused unless `PAYSTACK_ALLOW_LIVE_KEY=true`.
- `pk_…` is refused. A public key is not a secret.
- If `PAYSTACK_BASE_URL` is loopback (`127.0.0.0/8`, `localhost`, or `::1`), an `sk_live_` key is refused even when the opt-in is set. A live key is never sent to a mock.
- A non-https base URL is refused unless the host is loopback.

The default base URL is fixed at `https://api.paystack.co`. Test and live modes are selected by the key, which is how Paystack works.

## Safety model

Every operation is tagged `read`, `write`, or `money` in `spec/api-inventory.json`. The generator emits a distinct TypeScript type for each. A money operation carries `moneyGate: "PAYSTACK_ALLOW_MONEY_MOVEMENT"`. `requireMoneyCheck` rejects a money operation that does not have that brand, and a write or read operation is not assignable to the money type.

| Risk | When a request is sent |
| --- | --- |
| read | Immediately. Includes `POST /bank/validate`, which only looks up an account name. |
| write | `confirm: true` and `PAYSTACK_ALLOW_WRITES=true`. Otherwise a preview, and no HTTP request. |
| money | Both of the write conditions, plus `PAYSTACK_ALLOW_MONEY_MOVEMENT=true`. The preview names every missing switch. |

Confirm `false` or omitted is a preview (`blocked: false`). A missing env switch is a preview with `blocked: true`.

### What counts as money

These debit, refund, or pay out, so they are `money`:

- `POST /transaction/charge_authorization`
- `POST /transaction/partial_debit`
- `POST /refund`
- `POST /transfer`, `POST /transfer/finalize_transfer`, `POST /transfer/bulk`

`POST /transaction/initialize` does not debit by itself. It creates a charge flow (an authorization URL the customer can pay). That is money movement, so initialize is `money` and needs `PAYSTACK_ALLOW_MONEY_MOVEMENT`.

Creating or notifying a payment request does not debit a saved card. Those stay `write`. Resolving a dispute as `merchant-accepted` can cause Paystack to refund the customer. That action stays `write`, because the refund is the dispute outcome rather than `POST /refund`. The preview says so. Treat it as financially sensitive.

### Amounts, currency, idempotency

Amounts are positive integers in the subunit Paystack expects. This connector does not convert major units.

| Currency | Unit to send |
| --- | --- |
| NGN | kobo (100 = 1 NGN) |
| GHS | pesewas (100 = 1 GHS) |
| ZAR, KES, USD, EGP | minor unit (100 = 1 major) |
| XOF | ISO 4217 has no minor unit. Pass the positive integer Paystack shows for XOF. Confirm it on the dashboard before a money call. |

Currency is one of `NGN`, `GHS`, `ZAR`, `KES`, `USD`, `XOF`, `EGP`.

List endpoints accept `perPage`, `page`, `use_cursor`, `next`, and `previous` where Paystack paginates that way. `perPage` and `page` are integers from 1 to 200.

Paystack dedupes charges and transfers with the `reference` you send. Pass a new reference for a new attempt and reuse it if you are retrying the same one. This connector does not invent an `Idempotency-Key` header; Paystack's documented idempotency for these calls is `reference`.

### Redaction

The secret key is stripped from logs, errors, and previews in exact, percent-encoded, JSON-escaped, and `Authorization: Bearer` forms. Authorization codes, signatures, OTPs, BVNs, document numbers, and webhook secrets are removed. Bank and card account numbers in responses are masked to the last four digits. The webhook tool never returns the key or the digest.

## Tools

Twelve tools. Eleven talk to Paystack. `paystack_webhook` stays on the machine.

| Tool | Actions (risk) |
| --- | --- |
| `paystack_transactions` | list, fetch, verify, timeline, totals, export (read); initialize, charge_authorization, partial_debit (money) |
| `paystack_customers` | list, fetch (read); create, update, validate, set_risk_action (write) |
| `paystack_invoices` | list, fetch, verify, totals (read); create, update, notify, finalize, archive (write). Paystack calls these payment requests. |
| `paystack_settlements` | list, transactions (read) |
| `paystack_refunds` | list, fetch (read); create (money) |
| `paystack_disputes` | list, fetch, transaction, export (read); update, evidence, resolve (write) |
| `paystack_transfers` | list, fetch, verify (read); initiate, finalize, bulk (money) |
| `paystack_recipients` | list, fetch (read); create, update, delete (write) |
| `paystack_balance` | balance, ledger (read) |
| `paystack_lookups` | banks, resolve_account, countries, states (read); verify_account (read lookup, `POST /bank/validate`) |
| `paystack_catalog` | subaccounts, plans, subscriptions, products, payment pages, list and fetch only (read) |
| `paystack_webhook` | verify_signature (local). HMAC-SHA512 of the raw body with the secret key, constant-time compare to `x-paystack-signature`. |

`set_risk_action` takes `allow` (whitelist) or `deny` (blacklist). Banks accept `country=ghana` and `type=mobile_money` for MoMo.

### Examples

Payment Matcher, twice-daily feed. Reads only:

```json
{ "action": "list", "perPage": 50, "page": 1, "status": "success", "currency": "GHS" }
```

Tool: `paystack_transactions`. Then `verify` on the reference, `paystack_settlements` `list`, and `paystack_balance` `balance`. For a MoMo credit, `paystack_lookups` `banks` with `country` `ghana` and `type` `mobile_money`.

Invoice Desk, draft a payment request. First call omits `confirm` and returns a preview. After the owner says yes, and only if `PAYSTACK_ALLOW_WRITES=true`:

```json
{
  "action": "create",
  "confirm": true,
  "customer": "CUS_example",
  "amount": 15000,
  "currency": "GHS",
  "description": "Repair job 104, balance after deposit"
}
```

Tool: `paystack_invoices`. 15000 pesewas is 150 GHS.

Collections Desk, prepare a refund and do not send it. With the money switch off, `confirm: true` still previews:

```json
{ "action": "create", "confirm": true, "transaction": "1001", "amount": 5000, "currency": "GHS" }
```

Tool: `paystack_refunds`. The preview names `PAYSTACK_ALLOW_MONEY_MOVEMENT` when that switch is off. Dispute reads use `paystack_disputes` `list` so chasing can stop.

Billing Support, after an identity check that this connector does not perform. Reads only:

```json
{ "action": "fetch", "code": "CUS_example" }
```

Tool: `paystack_customers`, then `paystack_invoices` `fetch` and `paystack_transactions` `verify`. This bot does not refund and does not call money actions.

Webhook check, no network:

```json
{
  "action": "verify_signature",
  "raw_body": "{\"event\":\"charge.success\"}",
  "signature": "<hex from x-paystack-signature>"
}
```

Tool: `paystack_webhook`.

## Coverage and exclusions

`spec/api-inventory.json` is hand-written from the Paystack API reference and the endpoint table in [PaystackOSS/paystack-python](https://github.com/PaystackOSS/paystack-python/blob/main/README.md). Purposes are original wording. `node scripts/gen-operations.mjs --check` (part of `npm run ci`) regenerates `src/operations.ts` and `paystack.routes.json` and fails if they drift.

Mapped: 64 routes (42 read, 15 write, 7 money). Excluded: 56 routes, including the interactive charge API (PIN, OTP, card data), bulk charge, dedicated virtual accounts, splits, subscription and plan writes, transfer OTP disable, and product or page writes. The full list with reasons is in the inventory.

There is no single-settlement fetch in the PaystackOSS Python endpoint table. List settlements and `GET /settlement/{id}/transaction` are mapped.

## Comparison

| Server | Tools | Live keys | Confirm gate | Money gate |
| --- | --- | --- | --- | --- |
| [PaystackOSS/paystack-mcp-server](https://github.com/PaystackOSS/paystack-mcp-server) (`@paystack/mcp-server`, MIT, public preview) | `get_paystack_operation`, `make_paystack_request`, plus an operations resource. The whole API is one generic caller. | Rejects `sk_live_` at startup. Test key only. | No | No |
| [kohasummons/paystack-mcp](https://github.com/kohasummons/paystack-mcp) (MIT) | Named tools for products, customers, transactions (initialize, verify, fetch, list, charge, partial debit, totals, export), and bank, country, and state lists. | `PAYSTACK_SECRET_KEY`. No live-key opt-in documented. | No | No |
| [samaxbytez/paystack-mcp](https://github.com/samaxbytez/paystack-mcp) (`paystack-mcp` on npm) | README claims 121 tools across transactions, charges, transfers, refunds, and disputes. | Accepts `sk_test_` and `sk_live_` with no extra opt-in. | No | No |
| [@tracent/paystack-mcp](https://www.npmjs.com/package/@tracent/paystack-mcp) | README describes ten future tools and human-in-the-loop writes. The published note says the surface is still landing. | Not a finished server to depend on. | Claimed, not shipped as a complete server | Claimed |

This connector trades breadth for gates: scoped actions, a live-key opt-in, a separate money switch, previews, and tests. It is not a wrapper around the official preview server.

## Development

```bash
npm run ci
```

`ci` is typecheck, lint, Vitest, build, and `node scripts/gen-operations.mjs --check`.

The live check does not call Paystack. See [LIVE-CHECK.md](LIVE-CHECK.md).

```bash
/workspace/tools/paystack/start.sh
PAYSTACK_MOCK_PORT=$(cat /workspace/tools/paystack/mock.port) npm run live-check
/workspace/tools/paystack/stop.sh
```

## Provenance

Inventory and wording are original, checked against Paystack's public API reference (retrieved 18 Nov 2026) and the PaystackOSS paystack-python endpoint table. No Paystack source is vendored. Official MCP behavior is from [the Paystack MCP docs](https://paystack.com/docs/developer-tools/mcp-server/) and the [PaystackOSS/paystack-mcp-server README](https://github.com/PaystackOSS/paystack-mcp-server/blob/main/README.md).

## License

MIT. See [LICENSE](LICENSE).
