// Relais IA — galerie photos privée, isolée du bot Telegram et de NoTrack.
// Nécessite le JWT d'un compte Supabase et un PIN 4 chiffres à chaque action protégée.
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const PEPPER = Deno.env.get('PHOTO_VAULT_PEPPER') ?? '';
const ORIGIN = 'https://olandebn.github.io';
const BUCKET = 'relais-private-photos';
const LIMIT = 5 * 1024 * 1024;
const CORS = {
 'Access-Control-Allow-Origin': ORIGIN,
 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
 'Access-Control-Allow-Methods': 'POST, OPTIONS',
 'Vary': 'Origin',
 'Cache-Control': 'no-store',
};
const reply = (payload: Record<string,unknown>, status=200) =>
 new Response(JSON.stringify(payload), {status,headers:{...CORS,'Content-Type':'application/json'}});
const admin = (URL&&SERVICE_KEY) ? createClient(URL, SERVICE_KEY, {
 auth: { persistSession:false, autoRefreshToken:false },
}) : null;
const verifier = (URL&&ANON_KEY) ? createClient(URL, ANON_KEY, {
 auth: { persistSession:false, autoRefreshToken:false },
}) : null;
async function pinDigest(userId:string,pin:string):Promise<string> {
 const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(PEPPER),
  {name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${userId}:${pin}`));
 return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function mimeByMagic(bytes: Uint8Array):string|null {
 if(bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return 'image/jpeg';
 if(bytes.length>=8 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)) return 'image/png';
 if(bytes.length>=12 && String.fromCharCode(...bytes.slice(0,4))==='RIFF' &&
    String.fromCharCode(...bytes.slice(8,12))==='WEBP') return 'image/webp';
 return null;
}
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS') return new Response('ok',{headers:CORS});
 if(req.headers.get('origin')!==ORIGIN) return reply({error:'Origine non autorisée'},403);
 if(req.method!=='POST') return reply({error:'Méthode interdite'},405);
 if(!admin||!verifier||PEPPER.length<32) return reply({error:'Galerie non configurée côté serveur'},503);
 const auth=req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
 if(!auth) return reply({error:'Connexion requise'},401);
 const {data:identity,error:authError}=await verifier.auth.getUser(auth);
 if(authError||!identity?.user) return reply({error:'Session invalide'},401);
 const uid=identity.user.id;
 try {
  const isUpload=(req.headers.get('content-type')??'').toLowerCase().includes('multipart/form-data');
  let data:Record<string,unknown>;
  let file:File|null=null;
  if(isUpload){
   const form=await req.formData();
   data={action:form.get('action'),pin:form.get('pin')};
   file=form.get('file') instanceof File ? form.get('file') as File : null;
  } else data=await req.json();
  const action=String(data?.action??'');
  if(action==='status') {
   const {data:security,error}=await admin.from('photo_vault_security').select('user_id').eq('user_id',uid).maybeSingle();
   if(error) return reply({error:'Configuration de la galerie indisponible'},503);
   return reply({configured:!!security});
  }
  const pin=String(data?.pin??'');
  if(!/^\d{4}$/.test(pin)) return reply({error:'Code à 4 chiffres requis'},400);
  if(action==='setup' && (/^(\d)\1{3}$/.test(pin) || ['1234','4321','0123','9876','1212'].includes(pin)))
   return reply({error:'Choisis un code moins facile à deviner'},400);
  const digest=await pinDigest(uid,pin);
  const {data:check,error:pinError}=await admin.rpc('photo_vault_check',{
   p_user:uid,p_digest:digest,p_action:action==='setup'?'setup':'unlock',
  });
  if(pinError) return reply({error:'Vérification de sécurité indisponible'},503);
  if(!check?.ok){
   const messages:Record<string,string>={
    locked:'Trop de tentatives. Réessaie dans 15 minutes.',
    wrong_pin:'Code incorrect',not_configured:'Crée ton code d’accès',
    already_setup:'Un code a déjà été créé',
   };
   return reply({error:messages[check?.error]??'Accès refusé',code:check?.error},
     check?.error==='locked'?429:403);
  }
  if(action==='setup'||action==='unlock') return reply({ok:true});
  if(action==='list') {
   const {data:rows,error}=await admin.from('photo_vault_items').select('id,storage_path,display_name,mime_type,bytes,created_at')
    .eq('user_id',uid).order('created_at',{ascending:false}).limit(100);
   if(error) return reply({error:'Impossible de charger les photos'},503);
   const items=[];
   for(const row of rows??[]){
    const {data:signed}=await admin.storage.from(BUCKET).createSignedUrl(row.storage_path,300);
    items.push({id:row.id,name:row.display_name,bytes:row.bytes,created_at:row.created_at,
      signed_url:signed?.signedUrl??null});
   }
   return reply({items});
  }
  if(action==='upload') {
   if(!file||file.size===0||file.size>LIMIT) return reply({error:'Photo invalide ou supérieure à 5 Mo'},400);
   if(!['image/jpeg','image/png','image/webp'].includes(file.type))
    return reply({error:'Formats acceptés : JPG, PNG et WebP'},400);
   const bytes=new Uint8Array(await file.arrayBuffer());
   const mime=mimeByMagic(bytes);
   if(!mime||mime!==file.type) return reply({error:'Le contenu ne correspond pas au format annoncé'},400);
   const extension:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
   const path=`${uid}/${crypto.randomUUID()}.${extension[mime]}`;
   const {error:uploadError}=await admin.storage.from(BUCKET)
    .upload(path,bytes,{contentType:mime,cacheControl:'60',upsert:false});
   if(uploadError) return reply({error:'Enregistrement de la photo impossible'},503);
   const name=String(file.name||'Photo').slice(0,120).replace(/[\u0000-\u001F]/g,'').trim()||'Photo';
   const {error:dbError}=await admin.from('photo_vault_items').insert({
     user_id:uid,storage_path:path,display_name:name,mime_type:mime,bytes:file.size,
   });
   if(dbError){await admin.storage.from(BUCKET).remove([path]);return reply({error:'Métadonnées non enregistrées'},503)}
   return reply({ok:true});
  }
  if(action==='delete') {
   const id=String(data?.id??'');
   if(!/^[a-f0-9-]{36}$/i.test(id)) return reply({error:'Photo invalide'},400);
   const {data:row}=await admin.from('photo_vault_items').select('storage_path')
    .eq('user_id',uid).eq('id',id).maybeSingle();
   if(!row) return reply({error:'Photo introuvable'},404);
   const {error:removeError}=await admin.storage.from(BUCKET).remove([row.storage_path]);
   if(removeError) return reply({error:'Impossible de supprimer le fichier'},503);
   const {error:dbError}=await admin.from('photo_vault_items').delete().eq('id',id).eq('user_id',uid);
   if(dbError) return reply({error:'Fichier supprimé, actualise la liste'},503);
   return reply({ok:true});
  }
  return reply({error:'Action inconnue'},400);
 }catch(e){console.error('Photo vault request failed',e instanceof Error?e.name:'unknown');return reply({error:'Erreur de la galerie'},500)}
});
