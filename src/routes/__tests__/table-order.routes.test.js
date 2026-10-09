import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { io as connect } from 'socket.io-client';
import { startServer, request, registerMerchant } from './helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.stop();
});

const items = [{ name: 'Pasta', price: 10, quantity: 2 }, { name: 'Water', price: 2.5, quantity: 1 }];
const createOrder = (merchant_id, table_number, extra = {}) =>
  request(server.baseUrl, 'POST', '/api/table-orders', {
    body: { merchant_id, table_number, items, ...extra },
  });
const setStatus = (token, id, status) =>
  request(server.baseUrl, 'PATCH', `/api/table-orders/${id}/status`, { token, body: { status } });

// ---- Bug F: duplicate table orders ----------------------------------------
test('Bug F: a second pending order for the same table is rejected with 409', async () => {
  const m = await registerMerchant(server.baseUrl);
  assert.strictEqual((await createOrder(m.id, 5)).status, 201);
  const dup = await createOrder(m.id, 5);
  assert.strictEqual(dup.status, 409);
  assert.match(dup.body.error, /pending order/i);

  const list = await request(server.baseUrl, 'GET', '/api/table-orders', { token: m.token });
  assert.strictEqual(list.body.count, 1);
});

test('Bug F: table 5 and "5" are the same table', async () => {
  const m = await registerMerchant(server.baseUrl);
  assert.strictEqual((await createOrder(m.id, 5)).status, 201);
  assert.strictEqual((await createOrder(m.id, '5')).status, 409);
});

test('Bug F: different tables, and different merchants, can order independently', async () => {
  const a = await registerMerchant(server.baseUrl);
  const b = await registerMerchant(server.baseUrl);
  assert.strictEqual((await createOrder(a.id, 1)).status, 201);
  assert.strictEqual((await createOrder(a.id, 2)).status, 201);
  assert.strictEqual((await createOrder(b.id, 1)).status, 201);
});

test('Bug F: once the pending order is confirmed the table can take a new pending order', async () => {
  const m = await registerMerchant(server.baseUrl);
  const first = await createOrder(m.id, 7);
  assert.strictEqual((await setStatus(m.token, first.body.data.id, 'confirmed')).status, 200);
  assert.strictEqual((await createOrder(m.id, 7)).status, 201);
});

test('Bug F: concurrent requests for one table create only one order', async () => {
  const m = await registerMerchant(server.baseUrl);
  const results = await Promise.all(Array.from({ length: 8 }, () => createOrder(m.id, 9)));
  assert.strictEqual(results.filter((r) => r.status === 201).length, 1);
  assert.strictEqual(results.filter((r) => r.status === 409).length, 7);
});

// ---- Validation -----------------------------------------------------------
test('order total is computed from price x quantity', async () => {
  const m = await registerMerchant(server.baseUrl);
  const { status, body } = await createOrder(m.id, 3, { customer_name: 'Alice' });
  assert.strictEqual(status, 201);
  assert.strictEqual(body.data.total, 22.5);
  assert.strictEqual(body.data.status, 'pending');
  assert.strictEqual(body.data.customer_name, 'Alice');
});

test('order validation: missing fields and empty items return 400', async () => {
  const m = await registerMerchant(server.baseUrl);
  assert.strictEqual((await request(server.baseUrl, 'POST', '/api/table-orders', { body: {} })).status, 400);
  assert.strictEqual((await request(server.baseUrl, 'POST', '/api/table-orders', { body: { merchant_id: m.id, table_number: 1, items: [] } })).status, 400);
  assert.strictEqual((await request(server.baseUrl, 'POST', '/api/table-orders', { body: { merchant_id: m.id, table_number: 1, items: 'x' } })).status, 400);
});

test('order validation: negative price, zero/fractional quantity and non-numeric values are rejected', async () => {
  const m = await registerMerchant(server.baseUrl);
  for (const item of [
    { price: -5, quantity: 1 },
    { price: 5, quantity: 0 },
    { price: 5, quantity: -2 },
    { price: 5, quantity: 1.5 },
    { price: '5', quantity: 1 },
    { quantity: 1 },
    null,
  ]) {
    const { status } = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: { merchant_id: m.id, table_number: 11, items: [item] },
    });
    assert.strictEqual(status, 400, JSON.stringify(item));
  }
});

// ---- Status updates & authorisation ---------------------------------------
test('PATCH status: requires auth, validates value, 404 for unknown order', async () => {
  const m = await registerMerchant(server.baseUrl);
  const order = (await createOrder(m.id, 20)).body.data;

  const noAuth = await request(server.baseUrl, 'PATCH', `/api/table-orders/${order.id}/status`, { body: { status: 'ready' } });
  assert.strictEqual(noAuth.status, 401);
  assert.strictEqual((await setStatus(m.token, order.id, 'bogus')).status, 400);
  assert.strictEqual((await setStatus(m.token, 'missing-id', 'ready')).status, 404);
  assert.strictEqual((await setStatus(m.token, order.id, 'ready')).body.data.status, 'ready');
});

test('PATCH status: merchant cannot modify another merchant\'s order (403)', async () => {
  const a = await registerMerchant(server.baseUrl);
  const b = await registerMerchant(server.baseUrl);
  const order = (await createOrder(a.id, 30)).body.data;
  assert.strictEqual((await setStatus(b.token, order.id, 'cancelled')).status, 403);
});

test('GET /table-orders lists only the caller\'s orders and requires auth', async () => {
  const a = await registerMerchant(server.baseUrl);
  const b = await registerMerchant(server.baseUrl);
  await createOrder(a.id, 40);
  await createOrder(b.id, 40);
  const list = await request(server.baseUrl, 'GET', '/api/table-orders', { token: a.token });
  assert.strictEqual(list.body.count, 1);
  assert.strictEqual(list.body.data[0].merchant_id, a.id);
  assert.strictEqual((await request(server.baseUrl, 'GET', '/api/table-orders')).status, 401);
});

// ---- Bug K: Socket.IO events were never emitted ---------------------------
function waitFor(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('Bug K: creating an order emits "new_order" to the merchant room', async () => {
  const m = await registerMerchant(server.baseUrl);
  const socket = connect(server.baseUrl, { transports: ['websocket'] });
  try {
    await waitFor(socket, 'connect');
    socket.emit('join_merchant', m.id);
    await pause(150); // server has no join ack; give it time to process
    const received = waitFor(socket, 'new_order');
    const order = (await createOrder(m.id, 50)).body.data;
    const event = await received;
    assert.strictEqual(event.id, order.id);
    assert.strictEqual(event.table_number, 50);
  } finally {
    socket.close();
  }
});

test('Bug K: status change emits "order_status_changed" to the table room only', async () => {
  const m = await registerMerchant(server.baseUrl);
  const order = (await createOrder(m.id, 51)).body.data;

  const inRoom = connect(server.baseUrl, { transports: ['websocket'] });
  const otherRoom = connect(server.baseUrl, { transports: ['websocket'] });
  try {
    await Promise.all([waitFor(inRoom, 'connect'), waitFor(otherRoom, 'connect')]);
    inRoom.emit('join_table', 51);
    otherRoom.emit('join_table', 52);
    await pause(150);

    let leaked = false;
    otherRoom.on('order_status_changed', () => { leaked = true; });
    const received = waitFor(inRoom, 'order_status_changed');
    await setStatus(m.token, order.id, 'preparing');
    const event = await received;

    assert.deepStrictEqual(event, { order_id: order.id, status: 'preparing', table_number: 51 });
    await pause(150);
    assert.strictEqual(leaked, false);
  } finally {
    inRoom.close();
    otherRoom.close();
  }
});
