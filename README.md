# Relais IA

Assistant IA pour Telegram Business, en SaaS multi-clients.

- `index.html`, `styles.css`, `app.js` : le site (statique, aucune compilation), servi par GitHub Pages.
- `functions/` : les fonctions Supabase déjà déployées (`telegram-webhook`, `worker`, `api`, avec `core.ts` partagé).
- `supabase/` : le schéma de la base, déjà appliqué sur le projet `relais-ia` (owbcnkcuxcgsawjqkssk).

## Mise en ligne du site

Sur GitHub : Settings → Pages → Source « Deploy from a branch » → branche `main`, dossier `/ (root)`.
Le site sera en ligne à https://olandebn.github.io/chatting-ia-/

## Réglages Supabase (tableau de bord Supabase → Authentication → URL Configuration)

- Site URL : l'adresse de ton site (https://olandebn.github.io/chatting-ia-/)
- Redirect URLs : la même adresse suivie de `/**`
- Pour un vrai lancement : configure un SMTP (Authentication → Emails), l'envoi d'e-mails intégré est limité à quelques messages par heure.

## Configuration de la plateforme (une seule fois)

1. Crée ton compte sur le site, puis Mon compte → « J'ai un code administrateur » → saisis le code fourni.
2. Dans @BotFather : crée un bot, puis Bot Settings → Business Mode → Turn on.
3. Administration : colle le token du bot et ta clé API Anthropic, enregistre. Le webhook Telegram est configuré automatiquement.

## Fonctionnement

- Telegram envoie chaque message Business au webhook, qui l'enregistre et programme une réponse (délai aléatoire dans la plage choisie).
- Chaque minute, `pg_cron` appelle `worker`, qui génère la réponse avec Claude puis l'envoie (Automatique) ou crée un brouillon avec boutons Envoyer / Ignorer dans le chat privé du bot (Validation).
- Quand le propriétaire répond lui-même : pause de la discussion, réponses programmées annulées, réponse ajoutée aux « Exemples à valider ».
- `/stopai` envoyé par un contact : IA arrêtée dans la discussion et mémoire effacée.
- Messages supprimés après 30 jours (tâche cron quotidienne).
