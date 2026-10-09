# EU Pay QA Assignment: Bug Hunt, Fixes and Automated Tests

QA Tester Intern assignment for **EU Pay**, submitted by **Vikas**.

A Node.js payment API (Express, Socket.IO, JWT, webhooks, e-invoicing) with intentional bugs. I tested it manually, found and fixed the bugs, wrote automated regression tests and documented everything.

## Results

| | |
|---|---|
| Planted bugs found and fixed | **7 / 7** (A to G) |
| Additional bugs found and fixed | **8** (H to O) |
| Automated tests | **83**, all passing |
| Tests failing on the original code | **45** (proves the tests catch the bugs) |

## Quick Start

Requires Node.js 20+.

```bash
git clone <this-repo-url>
cd qa-engineer-test
npm install
npm start        # API on http://localhost:3000
npm test         # runs all 83 tests
```

Seeded test login: `merchant@test.com` / `Test123!`

## Bugs at a Glance

| ID | Component | Severity | Issue |
|----|-----------|----------|-------|
| A | Payments | Medium | `amount` returned as string |
| B | Payments | High | No maximum payment amount |
| C | Auth | Medium | Email validation accepts `user@domain` |
| D | Webhooks | **Critical** | No HMAC signature verification |
| E | Webhooks | High | Not idempotent (replayed event overwrites newer status) |
| F | Table Orders | Medium | Duplicate pending orders per table |
| G | E-Invoice | Medium | Same invoice submitted to tax authority repeatedly |
| H | Auth | Medium | Documented test login always failed (invalid seeded hash) |
| I | Payments | Medium | `"0x10"` created a €0 payment (validation and parsing disagreed) |
| J | Platform | Low | Malformed JSON returned 500 instead of 400 |
| K | Table Orders | Medium | Socket.IO events never emitted |
| L | Table Orders | Medium | Negative or NaN prices and quantities accepted |
| M | Webhooks | High | E-invoice webhook unauthenticated and unsigned |
| N | Webhooks | Low | E-invoice webhook wiped `submission_id` |
| O | E-Invoice | Low | Rejected request still created a draft invoice |

Every fix is marked in the code with a `// FIX <letter>` comment. Existing endpoints and response shapes are unchanged.

## Documentation

| File | Contents |
|------|----------|
| [`bug-reports.md`](bug-reports.md) | Each bug with reproduction steps, expected vs actual, impact, root cause, plus unfixed security observations |
| [`fixes.md`](fixes.md) | Code diff and reasoning for each fix |
| [`test-plan.md`](test-plan.md) | Test plan for the webhook payment flow: 18 scenarios, security tests, edge cases, integration tests, risk assessment |
| [`README-SUBMISSION.md`](README-SUBMISSION.md) | Short summary of my approach |

## Testing Approach

- **Manual first:** reproduced every bug with curl against the running API, not just by reading code.
- **Test types:** happy path, negative, security (signature spoofing, tampered payloads, SQL injection, XSS, `alg: none` JWT), edge cases (boundaries, odd number formats, huge inputs) and concurrency (parallel duplicate webhooks, orders and submissions).
- **Automated:** Node's built-in test runner. Each test file starts the real `src/server.js` on a free port, so tests exercise the same code as `npm start` and run in parallel without collisions. A real `socket.io-client` verifies the real-time events.

```
src/routes/__tests__/
  auth.routes.test.js
  payment.routes.test.js
  webhook.routes.test.js
  table-order.routes.test.js
  einvoice.routes.test.js
  helpers.js
```

## Known Limitations and Observations

Flagged but intentionally not changed, because they would alter API contracts (details in `bug-reports.md`):

- `POST /api/table-orders` is unauthenticated and trusts `merchant_id` from the body
- Socket.IO rooms are unauthenticated
- JWT and webhook secrets are hard-coded (should come from environment variables)
- Webhooks have no signed timestamp, so replay protection depends on `event_id` storage
- The in-memory store loses processed event ids on restart (production needs a DB unique index)

## Tech Stack

Node.js, Express, Socket.IO, JWT, bcryptjs, `node:test`, `socket.io-client` (dev dependency).

---

Original assignment README: see the upstream repo [European-pay/qa-engineer-test](https://github.com/European-pay/qa-engineer-test).
