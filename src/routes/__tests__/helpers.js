// Shared helpers for the black-box API tests.
// Each test file boots the real server (src/server.js) on a free port, so the
// tests exercise the exact same code path as `npm start` and never collide
// with each other when node:test runs files in parallel.
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js');

// Must match WEBHOOK_SECRET in webhook.routes.js
export const WEBHOOK_SECRET = 'test-webhook-secret-key';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER_FILE], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`Server exited early (code ${code})`)));
  });

  return {
    baseUrl: `http://localhost:${port}`,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      }),
  };
}

// JSON request helper. Returns { status, body }.
export async function request(baseUrl, method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // non-JSON response body
  }
  return { status: res.status, body: parsed };
}

let counter = 0;

// Registers a brand-new merchant so each test works on isolated data.
export async function registerMerchant(baseUrl) {
  counter += 1;
  const email = `qa-${process.pid}-${Date.now()}-${counter}@example.com`;
  const { status, body } = await request(baseUrl, 'POST', '/api/auth/register', {
    body: { email, password: 'SecurePass123!', business_name: 'QA Test Co' },
  });
  if (status !== 201) throw new Error(`registerMerchant failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.token, id: body.user.id, email };
}

export async function loginSeededMerchant(baseUrl) {
  const { status, body } = await request(baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'merchant@test.com', password: 'Test123!' },
  });
  if (status !== 200) throw new Error(`login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.token, id: body.user.id };
}

export async function createPayment(baseUrl, token, amount = 10) {
  const { status, body } = await request(baseUrl, 'POST', '/api/payments', {
    token,
    body: { amount, currency: 'EUR', customer_email: 'customer@example.com' },
  });
  if (status !== 201) throw new Error(`createPayment failed: ${status} ${JSON.stringify(body)}`);
  return body.data;
}

// HMAC-SHA256 hex digest of the exact body string, as a provider would send it
export function sign(rawBody, secret = WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// POST a correctly signed webhook (pass `signature` to override with a bad one)
export function postWebhook(baseUrl, route, payload, { signature } = {}) {
  const raw = JSON.stringify(payload);
  return request(baseUrl, 'POST', `/api/webhooks/${route}`, {
    raw,
    headers: { 'x-webhook-signature': signature ?? sign(raw) },
  });
}
