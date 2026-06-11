// routes-payment-auth.js
// ═══════════════════════════════════════════════════════════
// À INTÉGRER DANS TON server.js EXISTANT DE PRIVYDOC
// Routes paiement GeniusPay + protection Auth0
// Style "Node sans framework" identique au reste du projet.
// ═══════════════════════════════════════════════════════════

const env = require('./lib/env');
const genius = require('./lib/geniuspay');
const { requireAuth } = require('./lib/auth0');

// Petit utilitaire JSON (si tu n'en as pas déjà un)
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // anti-abus 1 MB
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON invalide')); }
    });
  });
}

// ═══════════════════════════════════════════════════════════
// Dans le handler principal de ton serveur, ajoute :
// ═══════════════════════════════════════════════════════════

async function handlePaymentAndAuthRoutes(req, res, url, db, saveDb) {
  // ── 1. INITIER UN PAIEMENT (protégé par Auth0) ──
  if (req.method === 'POST' && url.pathname === '/api/payment/initiate') {
    const user = await requireAuth(req, res);
    if (!user) return true;

    try {
      const body = await readBody(req);
      const { planId } = body; // "micro" ou "premium"
      // ⚠️ Le montant n'est JAMAIS envoyé par le client :
      // il est défini côté serveur dans lib/geniuspay.js (PLANS)

      const result = await genius.initiatePayment({
        planId,
        userEmail: user.email,
        userId: user.auth0Id,
      });

      // Enregistrer la transaction en attente
      db.payments = db.payments || [];
      db.payments.push({
        reference: result.reference,
        userId: user.auth0Id,
        email: user.email,
        planId,
        amount: result.plan.amount,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      saveDb();

      sendJson(res, 200, { success: true, checkoutUrl: result.checkoutUrl, reference: result.reference });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return true;
  }

  // ── 2. VÉRIFIER UN PAIEMENT (appelé au retour de success_url) ──
  if (req.method === 'GET' && url.pathname.startsWith('/api/payment/verify/')) {
    const user = await requireAuth(req, res);
    if (!user) return true;

    const reference = decodeURIComponent(url.pathname.split('/').pop());
    try {
      // Source de vérité : on interroge GeniusPay, pas le navigateur
      const verification = await genius.verifyPayment(reference);

      const record = (db.payments || []).find(
        (p) => p.reference === reference && p.userId === user.auth0Id
      );
      if (!record) return sendJson(res, 404, { success: false, error: 'Transaction introuvable' }), true;

      if (verification.paid && record.status !== 'completed') {
        // Activer le plan
        record.status = 'completed';
        record.paidAt = new Date().toISOString();

        const u = db.users.find((x) => x.auth0Id === user.auth0Id);
        if (u) {
          u.plan = record.planId;
          u.planExpiresAt = genius.computeExpiry(record.planId);
        }
        saveDb();
      }

      sendJson(res, 200, {
        success: true,
        paid: verification.paid,
        status: verification.status,
        plan: record.planId,
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // ── 3. WEBHOOK GENIUSPAY (notification serveur → serveur) ──
  // Configure cette URL dans ton dashboard GeniusPay :
  //   https://ton-app.up.railway.app/api/webhook/geniuspay
  if (req.method === 'POST' && url.pathname === '/api/webhook/geniuspay') {
    try {
      const body = await readBody(req);
      const reference = body?.data?.reference || body?.reference;
      if (!reference) return sendJson(res, 400, { received: false }), true;

      // ⚠️ On ne fait JAMAIS confiance au contenu du webhook seul :
      // on re-vérifie la transaction directement auprès de l'API.
      const verification = await genius.verifyPayment(reference);
      const record = (db.payments || []).find((p) => p.reference === reference);

      if (record && verification.paid && record.status !== 'completed') {
        record.status = 'completed';
        record.paidAt = new Date().toISOString();
        const u = db.users.find((x) => x.auth0Id === record.userId);
        if (u) {
          u.plan = record.planId;
          u.planExpiresAt = genius.computeExpiry(record.planId);
        }
        saveDb();
      }
      sendJson(res, 200, { received: true });
    } catch {
      sendJson(res, 200, { received: true }); // toujours 200 pour éviter les retries infinis
    }
    return true;
  }

  // ── 4. PROFIL UTILISATEUR (créé/synchronisé à la 1ère connexion Auth0) ──
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = await requireAuth(req, res);
    if (!user) return true;

    db.users = db.users || [];
    let u = db.users.find((x) => x.auth0Id === user.auth0Id);
    if (!u) {
      // Première connexion : on crée le profil local lié à Auth0
      u = {
        auth0Id: user.auth0Id,
        email: user.email,
        provider: user.provider, // "google-oauth2" ou "auth0" (email/mdp)
        plan: 'free',
        planExpiresAt: null,
        trialsUsed: 0,
        createdAt: new Date().toISOString(),
      };
      db.users.push(u);
      saveDb();
    }
    sendJson(res, 200, { success: true, user: u });
    return true;
  }

  return false; // route non gérée ici
}

module.exports = { handlePaymentAndAuthRoutes };

/* ═══════════════════════════════════════════════════════════
   EXEMPLE D'INTÉGRATION DANS server.js :

   const http = require('http');
   const { handlePaymentAndAuthRoutes } = require('./routes-payment-auth');

   const server = http.createServer(async (req, res) => {
     const url = new URL(req.url, `http://${req.headers.host}`);

     const handled = await handlePaymentAndAuthRoutes(req, res, url, db, saveDb);
     if (handled) return;

     // ... tes routes existantes (documents, liens, visionneuse, etc.)
     // ⚠️ Remplace ton ancien middleware JWT maison par requireAuth()
     //    sur toutes les routes protégées.
   });
   ═══════════════════════════════════════════════════════════ */
