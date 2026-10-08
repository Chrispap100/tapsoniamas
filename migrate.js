const fs=require('fs');
const path=require('path');

async function runMigrations(pool){
  await pool.query(`create schema if not exists shopping_app;
    create table if not exists shopping_app.schema_migrations(
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
  const dir=path.join(__dirname,'migrations');
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files){
    const exists=await pool.query('select 1 from shopping_app.schema_migrations where version=$1',[file]);
    if(exists.rowCount)continue;
    const sql=fs.readFileSync(path.join(dir,file),'utf8');
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into shopping_app.schema_migrations(version) values($1)',[file]);
      await client.query('commit');
      console.log('migration applied',file);
    }catch(e){
      await client.query('rollback');
      throw e;
    }finally{client.release()}
  }
}
module.exports={runMigrations};
