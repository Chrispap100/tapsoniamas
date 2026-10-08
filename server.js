const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const {Pool}=require('pg');
const {runMigrations}=require('./migrate');

const PORT=process.env.PORT||10000;
const DATABASE_URL=process.env.DATABASE_URL;
const ORIGIN=process.env.APP_ORIGIN||'https://tapsoniamas-api.onrender.com';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}}):null;
const clients=new Map();
const rateBuckets=new Map();
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function limited(key,limit,windowMs){
 const now=Date.now(),b=rateBuckets.get(key);
 if(rateBuckets.size>10000){for(const [k,v] of rateBuckets)if(now>v.reset)rateBuckets.delete(k)}
 if(!b||now>b.reset){rateBuckets.set(key,{count:1,reset:now+windowMs});return false}
 b.count++;return b.count>limit;
}
function securityHeaders(){
 return {
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'permissions-policy':'camera=(), microphone=(), geolocation=()',
  'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'strict-transport-security':'max-age=31536000; includeSubDomains'
 };
}

async function init(){
 if(!pool)return;
 await runMigrations(pool);
 await pool.query("delete from shopping_app.sessions where expires_at < now() or (revoked_at is not null and revoked_at < now()-interval '30 days')");
}
function send(res,status,data,headers={}){res.writeHead(status,{...securityHeaders(),'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':ORIGIN,'access-control-allow-credentials':'true',...headers});res.end(JSON.stringify(data))}
function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
function tokenHash(v){return crypto.createHash('sha256').update(v).digest('hex')}
async function createSession(userId){
 const raw=crypto.randomBytes(32).toString('base64url');
 await pool.query("insert into shopping_app.sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '7 days')",[tokenHash(raw),userId]);
 return raw;
}
async function sessionUser(req){
 const raw=cookies(req).psonia_session;if(!raw)return null;
 const r=await pool.query(`select u.id,u.email,u.display_name,u.status,u.app_role,u.last_login_at,u.created_at,s.token_hash
 from shopping_app.sessions s join shopping_app.users u on u.id=s.user_id
 where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now()`,[tokenHash(raw)]);
 return r.rows[0]||null;
}
function sessionCookie(raw){return `psonia_session=${encodeURIComponent(raw)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`}
function clearSessionCookie(){return 'psonia_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'}
async function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',d=>{b+=d;if(b.length>1e6)req.destroy()});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch{reject(new Error('invalid_json'))}});req.on('error',reject)})}
async function currentUser(userId){const r=await pool.query('select id,email,display_name,status,app_role,last_login_at,created_at from shopping_app.users where id=$1',[userId]);return r.rows[0]||null}
async function firstHousehold(userId){const r=await pool.query(`select h.id,h.name,h.invite_code,m.role from shopping_app.memberships m join shopping_app.households h on h.id=m.household_id where m.user_id=$1 order by m.created_at limit 1`,[userId]);return r.rows[0]||null}
async function isHouseholdAdmin(userId,householdId){const r=await pool.query(`select 1 from shopping_app.memberships m join shopping_app.users u on u.id=m.user_id where m.user_id=$1 and m.household_id=$2 and (m.role='owner' or u.app_role='admin')`,[userId,householdId]);return !!r.rowCount}
async function ensurePersonalList(userId,householdId){
 const found=await pool.query("select * from shopping_app.lists where owner_user_id=$1 and type='personal' limit 1",[userId]);
 if(found.rowCount)return found.rows[0];
 const id=crypto.randomUUID();
 const u=await currentUser(userId);
 const name=`Προσωπική λίστα${u?.display_name?' — '+u.display_name:''}`;
 const r=await pool.query(`insert into shopping_app.lists(id,household_id,owner_user_id,name,type,admin_visible,created_by) values($1,$2,$3,$4,'personal',true,$3) returning *`,[id,householdId,userId,name]);
 await pool.query("insert into shopping_app.list_memberships(list_id,user_id,role) values($1,$2,'owner') on conflict do nothing",[id,userId]);
 return r.rows[0];
}
async function canReadList(user,list){
 if(!list)return false;
 if(list.owner_user_id===user.id)return true;
 if(list.type==='shared'){
   const m=await pool.query('select 1 from shopping_app.list_memberships where list_id=$1 and user_id=$2',[list.id,user.id]);
   if(m.rowCount)return true;
   return await isHouseholdAdmin(user.id,list.household_id);
 }
 return list.admin_visible && await isHouseholdAdmin(user.id,list.household_id);
}
async function canWriteList(user,list){
 if(!list)return false;
 if(list.owner_user_id===user.id)return true;
 if(list.type==='shared'){
   const m=await pool.query('select 1 from shopping_app.list_memberships where list_id=$1 and user_id=$2',[list.id,user.id]);
   return !!m.rowCount || await isHouseholdAdmin(user.id,list.household_id);
 }
 return false;
}
async function getList(id){const r=await pool.query('select * from shopping_app.lists where id=$1',[id]);return r.rows[0]||null}
function emit(listId,event){const set=clients.get(listId);if(!set)return;for(const res of [...set]){try{res.write(`data: ${JSON.stringify(event)}\n\n`)}catch{set.delete(res)}}}
async function log(hid,listId,uid,action,itemName){await pool.query('insert into shopping_app.activity(id,household_id,list_id,user_id,action,item_name) values($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),hid,listId,uid,action,itemName||null])}
function staticFile(req,res){let p=new URL(req.url,'http://x').pathname;if(p==='/')p='/index.html';const safe=path.normalize(p).replace(/^\.\.(\/|\\|$)/,'');const file=path.join(__dirname,safe);if(!file.startsWith(__dirname)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return false;const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};res.writeHead(200,{...securityHeaders(),'content-type':types[ext]||'application/octet-stream'});fs.createReadStream(file).pipe(res);return true}

const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':ORIGIN,'access-control-allow-credentials':'true','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS'});return res.end()}
  const u=new URL(req.url,'http://localhost');
  if(['POST','PATCH','DELETE'].includes(req.method)){
    const origin=req.headers.origin;
    if(origin&&origin!==ORIGIN)return send(res,403,{error:'Το αίτημα απορρίφθηκε για λόγους ασφαλείας.'});
  }
  if(u.pathname==='/api/health')return send(res,200,{ok:true,database:!!pool});
  if(!pool&&u.pathname.startsWith('/api/'))return send(res,503,{error:'Η βάση δεδομένων δεν έχει συνδεθεί ακόμη.'});

  if(u.pathname==='/api/signup'&&req.method==='POST'){
    const b=await body(req);
    if(limited('signup:'+clientIp(req),8,15*60*1000))return send(res,429,{error:'Έγιναν πολλές προσπάθειες. Δοκίμασε ξανά αργότερα.'});
    if(!b.email||!b.password||String(b.password).length<6||!String(b.displayName||'').trim())return send(res,400,{error:'Χρειάζεται όνομα, email και κωδικός τουλάχιστον 6 χαρακτήρων.'});
    const id=crypto.randomUUID(),hash=await bcrypt.hash(String(b.password),12);
    const client=await pool.connect();
    let firstUser=false,created=false;
    try{
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(847261)");
      const count=await client.query('select count(*)::int as n from shopping_app.users');
      firstUser=count.rows[0].n===0;
      try{
        await client.query(`insert into shopping_app.users(id,email,password_hash,display_name,status,app_role) values($1,$2,$3,$4,$5,$6)`,[id,String(b.email).toLowerCase(),hash,String(b.displayName).trim().slice(0,80),firstUser?'active':'pending',firstUser?'admin':'user']);
        created=true;
      }catch(e){if(e.code!=='23505')throw e}
      await client.query('commit');
    }catch(e){await client.query('rollback');throw e}finally{client.release()}
    if(firstUser&&created)return send(res,201,{pending:false,bootstrapAdmin:true,message:'Ο πρώτος διαχειριστής δημιουργήθηκε. Μπορείς τώρα να συνδεθείς και να δημιουργήσεις το σπίτι σου.'});
    return send(res,201,{pending:true,message:'Αν τα στοιχεία είναι διαθέσιμα, η εγγραφή καταχωρήθηκε και περιμένει έγκριση από τον διαχειριστή.'});
  }

  if(u.pathname==='/api/login'&&req.method==='POST'){
    const b=await body(req);
    const emailKey=String(b.email||'').toLowerCase();
    if(limited('login-ip:'+clientIp(req),20,15*60*1000)||limited('login-email:'+emailKey,10,15*60*1000))return send(res,429,{error:'Έγιναν πολλές προσπάθειες σύνδεσης. Δοκίμασε ξανά αργότερα.'});
    const r=await pool.query('select * from shopping_app.users where email=$1',[String(b.email||'').toLowerCase()]);
    const user=r.rows[0];
    if(!user||!(await bcrypt.compare(String(b.password||''),user.password_hash)))return send(res,401,{error:'Λάθος email ή κωδικός.'});
    if(user.status==='pending')return send(res,403,{error:'Ο λογαριασμός σου περιμένει έγκριση από τον διαχειριστή.',status:'pending'});
    if(user.status!=='active')return send(res,403,{error:'Ο λογαριασμός δεν είναι ενεργός.',status:user.status});
    await pool.query('update shopping_app.users set last_login_at=now() where id=$1',[user.id]);
    const raw=await createSession(user.id);
    return send(res,200,{user:{id:user.id,email:user.email,displayName:user.display_name,role:user.app_role}}, {'set-cookie':sessionCookie(raw),'cache-control':'no-store'});
  }

  if(!u.pathname.startsWith('/api/')){if(staticFile(req,res))return;res.writeHead(404);return res.end('Not found')}

  if(u.pathname==='/api/logout'&&req.method==='POST'){
    const raw=cookies(req).psonia_session;
    if(raw)await pool.query('update shopping_app.sessions set revoked_at=now() where token_hash=$1',[tokenHash(raw)]);
    return send(res,200,{ok:true},{'set-cookie':clearSessionCookie(),'cache-control':'no-store'});
  }

  const user=await sessionUser(req);if(!user)return send(res,401,{error:'Η συνεδρία σου έληξε. Συνδέσου ξανά.'},{'set-cookie':clearSessionCookie(),'cache-control':'no-store'});
  if(user.status!=='active')return send(res,403,{error:'Ο λογαριασμός δεν είναι ενεργός.'});

  if(u.pathname==='/api/logout-all'&&req.method==='POST'){
    await pool.query('update shopping_app.sessions set revoked_at=now() where user_id=$1 and revoked_at is null',[user.id]);
    return send(res,200,{ok:true},{'set-cookie':clearSessionCookie(),'cache-control':'no-store'});
  }

  if(u.pathname==='/api/password'&&req.method==='POST'){
    const b=await body(req);
    if(limited('password:'+user.id,5,30*60*1000))return send(res,429,{error:'Έγιναν πολλές προσπάθειες αλλαγής κωδικού. Δοκίμασε αργότερα.'});
    if(String(b.newPassword||'').length<8)return send(res,400,{error:'Ο νέος κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.'});
    const r=await pool.query('select password_hash from shopping_app.users where id=$1',[user.id]);
    if(!r.rowCount||!(await bcrypt.compare(String(b.currentPassword||''),r.rows[0].password_hash)))return send(res,400,{error:'Ο τρέχων κωδικός δεν είναι σωστός.'});
    const hash=await bcrypt.hash(String(b.newPassword),12);
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query('update shopping_app.users set password_hash=$1 where id=$2',[hash,user.id]);
      await client.query('update shopping_app.sessions set revoked_at=now() where user_id=$1 and revoked_at is null',[user.id]);
      await client.query('commit');
    }catch(e){await client.query('rollback');throw e}finally{client.release()}
    return send(res,200,{ok:true,message:'Ο κωδικός άλλαξε. Συνδέσου ξανά.'},{'set-cookie':clearSessionCookie()});
  }

  if(u.pathname==='/api/me'&&req.method==='GET'){
    const h=await firstHousehold(user.id);
    return send(res,200,{user:{id:user.id,email:user.email,displayName:user.display_name,role:user.app_role,status:user.status},household:h});
  }

  if(u.pathname==='/api/households'&&req.method==='POST'){
    const b=await body(req),hid=crypto.randomUUID(),code=crypto.randomBytes(6).toString('hex').toUpperCase();
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query('insert into shopping_app.households(id,name,invite_code,created_by) values($1,$2,$3,$4)',[hid,b.name||'Το σπίτι μας',code,user.id]);
      await client.query("insert into shopping_app.memberships(user_id,household_id,role) values($1,$2,'owner') on conflict do nothing",[user.id,hid]);
      await client.query("update shopping_app.users set app_role='admin',status='active' where id=$1",[user.id]);
      const lid=crypto.randomUUID();
      await client.query(`insert into shopping_app.lists(id,household_id,owner_user_id,name,type,admin_visible,created_by) values($1,$2,null,'Κοινή λίστα','shared',true,$3)`,[lid,hid,user.id]);
      await client.query("insert into shopping_app.list_memberships(list_id,user_id,role) values($1,$2,'owner')",[lid,user.id]);
      await client.query('commit');
      await ensurePersonalList(user.id,hid);
      return send(res,201,{id:hid,name:b.name||'Το σπίτι μας',inviteCode:code});
    }catch(e){await client.query('rollback');throw e}finally{client.release()}
  }

  if(u.pathname==='/api/households/join'&&req.method==='POST'){
    const b=await body(req);
    if(limited('join:'+clientIp(req),20,15*60*1000))return send(res,429,{error:'Πάρα πολλές προσπάθειες κωδικού πρόσκλησης. Δοκίμασε αργότερα.'});
    const r=await pool.query('select id,name,invite_code from shopping_app.households where invite_code=$1',[String(b.inviteCode||'').toUpperCase()]);
    if(!r.rowCount)return send(res,404,{error:'Ο κωδικός πρόσκλησης δεν βρέθηκε.'});
    await pool.query("insert into shopping_app.memberships(user_id,household_id,role) values($1,$2,'member') on conflict do nothing",[user.id,r.rows[0].id]);
    await ensurePersonalList(user.id,r.rows[0].id);
    return send(res,200,{id:r.rows[0].id,name:r.rows[0].name,inviteCode:r.rows[0].invite_code});
  }

  const h=await firstHousehold(user.id);

  if(u.pathname==='/api/lists'&&req.method==='GET'){
    if(!h)return send(res,200,{lists:[]});
    await ensurePersonalList(user.id,h.id);
    const admin=await isHouseholdAdmin(user.id,h.id);
    const r=await pool.query(`
      select l.*,u.display_name as owner_name
      from shopping_app.lists l
      left join shopping_app.users u on u.id=l.owner_user_id
      where l.household_id=$1 and (
        l.owner_user_id=$2 or
        exists(select 1 from shopping_app.list_memberships lm where lm.list_id=l.id and lm.user_id=$2) or
        ($3=true and (l.type='shared' or l.admin_visible=true))
      )
      order by case when l.owner_user_id=$2 then 0 when l.type='shared' then 1 else 2 end,l.created_at
    `,[h.id,user.id,admin]);
    return send(res,200,{lists:r.rows,admin});
  }

  if(u.pathname==='/api/lists'&&req.method==='POST'){
    if(!h)return send(res,409,{error:'Πρέπει πρώτα να ανήκεις σε ένα σπίτι.'});
    const b=await body(req);
    const type=b.type==='personal'?'personal':'shared';
    if(type==='personal'){
      const personal=await ensurePersonalList(user.id,h.id);
      return send(res,200,{list:personal});
    }
    const id=crypto.randomUUID(),name=String(b.name||'Κοινή λίστα').trim().slice(0,80)||'Κοινή λίστα';
    const r=await pool.query(`insert into shopping_app.lists(id,household_id,owner_user_id,name,type,admin_visible,created_by) values($1,$2,null,$3,'shared',true,$4) returning *`,[id,h.id,name,user.id]);
    await pool.query("insert into shopping_app.list_memberships(list_id,user_id,role) values($1,$2,'owner')",[id,user.id]);
    if(user.app_role!=='admin'){
      const admins=await pool.query(`select m.user_id from shopping_app.memberships m join shopping_app.users u on u.id=m.user_id where m.household_id=$1 and (m.role='owner' or u.app_role='admin')`,[h.id]);
      for(const row of admins.rows)await pool.query("insert into shopping_app.list_memberships(list_id,user_id,role) values($1,$2,'admin') on conflict do nothing",[id,row.user_id]);
    }
    return send(res,201,{list:r.rows[0]});
  }

  if(u.pathname==='/api/admin/users'&&req.method==='GET'){
    if(!h||!(await isHouseholdAdmin(user.id,h.id)))return send(res,403,{error:'Μόνο ο διαχειριστής μπορεί να δει τους χρήστες.'});
    const r=await pool.query(`
      select u.id,u.email,u.display_name,u.status,u.app_role,u.last_login_at,u.created_at,
      exists(select 1 from shopping_app.memberships m where m.user_id=u.id and m.household_id=$1) as in_household,
      coalesce((select json_agg(lm.list_id) from shopping_app.list_memberships lm join shopping_app.lists l on l.id=lm.list_id where lm.user_id=u.id and l.household_id=$1),'[]'::json) as list_ids
      from shopping_app.users u order by u.created_at desc
    `,[h.id]);
    return send(res,200,{users:r.rows});
  }

  const approve=u.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/approve$/);
  if(approve&&req.method==='POST'){
    if(!h||!(await isHouseholdAdmin(user.id,h.id)))return send(res,403,{error:'Μόνο ο διαχειριστής μπορεί να εγκρίνει χρήστες.'});
    const uid=approve[1];
    const target=await currentUser(uid);if(!target)return send(res,404,{error:'Ο χρήστης δεν βρέθηκε.'});
    await pool.query("update shopping_app.users set status='active' where id=$1",[uid]);
    await pool.query("insert into shopping_app.memberships(user_id,household_id,role) values($1,$2,'member') on conflict do nothing",[uid,h.id]);
    await ensurePersonalList(uid,h.id);
    return send(res,200,{ok:true});
  }

  const statusMatch=u.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/status$/);
  if(statusMatch&&req.method==='PATCH'){
    if(!h||!(await isHouseholdAdmin(user.id,h.id)))return send(res,403,{error:'Μόνο ο διαχειριστής μπορεί να αλλάξει κατάσταση χρήστη.'});
    const b=await body(req),allowed=['active','suspended','rejected'];
    if(!allowed.includes(b.status))return send(res,400,{error:'Μη έγκυρη κατάσταση χρήστη.'});
    await pool.query('update shopping_app.users set status=$1 where id=$2 and id<>$3',[b.status,statusMatch[1],user.id]);
    return send(res,200,{ok:true});
  }

  const memberMatch=u.pathname.match(/^\/api\/lists\/([0-9a-f-]+)\/members$/);
  if(memberMatch&&req.method==='POST'){
    if(!h||!(await isHouseholdAdmin(user.id,h.id)))return send(res,403,{error:'Μόνο ο διαχειριστής μπορεί να προσθέτει μέλη σε λίστα.'});
    const list=await getList(memberMatch[1]);if(!list||list.household_id!==h.id||list.type!=='shared')return send(res,404,{error:'Η κοινή λίστα δεν βρέθηκε.'});
    const b=await body(req);
    await pool.query("insert into shopping_app.list_memberships(list_id,user_id,role) values($1,$2,'member') on conflict do nothing",[list.id,b.userId]);
    return send(res,200,{ok:true});
  }

  if(memberMatch&&req.method==='DELETE'){
    if(!h||!(await isHouseholdAdmin(user.id,h.id)))return send(res,403,{error:'Μόνο ο διαχειριστής μπορεί να αφαιρεί μέλη από λίστα.'});
    const list=await getList(memberMatch[1]);if(!list||list.household_id!==h.id||list.type!=='shared')return send(res,404,{error:'Η κοινή λίστα δεν βρέθηκε.'});
    const b=await body(req);
    if(String(b.userId||'')===String(user.id))return send(res,400,{error:'Δεν μπορείς να αφαιρέσεις τον εαυτό σου από εδώ.'});
    await pool.query('delete from shopping_app.list_memberships where list_id=$1 and user_id=$2',[list.id,b.userId]);
    return send(res,200,{ok:true});
  }

  const listId=u.searchParams.get('listId');
  const list=listId?await getList(listId):null;

  if(u.pathname==='/api/events'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':ORIGIN});
    if(!clients.has(list.id))clients.set(list.id,new Set());clients.get(list.id).add(res);
    res.write('event: ready\ndata: {}\n\n');
    const keepAlive=setInterval(()=>{try{res.write(': keepalive\n\n')}catch{}},25000);
    req.on('close',()=>{clearInterval(keepAlive);clients.get(list.id)?.delete(res);if(!clients.get(list.id)?.size)clients.delete(list.id)});return;
  }

  if(u.pathname==='/api/items'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select * from shopping_app.items where list_id=$1 order by created_at desc',[list.id]);
    return send(res,200,{items:r.rows});
  }

  if(u.pathname==='/api/items'&&req.method==='POST'){
    if(!list||!(await canWriteList(user,list)))return send(res,403,{error:'Δεν μπορείς να αλλάξεις αυτή τη λίστα.'});
    const b=await body(req),name=String(b.name||'').trim();
    const quantity=Number(b.quantity??1);
    if(!name||name.length>120)return send(res,400,{error:'Το όνομα προϊόντος πρέπει να είναι από 1 έως 120 χαρακτήρες.'});
    if(!Number.isFinite(quantity)||quantity<=0||quantity>100000)return send(res,400,{error:'Η ποσότητα δεν είναι έγκυρη.'});
    if(String(b.note||'').length>1000||String(b.store||'').length>120||String(b.unit||'').length>40)return send(res,400,{error:'Κάποιο πεδίο είναι μεγαλύτερο από το επιτρεπτό.'});
    const iid=crypto.randomUUID();
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext($1))",[list.id+':'+name.toLocaleLowerCase('el')]);
      const existing=await client.query("select * from shopping_app.items where list_id=$1 and status='active' and lower(trim(name))=lower(trim($2)) order by created_at limit 1 for update",[list.id,name]);
      let row,merged=false;
      if(existing.rowCount){
        const updated=await client.query('update shopping_app.items set quantity=quantity+$1,updated_at=now(),version=version+1 where id=$2 returning *',[quantity,existing.rows[0].id]);
        row=updated.rows[0];merged=true;
      }else{
        const inserted=await client.query(`insert into shopping_app.items(id,household_id,list_id,name,quantity,unit,category,store,note,priority,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11) returning *`,[iid,list.household_id,list.id,name,quantity,b.unit||'τεμ.',b.category||'Άλλα',b.store||'',b.note||'',b.priority||'normal',user.id]);
        row=inserted.rows[0];
      }
      await client.query('insert into shopping_app.activity(id,household_id,list_id,user_id,action,item_name) values($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),list.household_id,list.id,user.id,merged?'merge':'add',name]);
      await client.query('commit');
      emit(list.id,{type:'items_changed'});
      return send(res,merged?200:201,{item:row,merged});
    }catch(e){await client.query('rollback');throw e}finally{client.release()}
  }

  const itemMatch=u.pathname.match(/^\/api\/items\/([0-9a-f-]+)$/);
  if(itemMatch&&req.method==='PATCH'){
    const ir=await pool.query('select i.*,l.type,l.owner_user_id,l.admin_visible from shopping_app.items i join shopping_app.lists l on l.id=i.list_id where i.id=$1',[itemMatch[1]]);
    const item=ir.rows[0];if(!item)return send(res,404,{error:'Το προϊόν δεν βρέθηκε.'});
    const itemList={id:item.list_id,household_id:item.household_id,type:item.type,owner_user_id:item.owner_user_id,admin_visible:item.admin_visible};
    if(!(await canWriteList(user,itemList)))return send(res,403,{error:'Δεν μπορείς να αλλάξεις αυτή τη λίστα.'});
    const b=await body(req),allowed=['name','quantity','unit','category','store','note','priority','status'],sets=[],vals=[];let n=1;
    if(Object.prototype.hasOwnProperty.call(b,'name')&&(!String(b.name).trim()||String(b.name).length>120))return send(res,400,{error:'Μη έγκυρο όνομα προϊόντος.'});
    if(Object.prototype.hasOwnProperty.call(b,'quantity')&&(!Number.isFinite(Number(b.quantity))||Number(b.quantity)<=0||Number(b.quantity)>100000))return send(res,400,{error:'Μη έγκυρη ποσότητα.'});
    if(Object.prototype.hasOwnProperty.call(b,'note')&&String(b.note).length>1000)return send(res,400,{error:'Η σημείωση είναι πολύ μεγάλη.'});
    if(Object.prototype.hasOwnProperty.call(b,'status')&&!['active','purchased','deleted'].includes(b.status))return send(res,400,{error:'Μη έγκυρη κατάσταση προϊόντος.'});
    const expectedVersion=Number(b.version);
    if(!Number.isInteger(expectedVersion)||expectedVersion<1)return send(res,400,{error:'Λείπει η έκδοση του προϊόντος. Ανανέωσε τη λίστα και δοκίμασε ξανά.'});
    for(const k of allowed)if(Object.prototype.hasOwnProperty.call(b,k)){sets.push(k+'=
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push('deleted_by=
    vals.push(item.id,expectedVersion);
    const idParam=n++, versionParam=n; const r=await pool.query('update shopping_app.items set '+sets.join(',')+' where id=
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(b[k])}
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push(`deleted_by=${n++}`);vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(b[k])}
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push(`deleted_by=${n++}`);vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+idParam+' and version=
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(b[k])}
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push(`deleted_by=${n++}`);vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(b[k])}
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push(`deleted_by=${n++}`);vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+versionParam+' returning *',vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(b[k])}
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push(`deleted_by=${n++}`);vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
+(n++));vals.push(b[k])}
    sets.push('updated_at=now()','version=version+1');
    if(b.status==='purchased')sets.push('purchased_at=now()');
    if(b.status==='active')sets.push('purchased_at=null','deleted_at=null','deleted_by=null');
    if(b.status==='deleted'){sets.push('deleted_at=now()');sets.push(`deleted_by=${n++}`);vals.push(user.id)}
    vals.push(item.id,expectedVersion);
    const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=${n++} and version=${n} returning *`,vals);
    if(!r.rowCount){
      const latest=await pool.query('select * from shopping_app.items where id=$1',[item.id]);
      return send(res,409,{error:'Το προϊόν άλλαξε από άλλον χρήστη. Φόρτωσα την τελευταία έκδοση.',item:latest.rows[0]||null});
    }
    await log(item.household_id,item.list_id,user.id,'update',r.rows[0].name);emit(item.list_id,{type:'items_changed'});return send(res,200,{item:r.rows[0]});
  }

  if(u.pathname==='/api/activity'&&req.method==='GET'){
    if(!list||!(await canReadList(user,list)))return send(res,403,{error:'Δεν έχεις πρόσβαση σε αυτή τη λίστα.'});
    const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where a.list_id=$1 order by a.created_at desc limit 200',[list.id]);
    return send(res,200,{activity:r.rows});
  }

  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
