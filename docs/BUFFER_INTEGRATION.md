# RelaisIA + Buffer — Installateur corrigé V2 (17 novembre 2026)

## Pourquoi l'ancien installateur s'arrêtait

L'ancien installateur comparait les octets de `social.js` avec une empreinte SHA-256, sans prendre en compte les fins de ligne Windows (CRLF), ou les modifications antérieures conservées dans la branche Git. Il pouvait donc refuser une version de RelaisIA tout à fait compatible. **Ne force pas l'ancien ZIP.**

Cette V2 vérifie les sections du code nécessaires au module Buffer, n'applique que les changements ciblés et **conserve le reste de `social.js`**, ainsi que Telegram, NoTrack et les fichiers Supabase existants. Si une section ne correspond plus, elle s'arrête **sans écraser** les fichiers.

## Pour ton installation actuelle

Ton projet : `C:\Users\oland\Downloads\chatting-ia--main\chatting-ia--main`.

Les étapes suivantes sont déjà faites d'après la configuration précédente : compte `@starelyna` connecté dans Buffer, clés `BUFFER_API_KEY` et `BUFFER_MEDIA_SIGNING_KEY` enregistrées dans Supabase, table `social_buffer_jobs` créée, fonction `buffer-bridge` déployée. **Ne refais pas ces étapes**, sauf si un test prouve qu'elles ne fonctionnent pas. Nous n'avons pas encore confirmé que la clé Buffer permet effectivement de lire les canaux.

1. Décompresse **ce nouveau ZIP V2** dans un dossier neuf, distinct de l'ancien ZIP et du dépôt Git.
2. Lance `INSTALLER_WINDOWS.bat`. Au chemin proposé, appuie sur **Entrée**.
3. Quand `PREFLIGHT OK` s'affiche, écris **OUI**. Attends `INSTALLATION OK`.
4. Si le programme affiche `STOP`, n'essaie pas de contourner la vérification. Copie son message exact.
5. Depuis PowerShell :

```powershell
cd "C:\Users\oland\Downloads\chatting-ia--main\chatting-ia--main"
git status --short
node --check app.js
node --check social.js
git diff --check
git diff --stat
```

Si ces commandes réussissent et que `app.js`, `index.html` et `social.js` figurent dans `git status --short`, publie **uniquement** les fichiers de Buffer :

```powershell
git add app.js index.html social.js supabase/functions/buffer-bridge/index.ts docs/BUFFER_INTEGRATION.md
git diff --cached --check
git diff --cached --stat
git commit -m "feat: Buffer bridge UI installer fix"
git push origin main
```

N'exécute pas `git add .` ou `supabase db push` : les migrations Supabase déjà présentes en non-suivi ne font pas partie du correctif.

## Vérification après publication

Ouvre `https://olandebn.github.io/chatting-ia-/#/app/social` et recharge avec **Ctrl+F5**. L'onglet **Buffer** doit apparaître pour le compte administrateur. Il doit afficher les canaux Instagram si les secrets sont valides et si Buffer fournit les autorisations API attendues.

L'étape de connexion API est un test **sans publication réelle**. Pour programmer une publication, il faudra explicitement créer un brouillon, sélectionner le compte et la date, cocher la confirmation et accepter le dialogue final. **Aucune publication n'est faite à l'installation.**

## Protections techniques

- Refuse le dossier s'il ne contient pas un `.git`.
- Refuse les modifications locales ou fichiers préexistants sur les chemins concernés.
- Vérifie 9 changements contextuels précis dans `social.js` et les imports `app.js`/`index.html`.
- Reconstruit `social.js` en conservant les autres différences et les fins de ligne Windows CRLF.
- Sauvegarde les fichiers remplacés hors du dépôt Git dans `..._backup_buffer_v2_<date>`.
- Installe `supabase/functions/buffer-bridge/index.ts` et `docs/BUFFER_INTEGRATION.md`, sans toucher aux anciennes fonctions Supabase.
- En cas d'erreur pendant l'écriture, annule les fichiers partiellement créés.

## Limites

Cette version prend en charge les publications Instagram à **image unique**, depuis un brouillon RelaisIA vers Buffer. Elle ne gère ni les Stories, ni les Reels, ni les carrousels. Buffer peut exiger une notification manuelle pour certains contenus. Le statut `Programmé chez Buffer` ne garantit pas que la publication soit visible sur Instagram.

Pour éviter les doublons, l'application conserve un historique de programmation et bloque une nouvelle programmation du même brouillon quand son statut est incertain.

La clé Buffer reste uniquement dans les Secrets des Edge Functions Supabase, jamais dans le navigateur ou sur GitHub. Les URL des photos sont signées, mais une personne qui possède une URL valide peut voir cette photo durant sa validité.
