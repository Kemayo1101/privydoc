// lib/auth0.js
// Vérification des tokens Auth0 (RS256) sans aucune dépendance externe,
// avec le module crypto natif de Node.js (>= v16).
//
// Flux :
//   1. Le frontend utilise le SDK Auth0 (Universal Login) →
//      connexion Google OU email/mot de passe gérée par Auth0.
//   2. Le frontend obtient un access token et l'envoie en
//      header "Authorization: Bearer <token>" à chaque appel API.
//   3. Ce module vérifie la signature du token via les clés
//      publiques JWKS d'Auth0 (mises en cache 1h).

const https = require('https');
const crypto = require('crypto');
const env = require('./env');

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL = 60 * 60 * 1000; // 1 heure

function fetchJwks() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL) {
      return resolve(jwksCache.keys);
    }
    https
      .get(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const { keys } = JSON.parse(data);
            jwksCache = { keys, fetchedAt: now };
            resolve(keys);
          } catch (e) {
            reject(new Error('JWKS Auth0 illisible'));
          }
        });
      })
      .on('error', reject);
  });
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ── Vérifie un access token Auth0 et retourne son payload ──
async function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token malformé');

  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  const signature = b64urlDecode(parts[2]);

  if (header.alg !== 'RS256') throw new Error('Algorithme non supporté');

  // 1. Trouver la clé publique correspondante (kid)
  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Clé de signature inconnue');

  // 2. Vérifier la signature avec la clé publique (import JWK natif)
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    publicKey,
    signature
  );
  if (!valid) throw new Error('Signature invalide');

  // 3. Vérifier les claims standards
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('Token expiré');
  if (payload.iss !== `https://${env.AUTH0_DOMAIN}/`) throw new Error('Émetteur invalide');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const expectedAud = env.AUTH0_AUDIENCE || env.AUTH0_CLIENT_ID;
  if (!audiences.includes(expectedAud)) throw new Error('Audience invalide');

  return payload; // contient sub (id Auth0), email, etc.
}

// ── Middleware pour serveur Node sans framework ──
// Usage dans server.js :
//   const user = await requireAuth(req, res);
//   if (!user) return; // la réponse 401 a déjà été envoyée
async function requireAuth(req, res) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new Error('Token manquant');

    const payload = await verifyToken(match[1]);
    return {
      auth0Id: payload.sub,            // ex: "google-oauth2|1234..." ou "auth0|abcd..."
      email: payload.email || payload['https://privydoc.com/email'] || null,
      provider: payload.sub.split('|')[0], // "google-oauth2" ou "auth0"
    };
  } catch (err) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Non autorisé : ' + err.message }));
    return null;
  }
}

module.exports = { verifyToken, requireAuth };
