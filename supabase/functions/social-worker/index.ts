// Relais IA Social Worker V1. Deployment alone is inert: no cron job is created by this package.
// Schedule it only after Meta permissions and a test publication are validated.
import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
const URL=Deno.env.get('SUPABASE_URL')||'';
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const BUCKET='relais-social-private';
const GRAPH='https://graph.instagram.com/v26.0';
const db=createClient(URL,SERVICE,{auth:{autoRefreshToken:false,persistSession:false}});
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function secretKey(){const b64=Deno.env.get('SOCIAL_TOKEN_KEY');if(!b64)throw Error('SOCIAL_TOKEN_KEY manquant');const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));if(bytes.length!==32)throw Error('clé invalide');return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt'])}
async function decrypt(value:string){const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));const key=await secretKey();const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12));return new TextDecoder().decode(plain)}
async function note(post:any,event:string,detail?:string){await db.from('social_job_events').insert({user_id:post.user_id,post_id:post.id,event,detail:detail?.slice(0,250)||null});}
async function setState(post:any,state:string,patch:Record<string,unknown>={}){await db.from('social_posts').update({state,updated_at:new Date().toISOString(),...patch}).eq('id',post.id).eq('state','processing');}
async function apiPost(path:string,token:string,params:Record<string,string>){
 const body=new URLSearchParams({...params,access_token:token});
 const response=await fetch(GRAPH+'/'+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(22000)});
 const raw=await response.json().catch(()=>({}));if(!response.ok||!raw.id)throw Error('Meta HTTP '+response.status+' : '+String(raw.error?.message||'response invalid').slice(0,110));return String(raw.id);
}
Deno.serve(async req=>{
 const configured=Deno.env.get('SOCIAL_WORKER_SECRET');
 if(!configured||req.method!=='POST'||req.headers.get('x-social-worker-secret')!==configured)return respond({error:'forbidden'},403);
 if(!Deno.env.get('SOCIAL_TOKEN_KEY')||!Deno.env.get('INSTAGRAM_APP_SECRET'))return respond({error:'Meta non configuré',claimed:0},503);
 const {data:claimed,error:claimErr}=await db.rpc('social_claim_due_post');
 if(claimErr)return respond({error:'claim failed'},500);
 if(!claimed?.length)return respond({claimed:0});
 const post=claimed[0];
 const {data:account}=await db.from('social_accounts').select('*').eq('id',post.account_id).eq('user_id',post.user_id).maybeSingle();
 const {data:media}=await db.from('social_media').select('storage_path,mime_type,state').eq('id',post.media_id).eq('user_id',post.user_id).maybeSingle();
 if(!account||account.state!=='connected'||!account.encrypted_token||!account.platform_user_id||!media||media.state!=='ready'||media.mime_type!=='image/jpeg'){
   await setState(post,'failed',{last_error:'Compte ou JPG indisponible'});await note(post,'failed','Compte ou JPG indisponible');return respond({claimed:1,result:'failed'});
 }
 if(!account.token_expires_at||Date.parse(account.token_expires_at)<Date.now()+3600000){
   await setState(post,'failed',{last_error:'Token Instagram expiré / reconnexion requise'});await db.from('social_accounts').update({state:'expired'}).eq('id',account.id);await note(post,'expired');return respond({claimed:1,result:'expired'});
 }
 // Never retry automatically once a Meta request might have created a post.
 try{
  const {data:signed,error:signedErr}=await db.storage.from(BUCKET).createSignedUrl(media.storage_path,3600);
  if(signedErr||!signed?.signedUrl)throw Error('Image inaccessible');
  const token=await decrypt(account.encrypted_token);
  const container=await apiPost(encodeURIComponent(account.platform_user_id)+'/media',token,{image_url:signed.signedUrl,caption:post.caption||''});
  await db.from('social_posts').update({external_container_id:container}).eq('id',post.id).eq('state','processing');
  // Check whether Meta is ready; ambiguous status -> unknown (never blind retry).
  let finished=false;
  for(let i=0;i<5;i++){
    const u=new URL(GRAPH+'/'+encodeURIComponent(container));u.search=new URLSearchParams({fields:'status_code',access_token:token}).toString();
    const r=await fetch(u,{signal:AbortSignal.timeout(12000)});const j=await r.json().catch(()=>({}));
    if(r.ok&&j.status_code==='FINISHED'){finished=true;break}
    if(j.status_code==='ERROR'||j.status_code==='EXPIRED')throw Error('Conteneur Meta rejeté');
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  if(!finished){await setState(post,'unknown',{last_error:'Statut de conteneur inconnu : vérification manuelle requise'});await note(post,'unknown','Conteneur créé mais non publié, vérifier Meta');return respond({claimed:1,result:'unknown'});}
  const mediaId=await apiPost(encodeURIComponent(account.platform_user_id)+'/media_publish',token,{creation_id:container});
  const {data:updated,error:updateErr}=await db.from('social_posts').update({state:'published',external_post_id:mediaId,published_at:new Date().toISOString(),updated_at:new Date().toISOString(),last_error:null}).eq('id',post.id).eq('state','processing').select('id').maybeSingle();
  if(updateErr||!updated)throw Error('Publication Meta probablement effectuée mais statut local inconnu');
  await note(post,'published',mediaId);
  return respond({claimed:1,result:'published'});
 }catch(e){const detail=e instanceof Error?e.message:String(e);await setState(post,'unknown',{last_error:'État incertain : ne pas relancer sans vérification sur Instagram'});await note(post,'unknown',detail);return respond({claimed:1,result:'unknown'});}
});
