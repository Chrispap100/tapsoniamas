const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const {Pool}=require('pg');

const PORT=process.env.PORT||10000;
const JWT_SECRET=process.env.JWT_SECRET||crypto.randomBytes(48).toString('hex');
const DATABASE_URL=process.env.DATABASE_URL;
const ORIGIN=process.env.APP_ORIGIN||'https://tapsoniamas-preview.onrender.com';
if(!DATABASE_URL) console.error('DATABASE_URL missing');
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}}):null;
const clients=new Map();

async function init(){
 if(!pool)return;
 await pool.query('create schema if not exists shopping_app');
 await pool.query(`
 create table if not exists shopping_app.users(
   id uuid primary key,
   email text unique not null,
   password_hash text not null,
   display_name text not null default '',
   created_at timestamptz not null default now()
 );
 create table if not exists shopping_app.households(
   id uuid primary key,
   name text not null,
   invite_code text unique not null,
   created_by uuid not null references shopping_app.users(id),
   created_at timestamptz not null default now()
 );
 create table if not exists shopping_app.memberships(
   user_id uuid not null references shopping_app.users(id) on delete cascade,
   household_id uuid not null references shopping_app.households(id) on delete cascade,
   role text not null default 'member',
   created_at timestamptz not null default now(),
   primary key(user_id,household_id)
 );
 create table if not exists shopping_app.items(
   id uuid primary key,
   household_id uuid not null references shopping_app.households(id) on delete cascade,
   name text not null,
   quantity numeric not null default 1,
   unit text not null default 'τεμ.',
   category text not null default 'Άλλα',
   store text not null default '',
   note text not null default '',
   priority text not null default 'normal',
   status text not null default 'active',
   created_by uuid not null references shopping_app.users(id),
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   purchased_at timestamptz
 );
 create table if not exists shopping_app.activity(
   id uuid primary key,
   household_id uuid not null references shopping_app.households(id) on delete cascade,
   user_id uuid not null references shopping_app.users(id),
   action text not null,
   item_name text,
   created_at timestamptz not null default now()
 );`);
}
function send(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':ORIGIN,'access-control-allow-credentials':'true',...headers});res.end(JSON.stringify(data))}
function token(req){const h=req.headers.authorization||'';if(h.startsWith('Bearer '))return h.slice(7);try{return new URL(req.url,'http://localhost').searchParams.get('token')}catch{return null}}
function auth(req){try{return jwt.verify(token(req),JWT_SECRET)}catch{return null}}
async function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',d=>{b+=d;if(b.length>1e6)req.destroy()});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch{reject(new Error('invalid_json'))}});req.on('error',reject)})}
async function member(userId,householdId){const r=await pool.query('select 1 from shopping_app.memberships where user_id=$1 and household_id=$2',[userId,householdId]);return !!r.rowCount}
async function firstHousehold(userId){const r=await pool.query('select h.id,h.name,h.invite_code from shopping_app.memberships m join shopping_app.households h on h.id=m.household_id where m.user_id=$1 order by m.created_at limit 1',[userId]);return r.rows[0]||null}
function emit(householdId,event){const set=clients.get(householdId);if(!set)return;for(const res of set){res.write(`data: ${JSON.stringify(event)}\n\n`)}}
async function log(hid,uid,action,itemName){await pool.query('insert into shopping_app.activity(id,household_id,user_id,action,item_name) values($1,$2,$3,$4,$5)',[crypto.randomUUID(),hid,uid,action,itemName||null])}
function staticFile(req,res){let p=new URL(req.url,'http://x').pathname;if(p==='/')p='/index.html';const safe=path.normalize(p).replace(/^\.\.(\/|\\|$)/,'');const file=path.join(__dirname,safe);if(!file.startsWith(__dirname)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return false;const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};res.writeHead(200,{'content-type':types[ext]||'application/octet-stream'});fs.createReadStream(file).pipe(res);return true}

const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':ORIGIN,'access-control-allow-credentials':'true','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS'});return res.end()}
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/health')return send(res,200,{ok:true,database:!!pool});
  if(!pool&&u.pathname.startsWith('/api/'))return send(res,503,{error:'Η βάση δεδομένων δεν έχει συνδεθεί ακόμη.'});
  if(u.pathname==='/api/signup'&&req.method==='POST'){
    const b=await body(req);if(!b.email||!b.password||String(b.password).length<6)return send(res,400,{error:'Χρειάζεται email και κωδικός τουλάχιστον 6 χαρακτήρων.'});
    const id=crypto.randomUUID(),hash=await bcrypt.hash(String(b.password),12);
    try{await pool.query('insert into shopping_app.users(id,email,password_hash,display_name) values($1,$2,$3,$4)',[id,String(b.email).toLowerCase(),hash,b.displayName||'']);}
    catch(e){if(e.code==='23505')return send(res,409,{error:'Υπάρχει ήδη λογαριασμός με αυτό το email.'});throw e}
    const t=jwt.sign({sub:id,email:String(b.email).toLowerCase()},JWT_SECRET,{expiresIn:'30d'});return send(res,201,{token:t,user:{id,email:String(b.email).toLowerCase(),displayName:b.displayName||''}});
  }
  if(u.pathname==='/api/login'&&req.method==='POST'){
    const b=await body(req);const r=await pool.query('select * from shopping_app.users where email=$1',[String(b.email||'').toLowerCase()]);const user=r.rows[0];
    if(!user||!(await bcrypt.compare(String(b.password||''),user.password_hash)))return send(res,401,{error:'Λάθος email ή κωδικός.'});
    const t=jwt.sign({sub:user.id,email:user.email},JWT_SECRET,{expiresIn:'30d'});return send(res,200,{token:t,user:{id:user.id,email:user.email,displayName:user.display_name}});
  }
  if(!u.pathname.startsWith('/api/')){if(staticFile(req,res))return;res.writeHead(404);return res.end('Not found')}
  const a=auth(req);if(!a)return send(res,401,{error:'Χρειάζεται σύνδεση.'});
  if(u.pathname==='/api/me'&&req.method==='GET'){const h=await firstHousehold(a.sub);return send(res,200,{user:{id:a.sub,email:a.email},household:h})}
  if(u.pathname==='/api/households'&&req.method==='POST'){const b=await body(req),hid=crypto.randomUUID(),code=crypto.randomBytes(4).toString('hex').toUpperCase();await pool.query('insert into shopping_app.households(id,name,invite_code,created_by) values($1,$2,$3,$4)',[hid,b.name||'Το σπίτι μας',code,a.sub]);await pool.query('insert into shopping_app.memberships(user_id,household_id,role) values($1,$2,$3)',[a.sub,hid,'owner']);return send(res,201,{id:hid,name:b.name||'Το σπίτι μας',inviteCode:code})}
  if(u.pathname==='/api/households/join'&&req.method==='POST'){const b=await body(req);const r=await pool.query('select id,name,invite_code from shopping_app.households where invite_code=$1',[String(b.inviteCode||'').toUpperCase()]);if(!r.rowCount)return send(res,404,{error:'Ο κωδικός πρόσκλησης δεν βρέθηκε.'});await pool.query('insert into shopping_app.memberships(user_id,household_id) values($1,$2) on conflict do nothing',[a.sub,r.rows[0].id]);return send(res,200,{id:r.rows[0].id,name:r.rows[0].name,inviteCode:r.rows[0].invite_code})}
  const h=await firstHousehold(a.sub);if(['/api/items','/api/events','/api/activity'].includes(u.pathname)&&!h)return send(res,409,{error:'Δημιούργησε ή μπες πρώτα σε κοινή λίστα.'});
  if(u.pathname==='/api/events'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':ORIGIN});if(!clients.has(h.id))clients.set(h.id,new Set());clients.get(h.id).add(res);res.write('event: ready\ndata: {}\n\n');req.on('close',()=>clients.get(h.id)?.delete(res));return}
  if(u.pathname==='/api/items'&&req.method==='GET'){const r=await pool.query('select * from shopping_app.items where household_id=$1 order by created_at desc',[h.id]);return send(res,200,{items:r.rows})}
  if(u.pathname==='/api/items'&&req.method==='POST'){const b=await body(req),iid=crypto.randomUUID();const r=await pool.query(`insert into shopping_app.items(id,household_id,name,quantity,unit,category,store,note,priority,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10) returning *`,[iid,h.id,b.name,b.quantity||1,b.unit||'τεμ.',b.category||'Άλλα',b.store||'',b.note||'',b.priority||'normal',a.sub]);await log(h.id,a.sub,'add',b.name);emit(h.id,{type:'items_changed'});return send(res,201,{item:r.rows[0]})}
  const m=u.pathname.match(/^\/api\/items\/([0-9a-f-]+)$/);
  if(m&&req.method==='PATCH'){const iid=m[1],b=await body(req);const allowed=['name','quantity','unit','category','store','note','priority','status'];const sets=[],vals=[];let n=1;for(const k of allowed)if(Object.prototype.hasOwnProperty.call(b,k)){sets.push(`${k}=$${n++}`);vals.push(b[k])}sets.push(`updated_at=now()`);if(b.status==='purchased')sets.push('purchased_at=now()');if(b.status==='active')sets.push('purchased_at=null');vals.push(iid,h.id);const r=await pool.query(`update shopping_app.items set ${sets.join(',')} where id=$${n++} and household_id=$${n} returning *`,vals);if(!r.rowCount)return send(res,404,{error:'Το προϊόν δεν βρέθηκε.'});await log(h.id,a.sub,'update',r.rows[0].name);emit(h.id,{type:'items_changed'});return send(res,200,{item:r.rows[0]})}
  if(u.pathname==='/api/activity'&&req.method==='GET'){const r=await pool.query('select a.*,u.display_name,u.email from shopping_app.activity a join shopping_app.users u on u.id=a.user_id where household_id=$1 order by created_at desc limit 200',[h.id]);return send(res,200,{activity:r.rows})}
  return send(res,404,{error:'Δεν βρέθηκε η λειτουργία.'});
 }catch(e){console.error(e);send(res,500,{error:'Κάτι πήγε στραβά. Δοκίμασε ξανά.'})}
});
init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('listening',PORT))).catch(e=>{console.error(e);process.exit(1)});
