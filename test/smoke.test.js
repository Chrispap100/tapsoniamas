const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');

async function waitFor(url,tries=40){
  for(let i=0;i<tries;i++){
    try{const r=await fetch(url);if(r.ok)return r}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('server did not start');
}

test('server serves app and health without database',async t=>{
  const port=19091;
  const child=spawn(process.execPath,['server.js'],{
    env:{...process.env,PORT:String(port),DATABASE_URL:'',APP_ORIGIN:'http://127.0.0.1:'+port},
    stdio:'ignore'
  });
  t.after(()=>child.kill());
  const health=await waitFor('http://127.0.0.1:'+port+'/api/health');
  const data=await health.json();
  assert.equal(data.ok,true);
  assert.equal(data.database,false);
  const root=await fetch('http://127.0.0.1:'+port+'/');
  assert.equal(root.status,200);
  assert.match(await root.text(),/Τα Ψώνια μας/);
});

test('frontend does not persist auth tokens in localStorage or realtime URL',()=>{
  const js=fs.readFileSync('script.js','utf8');
  assert.doesNotMatch(js,/psonia\.token/);
  assert.doesNotMatch(js,/events\?[^\n]*token=/);
  assert.match(js,/credentials:'include'/);
});

test('server uses HttpOnly secure cookie sessions',()=>{
  const src=fs.readFileSync('server.js','utf8');
  assert.match(src,/HttpOnly; Secure; SameSite=Lax/);
  assert.match(src,/shopping_app\.sessions/);
  assert.doesNotMatch(src,/jsonwebtoken/);
});

test('offline queue and PWA protections are present',()=>{
  const offline=fs.readFileSync('offline.js','utf8');
  const sw=fs.readFileSync('sw.js','utf8');
  assert.match(offline,/indexedDB\.open/);
  assert.match(offline,/queue/);
  assert.match(sw,/pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw,/caches\.delete/);
});
