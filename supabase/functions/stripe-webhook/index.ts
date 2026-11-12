// Webhook Stripe optionnel — A NE PAS ACTIVER avant configuration du Checkout serveur.
// Aucun paiement n'est réputé effectué sur simple texte Telegram.
// Référence : https://supabase.com/docs/guides/functions/examples/stripe-webhooks
import Stripe from 'npm:stripe@^22';
import {createClient} from 'npm:@supabase/supabase-js@2';
const secretKey=Deno.env.get('STRIPE_SECRET_KEY');
const signingKey=Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET');
const url=Deno.env.get('SUPABASE_URL');
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const stripe=secretKey?new Stripe(secretKey):null;
const cryptoProvider=Stripe.createSubtleCryptoProvider();
const db=(url&&serviceKey)?createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}}):null;
Deno.serve(async (req)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!stripe||!signingKey||!db)return new Response('Not configured',{status:503});
  const signature=req.headers.get('stripe-signature');
  if(!signature)return new Response('Missing signature',{status:400});
  let event:Stripe.Event;
  try{
    event=await stripe.webhooks.constructEventAsync(await req.text(),signature,signingKey,undefined,cryptoProvider);
  }catch{
    return new Response('Invalid Stripe signature',{status:400});
  }
  if(event.type!=='checkout.session.completed'&&event.type!=='checkout.session.async_payment_succeeded')
    return Response.json({received:true,ignored:true});
  const session=event.data.object as Stripe.Checkout.Session;
  if(session.payment_status!=='paid')return Response.json({received:true,pending:true});
  const meta=session.metadata??{};
  const uid=meta.relais_user_id;
  const chat_id=Number(meta.relais_chat_id);
  const link_id=Number(meta.relais_link_id);
  if(!uid||!Number.isSafeInteger(chat_id)||!Number.isSafeInteger(link_id)||!Number.isInteger(session.amount_total))
    return Response.json({received:true,ignored:'missing verified checkout linkage'});
  if(session.currency!=='eur')return Response.json({received:true,ignored:'non-eur currency'});
  // Ne prendre en compte que les ventes liées à des chats et offres du même compte.
  const [{data:chat},{data:link}]=await Promise.all([
    db.from('chats').select('id').eq('id',chat_id).eq('user_id',uid).maybeSingle(),
    db.from('links').select('id').eq('id',link_id).eq('user_id',uid).maybeSingle(),
  ]);
  if(!chat||!link)return Response.json({received:true,ignored:'account mismatch'});
  const {error}=await db.from('payments').upsert({
    user_id:uid,chat_id,link_id,provider:'stripe',provider_ref:session.id,
    amount:session.amount_total/100,currency:'EUR',status:'confirmed',
    confirmed_at:new Date().toISOString(),
  },{onConflict:'provider,provider_ref'});
  if(error){console.error('Stripe payment persistence failure',error.code);return new Response('Database unavailable',{status:500})}
  return Response.json({received:true,confirmed:true});
});
