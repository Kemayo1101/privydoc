// ══════════════════════════════════════════════════════
//  PRIVYDOC — Serveur Backend Complet
//  Auth JWT + Upload Cloudinary + GeniusPay + Liens privés
// ══════════════════════════════════════════════════════

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const crypto  = require('crypto');

// ── CONFIG ──────────────────────────────────────────
const CONFIG = {
  PORT:               process.env.PORT || 3000,
  JWT_SECRET:         process.env.JWT_SECRET || 'privydoc_jwt_secret_2025_change_me',
  GENIUSPAY_BASE:     'pay.genius.ci',
  GENIUSPAY_PATH:     '/api/v1/merchant',
  GENIUSPAY_PK:       process.env.GENIUSPAY_PUBLIC_KEY  || '',
  GENIUSPAY_SK:       process.env.GENIUSPAY_SECRET_KEY  || '',
  SITE_URL:           process.env.SITE_URL || 'http://localhost:3000',
  CLOUDINARY_CLOUD:   process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_KEY:     process.env.CLOUDINARY_API_KEY    || '',
  CLOUDINARY_SECRET:  process.env.CLOUDINARY_API_SECRET || '',
};

// ── BASE DE DONNÉES (fichier JSON) ───────────────────
const DB_PATH = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], documents: [], payments: [], links: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── HELPERS ─────────────────────────────────────────

function hashPassword(password) {
  return crypto.createHmac('sha256', CONFIG.JWT_SECRET).update(password).digest('hex');
}

function generateToken(payload) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const sig     = crypto.createHmac('sha256', CONFIG.JWT_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', CONFIG.JWT_SECRET).update(header + '.' + body).digest('base64url');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getTokenFromRequest(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function generateId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ct  = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve({ type: 'json', data: JSON.parse(raw.toString()), raw }); }
        catch { reject(new Error('JSON invalide')); }
      } else {
        resolve({ type: 'raw', data: null, raw });
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── CLOUDINARY UPLOAD ────────────────────────────────
function uploadToCloudinary(fileBuffer, filename, resourceType = 'raw') {
  return new Promise((resolve, reject) => {
    const timestamp  = Math.floor(Date.now() / 1000).toString();
    const folder     = 'privydoc';
    const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature  = crypto.createHash('sha1')
      .update(paramsToSign + CONFIG.CLOUDINARY_SECRET).digest('hex');

    const boundary = '----PrivydocBoundary' + Date.now();
    const parts = [];

    const addField = (name, value) => {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
      );
    };

    addField('timestamp', timestamp);
    addField('api_key', CONFIG.CLOUDINARY_KEY);
    addField('signature', signature);
    addField('folder', folder);

    // File part
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const bodyEnd    = `\r\n--${boundary}--`;

    const bodyParts = Buffer.concat([
      Buffer.from(parts.join('\r\n') + '\r\n'),
      Buffer.from(fileHeader),
      fileBuffer,
      Buffer.from(bodyEnd),
    ]);

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CONFIG.CLOUDINARY_CLOUD}/${resourceType}/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyParts.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) reject(new Error(result.error.message));
          else resolve(result);
        } catch(e) { reject(new Error('Réponse Cloudinary invalide')); }
      });
    });
    req.on('error', reject);
    req.write(bodyParts);
    req.end();
  });
}

// ── PARSE MULTIPART ──────────────────────────────────
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;

  while (start < buffer.length) {
    const boundaryIdx = buffer.indexOf(boundaryBuf, start);
    if (boundaryIdx === -1) break;
    const headerStart = boundaryIdx + boundaryBuf.length + 2;
    const headerEnd   = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const headers     = buffer.slice(headerStart, headerEnd).toString();
    const dataStart   = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundaryBuf, dataStart);
    const dataEnd     = nextBoundary === -1 ? buffer.length : nextBoundary - 2;
    const data        = buffer.slice(dataStart, dataEnd);

    const nameMatch     = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        data,
        text: filenameMatch ? null : data.toString(),
      });
    }
    start = nextBoundary === -1 ? buffer.length : nextBoundary;
  }
  return parts;
}

// ── GENIUSPAY ────────────────────────────────────────
function geniuspayRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: CONFIG.GENIUSPAY_BASE,
      path:     CONFIG.GENIUSPAY_PATH + endpoint,
      method,
      headers: {
        'X-API-Key':    CONFIG.GENIUSPAY_PK,
        'X-API-Secret': CONFIG.GENIUSPAY_SK,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Réponse GeniusPay invalide: ' + data)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ══════════════════════════════════════════════════════
//  ROUTEUR PRINCIPAL
// ══════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  console.log(`[${new Date().toLocaleTimeString()}] ${method} ${pathname}`);

  try {

    // ════════════════════════════════════════
    // AUTH — INSCRIPTION
    // ════════════════════════════════════════
    if (pathname === '/api/auth/signup' && method === 'POST') {
      const { data } = await readBody(req);
      const { name, email, password, role } = data;

      if (!name || !email || !password || !role)
        return jsonResponse(res, 400, { success: false, error: 'Tous les champs sont requis' });
      if (password.length < 8)
        return jsonResponse(res, 400, { success: false, error: 'Mot de passe trop court (min 8 caractères)' });

      const db = loadDB();
      if (db.users.find(u => u.email === email))
        return jsonResponse(res, 400, { success: false, error: 'Cet email est déjà utilisé' });

      const user = {
        id:        generateId('USR'),
        name,
        email,
        password:  hashPassword(password),
        role,
        plan:      'free',
        docsUsed:  0,
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      saveDB(db);

      const token = generateToken({ userId: user.id, email: user.email });
      return jsonResponse(res, 201, {
        success: true,
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, docsUsed: user.docsUsed },
      });
    }

    // ════════════════════════════════════════
    // AUTH — CONNEXION
    // ════════════════════════════════════════
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { data } = await readBody(req);
      const { email, password } = data;

      if (!email || !password)
        return jsonResponse(res, 400, { success: false, error: 'Email et mot de passe requis' });

      const db   = loadDB();
      const user = db.users.find(u => u.email === email && u.password === hashPassword(password));
      if (!user)
        return jsonResponse(res, 401, { success: false, error: 'Email ou mot de passe incorrect' });

      const token = generateToken({ userId: user.id, email: user.email });
      return jsonResponse(res, 200, {
        success: true,
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, docsUsed: user.docsUsed },
      });
    }

    // ════════════════════════════════════════
    // AUTH — PROFIL UTILISATEUR
    // ════════════════════════════════════════
    if (pathname === '/api/auth/me' && method === 'GET') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Non authentifié' });

      const db   = loadDB();
      const user = db.users.find(u => u.id === payload.userId);
      if (!user) return jsonResponse(res, 404, { success: false, error: 'Utilisateur non trouvé' });

      return jsonResponse(res, 200, {
        success: true,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, docsUsed: user.docsUsed },
      });
    }

    // ════════════════════════════════════════
    // DOCUMENTS — UPLOAD
    // ════════════════════════════════════════
    if (pathname === '/api/documents/upload' && method === 'POST') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const db   = loadDB();
      const user = db.users.find(u => u.id === payload.userId);
      if (!user) return jsonResponse(res, 404, { success: false, error: 'Utilisateur non trouvé' });

      // Vérifier limite plan
      const userDocs = db.documents.filter(d => d.userId === user.id && d.active);
      const maxDocs  = user.plan === 'premium' ? 9999 : user.plan === 'micro' ? 1 : 2;
      if (userDocs.length >= maxDocs)
        return jsonResponse(res, 403, {
          success: false,
          error: user.plan === 'free'
            ? 'Limite atteinte (2 documents). Passez à un plan payant.'
            : 'Limite atteinte. Passez au plan Premium.',
        });

      // Parser multipart
      const ct       = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=(.+)/);
      if (!boundaryMatch)
        return jsonResponse(res, 400, { success: false, error: 'Format multipart requis' });

      const { raw }  = await readBody(req);
      const parts    = parseMultipart(raw, boundaryMatch[1]);
      const filePart = parts.find(p => p.filename);

      if (!filePart)
        return jsonResponse(res, 400, { success: false, error: 'Aucun fichier trouvé' });

      // Vérifier type fichier
      const allowedExts = ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.jpg','.jpeg','.png'];
      const ext = path.extname(filePart.filename).toLowerCase();
      if (!allowedExts.includes(ext))
        return jsonResponse(res, 400, { success: false, error: 'Format non supporté. Acceptés: PDF, Word, Excel, PowerPoint, images' });

      // Vérifier taille (50 MB max)
      if (filePart.data.length > 50 * 1024 * 1024)
        return jsonResponse(res, 400, { success: false, error: 'Fichier trop volumineux (max 50 MB)' });

      console.log('→ Upload Cloudinary:', filePart.filename, Math.round(filePart.data.length / 1024) + ' KB');

      // Upload vers Cloudinary
      let cloudinaryResult;
      try {
        cloudinaryResult = await uploadToCloudinary(filePart.data, filePart.filename, 'raw');
      } catch(e) {
        console.error('Cloudinary error:', e.message);
        return jsonResponse(res, 500, { success: false, error: 'Erreur upload Cloudinary: ' + e.message });
      }

      // Sauvegarder en base
      const doc = {
        id:          generateId('DOC'),
        userId:      user.id,
        name:        filePart.filename,
        size:        Math.round(filePart.data.length / 1024) + ' KB',
        ext:         ext,
        cloudinaryId: cloudinaryResult.public_id,
        secureUrl:   cloudinaryResult.secure_url,
        active:      true,
        views:       0,
        links:       [],
        createdAt:   new Date().toISOString(),
      };
      db.documents.push(doc);
      // Mettre à jour compteur
      user.docsUsed = (user.docsUsed || 0) + 1;
      saveDB(db);

      console.log('✅ Document uploadé:', doc.id, doc.name);
      return jsonResponse(res, 201, { success: true, document: doc });
    }

    // ════════════════════════════════════════
    // DOCUMENTS — LISTER
    // ════════════════════════════════════════
    if (pathname === '/api/documents' && method === 'GET') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const db   = loadDB();
      const docs = db.documents.filter(d => d.userId === payload.userId && d.active);
      return jsonResponse(res, 200, { success: true, documents: docs });
    }

    // ════════════════════════════════════════
    // DOCUMENTS — SUPPRIMER
    // ════════════════════════════════════════
    if (pathname.startsWith('/api/documents/') && method === 'DELETE') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const docId = pathname.split('/').pop();
      const db    = loadDB();
      const doc   = db.documents.find(d => d.id === docId && d.userId === payload.userId);
      if (!doc) return jsonResponse(res, 404, { success: false, error: 'Document non trouvé' });

      doc.active = false;
      saveDB(db);
      return jsonResponse(res, 200, { success: true, message: 'Document supprimé' });
    }

    // ════════════════════════════════════════
    // LIENS PRIVÉS — GÉNÉRER
    // ════════════════════════════════════════
    if (pathname === '/api/links/generate' && method === 'POST') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const { data }  = await readBody(req);
      const { docId, recipientName, recipientEmail, maxDevices, expiresIn } = data;

      const db  = loadDB();
      const doc = db.documents.find(d => d.id === docId && d.userId === payload.userId && d.active);
      if (!doc) return jsonResponse(res, 404, { success: false, error: 'Document non trouvé' });

      const linkToken = crypto.randomBytes(6).toString('hex').toUpperCase();
      const link = {
        id:             generateId('LNK'),
        docId,
        userId:         payload.userId,
        token:          linkToken,
        url:            CONFIG.SITE_URL + '/access/' + linkToken,
        recipientName:  recipientName || 'Destinataire',
        recipientEmail: recipientEmail || '',
        maxDevices:     maxDevices || 1,
        usedDevices:    [],
        views:          0,
        active:         true,
        expiresAt:      expiresIn ? new Date(Date.now() + expiresIn * 60 * 60 * 1000).toISOString() : null,
        createdAt:      new Date().toISOString(),
        lastAccessAt:   null,
      };
      db.links.push(link);
      // Ajouter le lien au document
      if (!doc.links) doc.links = [];
      doc.links.push(link.id);
      saveDB(db);

      console.log('✅ Lien généré:', link.url, 'pour', recipientName);
      return jsonResponse(res, 201, { success: true, link });
    }

    // ════════════════════════════════════════
    // LIENS — LISTER PAR DOCUMENT
    // ════════════════════════════════════════
    if (pathname.startsWith('/api/links/doc/') && method === 'GET') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const docId = pathname.split('/').pop();
      const db    = loadDB();
      const links = db.links.filter(l => l.docId === docId && l.userId === payload.userId);
      return jsonResponse(res, 200, { success: true, links });
    }

    // ════════════════════════════════════════
    // LIENS — RÉVOQUER
    // ════════════════════════════════════════
    if (pathname.startsWith('/api/links/') && method === 'DELETE') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const linkId = pathname.split('/').pop();
      const db     = loadDB();
      const link   = db.links.find(l => l.id === linkId && l.userId === payload.userId);
      if (!link) return jsonResponse(res, 404, { success: false, error: 'Lien non trouvé' });

      link.active = false;
      saveDB(db);
      return jsonResponse(res, 200, { success: true, message: 'Lien révoqué' });
    }

    // ════════════════════════════════════════
    // ACCÈS DOCUMENT VIA LIEN PRIVÉ
    // ════════════════════════════════════════
    if (pathname.startsWith('/access/') && method === 'GET') {
      const linkToken = pathname.split('/').pop();
      const db        = loadDB();
      const link      = db.links.find(l => l.token === linkToken);

      if (!link || !link.active) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(accessPage('error', null, 'Ce lien est invalide ou a été révoqué.'));
      }

      if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
        link.active = false;
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(accessPage('error', null, 'Ce lien a expiré.'));
      }

      const doc = db.documents.find(d => d.id === link.docId && d.active);
      if (!doc) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(accessPage('error', null, 'Document introuvable.'));
      }

      // Enregistrer l'accès
      link.views = (link.views || 0) + 1;
      link.lastAccessAt = new Date().toISOString();
      doc.views = (doc.views || 0) + 1;
      saveDB(db);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(accessPage('view', doc, null, link));
    }

    // ════════════════════════════════════════
    // STATS DASHBOARD
    // ════════════════════════════════════════
    if (pathname === '/api/stats' && method === 'GET') {
      const token   = getTokenFromRequest(req);
      const payload = token ? verifyToken(token) : null;
      if (!payload) return jsonResponse(res, 401, { success: false, error: 'Connexion requise' });

      const db    = loadDB();
      const docs  = db.documents.filter(d => d.userId === payload.userId && d.active);
      const links = db.links.filter(l => l.userId === payload.userId);
      const totalViews  = links.reduce((sum, l) => sum + (l.views || 0), 0);
      const activeLinks = links.filter(l => l.active).length;
      const suspicious  = links.filter(l => (l.views || 0) > 10).length;

      return jsonResponse(res, 200, {
        success: true,
        stats: { totalDocs: docs.length, activeLinks, totalViews, suspicious },
        recentActivity: links
          .filter(l => l.lastAccessAt)
          .sort((a, b) => new Date(b.lastAccessAt) - new Date(a.lastAccessAt))
          .slice(0, 5)
          .map(l => ({
            linkId: l.id,
            recipient: l.recipientName,
            views: l.views,
            lastAccess: l.lastAccessAt,
            active: l.active,
          })),
      });
    }

    // ════════════════════════════════════════
    // PAIEMENT — INITIER
    // ════════════════════════════════════════
    if (pathname === '/api/payment/initiate' && method === 'POST') {
      const { data } = await readBody(req);
      const { amount, plan, firstName, lastName, email, phone, paymentMethod } = data;

      if (!amount || !firstName || !lastName || !email)
        return jsonResponse(res, 400, { success: false, error: 'Champs manquants' });
      if (parseInt(amount) < 200)
        return jsonResponse(res, 400, { success: false, error: 'Montant minimum: 200 FCFA' });
      if (!CONFIG.GENIUSPAY_PK || !CONFIG.GENIUSPAY_SK)
        return jsonResponse(res, 500, { success: false, error: 'Clés GeniusPay non configurées' });

      const transactionId = 'PD-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const payload = {
        amount:      parseInt(amount),
        currency:    'XOF',
        description: plan === 'premium' ? 'PRIVYDOC Premium — 2 mois' : 'PRIVYDOC Petit Coût — 2 jours',
        customer:    { name: firstName + ' ' + lastName, email, ...(phone && { phone }) },
        success_url: CONFIG.SITE_URL + '/payment/success?ref=' + transactionId + '&plan=' + plan + '&email=' + encodeURIComponent(email),
        error_url:   CONFIG.SITE_URL + '/payment/failed',
        metadata:    { plan, user_email: email, transaction_ref: transactionId, platform: 'PRIVYDOC' },
        ...(paymentMethod && paymentMethod !== 'auto' && { payment_method: paymentMethod }),
      };

      console.log('→ GeniusPay:', transactionId, amount + ' XOF', plan);
      const result = await geniuspayRequest('POST', '/payments', payload);

      if (result.success && result.data) {
        const checkoutUrl = result.data.checkout_url || result.data.payment_url;
        // Sauvegarder la transaction
        const db = loadDB();
        db.payments.push({ id: transactionId, reference: result.data.reference, plan, amount: parseInt(amount), email, status: 'pending', createdAt: new Date().toISOString() });
        saveDB(db);
        console.log('✅ Paiement initié:', result.data.reference);
        return jsonResponse(res, 200, { success: true, reference: result.data.reference, checkout_url: checkoutUrl, transaction_id: transactionId });
      } else {
        console.error('❌ GeniusPay error:', result);
        return jsonResponse(res, 400, { success: false, error: result.error?.message || 'Erreur GeniusPay', details: result });
      }
    }

    // ════════════════════════════════════════
    // PAIEMENT — VÉRIFIER STATUT
    // ════════════════════════════════════════
    if (pathname.startsWith('/api/payment/verify/') && method === 'GET') {
      const reference = pathname.split('/').pop();
      const result    = await geniuspayRequest('GET', '/payments/' + reference, null);
      if (result.success) {
        return jsonResponse(res, 200, { success: true, status: result.data.status, data: result.data });
      }
      return jsonResponse(res, 400, { success: false, error: 'Transaction non trouvée' });
    }

    // ════════════════════════════════════════
    // PAIEMENT — ACTIVER PLAN APRÈS SUCCÈS
    // ════════════════════════════════════════
    if (pathname === '/payment/success' && method === 'GET') {
      const ref   = parsed.query.ref   || '';
      const plan  = parsed.query.plan  || '';
      const email = decodeURIComponent(parsed.query.email || '');

      // Mettre à jour le plan utilisateur
      if (email && plan) {
        const db   = loadDB();
        const user = db.users.find(u => u.email === email);
        if (user) {
          user.plan = plan === 'premium' ? 'premium' : 'micro';
          user.planActivatedAt = new Date().toISOString();
          user.planExpiresAt   = plan === 'premium'
            ? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()  // 2 mois
            : new Date(Date.now() +  2 * 24 * 60 * 60 * 1000).toISOString(); // 2 jours
          const payment = db.payments.find(p => p.id === ref);
          if (payment) payment.status = 'completed';
          saveDB(db);
          console.log('✅ Plan activé:', email, '→', user.plan);
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Paiement Réussi — PRIVYDOC</title>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#050810;color:#F0F4FF;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:2rem}
      .icon{width:90px;height:90px;border-radius:50%;background:rgba(16,185,129,0.15);border:2px solid #10B981;display:flex;align-items:center;justify-content:center;font-size:3rem;margin:0 auto 1.5rem;animation:pop .5s ease}
      @keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}
      h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;margin-bottom:.75rem}
      p{color:#8899BB;max-width:420px;margin:0 auto 2rem;line-height:1.6}
      a{background:linear-gradient(135deg,#3B82F6,#8B5CF6);color:white;padding:.85rem 2rem;border-radius:10px;text-decoration:none;font-weight:500}</style></head>
      <body><div class="icon">✅</div>
      <h1>Paiement réussi !</h1>
      <p>Votre accès PRIVYDOC ${plan === 'premium' ? 'Premium (2 mois)' : 'Petit Coût (2 jours)'} a été activé. Reconnectez-vous pour accéder à votre nouveau plan.</p>
      <a href="/">🚀 Retour à PRIVYDOC</a></body></html>`);
    }

    if (pathname === '/payment/failed' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Paiement Échoué — PRIVYDOC</title>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#050810;color:#F0F4FF;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:2rem}
      .icon{width:90px;height:90px;border-radius:50%;background:rgba(239,68,68,0.15);border:2px solid #EF4444;display:flex;align-items:center;justify-content:center;font-size:3rem;margin:0 auto 1.5rem}
      h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;margin-bottom:.75rem}
      p{color:#8899BB;max-width:400px;margin:0 auto 2rem}
      a{background:linear-gradient(135deg,#3B82F6,#8B5CF6);color:white;padding:.85rem 2rem;border-radius:10px;text-decoration:none;font-weight:500}</style></head>
      <body><div class="icon">❌</div><h1>Paiement échoué</h1>
      <p>Une erreur est survenue. Veuillez réessayer ou choisir un autre moyen de paiement.</p>
      <a href="/">↩ Réessayer</a></body></html>`);
    }

    // ════════════════════════════════════════
    // WEBHOOK GENIUSPAY
    // ════════════════════════════════════════
    if (pathname === '/api/webhook' && method === 'POST') {
      const { data } = await readBody(req);
      console.log('🔔 Webhook:', data.event, data.data?.reference);
      if (data.event === 'payment.success' && data.data?.metadata?.user_email) {
        const db   = loadDB();
        const user = db.users.find(u => u.email === data.data.metadata.user_email);
        if (user) {
          const plan = data.data.metadata.plan;
          user.plan  = plan === 'premium' ? 'premium' : 'micro';
          const payment = db.payments.find(p => p.reference === data.data.reference);
          if (payment) payment.status = 'completed';
          saveDB(db);
        }
      }
      res.writeHead(200); res.end('OK');
      return;
    }

    // ════════════════════════════════════════
    // PAGES STATIQUES
    // ════════════════════════════════════════
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(__dirname, 'privydoc.html'), 'text/html; charset=utf-8');
    }

    const staticPath = path.join(__dirname, pathname);
    const ext        = path.extname(pathname);
    const mime       = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon' };
    if (mime[ext] && fs.existsSync(staticPath)) {
      return serveFile(res, staticPath, mime[ext]);
    }

    return jsonResponse(res, 404, { error: 'Route non trouvée: ' + pathname });

  } catch (err) {
    console.error('❌ Erreur serveur:', err.message, err.stack);
    return jsonResponse(res, 500, { success: false, error: 'Erreur serveur: ' + err.message });
  }
});

// ── PAGE VISIONNEUSE DOCUMENT ────────────────────────
function accessPage(type, doc, errorMsg, link) {
  if (type === 'error') {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accès refusé — PRIVYDOC</title>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700&family=DM+Sans&display=swap" rel="stylesheet">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#050810;color:#F0F4FF;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:2rem}
    .icon{font-size:4rem;margin-bottom:1rem}h1{font-family:'Syne',sans-serif;font-size:1.8rem;font-weight:700;margin-bottom:.75rem}p{color:#8899BB;margin-bottom:2rem}
    a{color:#3B82F6;text-decoration:none}</style>
    </head><body><div class="icon">🔒</div><h1>Accès refusé</h1><p>${errorMsg}</p><a href="/">← Retour à PRIVYDOC</a></body></html>`;
  }

  const isPdf = doc.ext === '.pdf';
  const isImg = ['.jpg','.jpeg','.png','.gif','.webp'].includes(doc.ext);
  const watermarkText = `Document privé · ${link.recipientName} · ${new Date().toLocaleDateString('fr-FR')}`;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${doc.name} — PRIVYDOC Viewer</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700&family=DM+Sans&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;-webkit-user-select:none;user-select:none}
    body{font-family:'DM Sans',sans-serif;background:#050810;color:#F0F4FF;min-height:100vh;overflow-x:hidden}
    .viewer-nav{background:#0c1120;border-bottom:1px solid rgba(255,255,255,0.06);padding:.75rem 1.5rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1.1rem;color:#F0F4FF}
    .logo span{color:#06B6D4}
    .doc-title{font-size:.85rem;color:#8899BB}
    .secure-badge{display:flex;align-items:center;gap:.4rem;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);color:#10B981;padding:.3rem .7rem;border-radius:100px;font-size:.75rem}
    .viewer-body{max-width:900px;margin:2rem auto;padding:0 1rem;position:relative}
    .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:clamp(.7rem,2vw,1.1rem);color:rgba(59,130,246,0.12);font-weight:700;pointer-events:none;z-index:100;white-space:nowrap;text-align:center;line-height:1.8;letter-spacing:.05em}
    .doc-frame{width:100%;border:none;border-radius:12px;background:#fff;min-height:80vh}
    .no-preview{background:#0c1120;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:4rem 2rem;text-align:center}
    .no-preview .icon{font-size:4rem;margin-bottom:1rem}
    .no-preview h3{font-family:'Syne',sans-serif;font-size:1.2rem;margin-bottom:.5rem}
    .no-preview p{color:#8899BB;font-size:.85rem}
    .protected-bar{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:.6rem 1rem;display:flex;align-items:center;gap:.5rem;font-size:.8rem;color:#EF4444;margin-bottom:1rem}
  </style>
  <script>
    document.addEventListener('contextmenu',e=>e.preventDefault());
    document.addEventListener('keydown',e=>{
      if((e.ctrlKey||e.metaKey)&&['s','p','u','a','c'].includes(e.key.toLowerCase()))e.preventDefault();
      if(e.key==='F12'||e.key==='PrintScreen')e.preventDefault();
    });
    document.addEventListener('copy',e=>e.preventDefault());
    document.addEventListener('cut',e=>e.preventDefault());
  </script>
  </head><body>
  <div class="viewer-nav">
    <div class="logo">🔒 PRIVY<span>DOC</span></div>
    <div class="doc-title">📄 ${doc.name}</div>
    <div class="secure-badge">🛡️ Document sécurisé</div>
  </div>
  <div class="viewer-body">
    <div class="watermark">${watermarkText}<br>${watermarkText}<br>${watermarkText}</div>
    <div class="protected-bar">🚫 Téléchargement désactivé · Copie bloquée · Clic droit désactivé</div>
    ${isPdf
      ? `<iframe class="doc-frame" src="${doc.secureUrl}" style="height:85vh" sandbox="allow-scripts allow-same-origin"></iframe>`
      : isImg
      ? `<div style="text-align:center"><img src="${doc.secureUrl}" style="max-width:100%;border-radius:12px;pointer-events:none" draggable="false" oncontextmenu="return false"></div>`
      : `<div class="no-preview"><div class="icon">📄</div><h3>${doc.name}</h3><p>Prévisualisation non disponible pour ce format.<br>Le document est protégé et accessible uniquement via cette visionneuse.</p></div>`
    }
  </div>
  </body></html>`;
}

// ── DÉMARRAGE ────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║       🔒 PRIVYDOC — Serveur Complet        ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  ✅ Port     : ${CONFIG.PORT}                         ║`);
  console.log(`║  🌐 URL      : ${CONFIG.SITE_URL}`);
  console.log(`║  💳 GeniusPay: ${CONFIG.GENIUSPAY_PK ? '✅ Configuré' : '❌ Clés manquantes'}`);
  console.log(`║  ☁️  Cloudinary: ${CONFIG.CLOUDINARY_CLOUD ? '✅ Configuré' : '❌ Clés manquantes'}`);
  console.log('╚════════════════════════════════════════════╝\n');
});
