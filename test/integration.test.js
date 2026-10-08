const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');

const DATABASE_URL=process.env.TEST_DATABASE_URL;
const ORIGIN='http://127.0.0.1:19092';
if(!DATABASE_URL){test('integration skipped without TEST_DATABASE_URL',{skip:true},()=>{});}
else{
  async function waitFor(url,tries=80){
    for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,100))}
    throw new Error('server did not start');
  }
  function client(){
    let cookie='';
    return {
      get cookie(){return cookie},
      async req(path,{method='GET',body,signal}={}){
        const headers={};
        if(cookie)headers.cookie=cookie;
        if(method!=='GET'){headers['content-type']='application/json';headers.origin=ORIGIN}
        const r=await fetch(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal});
        const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
        let data=null;const ct=r.headers.get('content-type')||'';
        if(ct.includes('application/json'))data=await r.json();
        return {r,data};
      }
    };
  }

  test('full admin/user permissions and list flow',async t=>{
    const {Pool}=require('pg');
    const db=new Pool({connectionString:DATABASE_URL});
    await db.query('drop schema if exists shopping_app cascade');
    await db.end();

    const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'19092',DATABASE_URL,APP_ORIGIN:ORIGIN,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);
    t.after(()=>child.kill());
    await waitFor(ORIGIN+'/api/health');

    const admin=client(),user=client();

    let x=await admin.req('/api/signup',{method:'POST',body:{displayName:'Admin Test',email:'admin-test@example.com',password:'AdminPass123!'}});
    assert.equal(x.r.status,201);assert.equal(x.data.bootstrapAdmin,true);

    x=await admin.req('/api/login',{method:'POST',body:{email:'admin-test@example.com',password:'AdminPass123!'}});
    assert.equal(x.r.status,200);assert.match(admin.cookie,/psonia_session=/);

    x=await admin.req('/api/households',{method:'POST',body:{name:'Test Home'}});
    assert.equal(x.r.status,201);

    x=await admin.req('/api/lists');
    assert.equal(x.r.status,200);
    const adminPersonal=x.data.lists.find(l=>l.type==='personal'&&l.owner_name==='Admin Test');
    const shared=x.data.lists.find(l=>l.type==='shared');
    assert.ok(adminPersonal);assert.ok(shared);

    x=await user.req('/api/signup',{method:'POST',body:{displayName:'User Test',email:'user-test@example.com',password:'UserPass123!'}});
    assert.equal(x.r.status,201);assert.equal(x.data.pending,true);

    x=await user.req('/api/login',{method:'POST',body:{email:'user-test@example.com',password:'UserPass123!'}});
    assert.equal(x.r.status,403);assert.equal(x.data.status,'pending');

    x=await admin.req('/api/admin/users');
    assert.equal(x.r.status,200);
    const pending=x.data.users.find(u=>u.email==='user-test@example.com');
    assert.ok(pending);assert.equal(pending.status,'pending');

    x=await admin.req('/api/admin/users/'+pending.id+'/approve',{method:'POST',body:{}});
    assert.equal(x.r.status,200);

    x=await admin.req('/api/lists/'+shared.id+'/members',{method:'POST',body:{userId:pending.id}});
    assert.equal(x.r.status,200);

    x=await user.req('/api/login',{method:'POST',body:{email:'user-test@example.com',password:'UserPass123!'}});
    assert.equal(x.r.status,200);

    x=await user.req('/api/lists');
    assert.equal(x.r.status,200);
    const userPersonal=x.data.lists.find(l=>l.type==='personal');
    assert.ok(userPersonal);
    assert.ok(x.data.lists.some(l=>l.id===shared.id));
    assert.ok(!x.data.lists.some(l=>l.id===adminPersonal.id));

    x=await user.req('/api/items?listId='+adminPersonal.id);
    assert.equal(x.r.status,403);

    x=await admin.req('/api/items?listId='+userPersonal.id);
    assert.equal(x.r.status,200);
    x=await admin.req('/api/items?listId='+userPersonal.id,{method:'POST',body:{name:'Δεν επιτρέπεται'}});
    assert.equal(x.r.status,403);

    x=await user.req('/api/items?listId='+shared.id,{method:'POST',body:{name:'Γάλα',quantity:1,unit:'τεμ.'}});
    assert.ok([200,201].includes(x.r.status));const item=x.data.item;assert.equal(item.version,1);

    x=await admin.req('/api/items?listId='+shared.id,{method:'POST',body:{name:'γάλα',quantity:2,unit:'τεμ.'}});
    assert.equal(x.r.status,200);assert.equal(x.data.merged,true);assert.equal(Number(x.data.item.quantity),3);

    x=await user.req('/api/items?listId='+shared.id);
    const fresh=x.data.items.find(i=>i.id===item.id);assert.ok(fresh);const baseVersion=fresh.version;

    x=await admin.req('/api/items/'+item.id,{method:'PATCH',body:{note:'admin edit',version:baseVersion}});
    assert.equal(x.r.status,200);

    x=await user.req('/api/items/'+item.id,{method:'PATCH',body:{store:'Lidl',version:baseVersion}});
    assert.equal(x.r.status,409);

    x=await user.req('/api/items?listId='+shared.id);const latest=x.data.items.find(i=>i.id===item.id);
    x=await user.req('/api/items/'+item.id,{method:'PATCH',body:{status:'deleted',version:latest.version}});
    assert.equal(x.r.status,200);assert.ok(x.data.item.deleted_at);

    x=await user.req('/api/items?listId='+shared.id);const deleted=x.data.items.find(i=>i.id===item.id);
    x=await user.req('/api/items/'+item.id,{method:'PATCH',body:{status:'active',version:deleted.version}});
    assert.equal(x.r.status,200);assert.equal(x.data.item.deleted_at,null);

    const controller=new AbortController();
    const sse=await fetch(ORIGIN+'/api/events?listId='+shared.id,{headers:{cookie:user.cookie},signal:controller.signal});
    assert.equal(sse.status,200);
    const reader=sse.body.getReader();const first=await reader.read();const text=new TextDecoder().decode(first.value);
    assert.match(text,/ready/);controller.abort();reader.cancel().catch(()=>{});

    x=await admin.req('/api/lists/'+shared.id+'/members',{method:'DELETE',body:{userId:pending.id}});
    assert.equal(x.r.status,200);
    x=await user.req('/api/items?listId='+shared.id);
    assert.equal(x.r.status,403);

    assert.equal(stderr,'');
  });
}
