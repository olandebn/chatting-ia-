// Relais IA Social Automation: isolated API. Does not modify the Telegram worker.
import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
const URL=Deno.env.get('SUPABASE_URL')||'';
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const PUB=Deno.env.get('SUPABASE_ANON_KEY')||'';
const ORIGIN='https://olandebn.github.io';
const BUCKET='relais-social-private';
const VERSION='v26.0';
const REDIRECT=URL+'/functions/v1/social-api';
const admin=createClient(URL,SERVICE,{auth:{autoRefreshToken:false,persistSession:false}});
const auth=createClient(URL,PUB,{auth:{autoRefreshToken:false,persistSession:false}});
const cors={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'OPTIONS,POST','Cache-Control':'no-store','Vary':'Origin'};
const result=(object:unknown,status=200)=>new Response(JSON.stringify(object),{status,headers:{...cors,'Content-Type':'application/json'}});
const bad=(s:string,code=400)=>result({error:s},code);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isId=(x:unknown):x is string=>typeof x==='string'&&uuid.test(x);
const safeText=(s:unknown,max:number)=>typeof s==='string'?s.trim().slice(0,max):'';
const accepted=new Set(['image/jpeg','image/png','image/webp']);
const contentMagic=(v:Uint8Array)=>v[0]===255&&v[1]===216&&v[2]===255?'image/jpeg':v.length>8&&[137,80,78,71,13,10,26,10].every((b,i)=>v[i]===b)?'image/png':v.length>12&&String.fromCharCode(...v.slice(0,4))==='RIFF'&&String.fromCharCode(...v.slice(8,12))==='WEBP'?'image/webp':null;
function errMessage(e:unknown){return e instanceof Error?e.message:String(e)}
async function encryptionKey(){
 const b64=Deno.env.get('SOCIAL_TOKEN_KEY');if(!b64)throw Error('SOCIAL_TOKEN_KEY non configuré');
 const binary=atob(b64),raw=Uint8Array.from(binary,c=>c.charCodeAt(0));
 if(raw.length!==32)throw Error('SOCIAL_TOKEN_KEY doit contenir 32 octets en base64');
 return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
async function encrypt(value:string){const nonce=crypto.getRandomValues(new Uint8Array(12));const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},await encryptionKey(),new TextEncoder().encode(value));return btoa(String.fromCharCode(...nonce,...new Uint8Array(bytes)))}
async function accountFor(uid:string,creator:string,accountId:string){const {data,error}=await admin.from('social_accounts').select('*').eq('user_id',uid).eq('creator_id',creator).eq('id',accountId).maybeSingle();if(error)throw error;return data}
async function creatorFor(uid:string,id:string){const {data,error}=await admin.from('social_creators').select('*').eq('user_id',uid).eq('id',id).maybeSingle();if(error)throw error;return data}
function redirectStatus(code:string){const u=new URL(ORIGIN+'/chatting-ia-/');u.hash='#/app/social';u.searchParams.set('social_oauth',code);return Response.redirect(u.toString(),302)}
async function oauthCallback(input:URL){
 const state=input.searchParams.get('state')||'';
 if(!isId(state))return redirectStatus('invalid_state');
 const {data:s}=await admin.from('social_oauth_states').select('*').eq('state',state).maybeSingle();
 if(!s || s.used_at || new Date(s.expires_at).getTime()<Date.now())return redirectStatus('expired_state');
 // Consume before doing any network operation: one-time callback.
 const {data:consumed,error:consumeErr}=await admin.from('social_oauth_states').update({used_at:new Date().toISOString()}).eq('state',state).is('used_at',null).select('state').maybeSingle();
 if(consumeErr||!consumed)return redirectStatus('consumed_state');
 const code=input.searchParams.get('code'); if(!code)return redirectStatus('authorization_denied');
 const clientId=Deno.env.get('INSTAGRAM_APP_ID'),secret=Deno.env.get('INSTAGRAM_APP_SECRET');
 if(!clientId||!secret)return redirectStatus('not_configured');
 try{
   const body=new URLSearchParams({client_id:clientId,client_secret:secret,grant_type:'authorization_code',redirect_uri:REDIRECT,code});
   const shortResponse=await fetch('https://api.instagram.com/oauth/access_token',{method:'POST',body,signal:AbortSignal.timeout(18000)});
   const short=await shortResponse.json();if(!shortResponse.ok||!short.access_token)throw Error('exchange short-lived token failed');
   const exchangeUrl=new URL('https://graph.instagram.com/access_token');
   exchangeUrl.search=new URLSearchParams({grant_type:'ig_exchange_token',client_secret:secret,access_token:short.access_token}).toString();
   const longResponse=await fetch(exchangeUrl,{signal:AbortSignal.timeout(18000)});
   const long=await longResponse.json();if(!longResponse.ok||!long.access_token)throw Error('exchange long-lived token failed');
   const meUrl=new URL('https://graph.instagram.com/me');meUrl.search=new URLSearchParams({fields:'id,username,account_type',access_token:long.access_token}).toString();
   const profileResponse=await fetch(meUrl,{signal:AbortSignal.timeout(18000)});
   const me=await profileResponse.json();if(!profileResponse.ok||!me.id)throw Error('Instagram account profile unavailable');
   const expires=new Date(Date.now()+Math.min(Number(long.expires_in)||5184000,5184000)*1000).toISOString();
   const encrypted=await encrypt(long.access_token);
   const {data:existing}=await admin.from('social_accounts').select('id').eq('user_id',s.user_id).eq('platform','instagram').eq('platform_user_id',String(me.id)).maybeSingle();
   const payload={user_id:s.user_id,creator_id:s.creator_id,platform:'instagram',platform_user_id:String(me.id),username:String(me.username||''),state:'connected',encrypted_token:encrypted,token_expires_at:expires,permissions:['instagram_business_basic','instagram_business_content_publish'],updated_at:new Date().toISOString()};
   const save=existing?await admin.from('social_accounts').update(payload).eq('id',existing.id).eq('user_id',s.user_id):await admin.from('social_accounts').insert(payload);
   if(save.error)throw save.error;
   return redirectStatus('connected');
 }catch(e){console.error('social oauth callback failed',errMessage(e));return redirectStatus('connection_failed')}
}
async function postHandler(req:Request){
 if(req.headers.get('origin')!==ORIGIN)return bad('Origine non autorisée',403);
 const bearer=req.headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
 if(!bearer)return bad('Session requise',401);
 const {data:userInfo,error:userErr}=await auth.auth.getUser(bearer);
 if(userErr||!userInfo.user)return bad('Session invalide',401);
 const uid=userInfo.user.id;
 let b:any;try{b=await req.json()}catch{return bad('JSON invalide')}
 if(!b || typeof b!=='object')return bad('Requête invalide');
 const action=String(b.action||'');
 try{
  if(action==='status'){
    const [creators,accounts]=await Promise.all([admin.from('social_creators').select('id,name,timezone,description').eq('user_id',uid).order('created_at'),admin.from('social_accounts').select('id,creator_id,platform,username,state,permissions,token_expires_at').eq('user_id',uid)]);
    if(creators.error||accounts.error)throw creators.error||accounts.error;
    return result({creators:creators.data,accounts:accounts.data,instagram_configured:!!(Deno.env.get('INSTAGRAM_APP_ID')&&Deno.env.get('INSTAGRAM_APP_SECRET')&&Deno.env.get('SOCIAL_TOKEN_KEY')),publishing_available:false});
  }
  if(action==='create_creator'){
    const name=safeText(b.name,100);if(!name)return bad('Nom du créateur requis');
    const {data,error}=await admin.from('social_creators').insert({user_id:uid,name}).select('id,name,timezone').single();if(error)throw error;return result({creator:data});
  }
  if(!isId(b.creator_id)||!(await creatorFor(uid,b.creator_id)))return bad('Créateur introuvable',404);
  const creator=b.creator_id;
  if(action==='dashboard'){
    const [media,posts]=await Promise.all([admin.from('social_media').select('id,filename,mime_type,bytes,state,caption_notes,is_synthetic,created_at').eq('user_id',uid).eq('creator_id',creator).neq('state','archived').order('created_at',{ascending:false}).limit(200),admin.from('social_posts').select('id,media_id,account_id,caption,state,scheduled_at,created_at,external_permalink,last_error').eq('user_id',uid).eq('creator_id',creator).order('created_at',{ascending:false}).limit(200)]);
    if(media.error||posts.error)throw media.error||posts.error;return result({media:media.data,posts:posts.data});
  }
  if(action==='start_upload'){
    const mime=String(b.mime_type||'');const bytes=Number(b.bytes||0);
    const filename=safeText(b.filename,160).replace(/[\u0000-\u001F]/g,'');
    const sha256=String(b.sha256||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(sha256))return bad('Empreinte SHA-256 requise');
    const {data:duplicate}=await admin.from('social_media').select('id').eq('user_id',uid).eq('creator_id',creator).eq('sha256',sha256).in('state',['ready','uploading']).limit(1).maybeSingle();
    if(duplicate)return bad('Cette image a déjà été importée');
    if(!filename||!accepted.has(mime)||!Number.isSafeInteger(bytes)||bytes<1||bytes>15*1024*1024)return bad('Image JPG, PNG ou WebP requise (15 Mo max)');
    const id=crypto.randomUUID();const ext=mime==='image/jpeg'?'jpg':mime==='image/png'?'png':'webp';const path=`${uid}/${creator}/${id}.${ext}`;
    const {data:signed,error:signErr}=await admin.storage.from(BUCKET).createSignedUploadUrl(path);
    if(signErr||!signed)throw signErr||Error('Impossible de préparer le transfert');
    const {error}=await admin.from('social_media').insert({id,user_id:uid,creator_id:creator,filename,storage_path:path,mime_type:mime,bytes,sha256,state:'uploading',is_synthetic:!!b.is_synthetic});
    if(error)throw error;return result({media_id:id,path,token:signed.token});
  }
  if(action==='finish_upload'){
    if(!isId(b.media_id))return bad('Média invalide');
    const {data:m}=await admin.from('social_media').select('*').eq('id',b.media_id).eq('user_id',uid).eq('creator_id',creator).maybeSingle();
    if(!m)return bad('Média introuvable',404);
    if(m.state==='ready')return result({ok:true});
    const {data:blob,error:downloadErr}=await admin.storage.from(BUCKET).download(m.storage_path);
    if(downloadErr||!blob)return bad('Transfert incomplet, réessaie');
    const contentBytes=new Uint8Array(await blob.arrayBuffer());
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',contentBytes)).reduce((a,b)=>a+b.toString(16).padStart(2,'0'),'');
    if(blob.size!==Number(m.bytes)||digest!==m.sha256||contentMagic(contentBytes.slice(0,16))!==m.mime_type){
      await admin.storage.from(BUCKET).remove([m.storage_path]);
      await admin.from('social_media').delete().eq('id',m.id).eq('user_id',uid);
      return bad('Fichier incorrect ou corrompu');
    }
    const {error}=await admin.from('social_media').update({state:'ready'}).eq('id',m.id).eq('user_id',uid);if(error)throw error;return result({ok:true});
  }
  if(action==='media_preview'){
    if(!isId(b.media_id))return bad('Média invalide');
    const {data:m}=await admin.from('social_media').select('storage_path').eq('user_id',uid).eq('creator_id',creator).eq('id',b.media_id).eq('state','ready').maybeSingle();
    if(!m)return bad('Média introuvable',404);
    const {data:s,error}=await admin.storage.from(BUCKET).createSignedUrl(m.storage_path,300);if(error)throw error;return result({url:s.signedUrl});
  }
  if(action==='archive_media'){
    if(!isId(b.media_id))return bad('Média invalide');
    const {data:inUse}=await admin.from('social_posts').select('id').eq('user_id',uid).eq('creator_id',creator).eq('media_id',b.media_id).in('state',['scheduled','processing']).limit(1);
    if(inUse?.length)return bad('Média utilisé par une publication planifiée');
    const {error}=await admin.from('social_media').update({state:'archived'}).eq('user_id',uid).eq('creator_id',creator).eq('id',b.media_id);if(error)throw error;return result({ok:true});
  }
  if(action==='create_post'){
    if(!isId(b.media_id))return bad('Média invalide');
    const caption=safeText(b.caption,2200);
    const {data:m}=await admin.from('social_media').select('id,is_synthetic').eq('user_id',uid).eq('creator_id',creator).eq('id',b.media_id).eq('state','ready').maybeSingle();if(!m)return bad('Média non disponible');
    const finalCaption=m.is_synthetic&&!/(cr[eé]atrice virtuelle|g[eé]n[eé]r[eé]e? par ia|#cr[eé]atricevirtuelle)/i.test(caption)?(caption.slice(0,2165)+'\n\n#CréatriceVirtuelle'):caption;
    const {data, error}=await admin.from('social_posts').insert({user_id:uid,creator_id:creator,media_id:m.id,caption:finalCaption,state:'draft'}).select('id,state').single();if(error)throw error;return result({post:data});
  }
  if(action==='update_post'){
    if(!isId(b.post_id))return bad('Brouillon invalide');
    const {data:original}=await admin.from('social_posts').select('media_id').eq('id',b.post_id).eq('user_id',uid).eq('creator_id',creator).eq('state','draft').maybeSingle();
    if(!original)return bad('Brouillon introuvable');
    const {data:mediaItem}=await admin.from('social_media').select('is_synthetic').eq('id',original.media_id).eq('user_id',uid).maybeSingle();
    const draftCaption=safeText(b.caption,2200);
    const finalCaption=mediaItem?.is_synthetic&&!/(cr[eé]atrice virtuelle|g[eé]n[eé]r[eé]e? par ia|#cr[eé]atricevirtuelle)/i.test(draftCaption)?(draftCaption.slice(0,2165)+'\n\n#CréatriceVirtuelle'):draftCaption;
    const {data:m,error}=await admin.from('social_posts').update({caption:finalCaption,updated_at:new Date().toISOString()}).eq('id',b.post_id).eq('user_id',uid).eq('creator_id',creator).eq('state','draft').select('id,caption').maybeSingle();if(error)throw error;if(!m)return bad('Seuls les brouillons peuvent être modifiés');return result({post:m});
  }
  if(action==='schedule_post'){
    if(!isId(b.post_id)||!isId(b.account_id))return bad('Identifiants invalides');
    if(b.approved_non_explicit!==true)return bad('Confirmation du contenu non explicite et conforme à Instagram requise');
    const at=new Date(String(b.scheduled_at||''));if(!Number.isFinite(at.getTime())||at.getTime()<Date.now()+60_000||at.getTime()>Date.now()+365*864e5)return bad('Date de programmation invalide');
    const account=await accountFor(uid,creator,b.account_id);if(!account||account.state!=='connected'||!account.encrypted_token)return bad('Connecte un compte Instagram professionnel avant de programmer');
    if(account.platform!=='instagram'||!account.permissions?.includes('instagram_business_content_publish'))return bad('Publication Instagram non autorisée');
    if(!Deno.env.get('INSTAGRAM_APP_ID')||!Deno.env.get('INSTAGRAM_APP_SECRET')||!Deno.env.get('SOCIAL_TOKEN_KEY')||!Deno.env.get('SOCIAL_WORKER_SECRET'))return bad('Intégration Meta ou planificateur non configuré');
    const {data:post}=await admin.from('social_posts').select('media_id,caption').eq('user_id',uid).eq('creator_id',creator).eq('id',b.post_id).eq('state','draft').maybeSingle();if(!post)return bad('Brouillon introuvable');
    const {data:m}=await admin.from('social_media').select('mime_type,state').eq('user_id',uid).eq('creator_id',creator).eq('id',post.media_id).maybeSingle();
    if(m?.state!=='ready'||m.mime_type!=='image/jpeg')return bad('Instagram requiert ici une image JPG prête à publier');
    const {error}=await admin.from('social_posts').update({state:'scheduled',account_id:account.id,scheduled_at:at.toISOString(),approved_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',b.post_id).eq('user_id',uid).eq('creator_id',creator).eq('state','draft');if(error)throw error;
    return result({ok:true,warning:'La tâche sera exécutée seulement après activation du planificateur Instagram'});
  }
  if(action==='cancel_post'){
    if(!isId(b.post_id))return bad('ID invalide');
    const {data:post,error}=await admin.from('social_posts').update({state:'cancelled',updated_at:new Date().toISOString()}).eq('id',b.post_id).eq('user_id',uid).eq('creator_id',creator).in('state',['draft','scheduled']).select('id').maybeSingle();if(error)throw error;if(!post)return bad('Publication déjà en cours ou introuvable');return result({ok:true});
  }
  if(action==='oauth_start'){
    if(!Deno.env.get('INSTAGRAM_APP_ID')||!Deno.env.get('INSTAGRAM_APP_SECRET')||!Deno.env.get('SOCIAL_TOKEN_KEY'))return bad('Configure INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET et SOCIAL_TOKEN_KEY dans les secrets Supabase.');
    const {data:record,error}=await admin.from('social_oauth_states').insert({user_id:uid,creator_id:creator}).select('state').single();if(error)throw error;
    const u=new URL('https://www.instagram.com/oauth/authorize');u.search=new URLSearchParams({client_id:Deno.env.get('INSTAGRAM_APP_ID')!,redirect_uri:REDIRECT,response_type:'code',scope:'instagram_business_basic,instagram_business_content_publish',state:record.state}).toString();
    return result({url:u.toString(),redirect_uri:REDIRECT});
  }
  if(action==='disconnect'){
    if(!isId(b.account_id))return bad('Compte invalide');
    const {data:row}=await admin.from('social_accounts').select('id').eq('id',b.account_id).eq('user_id',uid).eq('creator_id',creator).maybeSingle();if(!row)return bad('Compte introuvable',404);
    const {error}=await admin.from('social_accounts').update({state:'disconnected',encrypted_token:null,token_expires_at:null,permissions:[]}).eq('id',row.id).eq('user_id',uid);if(error)throw error;return result({ok:true,reminder:'Révoque aussi les permissions de l’application dans Instagram si nécessaire.'});
  }
  if(action==='generate_captions'){
    const description=safeText(b.description,400),style=safeText(b.style,40);
    if(!description||!['naturel','élégant','lifestyle','glamour','humoristique','mystérieux','séduisant'].includes(style))return bad('Décris la photo et choisis un style');
    const apiKey=Deno.env.get('NOTRACK_API_KEY');if(!apiKey)return bad('Génération IA non configurée',503);
    const system='Tu écris trois légendes Instagram francophones DISTINCTES pour une créatrice de contenu virtuelle adulte. Style: '+style+'. Le contenu est mode, lifestyle ou portrait, jamais sexuel. Chaque légende fait moins de 250 caractères, sans informations inventées et sans promesse trompeuse. Mentionne clairement #CréatriceVirtuelle dans au moins une variante. Réponds UNIQUEMENT avec un objet JSON {"variants":["...","...","..."]}.';
    const response=await fetch('https://api.notrack.ai/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:'notrack-uncensored',stream:false,max_tokens:360,temperature:0.6,messages:[{role:'system',content:system},{role:'user',content:'Description de la photo : '+description}]}),signal:AbortSignal.timeout(22000)});
    if(!response.ok)return bad(response.status===429?'NoTrack occupé, réessaie plus tard':'NoTrack indisponible',503);
    const responseData=await response.json();const raw=String(responseData?.choices?.[0]?.message?.content||'');let parsed:any;
    try{parsed=JSON.parse(raw.replace(/^```json\s*/,'').replace(/```$/,'').trim())}catch{return bad('Réponse IA inexploitable, réessaie',502)}
    if(!Array.isArray(parsed.variants))return bad('Réponse IA invalide',502);
    return result({variants:parsed.variants.filter((x:unknown)=>typeof x==='string').slice(0,3).map((x:string)=>x.slice(0,300))});
  }
  return bad('Action inconnue',404);
 }catch(e){console.error('social api',action,errMessage(e));return bad('Erreur du module social. Consulte les journaux.',500)}
}
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 const input=new URL(req.url);
 if(req.method==='GET')return oauthCallback(input);
 if(req.method==='POST')return postHandler(req);
 return bad('Méthode non autorisée',405);
});
