import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, request, registerMerchant, postWebhook } from './helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.stop();
});

const SIRET = '12345678901234';
let seq = 0;
const newInvoiceId = () => `inv-${process.pid}-${Date.now()}-${seq++}`;
const submit = (token, body) => request(server.baseUrl, 'POST', '/api/einvoice/submit', { token, body });
const statusOf = (token, id) => request(server.baseUrl, 'GET', `/api/einvoice/status/${id}`, { token });

// ---- Bug G: duplicate submissions -----------------------------------------
test('Bug G: submitting the same invoice twice returns 409 the second time', async () => {
  const m = await registerMerchant(server.baseUrl);
  const invoice_id = newInvoiceId();

  const first = await submit(m.token, { invoice_id, customer_siret: SIRET });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.data.status, 'submitted');

  const second = await submit(m.token, { invoice_id, customer_siret: SIRET });
  assert.strictEqual(second.status, 409);
  assert.match(second.body.error, /already submitted/i);

  // the original submission must be untouched (no new submission_id issued)
  const status = await statusOf(m.token, invoice_id);
  assert.strictEqual(status.body.data.submission_id, first.body.data.submission_id);
});

test('Bug G: concurrent duplicate submissions result in exactly one success', async () => {
  const m = await registerMerchant(server.baseUrl);
  const invoice_id = newInvoiceId();
  const results = await Promise.all(Array.from({ length: 6 }, () => submit(m.token, { invoice_id, customer_siret: SIRET })));
  assert.strictEqual(results.filter((r) => r.status === 200).length, 1);
  assert.strictEqual(results.filter((r) => r.status === 409).length, 5);
});

test('Bug G: an already ACCEPTED invoice cannot be resubmitted', async () => {
  const m = await registerMerchant(server.baseUrl);
  const invoice_id = newInvoiceId();
  await submit(m.token, { invoice_id, customer_siret: SIRET });
  await postWebhook(server.baseUrl, 'e-invoice', { invoice_id, status: 'accepted' });
  assert.strictEqual((await submit(m.token, { invoice_id, customer_siret: SIRET })).status, 409);
});

test('Bug G: a REJECTED invoice may be corrected and resubmitted', async () => {
  const m = await registerMerchant(server.baseUrl);
  const invoice_id = newInvoiceId();
  await submit(m.token, { invoice_id, customer_siret: SIRET });
  await postWebhook(server.baseUrl, 'e-invoice', { invoice_id, status: 'rejected' });
  assert.strictEqual((await submit(m.token, { invoice_id, customer_siret: SIRET })).status, 200);
});

// ---- Validation -----------------------------------------------------------
test('submit: invalid SIRET values are rejected', async () => {
  const m = await registerMerchant(server.baseUrl);
  for (const siret of [undefined, '', '1234567890123', '123456789012345', 'ABCDEFGHIJKLMN', '1234567890123A', 12345678901234, null]) {
    const { status } = await submit(m.token, { invoice_id: newInvoiceId(), customer_siret: siret });
    assert.strictEqual(status, 400, `siret=${JSON.stringify(siret)}`);
  }
});

test('submit: a request rejected for a bad SIRET does not leave a draft invoice behind', async () => {
  const m = await registerMerchant(server.baseUrl);
  const invoice_id = newInvoiceId();
  assert.strictEqual((await submit(m.token, { invoice_id })).status, 400);
  assert.strictEqual((await statusOf(m.token, invoice_id)).status, 404);
});

test('submit: invoice_id is required', async () => {
  const m = await registerMerchant(server.baseUrl);
  assert.strictEqual((await submit(m.token, { customer_siret: SIRET })).status, 400);
});

// ---- Auth & ownership -----------------------------------------------------
test('einvoice endpoints require authentication', async () => {
  assert.strictEqual((await submit(undefined, { invoice_id: 'x', customer_siret: SIRET })).status, 401);
  assert.strictEqual((await statusOf(undefined, 'x')).status, 401);
});

test('a merchant cannot submit or read another merchant\'s invoice (403)', async () => {
  const a = await registerMerchant(server.baseUrl);
  const b = await registerMerchant(server.baseUrl);
  const invoice_id = newInvoiceId();
  await submit(a.token, { invoice_id, customer_siret: SIRET });
  assert.strictEqual((await submit(b.token, { invoice_id, customer_siret: SIRET })).status, 403);
  assert.strictEqual((await statusOf(b.token, invoice_id)).status, 403);
});

test('status: unknown invoice returns 404; submitted invoice reports its status', async () => {
  const m = await registerMerchant(server.baseUrl);
  assert.strictEqual((await statusOf(m.token, 'does-not-exist')).status, 404);

  const invoice_id = newInvoiceId();
  await submit(m.token, { invoice_id, customer_siret: SIRET });
  const { body } = await statusOf(m.token, invoice_id);
  assert.strictEqual(body.data.einvoice_status, 'submitted');
  assert.match(body.data.submission_id, /^SUB-/);
});
