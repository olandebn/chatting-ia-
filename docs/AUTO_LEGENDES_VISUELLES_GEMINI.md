# RelaisIA — Légendes Instagram automatiques à partir des photos (Gemini)

Le module Social Automation propose automatiquement **trois légendes** quand tu sélectionnes des photos dans **Médias → Créer une publication** ou que tu modifies les photos dans l'éditeur. La première proposition remplit le champ de légende; tu peux la modifier et sélectionner les deux autres. Aucune photo n'est publiée sans validation explicite via Buffer.

## Activation du service de vision

1. Crée une clé API Gemini via https://aistudio.google.com/apikey.
2. Dans Supabase pour le projet `owbcnkcuxcgsawjqkssk`, ouvre **Edge Functions → Secrets**.
3. Ajoute un secret nommé `GEMINI_API_KEY` et colle sa valeur **uniquement dans Supabase**. Ne la mets jamais dans le frontend ni sur GitHub.
4. L'Edge Function `social-api` V7 est déjà déployée côté Supabase. Si tu utilises une installation autonome, déploie ensuite ton propre `social-api` en conservant la configuration JWT antérieure.
5. Recharge RelaisIA après activation, puis sélectionne deux ou trois photos pour voir **Analyse des photos...** suivi de **Légende générée automatiquement**.

## Sécurité et données

- Les photos restent dans le stockage privé Supabase ; seul le backend lit un **échantillon représentatif jusqu'à 4 images** et les transmet à Google Gemini pour analyse. Google traite ces images conformément à ses conditions API et aux paramètres du compte Gemini.
- Chaque image analysée est limitée à 2 Mo ; au-delà, l'éditeur affiche une erreur et la légende peut être saisie manuellement.
- Les appels sont limités à 20 analyses par heure et par utilisateur, avec une seule génération déclenchée après 700 ms sans changement de sélection.
- La clé n'apparaît ni dans le navigateur ni dans les fichiers du site public.
- Le texte généré reste **éditable**, le marquage `#CréatriceVirtuelle` est demandé à l'IA et appliqué côté serveur à l'enregistrement pour les photos synthétiques.
- Une génération peut consommer le quota ou des crédits Gemini. La facturation dépend du compte et du modèle.
- Si `GEMINI_API_KEY` est absente, l'éditeur continue de proposer la génération texte NoTrack avec la description manuelle. C'est une **dégradation normale**, pas une analyse des images.
- Aucun cron, aucune programmation Meta, aucun envoi Buffer et aucune publication Instagram n'est déclenché par cette fonction.
