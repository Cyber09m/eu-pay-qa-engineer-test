import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { createPayment, getPayments, getPaymentById } from '../db/database.js';

const router = express.Router();

// FIX B: per-transaction ceiling (EUR/USD/GBP are all 2-decimal currencies)
const MAX_PAYMENT_AMOUNT = 50000;

/**
 * Strictly parse a payment amount. Returns a positive number with at most
 * 2 decimals, or null if the value is not acceptable.
 * Note: the old check `isNaN(amount)` + `parseFloat(amount)` disagreed on
 * values like "0x10" (isNaN=false, parseFloat=0) and created EUR 0 payments.
 */
function parseAmount(value) {
  if (typeof value === 'string') {
    if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  } else if (typeof value !== 'number') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (Math.round(n * 100) / 100 !== n) return null; // more than 2 decimals
  return n;
}

// GET /api/payments - List all payments for authenticated merchant
router.get('/', authenticate, (req, res) => {
  try {
    const merchantId = req.user.id;
    const payments = getPayments(merchantId);

    // FIX A: amount must stay a number (clients do arithmetic on it)
    const formattedPayments = payments.map(p => ({
      id: p.id,
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      customer_email: p.customer_email,
      created_at: p.created_at
    }));

    res.json({
      success: true,
      data: formattedPayments,
      count: formattedPayments.length
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// GET /api/payments/:id - Get single payment
router.get('/:id', authenticate, (req, res) => {
  try {
    const payment = getPaymentById(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Verify ownership
    if (payment.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      success: true,
      data: {
        id: payment.id,
        amount: Number(payment.amount), // FIX A (single payment)
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email,
        created_at: payment.created_at
      }
    });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// POST /api/payments - Create new payment
router.post('/', authenticate, (req, res) => {
  try {
    const { amount, currency, customer_email } = req.body;

    // Validation
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    // FIX B: enforce a maximum per-transaction amount
    if (parsedAmount > MAX_PAYMENT_AMOUNT) {
      return res.status(400).json({
        error: `Amount exceeds the maximum allowed per transaction (${MAX_PAYMENT_AMOUNT})`
      });
    }

    if (!currency || !['EUR', 'USD', 'GBP'].includes(currency)) {
      return res.status(400).json({ error: 'Valid currency is required (EUR, USD, GBP)' });
    }

    if (typeof customer_email !== 'string' || !customer_email.includes('@')) {
      return res.status(400).json({ error: 'Valid customer email is required' });
    }

    const payment = createPayment({
      merchant_id: req.user.id,
      amount: parsedAmount,
      currency,
      customer_email,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Payment created',
      data: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email
      }
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

export default router;
