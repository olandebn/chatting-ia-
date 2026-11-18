# RelaisIA — Remplacement de Gemini par Groq (Qwen 3.8)

## Clé et sécurité
La clé déjà envoyée dans une conversation doit être **révoquée**, puis remplacée par une nouvelle dans GroqCloud (`https://console.groq.com/keys`).

Dans Supabase > **Edge Functions > Secrets**, crée le secret `GROQ_API_KEY` avec la nouvelle clé, **sans la coller dans le chat ou sur GitHub**. L'installateur ne configure pas de secret et ne poste rien sur Instagram.

Groq dispose d'une offre gratuite soumise à des limites. L'analyse visuelle et la génération des trois légendes sont effectuées par Qwen 3.8, jusqu'à 3 images analysées par carrousel (couverture, milieu, fin). Les photos privées sont envoyées à Groq, elles ne deviennent pas publiques. NoTrack reste disponible pour l'outil de rédaction manuelle ; l'intégration Groq seule n'a pas besoin de recharger des crédits Gemini.

## Installer la mise à jour du code source

1. Extrais le ZIP séparément du dépôt local.
2. Lance `INSTALLER_WINDOWS.bat`.
3. Appuie sur Entrée pour le dossier du projet, puis attends `PREFLIGHT OK`.
4. Tape **OUI**, vérifie `INSTALLATION OK`.
5. Dans PowerShell :

```powershell
cd "C:\Users\oland\Downloads\chatting-ia--main\chatting-ia--main"
node --check social.js
node --check app.js
git add social.js app.js index.html supabase/functions/social-api/index.ts docs/GROQ_VISION_README.md
git diff --cached --check
git diff --cached --stat
git commit -m "feat: remplacer Gemini par Groq Vision"
git push origin main
```

Ouvre ensuite `https://olandebn.github.io/chatting-ia-/?v=vision-groq-v2-20261118#/app/social` et rafraîchis avec Ctrl + Shift + R. Teste avec un brouillon, sans le programmer.

**Remarque :** la V10 de la fonction Supabase est déjà déployée indépendamment. Ce correctif permet de synchroniser le dépôt GitHub ; les fichiers locaux peuvent être légèrement différents du code V10 (la fonction locale utilise Groq pour les textes, tandis que V10 contient en plus une option NoTrack désactivée par défaut). Ne redéploie pas `social-api` depuis le local sans vérifier ce point.
