import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, request, registerMerchant } from './helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.stop();
});

const register = (body) => request(server.baseUrl, 'POST', '/api/auth/register', { body });
const validBody = (email) => ({ email, password: 'SecurePass123!', business_name: 'Acme Ltd' });

// ---- Bug C: email validation ----------------------------------------------
test('Bug C: register rejects an email without a TLD ("user@domain")', async () => {
  const { status, body } = await register(validBody('user@domain'));
  assert.strictEqual(status, 400);
  assert.match(body.error, /email/i);
});

for (const bad of ['user@domain.', 'user@.com', 'plainaddress', 'a b@example.com', '@example.com', 'user@@example.com', 'user@example.c']) {
  test(`Bug C: register rejects invalid email "${bad}"`, async () => {
    const { status } = await register(validBody(bad));
    assert.strictEqual(status, 400);
  });
}

test('Bug C: register rejects non-string email values', async () => {
  for (const email of [123, {}, ['a@b.com'], null]) {
    const { status } = await register(validBody(email));
    assert.strictEqual(status, 400, `email=${JSON.stringify(email)}`);
  }
});

test('Bug C (regression): register still accepts valid emails, incl. subdomain and +tag', async () => {
  const { status, body } = await register(validBody(`new.merchant+tag-${Date.now()}@mail.example.co.uk`));
  assert.strictEqual(status, 201);
  assert.ok(body.token);
});

test('register: email uniqueness is case-insensitive', async () => {
  const email = `case-${Date.now()}@example.com`;
  assert.strictEqual((await register(validBody(email))).status, 201);
  assert.strictEqual((await register(validBody(email.toUpperCase()))).status, 409);
});

// ---- Registration validation ----------------------------------------------
test('register: rejects short password and bad business name', async () => {
  assert.strictEqual((await register({ ...validBody(`a${Date.now()}@example.com`), password: 'short' })).status, 400);
  assert.strictEqual((await register({ ...validBody(`b${Date.now()}@example.com`), business_name: 'x' })).status, 400);
  assert.strictEqual((await register({ ...validBody(`c${Date.now()}@example.com`), password: 12345678 })).status, 400);
});

test('register: never returns the password hash', async () => {
  const { body } = await register(validBody(`nohash-${Date.now()}@example.com`));
  assert.strictEqual(body.user.password, undefined);
});

// ---- Login (Bug H: seeded hash was invalid) -------------------------------
test('Bug H: seeded merchant can log in with the documented credentials', async () => {
  const { status, body } = await request(server.baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'merchant@test.com', password: 'Test123!' },
  });
  assert.strictEqual(status, 200);
  assert.ok(body.token);
  assert.strictEqual(body.user.email, 'merchant@test.com');
});

test('login: wrong password and unknown user both return the same 401', async () => {
  const wrongPw = await request(server.baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'merchant@test.com', password: 'WrongPass1!' },
  });
  const unknown = await request(server.baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'nobody@example.com', password: 'Test123!' },
  });
  assert.strictEqual(wrongPw.status, 401);
  assert.strictEqual(unknown.status, 401);
  assert.deepStrictEqual(wrongPw.body, unknown.body); // no user enumeration
});

test('login: missing fields return 400', async () => {
  const { status } = await request(server.baseUrl, 'POST', '/api/auth/login', { body: { email: 'merchant@test.com' } });
  assert.strictEqual(status, 400);
});

test('login: works after registering (email normalised)', async () => {
  const email = `Login-${Date.now()}@Example.com`;
  await register(validBody(email));
  const { status } = await request(server.baseUrl, 'POST', '/api/auth/login', {
    body: { email, password: 'SecurePass123!' },
  });
  assert.strictEqual(status, 200);
});

// ---- Bug J: malformed JSON ------------------------------------------------
test('Bug J: malformed JSON body returns 400, not 500', async () => {
  const { status, body } = await request(server.baseUrl, 'POST', '/api/auth/login', { raw: '{bad json' });
  assert.strictEqual(status, 400);
  assert.match(body.error, /json/i);
});

// ---- JWT / auth middleware ------------------------------------------------
test('auth middleware: missing, malformed and forged tokens get 401', async () => {
  const noToken = await request(server.baseUrl, 'GET', '/api/payments');
  assert.strictEqual(noToken.status, 401);

  const garbage = await request(server.baseUrl, 'GET', '/api/payments', { token: 'not.a.jwt' });
  assert.strictEqual(garbage.status, 401);

  const { token } = await registerMerchant(server.baseUrl);
  const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
  const forged = await request(server.baseUrl, 'GET', '/api/payments', { token: tampered });
  assert.strictEqual(forged.status, 401);
});

test('auth middleware: "alg: none" token is rejected', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: '1', email: 'merchant@test.com', type: 'merchant' })}.`;
  const { status } = await request(server.baseUrl, 'GET', '/api/payments', { token: none });
  assert.strictEqual(status, 401);
});
