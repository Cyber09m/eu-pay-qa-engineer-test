import express from 'express';
import crypto from 'crypto';
import { getPaymentById, db } from '../db/database.js';

const router = express.Router();

// Webhook secret for HMAC verification
const WEBHOOK_SECRET = 'test-webhook-secret-key';

// Statuses a payment provider may report. Anything else is rejected so that
// arbitrary strings (e.g. XSS payloads) can never be persisted as a status.
const VALID_PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'cancelled', 'refunded'];

/**
 * FIX D: verify the HMAC-SHA256 signature of the RAW request body.
 * - computed over the exact bytes received (req.rawBody, captured in server.js)
 *   rather than JSON.stringify(req.body), which can differ from what the
 *   provider signed (key order, whitespace, unicode escaping)
 * - compared with timingSafeEqual to avoid leaking the signature via timing
 */
function hasValidSignature(req) {
  const signature = req.headers['x-webhook-signature'];
  if (typeof signature !== 'string' || !req.rawBody) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  const received = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws on length mismatch, so check length first
  return received.length === expectedBuf.length && crypto.timingSafeEqual(received, expectedBuf);
}

/**
 * POST /api/webhooks/payment-status
 * 
 * Simulates external payment provider webhooks (like Powens)
 * Tests webhook signature verification and idempotency
 */
router.post('/payment-status', (req, res) => {
  try {
    const { payment_id, status, event_id } = req.body;

    // FIX D: reject unsigned / wrongly signed webhooks before touching any data
    if (!hasValidSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (!payment_id || !status) {
      return res.status(400).json({ error: 'payment_id and status required' });
    }

    if (typeof status !== 'string' || !VALID_PAYMENT_STATUSES.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        valid_statuses: VALID_PAYMENT_STATUSES
      });
    }

    // event_id is the idempotency key, so it is mandatory
    if (typeof event_id !== 'string' || event_id.trim() === '' || event_id.length > 128) {
      return res.status(400).json({ error: 'event_id required' });
    }

    // FIX E: webhooks are delivered at-least-once; a replayed event must not
    // be applied again (it could overwrite a newer status with a stale one).
    if (db.processed_webhooks.includes(event_id)) {
      return res.status(200).json({ success: true, message: 'Already processed', duplicate: true });
    }

    const payment = getPaymentById(payment_id);
    if (!payment) {
      // Not recorded as processed: the provider may retry once the payment exists
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Update payment status
    payment.status = status;
    payment.webhook_received_at = new Date();

    // FIX E: remember the event only after it was applied successfully
    db.processed_webhooks.push(event_id);

    res.status(200).json({
      success: true,
      message: 'Webhook processed',
      payment_id,
      new_status: status
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * POST /api/webhooks/e-invoice
 * 
 * Simulates e-invoice submission webhook from tax authority
 */
router.post('/e-invoice', (req, res) => {
  try {
    const { invoice_id, status, submission_id, tax_authority_id } = req.body;

    // Same spoofing risk as the payment webhook (it mutates tax records
    // without any auth), so it gets the same signature check.
    if (!hasValidSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (!invoice_id || !status) {
      return res.status(400).json({ error: 'invoice_id and status required' });
    }

    // Find invoice in database
    const invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice status. Optional fields are only overwritten when sent,
    // otherwise a status-only callback wiped the stored submission_id.
    invoice.einvoice_status = status;
    if (submission_id !== undefined) invoice.einvoice_submission_id = submission_id;
    if (tax_authority_id !== undefined) invoice.tax_authority_id = tax_authority_id;
    invoice.submitted_at = new Date();

    res.status(200).json({
      success: true,
      message: 'E-invoice webhook processed',
      invoice_id,
      status
    });
  } catch (error) {
    console.error('E-invoice webhook error:', error);
    res.status(500).json({ error: 'E-invoice webhook failed' });
  }
});

export default router;
