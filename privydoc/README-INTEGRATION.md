# PRIVYDOC — Intégration GeniusPay + Auth0

## 🚨 SÉCURITÉ : à faire EN PREMIER

1. **Régénère ta clé secrète GeniusPay** (`sk_live_...`) dans le dashboard GeniusPay.
   Elle a circulé en texte brut dans des conversations → considère-la compromise.
2. La nouvelle clé va **uniquement** dans Railway → Variables. Jamais dans le code, jamais sur GitHub.
3. Vérifie que `.gitignore` contient bien `.env` avant tout `git push`.

## 📁 Fichiers

```
privydoc/
├── .env.example              ← modèle (placeholders uniquement)
├── .gitignore                ← protège .env
├── lib/
│   ├── env.js                ← chargement + vérification des variables
│   ├── geniuspay.js          ← paiements côté serveur (SK jamais exposée)
│   └── auth0.js              ← vérification tokens Auth0 (crypto natif, 0 dépendance)
├── routes-payment-auth.js    ← routes à brancher dans server.js
└── public/
    └── auth0-payment-snippet.html ← code frontend à intégrer dans privydoc.html
```

## ⚙️ Configuration Auth0 (dashboard auth0.com)

### 1. Créer l'application
- Applications → Create Application → **Single Page Application**
- Nom : `PRIVYDOC`
- **Allowed Callback URLs** : `https://ton-app.up.railway.app, http://localhost:3000`
- **Allowed Logout URLs** : idem
- **Allowed Web Origins** : idem
- Note le **Domain** et le **Client ID** → variables `AUTH0_DOMAIN` / `AUTH0_CLIENT_ID`

### 2. Créer l'API (pour l'audience)
- Applications → APIs → Create API
- Identifier : `https://api.privydoc.com` (c'est un identifiant logique, pas une vraie URL)
- → variable `AUTH0_AUDIENCE`

### 3. Activer les connexions
- Authentication → Database → `Username-Password-Authentication` ✅ (email/mot de passe)
- Authentication → Social → **Google** ✅
  - Les clés de dev Auth0 fonctionnent pour tester, mais en production crée
    tes propres identifiants Google OAuth (Google Cloud Console) et colle-les dans Auth0.

### 4. (Recommandé) Ajouter l'email dans l'access token
Actions → Library → Build Custom → trigger `post-login` :
```javascript
exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim('https://privydoc.com/email', event.user.email);
};
```
Puis ajoute-la au flow **Login**.

## 🚂 Variables Railway

| Variable | Valeur |
|---|---|
| `GENIUS_PK` | ta clé publique GeniusPay |
| `GENIUS_SK` | ta **nouvelle** clé secrète (après régénération) |
| `GENIUS_BASE_URL` | `https://pay.genius.ci/api/v1` |
| `AUTH0_DOMAIN` | `ton-tenant.eu.auth0.com` |
| `AUTH0_CLIENT_ID` | depuis le dashboard Auth0 |
| `AUTH0_AUDIENCE` | `https://api.privydoc.com` |
| `APP_URL` | URL Railway de l'app |

## 🔄 Migration depuis ton JWT maison

- Supprime les routes `POST /api/auth/signup` et `POST /api/auth/login` (Auth0 les remplace).
- `GET /api/auth/me` est conservée mais utilise maintenant `requireAuth()` d'Auth0
  et crée le profil local à la première connexion.
- Sur **toutes** les routes protégées (documents, liens, stats), remplace ton
  ancien middleware par :
  ```javascript
  const user = await requireAuth(req, res);
  if (!user) return; // 401 déjà envoyé
  ```
- Les utilisateurs sont identifiés par `auth0Id` (`payload.sub`), ex. :
  - `google-oauth2|10543...` → connexion Google
  - `auth0|66f2ab...` → inscription email/mot de passe

## 💳 Flux de paiement (sécurisé)

1. Frontend → `POST /api/payment/initiate` avec **seulement** `{ planId }`
   (le montant est défini côté serveur — impossible de payer 1 FCFA en trichant).
2. Serveur → GeniusPay avec `X-API-Key` + `X-API-Secret` → reçoit `checkout_url`.
3. Redirection vers la page GeniusPay (Wave, Orange Money, MTN MoMo, Moov, Visa/Mastercard).
4. Retour sur `/payment/success?ref=...` → le frontend appelle
   `GET /api/payment/verify/:ref` → le **serveur re-vérifie auprès de GeniusPay**
   avant d'activer le plan. Le navigateur n'est jamais la source de vérité.
5. Le webhook `/api/webhook/geniuspay` couvre le cas où l'utilisateur ferme
   l'onglet avant le retour (configure l'URL dans le dashboard GeniusPay).

## ✅ Checklist avant déploiement

- [ ] Clé secrète GeniusPay régénérée
- [ ] `.env` absent du repo (`git status` ne doit pas le montrer)
- [ ] Variables configurées sur Railway
- [ ] URLs de callback Auth0 = URL Railway exacte
- [ ] Webhook GeniusPay configuré
- [ ] Test complet : signup email → paiement micro 200 FCFA → vérification plan actif
- [ ] Test : connexion Google → paiement premium 5000 FCFA
