'use strict';

const API=location.hostname==='tapsoniamas-preview.onrender.com'?'https://tapsoniamas-api.onrender.com/api':'/api';
const categories=['Άλλα','Φρούτα','Λαχανικά','Κρέας','Ψάρια','Γαλακτοκομικά','Αρτοποιείο','Ποτά','Κατεψυγμένα','Καθαριστικά','Χαρτικά','Προσωπική φροντίδα','Σπίτι'];
const stores=['','Super Market','Lidl','Μανάβικο','Κρεοπωλείο','Φαρμακείο','Jumbo','Άλλο'];
const units=['κιλά','κιλό','kg','γρ','γραμμάρια','τεμάχια','τεμάχιο','μπουκάλια','μπουκάλι','πακέτα','πακέτο'];

let me=null, household=null, lists=[], selectedList=null, items=[], query='', eventSource=null, deferredPrompt=null;

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];

function show(sel){['#authView','#householdView','#appView'].forEach(s=>$(s).hidden=s!==sel)}
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2800)}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function selectHtml(values,current){return values.map(v=>`<option ${v===current?'selected':''}>${escapeHtml(v)}</option>`).join('')}

async function api(path,opts={}){
  const headers={'content-type':'application/json',...(opts.headers||{})};
  const r=await fetch(API+path,{...opts,headers,credentials:'include'});
  let data={};try{data=await r.json()}catch{}
  if(!r.ok)throw Object.assign(new Error(data.error||'Κάτι πήγε στραβά.'),{status:r.status,data});
  return data;
}

async function boot(){
  try{
    const data=await api('/me');
    me=data.user;household=data.household;
    if(!household){show('#householdView');return}
    await enterApp();
  }catch(e){
    if(e.status===401||e.status===403){show('#authView')}
    else toast(e.message);
  }
}

async function enterApp(){
  show('#appView');
  $('#houseMeta').textContent=household?.name||'';
  $('#inviteDisplay').textContent=household?.invite_code||household?.inviteCode||'—';
  $('#adminNavBtn').hidden=me?.role!=='admin';
  await loadLists();
  if(me?.role==='admin')loadUsers().catch(()=>{});
}

async function loadLists(){
  const d=await api('/lists');
  lists=d.lists||[];
  const select=$('#listSelect');
  const previous=selectedList?.id;
  select.innerHTML='';
  for(const l of lists){
    const o=document.createElement('option');
    o.value=l.id;
    o.textContent=listLabel(l);
    select.appendChild(o);
  }
  selectedList=lists.find(l=>l.id===previous)||lists.find(l=>l.owner_user_id===me?.id&&l.type==='personal')||lists[0]||null;
  if(selectedList)select.value=selectedList.id;
  updatePrivacyNotice();
  if(selectedList){
    await loadItems();
    connectRealtime();
    await loadHistory().catch(()=>{});
  }else{
    items=[];render();
  }
}

function listLabel(l){
  if(l.type==='personal'){
    if(l.owner_user_id===me?.id)return '🔒 Η προσωπική μου';
    return '👁 '+(l.owner_name?('Προσωπική — '+l.owner_name):l.name);
  }
  return '👥 '+l.name;
}

function canWriteCurrent(){
  if(!selectedList)return false;
  if(selectedList.owner_user_id===me?.id)return true;
  return selectedList.type==='shared';
}

function updatePrivacyNotice(){
  const n=$('#privacyNotice');
  if(!selectedList){n.hidden=true;return}
  if(selectedList.type==='personal'&&selectedList.owner_user_id===me?.id){
    n.textContent='Προσωπική λίστα. Οι άλλοι χρήστες δεν τη βλέπουν. Ο διαχειριστής του χώρου μπορεί να έχει πρόσβαση σύμφωνα με την πολιτική της εφαρμογής.';
    n.hidden=false;
  }else if(selectedList.type==='personal'){
    n.textContent='Προσωπική λίστα άλλου χρήστη — μόνο προβολή για διαχειριστή.';
    n.hidden=false;
  }else{
    n.textContent='Κοινή λίστα — τη βλέπουν μόνο τα μέλη που έχουν προστεθεί σε αυτή.';
    n.hidden=false;
  }
  const writable=canWriteCurrent();
  $('#quickInput').disabled=!writable;
  $('#addBtn').disabled=!writable;
}

async function selectList(id){
  selectedList=lists.find(l=>l.id===id)||null;
  updatePrivacyNotice();
  await loadItems();
  connectRealtime();
  await loadHistory().catch(()=>{});
}

async function loadItems(){
  if(!selectedList){items=[];render();return}
  const d=await api('/items?listId='+encodeURIComponent(selectedList.id));
  items=d.items||[];
  render();
}

async function loadHistory(){
  if(!selectedList){$('#historyList').innerHTML='<div class="empty">Δεν υπάρχει λίστα.</div>';return}
  const d=await api('/activity?listId='+encodeURIComponent(selectedList.id));
  const rows=d.activity||[];
  $('#historyList').innerHTML=rows.length?rows.map(h=>`<div class="history"><span>${new Date(h.created_at).toLocaleString('el-GR',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'})}</span>${escapeHtml(h.display_name||h.email||'Χρήστης')} • ${escapeHtml(h.action)}${h.item_name?' «'+escapeHtml(h.item_name)+'»':''}</div>`).join(''):'<div class="empty">Δεν υπάρχει ακόμη ιστορικό.</div>';
}

function connectRealtime(){
  eventSource?.close();eventSource=null;
  if(!selectedList)return;
  eventSource=new EventSource(API+`/events?listId=${encodeURIComponent(selectedList.id)}`,{withCredentials:true});
  eventSource.onmessage=()=>{loadItems().catch(()=>{});loadHistory().catch(()=>{})};
}

function parseInput(raw){
  const input=raw.trim().replace(/\s+/g,' ');
  let quantity=1,unit='τεμ.',name=input;
  const first=input.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/),last=input.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)$/);
  if(first){quantity=Number(first[1].replace(',','.'));name=first[2]}
  else if(last){quantity=Number(last[2].replace(',','.'));name=last[1]}
  const p=name.split(' ');
  if(p.length>1&&units.includes(p[0].toLowerCase())){unit=p[0];name=p.slice(1).join(' ')}
  return{name:name.trim()||input,quantity:Number.isFinite(quantity)&&quantity>0?quantity:1,unit};
}

async function addItem(){
  if(!selectedList||!canWriteCurrent())return;
  const el=$('#quickInput'),raw=el.value.trim();if(!raw)return;
  const p=parseInput(raw);
  const dup=items.find(i=>i.status==='active'&&i.name.toLocaleLowerCase('el')===p.name.toLocaleLowerCase('el'));
  try{
    if(dup){
      await api('/items/'+dup.id,{method:'PATCH',body:JSON.stringify({quantity:Number(dup.quantity)+p.quantity})});
      toast('Αυξήθηκε η ποσότητα');
    }else{
      await api('/items?listId='+encodeURIComponent(selectedList.id),{method:'POST',body:JSON.stringify({name:p.name,quantity:p.quantity,unit:p.unit})});
    }
    el.value='';await loadItems();
  }catch(e){toast(e.message)}
}

async function patch(item,changes){
  if(!canWriteCurrent())return toast('Αυτή η προσωπική λίστα είναι μόνο για προβολή.');
  try{
    await api('/items/'+item.id,{method:'PATCH',body:JSON.stringify(changes)});
    await loadItems();
  }catch(e){toast(e.message)}
}

function makeItem(item){
  const node=$('#itemTemplate').content.firstElementChild.cloneNode(true);
  const check=node.querySelector('.check'),main=node.querySelector('.item-main'),icon=node.querySelector('.icon'),editor=node.querySelector('.editor');
  const writable=canWriteCurrent();
  node.classList.add(item.status);
  check.textContent=item.status==='purchased'?'✓':'○';
  icon.textContent=item.status==='deleted'?'↩':'🗑';
  main.querySelector('strong').textContent=item.name;
  main.querySelector('span').textContent=`${item.quantity} ${item.unit}${item.store?' • '+item.store:''}${item.category!=='Άλλα'?' • '+item.category:''}`;
  main.querySelector('small').textContent=item.note||'';
  check.disabled=!writable;icon.disabled=!writable;
  check.onclick=()=>patch(item,item.status==='purchased'?{status:'active'}:{status:'purchased'});
  icon.onclick=()=>patch(item,item.status==='deleted'?{status:'active'}:{status:'deleted'});
  if(item.status!=='deleted'&&writable){
    editor.innerHTML=`<label>Ποσότητα<input data-k="quantity" type="number" min="0.1" step="0.1" value="${item.quantity}"></label><label>Μονάδα<input data-k="unit" value="${escapeHtml(item.unit)}"></label><label>Κατηγορία<select data-k="category">${selectHtml(categories,item.category)}</select></label><label>Κατάστημα<select data-k="store">${selectHtml(stores,item.store)}</select></label><label class="wide">Σημείωση<input data-k="note" value="${escapeHtml(item.note||'')}" placeholder="π.χ. πλήρες 3,5%"></label><label>Προτεραιότητα<select data-k="priority"><option value="normal" ${item.priority==='normal'?'selected':''}>Κανονικό</option><option value="important" ${item.priority==='important'?'selected':''}>Σημαντικό</option><option value="urgent" ${item.priority==='urgent'?'selected':''}>Επείγον</option></select></label>`;
    editor.querySelectorAll('[data-k]').forEach(el=>el.onchange=()=>{
      const key=el.dataset.k;let value=el.value;if(key==='quantity')value=Number(value)||1;patch(item,{[key]:value});
    });
    main.onclick=()=>editor.hidden=!editor.hidden;
  }else main.onclick=()=>{};
  return node;
}

function render(){
  const visible=items.filter(i=>i.name.toLocaleLowerCase('el').includes(query.toLocaleLowerCase('el')));
  const active=visible.filter(i=>i.status==='active'),purchased=visible.filter(i=>i.status==='purchased'),trash=visible.filter(i=>i.status==='deleted');
  $('#summary').textContent=`${active.length} προς αγορά • ${purchased.length} αγορασμένα`;
  fill('#activeList',active,'Η λίστα είναι καθαρή. Πρόσθεσε κάτι.');
  $('#purchasedSection').hidden=!purchased.length;fill('#purchasedList',purchased);
  $('#trashSection').hidden=!trash.length;$('#trashSummary').textContent=`Πρόσφατα διαγραμμένα (${trash.length})`;fill('#trashList',trash);
}

function fill(sel,list,empty=''){
  const el=$(sel);el.innerHTML='';
  if(!list.length&&empty){el.innerHTML=`<div class="empty">${empty}</div>`;return}
  list.forEach(i=>el.appendChild(makeItem(i)));
}

async function loadUsers(){
  if(me?.role!=='admin')return;
  const d=await api('/admin/users');
  renderUsers(d.users||[]);
}

function renderUsers(users){
  const wrap=$('#usersList');wrap.innerHTML='';
  const sharedLists=lists.filter(l=>l.type==='shared');
  if(!users.length){wrap.innerHTML='<div class="empty">Δεν υπάρχουν χρήστες.</div>';return}
  for(const u of users){
    const card=document.createElement('article');card.className='user-card';
    const head=document.createElement('div');head.className='user-head';
    const info=document.createElement('div');
    const title=document.createElement('strong');title.textContent=u.display_name||u.email;
    const meta=document.createElement('small');meta.textContent=`${u.email} • ${u.status==='pending'?'Αναμονή':u.status==='active'?'Ενεργός':u.status}`;
    info.append(title,meta);head.appendChild(info);card.appendChild(head);

    const actions=document.createElement('div');actions.className='user-actions';
    if(u.status==='pending'){
      const approve=document.createElement('button');approve.className='secondary';approve.textContent='Έγκριση';
      approve.onclick=async()=>{try{await api('/admin/users/'+u.id+'/approve',{method:'POST',body:'{}'});toast('Ο χρήστης εγκρίθηκε');await loadUsers();await loadLists()}catch(e){toast(e.message)}};
      actions.appendChild(approve);
    }else if(u.id!==me.id){
      const suspend=document.createElement('button');suspend.className='secondary';suspend.textContent=u.status==='active'?'Απενεργοποίηση':'Ενεργοποίηση';
      suspend.onclick=async()=>{try{await api('/admin/users/'+u.id+'/status',{method:'PATCH',body:JSON.stringify({status:u.status==='active'?'suspended':'active'})});await loadUsers()}catch(e){toast(e.message)}};
      actions.appendChild(suspend);
    }

    if(u.status==='active'&&u.id!==me.id&&sharedLists.length){
      const memberBox=document.createElement('div');memberBox.className='member-box';
      const label=document.createElement('small');label.textContent='Πρόσβαση σε κοινές λίστες';
      memberBox.appendChild(label);
      for(const l of sharedLists){
        const already=(u.list_ids||[]).includes(l.id);
        const b=document.createElement('button');b.className='chip';b.textContent=(already?'✓ ':'+ ')+l.name;b.disabled=already;
        b.onclick=async()=>{try{await api('/lists/'+l.id+'/members',{method:'POST',body:JSON.stringify({userId:u.id})});toast('Προστέθηκε στην κοινή λίστα');await loadUsers()}catch(e){toast(e.message)}};
        memberBox.appendChild(b);
      }
      card.appendChild(memberBox);
    }

    card.appendChild(actions);wrap.appendChild(card);
  }
}

function setTab(tab){
  ['list','history','admin','settings'].forEach(t=>$('#'+t+'View').hidden=t!==tab);
  $$('nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='history')loadHistory().catch(()=>{});
  if(tab==='admin')loadUsers().catch(e=>toast(e.message));
}

function updateNetwork(){
  const on=navigator.onLine,n=$('#network');
  n.textContent=on?'● Online':'● Offline';n.className='status '+(on?'ok':'off');
}

$('#showLogin').onclick=()=>{$('#loginForm').hidden=false;$('#signupForm').hidden=true;$('#showLogin').classList.add('active');$('#showSignup').classList.remove('active')};
$('#showSignup').onclick=()=>{$('#loginForm').hidden=true;$('#signupForm').hidden=false;$('#showSignup').classList.add('active');$('#showLogin').classList.remove('active')};

$('#loginForm').onsubmit=async e=>{
  e.preventDefault();$('#authError').hidden=true;
  try{
    const d=await api('/login',{method:'POST',body:JSON.stringify({email:$('#loginEmail').value,password:$('#loginPassword').value})});
    await boot();
  }catch(err){$('#authError').textContent=err.message;$('#authError').hidden=false}
};

$('#signupForm').onsubmit=async e=>{
  e.preventDefault();$('#authError').hidden=true;
  try{
    const d=await api('/signup',{method:'POST',body:JSON.stringify({displayName:$('#signupName').value,email:$('#signupEmail').value,password:$('#signupPassword').value})});
    $('#signupForm').hidden=true;$('#loginForm').hidden=false;$('#showLogin').classList.add('active');$('#showSignup').classList.remove('active');
    $('#authError').textContent=d.message||'Η εγγραφή ολοκληρώθηκε.';$('#authError').hidden=false;
  }catch(err){$('#authError').textContent=err.message;$('#authError').hidden=false}
};

$('#createHouse').onclick=async()=>{
  try{const d=await api('/households',{method:'POST',body:JSON.stringify({name:$('#houseName').value||'Το σπίτι μας'})});household=d;const m=await api('/me');me=m.user;await enterApp()}
  catch(e){$('#houseError').textContent=e.message;$('#houseError').hidden=false}
};

$('#joinHouse').onclick=async()=>{
  try{const d=await api('/households/join',{method:'POST',body:JSON.stringify({inviteCode:$('#inviteCode').value})});household=d;await enterApp()}
  catch(e){$('#houseError').textContent=e.message;$('#houseError').hidden=false}
};

$('#logoutBtn').onclick=async()=>{try{await api('/logout',{method:'POST',body:'{}'})}catch{}eventSource?.close();me=null;household=null;lists=[];selectedList=null;show('#authView')};
$('#listSelect').onchange=e=>selectList(e.target.value);
$('#newSharedListBtn').onclick=()=>$('#sharedListDialog').showModal();
$('#createSharedList').onclick=async e=>{
  e.preventDefault();
  const name=$('#sharedListName').value.trim();
  if(!name)return toast('Γράψε όνομα για την κοινή λίστα.');
  try{
    await api('/lists',{method:'POST',body:JSON.stringify({name,type:'shared'})});
    $('#sharedListName').value='';$('#sharedListDialog').close();await loadLists();if(me?.role==='admin')await loadUsers();
  }catch(err){toast(err.message)}
};
$('#refreshUsers').onclick=()=>loadUsers().catch(e=>toast(e.message));
$('#addBtn').onclick=addItem;
$('#quickInput').onkeydown=e=>{if(e.key==='Enter')addItem()};
$('#search').oninput=e=>{query=e.target.value;render()};
$('#clearPurchased').onclick=async()=>{for(const i of items.filter(x=>x.status==='purchased'))await patch(i,{status:'deleted'})};
$$('nav button').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));

const theme=localStorage.getItem('psonia.theme')||'system';
$('#theme').value=theme;document.documentElement.dataset.theme=theme;
$('#theme').onchange=e=>{document.documentElement.dataset.theme=e.target.value;localStorage.setItem('psonia.theme',e.target.value)};

addEventListener('online',updateNetwork);addEventListener('offline',updateNetwork);
addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('#installBtn').hidden=false});
$('#installBtn').onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('#installBtn').hidden=true};
if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));

updateNetwork();boot();
