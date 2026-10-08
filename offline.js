'use strict';
const OfflineStore=(()=>{
  const DB='psonia-offline-v1',VER=1;
  function open(){return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB,VER);
    r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('cache'))db.createObjectStore('cache');if(!db.objectStoreNames.contains('queue'))db.createObjectStore('queue',{keyPath:'id'})};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  })}
  async function tx(store,mode,fn){const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction(store,mode),s=t.objectStore(store);let req;try{req=fn(s)}catch(e){reject(e);return}t.oncomplete=()=>resolve(req?.result);t.onerror=()=>reject(t.error)})}
  const cacheKey=id=>'list:'+id;
  return {
    async saveList(listId,items){return tx('cache','readwrite',s=>s.put({items,at:Date.now()},cacheKey(listId)))},
    async loadList(listId){return tx('cache','readonly',s=>s.get(cacheKey(listId)))},
    async enqueue(m){const row={id:crypto.randomUUID(),createdAt:Date.now(),retries:0,status:'pending',...m};await tx('queue','readwrite',s=>s.put(row));return row},
    async all(){return tx('queue','readonly',s=>s.getAll())},
    async remove(id){return tx('queue','readwrite',s=>s.delete(id))},
    async update(row){return tx('queue','readwrite',s=>s.put(row))}
  };
})();
