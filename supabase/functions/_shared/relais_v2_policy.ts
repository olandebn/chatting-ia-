// Relais IA V2 — fonctions métier pures, testables sans Telegram/Supabase.
export type ReplySettings = {
 reply_length?: 'short'|'medium'|'long';
 emoji_level?: 'none'|'rare'|'frequent';
 reply_tone?: 'warm'|'neutral'|'professional';
 pronouns?: 'tu'|'vous';
};
export function styleGuide(s: ReplySettings = {}): string {
 const length = ({ short:'10 à 20', medium:'20 à 35', long:'35 à 60' } as const)[s.reply_length ?? 'medium'] ?? '20 à 35';
 const emoji = ({none:'aucun emoji', rare:'0 ou 1 emoji', frequent:'0 à 2 emojis, sans automatisme'} as const)[s.emoji_level ?? 'rare'] ?? '0 ou 1 emoji';
 const tone = ({warm:'chaleureux, naturel et attentionné',neutral:'naturel et neutre',professional:'professionnel et cordial'} as const)[s.reply_tone ?? 'warm'] ?? 'chaleureux';
 return `STYLE PRIORITAIRE : ${length} mots en moyenne ; ${emoji} ; ton ${tone} ; ${(s.pronouns??'tu')==='vous'?'vouvoiement':'tutoiement'}. Varie les ouvertures ; pas de question systématique. Réponds aux messages récents du contact en UN message cohérent. Pas de contenu sexuel ni de fausses promesses. Si on te demande si une IA t’aide à répondre, sois transparent.`;
}
export function explicitOfferInterest(t: string): boolean {
 return /\b(quel(?:s|les)?\s+(?:(?:sont|est)\s+(?:tes|vos|les)\s+)?(?:prix|tarifs?|offres?)|combien\s+(?:ça|cela|c['’]est|coûte)|comment\s+(?:acheter|payer|s['’]abonner)|je\s+(?:veux|voudrais|souhaite)\s+(?:acheter|payer|m['’]abonner)|envoie[- ]moi\s+(?:le\s+)?lien|tu\s+proposes\s+quoi)\b/i.test(t);
}
export function explicitRefusal(t: string): boolean {
 return /\b(pas\s+interess[ée]|pas\s+intéress[ée]|non\s+merci|ne\s+me\s+propose\s+plus|stop\s+(?:les\s+)?offres|arrête\s+de\s+vendre)\b/i.test(t);
}
const TOPICS: [string, RegExp][] = [
 ['cinéma',/\b(cinéma|films?|séries?)\b/i], ['musique',/\b(musique|concerts?|rap)\b/i],
 ['sport',/\b(sport|foot(?:ball)?|basket|musculation|fitness)\b/i],
 ['jeux vidéo',/\b(jeux? vidéo|gaming|valorant|minecraft)\b/i],
 ['voyages',/\b(voyage|voyager|vacances|tourisme)\b/i],
 ['lecture',/\b(lire|livres?|romans?)\b/i],
 ['cuisine',/\b(cuisiner|cuisine|recettes?)\b/i],
];
export function extractSafeMemory(contactMessages: string[], old?: {facts?:Record<string,unknown>;topics?:string[]}): {summary:string;facts:Record<string,unknown>;topics:string[]} {
 const facts: Record<string,unknown> = {};
 const topics = new Set((old?.topics ?? []).filter(x=>TOPICS.some(([key])=>key===x)));
 if (typeof old?.facts?.first_name === 'string' && /^[A-Za-zÀ-ÿ-]{2,28}$/.test(old.facts.first_name)) facts.first_name=old.facts.first_name;
 for (const message of contactMessages) {
  // Ne jamais enregistrer une phrase libre, une adresse, une donnée intime ou médicale.
  const text=String(message).slice(0,1200);
  const name = text.match(/\b(?:je\s+m['’]appelle|mon\s+prénom\s+est)\s+([A-Za-zÀ-ÿ-]{2,28})\b/i);
  if (name) facts.first_name=name[1];
  if (/\b(j['’]aime|j['’]adore|je\s+suis\s+fan|je\s+pratique)\b/i.test(text)) {
    for (const [topic,pattern] of TOPICS) if (pattern.test(text)) topics.add(topic);
  }
  if (explicitRefusal(text)) facts.no_offers = true;
 }
 if (old?.facts?.no_offers === true) facts.no_offers = true;
 const labels: string[]=[];
 if (facts.first_name) labels.push(`Prénom donné : ${facts.first_name}`);
 if (topics.size) labels.push(`Centres d'intérêt déclarés : ${[...topics].join(', ')}`);
 if (facts.no_offers) labels.push('A refusé les offres commerciales');
 return {summary:labels.join(' ; ').slice(0,300),facts,topics:[...topics].slice(0,10)};
}
export function shouldAllowOffer(input:{lastContactMessage:string;noOffers:boolean;lastOfferAt?:string|null;lastContactAt?:string|null}):boolean {
 if (input.noOffers || !explicitOfferInterest(input.lastContactMessage)) return false;
 return !input.lastOfferAt || (!!input.lastContactAt && new Date(input.lastContactAt)>new Date(input.lastOfferAt));
}
export function isPermanentApiError(message:string):boolean {return /NoTrack\s+(401|402|403)\b|(?:OpenAI|Claude)\s+(401|402|403)\b|credits?\s+(remaining|insufficient)|crédit\s+insuffisant|invalid.api.key/i.test(message)}
export function mayRetryStatus(status:number):boolean {return status===408||status===429||status>=500}
