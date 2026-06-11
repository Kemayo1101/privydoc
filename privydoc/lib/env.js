// lib/env.js
// Chargeur .env minimaliste, sans dépendance (pas de dotenv).
// En production sur Railway, les variables sont déjà dans process.env
// et le fichier .env n'existe pas → ce module ne fait rien.

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return; // Railway : rien à faire

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

// Vérification au démarrage : on échoue vite si une clé manque
const REQUIRED = ['GENIUS_PK', 'GENIUS_SK', 'AUTH0_DOMAIN', 'AUTH0_CLIENT_ID'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ Variables d\'environnement manquantes :', missing.join(', '));
  console.error('   → En local : crée un fichier .env (voir .env.example)');
  console.error('   → Sur Railway : Settings → Variables');
  process.exit(1);
}

module.exports = {
  GENIUS_PK: process.env.GENIUS_PK,
  GENIUS_SK: process.env.GENIUS_SK,
  GENIUS_BASE_URL: process.env.GENIUS_BASE_URL || 'https://pay.genius.ci/api/v1',
  AUTH0_DOMAIN: process.env.AUTH0_DOMAIN,
  AUTH0_CLIENT_ID: process.env.AUTH0_CLIENT_ID,
  AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE || '',
  APP_URL: process.env.APP_URL || 'http://localhost:3000',
  PORT: process.env.PORT || 3000,
};
