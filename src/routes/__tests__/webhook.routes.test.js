import { test, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startServer, request, registerMerchant, createPayment, postWebhook, sign, WEBHOOK_SECRET,
} from './helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.stop();
});

const hook = (payload, opts) => postWebhook(server.baseUrl, 'payment-status', payload, opts);
const getStatus = async (token, id) =>
  (await request(server.baseUrl, 'GET', `/api/payments/${id}`, { token })).body.data.status;

// Fresh merchant + payment per test so tests never share state
async function setup() {
  const merchant = await registerMerchant(server.baseUrl);
  const payment = await createPayment(server.baseUrl, merchant.token);
  let n = 0;
  const evt = () => `evt_${payment.id}_${Date.now()}_${n++}`;
  return { ...merchant, payment, evt };
}

// ---- Bug D: signature verification ----------------------------------------
test('Bug D: webhook without a signature header is rejected (401) and changes nothing', async () => {
  const m = await setup();
  const { status } = await request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {
    body: { payment_id: m.payment.id, status: 'completed', event_id: m.evt() },
  });
  assert.strictEqual(status, 401);
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'pending');
});

test('Bug D: webhook with a forged signature is rejected (401)', async () => {
  const m = await setup();
  const { status } = await hook(
    { payment_id: m.payment.id, status: 'completed', event_id: m.evt() },
    { signature: 'fake-signature' },
  );
  assert.strictEqual(status, 401);
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'pending');
});

test('Bug D: signature made with the wrong secret is rejected', async () => {
  const m = await setup();
  const payload = { payment_id: m.payment.id, status: 'completed', event_id: m.evt() };
  const { status } = await hook(payload, { signature: sign(JSON.stringify(payload), 'attacker-secret') });
  assert.strictEqual(status, 401);
});

test('Bug D: valid signature for a DIFFERENT body (tampered payload) is rejected', async () => {
  const m = await setup();
  const original = { payment_id: m.payment.id, status: 'pending', event_id: m.evt() };
  const tampered = { ...original, status: 'completed' };
  const { status } = await request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {
    raw: JSON.stringify(tampered),
    headers: { 'x-webhook-signature': sign(JSON.stringify(original)) },
  });
  assert.strictEqual(status, 401);
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'pending');
});

test('Bug D: truncated / different-length signature is rejected without crashing', async () => {
  const m = await setup();
  const payload = { payment_id: m.payment.id, status: 'completed', event_id: m.evt() };
  const full = sign(JSON.stringify(payload));
  for (const sig of [full.slice(0, 10), full + 'ff', '', 'x']) {
    const { status } = await hook(payload, { signature: sig });
    assert.strictEqual(status, 401);
  }
});

test('Bug D (happy path): correctly signed webhook updates the payment status', async () => {
  const m = await setup();
  const { status, body } = await hook({ payment_id: m.payment.id, status: 'completed', event_id: m.evt() });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.new_status, 'completed');
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'completed');
});

test('Bug D: signature is verified against the raw bytes (key order / whitespace preserved)', async () => {
  const m = await setup();
  const raw = `{ "status" : "failed",\n "event_id":"${m.evt()}", "payment_id":"${m.payment.id}" }`;
  const { status } = await request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {
    raw,
    headers: { 'x-webhook-signature': sign(raw) },
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'failed');
});

// ---- Bug E: idempotency ---------------------------------------------------
test('Bug E: replaying the same event_id is acknowledged but not re-applied', async () => {
  const m = await setup();
  const first = { payment_id: m.payment.id, status: 'completed', event_id: m.evt() };
  const newer = { payment_id: m.payment.id, status: 'refunded', event_id: m.evt() };

  assert.strictEqual((await hook(first)).status, 200);
  assert.strictEqual((await hook(newer)).status, 200);
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'refunded');

  // Provider retries the OLD event: must not roll the status back to "completed"
  const replay = await hook(first);
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.message, 'Already processed');
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'refunded');
});

test('Bug E: concurrent duplicate deliveries apply exactly once', async () => {
  const m = await setup();
  const payload = { payment_id: m.payment.id, status: 'completed', event_id: m.evt() };
  const results = await Promise.all(Array.from({ length: 10 }, () => hook(payload)));
  const processed = results.filter((r) => r.body.message === 'Webhook processed');
  const duplicates = results.filter((r) => r.body.message === 'Already processed');
  assert.strictEqual(processed.length, 1);
  assert.strictEqual(duplicates.length, 9);
});

test('Bug E: an event for an unknown payment (404) does not burn its event_id', async () => {
  const m = await setup();
  const eventId = m.evt();
  const early = await hook({ payment_id: 'not-created-yet', status: 'completed', event_id: eventId });
  assert.strictEqual(early.status, 404);

  // Same event retried once the payment exists must be processed, not skipped
  const retry = await hook({ payment_id: m.payment.id, status: 'completed', event_id: eventId });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.body.message, 'Webhook processed');
});

// ---- Input validation / security edge cases -------------------------------
test('webhook validation: missing payment_id / status / event_id return 400', async () => {
  const m = await setup();
  assert.strictEqual((await hook({ status: 'completed', event_id: m.evt() })).status, 400);
  assert.strictEqual((await hook({ payment_id: m.payment.id, event_id: m.evt() })).status, 400);
  assert.strictEqual((await hook({ payment_id: m.payment.id, status: 'completed' })).status, 400);
  assert.strictEqual((await hook({ payment_id: m.payment.id, status: 'completed', event_id: '' })).status, 400);
  assert.strictEqual((await hook({ payment_id: m.payment.id, status: 'completed', event_id: null })).status, 400);
});

test('webhook: unknown status values (incl. XSS payload) are rejected', async () => {
  const m = await setup();
  for (const status of ['<script>alert(1)</script>', 'hacked', 'COMPLETED', 42, {}]) {
    const { status: code } = await hook({ payment_id: m.payment.id, status, event_id: m.evt() });
    assert.strictEqual(code, 400, `status=${JSON.stringify(status)}`);
  }
  assert.strictEqual(await getStatus(m.token, m.payment.id), 'pending');
});

test('webhook: SQL-injection style payment_id is handled safely (404, no crash)', async () => {
  const m = await setup();
  const { status } = await hook({ payment_id: "1' OR '1'='1", status: 'completed', event_id: m.evt() });
  assert.strictEqual(status, 404);
});

test('webhook: very large payment_id and event_id length limit', async () => {
  const m = await setup();
  const big = await hook({ payment_id: '9'.repeat(10000), status: 'completed', event_id: m.evt() });
  assert.strictEqual(big.status, 404);
  const longEvent = await hook({ payment_id: m.payment.id, status: 'completed', event_id: 'e'.repeat(129) });
  assert.strictEqual(longEvent.status, 400);
});

test('webhook: malformed JSON returns 400', async () => {
  const raw = '{"payment_id": "1", ';
  const { status } = await request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {
    raw,
    headers: { 'x-webhook-signature': sign(raw) },
  });
  assert.strictEqual(status, 400);
});

test('webhook: empty body is rejected (401, nothing to verify)', async () => {
  const { status } = await request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {});
  assert.strictEqual(status, 401);
});

// ---- e-invoice webhook ----------------------------------------------------
test('e-invoice webhook: unsigned request is rejected, signed one updates status', async () => {
  const m = await setup();
  const invoice_id = `inv-wh-${Date.now()}`;
  await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
    token: m.token,
    body: { invoice_id, customer_siret: '12345678901234' },
  });

  const unsigned = await request(server.baseUrl, 'POST', '/api/webhooks/e-invoice', {
    body: { invoice_id, status: 'accepted' },
  });
  assert.strictEqual(unsigned.status, 401);

  const signed = await postWebhook(server.baseUrl, 'e-invoice', { invoice_id, status: 'accepted', tax_authority_id: 'TA-1' });
  assert.strictEqual(signed.status, 200);

  const status = await request(server.baseUrl, 'GET', `/api/einvoice/status/${invoice_id}`, { token: m.token });
  assert.strictEqual(status.body.data.einvoice_status, 'accepted');
  assert.strictEqual(status.body.data.tax_authority_id, 'TA-1');
  // status-only callback must not wipe the stored submission_id
  assert.match(status.body.data.submission_id, /^SUB-/);
});

test('e-invoice webhook: unknown invoice returns 404, missing fields 400', async () => {
  assert.strictEqual((await postWebhook(server.baseUrl, 'e-invoice', { invoice_id: 'nope', status: 'accepted' })).status, 404);
  assert.strictEqual((await postWebhook(server.baseUrl, 'e-invoice', { status: 'accepted' })).status, 400);
});

test('sanity: WEBHOOK_SECRET constant in tests matches the server', async () => {
  const m = await setup();
  const raw = JSON.stringify({ payment_id: m.payment.id, status: 'completed', event_id: m.evt() });
  assert.strictEqual(sign(raw), sign(raw, WEBHOOK_SECRET));
  const { status } = await request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {
    raw, headers: { 'x-webhook-signature': sign(raw) },
  });
  assert.strictEqual(status, 200);
});
