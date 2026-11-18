# Live check

Everything in this check ran against a local mock. Nothing was sent to Paystack. There was no Paystack account, no sign-up, no live key, and no real money.

`PAYSTACK_TEST_SECRET_KEY` was unset in the environment. The connector used a throwaway `sk_test_` fixture that exists only inside `/workspace/tools/paystack/mock-server.mjs`. The mock listens on `127.0.0.1` and checks `Authorization: Bearer` with that fixture. A real `sk_live_` key was never loaded. The connector would refuse one on loopback anyway.

The webhook fixture is HMAC-SHA512 of a fixed JSON body, computed by the mock with the same throwaway key. It is not a Paystack signature.

## Runs

18 Nov 2026, after `npm run ci` (151 Vitest tests).

| Run | Mock | Result |
| --- | --- | --- |
| 1 | `127.0.0.1:43653`, then stopped | 23 passed, 0 failed |
| 2 | fresh start on `127.0.0.1:41303`, then stopped | 23 passed, 0 failed |

`stop.sh` between the runs removed the pid and the port file. After the second stop the pid file was gone.

## What the 23 checks covered

- Mock health.
- Signed webhook fixture matches a local HMAC.
- 12 MCP tools over stdio.
- Transaction list with `perPage`, `page`, `use_cursor`, and `next`.
- Banks with `country=ghana` and `type=mobile_money` (MTN).
- Balance and settlement list.
- Customer create preview while writes are off (`PAYSTACK_ALLOW_WRITES` named, nothing sent).
- Charge preview while both switches are off (both switch names, authorization code not echoed).
- Mock-injected HTTP 401, 403, 404, 422, and 429. 429 included `Retry-After: 7`, mapped to `retry after 7s`. No retry.
- Webhook verify: missing header, length mismatch, tampered body, wrong key, valid signature. The key was not in the tool result.
- Customer create sent only after `confirm: true` and `PAYSTACK_ALLOW_WRITES=true`.
- Refund create held when writes were on and `PAYSTACK_ALLOW_MONEY_MOVEMENT` was off. Reason: `Not sent. Missing PAYSTACK_ALLOW_MONEY_MOVEMENT=true.`
- Charge authorization sent only with both switches and `confirm: true`. The mock returned an authorization code and account number; the tool result masked the account to last4 and did not contain the authorization code.
- Transfer initiate sent under the same money gate.

## Codes the mock injected

| Code | How |
| --- | --- |
| 401 | `GET /transaction/err-401`, body `{status:false, message:"mock 401"}` |
| 403 | `GET /transaction/err-403` |
| 404 | `GET /transaction/err-404` |
| 422 | `GET /transaction/err-422` |
| 429 | `GET /transaction/err-429` plus `Retry-After: 7` |

A wrong bearer token also returns 401 from the mock. That path was not part of the 23 checks. HTTP 400, HTTP 200 with `{status:false}`, and HTTP 502 are covered by Vitest with a fake `fetch`, not by this mock run.

## Rerun

```bash
/workspace/tools/paystack/start.sh
PAYSTACK_MOCK_PORT=$(cat /workspace/tools/paystack/mock.port) npm run live-check
/workspace/tools/paystack/stop.sh
```

Run from `/workspace/connectors/paystack` after `npm run build`. `DATABASE_URL` is deleted inside the live-check script. Do not point `PAYSTACK_BASE_URL` at `https://api.paystack.co` for this script.
