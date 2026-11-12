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

## Choisir OpenAI comme moteur IA

Ce projet prend en charge Claude (Anthropic) et OpenAI. Par défaut, Claude reste actif afin d'éviter de casser le bot actuel.

1. Sur [platform.openai.com/api-keys](https://platform.openai.com/api-keys), crée une clé API de projet avec facturation API séparée de ChatGPT Plus.
2. Dans Supabase, projet Relais IA → **Edge Functions → Secrets**, crée **OPENAI_API_KEY** contenant cette clé. Ne mets jamais la clé dans `app.js`, dans GitHub ou dans le tableau de bord.
3. Déploie les fonctions `worker` et `api` (et `telegram-webhook` si tu souhaites synchroniser la copie de `core.ts`).
4. Dans Relais IA → Administration, choisis **OpenAI — GPT**, puis **GPT-5.4 mini** ; enregistre.
5. Passe le bot en **Validation** et fais un test réel. Ensuite seulement, passe en Automatique.
6. Configure des **alertes de budget et une limite de dépenses** sur ton projet OpenAI.

**Déploiement en CLI (depuis la racine du projet) :**

```bash
supabase login
supabase link --project-ref owbcnkcuxcgsawjqkssk
supabase functions deploy worker
supabase functions deploy api
# facultatif pour harmoniser le core partagé :
supabase functions deploy telegram-webhook
```

Pour publier l'interface : commite `app.js` dans le dépôt public `olandebn/chatting-ia-` (GitHub Pages).

**Sécurité et confidentialité :** la clé OpenAI est utilisée uniquement côté Edge Function, jamais en navigateur. L'historique transmis à OpenAI inclut des messages privés Telegram ; informe les personnes concernées, vérifie leur consentement/tes obligations de protection des données, et garde les règles de conservation et de suppression des messages. `store: false` désactive la conservation de la réponse en tant qu'objet stocké, mais n'annule pas toutes les pratiques de journalisation du fournisseur.
