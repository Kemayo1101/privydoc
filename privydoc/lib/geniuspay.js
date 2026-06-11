// lib/geniuspay.js
// Module GeniusPay 100% côté serveur.
// ⚠️ La clé secrète (GENIUS_SK) ne doit JAMAIS apparaître dans le frontend.
// Le navigateur appelle /api/payment/initiate → le serveur appelle GeniusPay.

const https = require('https');
const crypto = require('crypto');
const env = require('./env');

// ── Plans PRIVYDOC (montants validés côté serveur, jamais reçus du client) ──
const PLANS = {
  micro: {
    label: 'Formule Petit Coût',
    amount: 200, // minimum GeniusPay en XOF
    currency: 'XOF',
    durationDays: 2,
  },
  premium: {
    label: 'Abonnement Premium',
    amount: 5000,
    currency: 'XOF',
    durationDays: 60,
  },
};

// ── Appel HTTPS générique vers GeniusPay ──
function geniusRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(env.GENIUS_BASE_URL + endpoint);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'X-API-Key': env.GENIUS_PK,
        'X-API-Secret': env.GENIUS_SK, // ← uniquement ici, côté serveur
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          reject(new Error('Réponse GeniusPay invalide : ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Timeout GeniusPay'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Initier un paiement (Mobile Money + Visa/Mastercard via checkout GeniusPay) ──
async function initiatePayment({ planId, userEmail, userId }) {
  const plan = PLANS[planId];
  if (!plan) throw new Error('Plan inconnu : ' + planId);

  // Référence interne unique et traçable
  const reference = 'PVD-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  const { status, data } = await geniusRequest('POST', '/payments', {
    amount: plan.amount,
    currency: plan.currency,
    reference,
    description: `PRIVYDOC — ${plan.label}`,
    customer: { email: userEmail },
    // Le checkout GeniusPay propose Wave / Orange Money / MTN MoMo /
    // Moov Money / Visa / Mastercard selon la configuration du compte marchand.
    success_url: `${env.APP_URL}/payment/success?ref=${reference}&plan=${planId}`,
    error_url: `${env.APP_URL}/payment/failed?ref=${reference}`,
    metadata: { userId, planId },
  });

  if (status >= 400 || !data.success) {
    throw new Error(data?.error?.message || 'Échec initialisation paiement');
  }

  const checkoutUrl = data.data?.checkout_url || data.data?.payment_url;
  if (!checkoutUrl) throw new Error('URL de paiement non reçue de GeniusPay');

  return {
    reference,
    checkoutUrl,
    plan: { id: planId, label: plan.label, amount: plan.amount, currency: plan.currency },
  };
}

// ── Vérifier un paiement côté serveur (source de vérité) ──
// ⚠️ Ne JAMAIS activer un plan sur la seule base du retour navigateur
// (success_url) : toujours re-vérifier auprès de l'API GeniusPay.
async function verifyPayment(reference) {
  const { data } = await geniusRequest('GET', `/payments/${encodeURIComponent(reference)}`);
  const payment = data?.data || {};
  const st = String(payment.status || '').toLowerCase();
  return {
    reference,
    paid: ['success', 'successful', 'completed', 'paid'].includes(st),
    status: payment.status || 'unknown',
    amount: payment.amount,
    currency: payment.currency,
    metadata: payment.metadata || {},
    raw: payment,
  };
}

// ── Activation du plan après paiement confirmé ──
function computeExpiry(planId, from = new Date()) {
  const plan = PLANS[planId];
  const expiry = new Date(from);
  expiry.setDate(expiry.getDate() + plan.durationDays);
  return expiry.toISOString();
}

module.exports = { PLANS, initiatePayment, verifyPayment, computeExpiry };
