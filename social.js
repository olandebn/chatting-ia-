// Social Automation V1 — isolated view; does not touch Telegram services.
export async function viewSocialAutomation(main,{sb,esc,toast,fail,fmtDate}){
  const call=async(action,body={})=>{
    const {data,error}=await sb.functions.invoke('social-api',{body:{action,...body}});
    if(error){let message=error.message;try{const parsed=await error.context.json();message=parsed.error||message}catch{}throw Error(message)}
    if(data?.error)throw Error(data.error);
    return data;
  };
  let creators=[],accounts=[],media=[],posts=[],creatorId='',tab='overview',loading=false;
  let configured=false;
  const btnBusy=(button,b)=>{button.disabled=b;button.setAttribute('aria-busy',String(b))};
  const notify=e=>fail(e);
  const $$=(selector)=>[...main.querySelectorAll(selector)];
  const $=(selector)=>main.querySelector(selector);
  const timeText=t=>t?fmtDate(t):'—';
  const protect=s=>esc(s??'');
  const pill=s=>`<span class="social-pill">${protect(s)}</span>`;
  const tabs=[['overview','Vue d’ensemble'],['accounts','Comptes'],['media','Médias'],['posts','Publications'],['calendar','Calendrier']];
  const statusText={'draft':'Brouillon','scheduled':'Planifié','processing':'En cours','published':'Publié','failed':'Échec','unknown':'À vérifier','cancelled':'Annulé'};
  async function initialize(){
    try{
      const result=await call('status');creators=result.creators||[];accounts=result.accounts||[];configured=!!result.instagram_configured;
      if(creators.length)creatorId=creators[0].id;
      await loadData();draw();
    }catch(e){main.innerHTML='<section class="panel"><h2>Social Automation</h2><p>Le service Social Automation est inaccessible. Vérifie le déploiement de la fonction Supabase <code>social-api</code>.</p></section>';notify(e)}
  }
  async function loadData(){if(!creatorId){media=[];posts=[];return}const result=await call('dashboard',{creator_id:creatorId});media=result.media||[];posts=result.posts||[]}
  function layout(content){
    main.innerHTML=`<div class="social-page">
      <div class="main-head"><div><h1>Social Automation</h1><p>Prépare tes médias, rédige les légendes et organise tes publications depuis Relais IA.</p></div></div>
      <section class="panel social-toolbar"><label for="social-creator">Créateur</label>
      <select id="social-creator"><option value="">Choisir...</option>${creators.map(c=>`<option value="${protect(c.id)}" ${c.id===creatorId?'selected':''}>${protect(c.name)}</option>`).join('')}</select>
      <button type="button" id="social-new-creator" class="btn-sm">+ Nouveau créateur</button></section>
      <nav class="social-tabs" aria-label="Modules Social Automation">${tabs.map(([id,label])=>`<button class="btn-sm ${tab===id?'social-selected':''}" data-social-tab="${id}" aria-current="${tab===id?'page':'false'}">${label}</button>`).join('')}</nav>
      ${content}</div>`;
    $('#social-creator').onchange=async e=>{creatorId=e.target.value;try{await loadData();draw()}catch(err){notify(err)}};
    $('#social-new-creator').onclick=async()=>{const name=prompt('Nom du créateur à ajouter (ex : Elyna Moreau)');if(!name?.trim())return;try{const r=await call('create_creator',{name:name.trim()});creators.push(r.creator);creatorId=r.creator.id;await loadData();draw();toast('Créateur créé')}catch(e){notify(e)}};
    $$('[data-social-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.socialTab;draw()});
  }
  function overview(){
    const ready=media.filter(m=>m.state==='ready').length;
    const planned=posts.filter(p=>p.state==='scheduled').length;
    const published=posts.filter(p=>p.state==='published').length;
    const connected=accounts.filter(a=>a.creator_id===creatorId&&a.state==='connected').length;
    return `<div class="social-stats">${[['Médias prêts',ready],['Brouillons',posts.filter(p=>p.state==='draft').length],['Planifiés',planned],['Publiés (confirmés)',published]].map(([label,n])=>`<div class="panel social-stat"><small>${label}</small><strong>${n}</strong></div>`).join('')}</div>
      <section class="panel"><h2>Mise en route</h2><p>${creators.length?'Ton espace créateur est disponible.':'Commence par créer ton premier créateur.'}</p>
        <div class="social-checks"><p>① Instagram : ${connected?'Compte connecté':'Connexion requise'}</p><p>② Médias privés : ${ready} prêt(s)</p><p>③ Brouillons : ${posts.filter(p=>p.state==='draft').length}</p><p>④ Publication automatique : ${configured?'Configuration Meta présente, tests et planificateur à vérifier':'Indisponible tant que Meta n’est pas configuré'}</p></div>
        <p class="hint">Aucune publication n'est lancée depuis cette page sans validation. Les clics et ventes ne sont jamais inventés.</p></section>`;
  }
  function accountsView(){const a=accounts.filter(x=>x.creator_id===creatorId);
    return `<section class="panel"><h2>Comptes connectés</h2><p>Seul Instagram Login professionnel est préparé pour la publication. Threads, TikTok et les fonctions de DM Instagram seront intégrés avec leurs permissions officielles.</p>
     ${a.length?a.map(x=>`<div class="social-entry"><div><strong>${protect(x.platform)} · ${protect(x.username||'compte')}</strong><p class="muted">${protect(x.state)} · Token expire : ${timeText(x.token_expires_at)}</p></div><button data-disconnect="${protect(x.id)}" class="btn-sm btn-danger">Déconnecter</button></div>`).join(''):'<p class="muted">Aucun compte connecté.</p>'}
     <div class="row"><button id="social-connect" class="btn-primary" ${!creatorId||!configured?'disabled':''}>Connecter Instagram professionnel</button>${!configured?'<span class="muted small">Non configuré : identifiants Meta manquants côté serveur</span>':''}</div>
     <p class="hint">Permissions nécessaires : instagram_business_basic et instagram_business_content_publish. Ne colle jamais ton mot de passe Instagram ou un token dans le navigateur.</p></section>`;
  }
  function mediaView(){return `<section class="panel"><h2>Bibliothèque de médias</h2><p>Photos privées JPG, PNG ou WebP, 15 Mo maximum par fichier. Pour l'Instagram Autopost V1, seules les images JPG sont publiables.</p>
      <label class="social-upload">Ajouter des images <input id="social-files" type="file" accept="image/jpeg,image/png,image/webp" multiple ${!creatorId?'disabled':''}></label>
      <label class="social-label"><input id="social-synthetic" type="checkbox" checked> Images de créatrice virtuelle / générées par IA</label>
      <p id="social-upload-progress" class="muted small" role="status"></p>
      <div class="social-media-grid">${media.length?media.map(m=>`<article class="social-media-item"><div class="social-image" data-preview="${protect(m.id)}"><span>Voir la photo</span></div><strong title="${protect(m.filename)}">${protect(m.filename)}</strong><p class="small muted">${protect(m.mime_type)} · ${Math.ceil(m.bytes/1024)} Ko ${m.is_synthetic?'· Synthétique':''}</p><button data-archive="${protect(m.id)}" class="btn-sm">Archiver</button></article>`).join(''):'<p class="muted">Aucun média. Ajoute ta première photo.</p>'}</div></section>`}
  function postsView(){return `<section class="panel"><h2>Créer une publication</h2><p>Choisis un JPG, puis prépare une légende. Aucun envoi ne sera effectué avant la programmation et l'autorisation Instagram.</p>
      <div class="social-form"><label>Photo prête <select id="social-draft-media"><option value="">Choisir une image...</option>${media.filter(m=>m.state==='ready'&&m.mime_type==='image/jpeg').map(m=>`<option value="${protect(m.id)}">${protect(m.filename)}</option>`).join('')}</select></label>
      <label>Décris le contenu pour générer des légendes IA <input id="social-description" maxlength="400" placeholder="Ex : selfie mode en robe bordeaux devant un miroir"></label>
      <label>Style <select id="social-style">${['naturel','élégant','lifestyle','glamour','humoristique','mystérieux','séduisant'].map(x=>`<option>${x}</option>`).join('')}</select></label>
      <button type="button" id="social-generate" class="btn-sm">Générer 3 légendes avec NoTrack</button>
      <div id="social-variants"></div><label>Légende validée <textarea id="social-caption" maxlength="2200" rows="5" placeholder="Légende et hashtags..." required></textarea></label>
      <button type="button" id="social-create-post" class="btn-primary" ${!creatorId?'disabled':''}>Enregistrer le brouillon</button></div></section>
      <section class="panel"><h2>Mes publications</h2>${posts.length?posts.map(p=>`<div class="social-entry"><div><strong>${protect(statusText[p.state]||p.state)}</strong><p class="small muted">${protect(p.caption||'(sans légende)')}</p><p class="small muted">${p.scheduled_at?'Prévue : '+timeText(p.scheduled_at):'Créée : '+timeText(p.created_at)}</p>${p.last_error?`<p class="small">${protect(p.last_error)}</p>`:''}</div>
       <div class="social-actions">${p.state==='draft'?`<button data-schedule="${protect(p.id)}" class="btn-sm">Programmer</button>`:''}${['draft','scheduled'].includes(p.state)?`<button data-cancel="${protect(p.id)}" class="btn-sm btn-danger">Annuler</button>`:''}${p.external_permalink?`<a href="${protect(p.external_permalink)}" target="_blank" rel="noopener noreferrer">Voir</a>`:''}</div></div>`).join(''):'<p class="muted">Aucun brouillon pour ce créateur.</p>'}</section>`}
  function calendarView(){const days=posts.filter(p=>p.scheduled_at).sort((a,b)=>String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
    return `<section class="panel"><h2>Calendrier des publications</h2><p>Vue liste — heure locale de ton appareil. Les publications ne seront exécutées que si le planificateur officiel a été activé.</p>
      ${days.length?days.map(p=>`<div class="social-entry"><div><strong>${timeText(p.scheduled_at)}</strong><p>${protect(p.caption||'(sans légende)')}</p></div>${pill(statusText[p.state]||p.state)}</div>`).join(''):'<p class="muted">Aucune publication programmée.</p>'}</section>`}
  function draw(){
    layout(!creators.length?'<section class="panel"><h2>Bienvenue</h2><p>Crée un espace créateur pour commencer.</p></section>':tab==='overview'?overview():tab==='accounts'?accountsView():tab==='media'?mediaView():tab==='posts'?postsView():calendarView());
    if(tab==='accounts'){
      const connect=$('#social-connect');if(connect)connect.onclick=async()=>{try{const r=await call('oauth_start',{creator_id:creatorId});window.location.assign(r.url)}catch(e){notify(e)}};
      $$('[data-disconnect]').forEach(b=>b.onclick=async()=>{if(!confirm('Déconnecter ce compte ? Les publications futures seront bloquées.'))return;try{await call('disconnect',{creator_id:creatorId,account_id:b.dataset.disconnect});const r=await call('status');accounts=r.accounts||[];draw();toast('Compte déconnecté')}catch(e){notify(e)}});
    }
    if(tab==='media'){
      const input=$('#social-files');if(input)input.onchange=async()=>{
        const files=[...input.files].slice(0,100);const progress=$('#social-upload-progress');
        for(let i=0;i<files.length;i++){
          const file=files[i];progress.textContent=`Import : ${i+1}/${files.length} — ${file.name}`;
          try{
            const content=new Uint8Array(await file.arrayBuffer());
            const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',content)),v=>v.toString(16).padStart(2,'0')).join('');
            const upload=await call('start_upload',{creator_id:creatorId,filename:file.name,mime_type:file.type,bytes:file.size,sha256,is_synthetic:$('#social-synthetic').checked});
            const {error}=await sb.storage.from('relais-social-private').uploadToSignedUrl(upload.path,upload.token,file,{contentType:file.type});if(error)throw error;
            await call('finish_upload',{creator_id:creatorId,media_id:upload.media_id});
          }catch(e){notify(e)}
        }
        progress.textContent='Import terminé';await loadData();draw();toast('Import terminé');
      };
      $$('[data-preview]').forEach(b=>b.onclick=async()=>{try{const v=await call('media_preview',{creator_id:creatorId,media_id:b.dataset.preview});const image=new Image();image.src=v.url;image.alt='Aperçu privé';image.style='max-width:min(86vw,750px);max-height:80vh;object-fit:contain';const w=window.open('','_blank');if(!w){toast('Autorise les fenêtres de prévisualisation',true);return}w.document.title='Aperçu privé';w.document.body.style='margin:0;display:grid;place-items:center;background:#161c32;min-height:100vh';w.document.body.append(image)}catch(e){notify(e)}});
      $$('[data-archive]').forEach(b=>b.onclick=async()=>{if(!confirm('Archiver cette image ?'))return;try{await call('archive_media',{creator_id:creatorId,media_id:b.dataset.archive});await loadData();draw();toast('Image archivée')}catch(e){notify(e)}});
    }
    if(tab==='posts'){
      const generate=$('#social-generate');if(generate)generate.onclick=async()=>{btnBusy(generate,true);try{const r=await call('generate_captions',{creator_id:creatorId,description:$('#social-description').value,style:$('#social-style').value});$('#social-variants').innerHTML=r.variants.map((v,i)=>`<div class="social-variant"><p>${protect(v)}</p><button type="button" data-pick="${i}" class="btn-sm">Utiliser</button></div>`).join('');$$('[data-pick]').forEach(b=>b.onclick=()=>{$('#social-caption').value=r.variants[Number(b.dataset.pick)]})}catch(e){notify(e)}finally{btnBusy(generate,false)}};
      const save=$('#social-create-post');if(save)save.onclick=async()=>{btnBusy(save,true);try{await call('create_post',{creator_id:creatorId,media_id:$('#social-draft-media').value,caption:$('#social-caption').value});await loadData();draw();toast('Brouillon enregistré')}catch(e){notify(e)}finally{btnBusy(save,false)}};
      $$('[data-cancel]').forEach(b=>b.onclick=async()=>{if(!confirm('Annuler cette publication ?'))return;try{await call('cancel_post',{creator_id:creatorId,post_id:b.dataset.cancel});await loadData();draw();toast('Publication annulée')}catch(e){notify(e)}});
      $$('[data-schedule]').forEach(b=>b.onclick=async()=>{const account=accounts.find(a=>a.creator_id===creatorId&&a.platform==='instagram'&&a.state==='connected');if(!account){toast('Connecte Instagram avant de programmer',true);return}if(!confirm('Je confirme que cette image est non explicite, adaptée à Instagram et autorisée à être publiée sur le compte connecté.'))return;const value=prompt('Date et heure (format ISO avec fuseau, ex : 2026-12-01T14:00:00+01:00)');if(!value)return;try{await call('schedule_post',{creator_id:creatorId,post_id:b.dataset.schedule,account_id:account.id,scheduled_at:value,approved_non_explicit:true});await loadData();draw();toast('Planification enregistrée')}catch(e){notify(e)}});
    }
  }
  await initialize();
}
