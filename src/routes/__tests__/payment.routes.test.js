import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, request, registerMerchant, loginSeededMerchant, createPayment } from './helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.stop();
});

const post = (token, body) => request(server.baseUrl, 'POST', '/api/payments', { token, body });
const valid = { amount: 25.5, currency: 'EUR', customer_email: 'customer@example.com' };

// ---- Bug A: amount must be a number ---------------------------------------
test('Bug A: GET /payments returns amount as a number', async () => {
  const { token } = await loginSeededMerchant(server.baseUrl);
  const { status, body } = await request(server.baseUrl, 'GET', '/api/payments', { token });
  assert.strictEqual(status, 200);
  assert.ok(body.data.length >= 2);
  for (const p of body.data) assert.strictEqual(typeof p.amount, 'number');
  assert.strictEqual(body.data.find((p) => p.id === '1').amount, 25.5);
  assert.strictEqual(body.count, body.data.length);
});

test('Bug A: GET /payments/:id returns amount as a number', async () => {
  const { token } = await loginSeededMerchant(server.baseUrl);
  const { status, body } = await request(server.baseUrl, 'GET', '/api/payments/2', { token });
  assert.strictEqual(status, 200);
  assert.strictEqual(typeof body.data.amount, 'number');
  assert.strictEqual(body.data.amount, 100);
});

// ---- Bug B: maximum amount ------------------------------------------------
test('Bug B: rejects EUR 999,999,999 (over the maximum)', async () => {
  const { token } = await registerMerchant(server.baseUrl);
  const { status, body } = await post(token, { ...valid, amount: 999999999 });
  assert.strictEqual(status, 400);
  assert.ok(body.error.includes('maximum'));
});

test('Bug B: boundary - 50000 accepted, 50000.01 rejected', async () => {
  const { token } = await registerMerchant(server.baseUrl);
  assert.strictEqual((await post(token, { ...valid, amount: 50000 })).status, 201);
  assert.strictEqual((await post(token, { ...valid, amount: 50000.01 })).status, 400);
});

test('Bug B: a rejected over-limit payment is not stored', async () => {
  const { token } = await registerMerchant(server.baseUrl);
  await post(token, { ...valid, amount: 1e9 });
  const { body } = await request(server.baseUrl, 'GET', '/api/payments', { token });
  assert.strictEqual(body.count, 0);
});

// ---- Amount validation (negative / edge cases) ----------------------------
for (const [label, amount] of [
  ['zero', 0],
  ['negative', -5],
  ['non-numeric string', 'abc'],
  ['hex string "0x10" (used to create a EUR 0 payment)', '0x10'],
  ['exponent string "1e3"', '1e3'],
  ['3 decimal places', 12.345],
  ['boolean', true],
  ['null', null],
  ['array', [10]],
  ['empty string', ''],
  ['Infinity-like string', 'Infinity'],
]) {
  test(`POST /payments rejects amount: ${label}`, async () => {
    const { token } = await registerMerchant(server.baseUrl);
    const { status } = await post(token, { ...valid, amount });
    assert.strictEqual(status, 400);
  });
}

test('POST /payments accepts a numeric string and stores a number', async () => {
  const { token } = await registerMerchant(server.baseUrl);
  const { status, body } = await post(token, { ...valid, amount: '25.50' });
  assert.strictEqual(status, 201);
  assert.strictEqual(body.data.amount, 25.5);
  assert.strictEqual(body.data.status, 'pending');
});

test('POST /payments rejects bad currency, missing/invalid email', async () => {
  const { token } = await registerMerchant(server.baseUrl);
  assert.strictEqual((await post(token, { ...valid, currency: 'JPY' })).status, 400);
  assert.strictEqual((await post(token, { ...valid, currency: undefined })).status, 400);
  assert.strictEqual((await post(token, { ...valid, customer_email: 'nope' })).status, 400);
  assert.strictEqual((await post(token, { ...valid, customer_email: 12345 })).status, 400); // used to crash with 500
});

// ---- Auth & ownership -----------------------------------------------------
test('payments endpoints require authentication', async () => {
  assert.strictEqual((await request(server.baseUrl, 'GET', '/api/payments')).status, 401);
  assert.strictEqual((await request(server.baseUrl, 'GET', '/api/payments/1')).status, 401);
  assert.strictEqual((await post(undefined, valid)).status, 401);
});

test('a merchant cannot read another merchant\'s payment (403) or see it in the list', async () => {
  const a = await registerMerchant(server.baseUrl);
  const b = await registerMerchant(server.baseUrl);
  const payment = await createPayment(server.baseUrl, a.token, 42);

  const forbidden = await request(server.baseUrl, 'GET', `/api/payments/${payment.id}`, { token: b.token });
  assert.strictEqual(forbidden.status, 403);

  const list = await request(server.baseUrl, 'GET', '/api/payments', { token: b.token });
  assert.strictEqual(list.body.count, 0);
});

test('GET /payments/:id returns 404 for unknown id', async () => {
  const { token } = await registerMerchant(server.baseUrl);
  const { status } = await request(server.baseUrl, 'GET', '/api/payments/does-not-exist', { token });
  assert.strictEqual(status, 404);
});
