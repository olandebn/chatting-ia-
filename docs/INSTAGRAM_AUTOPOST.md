# Instagram Autopost — Relais IA

Publication automatique de photos sur un compte Instagram **professionnel** via l’API officielle
« Instagram API with Instagram Login » (Graph API v27.0), depuis le module Social Automation.

## Architecture

```
GitHub Pages (social.js)  ──JWT──▶  social-api (Edge Function)  ──▶  Postgres (social_*) + Storage privé
                                          │  OAuth Instagram (GET callback)
pg_cron « relais-social-worker » ──secret Vault──▶ social-worker ──▶ graph.instagram.com
```

* Aucun token Instagram n’atteint le navigateur. Les tokens longue durée (60 j) sont chiffrés
  en AES‑256‑GCM avec `SOCIAL_TOKEN_KEY` et renouvelés automatiquement par le worker 10 jours avant expiration.
* Les tables `social_*` n’ont **aucun** accès `anon`/`authenticated` : tout passe par les Edge Functions,
  qui filtrent chaque requête par `user_id` + `creator_id`.
* Les photos restent dans le bucket privé `relais-social-private`. Pour la publication, Meta reçoit une
  URL signée valable 1 heure (Meta télécharge l’image une seule fois lors de la création du conteneur).
* Le secret du worker est généré **dans** la base (Vault `social_worker_secret`) : personne ne le voit.

## Machine d’états d’une publication

`draft` → `scheduled` → `processing` → `published`
                                   ↘ `failed` (rien n’a été publié — vérifié)
                                   ↘ `unknown` « À vérifier » (Meta a peut‑être publié)

* Créer un **conteneur** ne publie rien : réessayé automatiquement en cas d’erreur réseau/temporaire.
* `media_publish` est appelé **au plus une fois** : `publish_attempted_at` est écrit avant l’appel.
* Réponse ambiguë (timeout, 5xx, plantage) ⇒ `unknown`, puis le worker vérifie en lecture seule le statut
  du conteneur et la liste réelle des posts du compte ; il ne passe à `published` que s’il retrouve le post,
  et à `failed` seulement si Meta confirme que le conteneur n’a pas été publié.
* Quota Meta (`content_publishing_limit`) vérifié avant chaque création ; si atteint, report de 30 min.

## 1. Préparer le compte Instagram

1. Dans l’app Instagram : *Paramètres → Type de compte et outils → Passer à un compte professionnel*
   (Créateur ou Entreprise).
2. Le compte doit être **public** pour être ajouté comme testeur.

## 2. Créer l’application Meta (Meta for Developers)

1. <https://developers.facebook.com/apps> → **Créer une app**.
2. Cas d’utilisation : **« Gérer les messages et le contenu sur Instagram »** (Instagram API). Type : **Entreprise**.
   Nom suggéré : `Relais IA`. Ne pas rattacher à un portefeuille business si vous n’en avez pas besoin.
3. Dans le cas d’utilisation → **Configuration de l’API avec connexion Instagram** :
   * Copiez l’**ID de l’app Instagram** et la **clé secrète de l’app Instagram** (⚠️ différents de l’ID d’app Facebook
     affiché en haut de page). Ne les collez nulle part ailleurs que dans les secrets Supabase (étape 3).
   * **Configurer la connexion professionnelle Instagram → Paramètres** :
     * URI de redirection OAuth : `https://owbcnkcuxcgsawjqkssk.supabase.co/functions/v1/social-api`
     * URL de rappel d’annulation d’autorisation : `https://owbcnkcuxcgsawjqkssk.supabase.co/functions/v1/social-api?meta=deauthorize`
     * URL de demande de suppression des données : `https://owbcnkcuxcgsawjqkssk.supabase.co/functions/v1/social-api?meta=data_deletion`
4. **Autorisations** du cas d’utilisation : ajoutez `instagram_business_basic` et
   `instagram_business_content_publish` (accès **Standard** suffit pour un compte que vous possédez/gérez).
5. **Rôles de l’app → Rôles → Testeurs Instagram** : ajoutez votre compte Instagram, puis acceptez l’invitation
   dans Instagram (*Paramètres → Apps et sites web → Invitations de testeur*).
6. L’app peut rester en **mode développement** pour vos propres comptes. Pour servir des comptes que vous ne
   gérez pas, il faudra l’accès avancé (App Review) et passer l’app en mode Live (URL de politique de
   confidentialité requise).

## 3. Secrets Supabase

Dashboard Supabase → projet `relais-ia` → **Edge Functions → Secrets** → *Add new secret* :

| Nom | Valeur |
|---|---|
| `INSTAGRAM_APP_ID` | ID de l’app **Instagram** (étape 2.3) |
| `INSTAGRAM_APP_SECRET` | Clé secrète de l’app **Instagram** |
| `SOCIAL_TOKEN_KEY` | 32 octets aléatoires en base64 (voir ci‑dessous) |
| `NOTRACK_API_KEY` | déjà présent (génération IA) |

`SOCIAL_WORKER_SECRET` n’est **plus nécessaire** : le worker est authentifié par le secret Vault
généré automatiquement. (S’il est défini, il est aussi accepté.)

Générer `SOCIAL_TOKEN_KEY` sans l’afficher (PowerShell, copie directement dans le presse‑papiers) :

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard
```

⚠️ Ne changez plus cette clé ensuite : les tokens déjà chiffrés deviendraient illisibles (il faudrait reconnecter Instagram).

## 4. Connecter Instagram dans Relais IA

1. Relais IA → **Social Automation → Compte Instagram** → *Connecter Instagram professionnel*.
2. Instagram demande d’autoriser **Relais IA** : acceptez la lecture du profil **et** la publication.
3. Retour automatique sur Relais IA : le compte, son @nom, son type, les permissions accordées et la date
   d’expiration du token s’affichent.

Messages possibles au retour : autorisation refusée, permissions incomplètes, compte non professionnel,
compte déjà relié à un autre créateur, lien expiré (10 min), échec de l’échange Meta (voir journaux).

## 5. Activer la publication automatique

Le cron `relais-social-worker` (chaque minute) a été créé **inactif**. Une fois Instagram connecté et un premier
test validé, un administrateur Relais IA l’active depuis *Compte Instagram → Activer la publication automatique*
(confirmation « ACTIVER »). Équivalent SQL :

```sql
select public.social_set_scheduler(true);   -- activer
select public.social_set_scheduler(false);  -- mettre en pause
```

Tant qu’il est en pause, les publications programmées attendent ; rien n’est publié.

## 6. Test recommandé (premier envoi réel)

1. Importer une photo JPEG 4:5 non sensible.
2. Créer un brouillon, le programmer à +5 minutes.
3. Activer le planificateur, attendre le passage à **Publié**, cliquer *Voir sur Instagram*.
4. En cas d’« À vérifier » : regarder le compte Instagram ; le worker confirmera automatiquement si le post existe.

## Contraintes Instagram appliquées

* JPEG uniquement, 8 Mo max, ratio entre 4:5 et 1,91:1, largeur ≥ 320 px. L’import peut convertir et
  recadrer automatiquement (option cochée par défaut).
* Légende ≤ 2 200 caractères, 30 hashtags max.
* Mention de transparence `#CréatriceVirtuelle` ajoutée automatiquement aux contenus marqués « IA ».
* Quota Meta : 50 publications API / 24 h glissantes (valeur lue en direct via `content_publishing_limit`).

## Tests

```bash
deno test supabase/functions/social-worker/engine_test.ts
```

23 tests avec un faux Graph API (aucun appel à Meta) : publication nominale, conteneur en cours, timeout
pendant `media_publish` (⇒ « À vérifier », jamais republié), erreurs temporaires, token expiré/refusé,
permission manquante, média refusé, quota, réconciliation, renouvellement de token, non‑fuite du token.
