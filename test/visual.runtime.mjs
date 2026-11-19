import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {get} from 'node:http';
import WebSocket from 'ws';
import miniflare from 'miniflare';
import {png,jpg,imageArgs,letteringArgs,bindings,network} from './visual-fixtures.mjs';
import {sha256,stable} from '../src/io.mjs';
const {Miniflare,convertV4MiniflareOptions}=miniflare;
async function runtime(options={}) {
  const net=network(options);
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await readFile(new URL('../.test-build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-11-17',cf:false,inspectorPort:0,
    durableObjects:{EDITORIAL_JOBS:{className:'EditorialJob',useSQLite:true},EDITORIAL_BUDGET:{className:'EditorialBudget',useSQLite:true}},bindings:{...bindings(),...options.bindings},outboundService:net.handler}));
  const call=async(args,name='review_illustration')=>(await(await mf.dispatchFetch('https://reviewer.test/mcp',{method:'POST',headers:{'x-api-key':'test-mcp-token'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
  return {mf,net,call};
}
test('Cloudflare runtime: private PNG/JPEG, SQLite replay, original lettering normalization and deletion',async()=>{
  const files=new Map([['test-image-001',png()],['test-image-002',jpg()]]);
  const r=await runtime({files,metadata:m=>{if(m.id==='test-image-002')m.mimeType='image/jpeg';}});
  try {
    const args=imageArgs();args.images.push({role:'crop',label:'Synthetic detail',drive_file_id:'test-image-002'});
    const result=await r.call(args);assert.ok(!result.isError,JSON.stringify(result));assert.equal(r.net.inferences().length,1);assert.equal(r.net.deletes().length,2);
    assert.deepEqual(await r.call(args),result);assert.equal(r.net.inferences().length,1);
    const lettering=await r.call(letteringArgs({focus_rules:['L05']}),'review_comic_lettering');assert.ok(!lettering.isError,JSON.stringify(lettering));assert.equal(lettering.structuredContent.review.balloon_results[0].tail_mark,'NOT_TESTED');
  }finally{await r.mf.dispose();}
});
async function inspector(mf) {
  const endpoint=await mf.getInspectorURL();
  endpoint.protocol='http:';
  const list=await new Promise((resolve,reject)=>get(new URL('/json/list',endpoint),r=>{
    let body='';r.setEncoding('utf8');r.on('data',x=>body+=x);r.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});
  }).on('error',reject));
  const target=list.find(x=>x.webSocketDebuggerUrl&&x.title?.includes('worker'))??list.find(x=>x.webSocketDebuggerUrl);
  if(!target)throw Error('No workerd inspector target.');
  const ws=new WebSocket(target.webSocketDebuggerUrl,{handshakeTimeout:5000});await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let sequence=0;const pending=new Map();
  ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id&&pending.has(data.id)){const p=pending.get(data.id);pending.delete(data.id);if(data.error)p.reject(Error(data.error.message));else p.resolve(data.result);}});
  return {call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector command timed out: '+method));},5000);pending.set(id,{resolve:x=>{clearTimeout(timer);resolve(x);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});},close(){ws.close();}};
}
test('Cloudflare runtime: large sequential PNG batch stays below 96 MiB measured V8 heap and backing storage',async t=>{
  // Two near-maximum compressed buffers plus four small images: just under 30 MiB
  // encoded, 8 million aggregate pixels. Incompressible stored DEFLATE blocks.
  const files=new Map([['test-image-001',png(4096,1279,{level:0})],['test-image-002',png(4096,639,{level:0})],
    ...Array.from({length:4},(_,i)=>[`test-image-00${i+3}`,png()])]);
  let inspectorClient,peak=0,samples=0;
  const sample=async()=>{if(!inspectorClient)return;const h=await inspectorClient.call('Runtime.getHeapUsage');peak=Math.max(peak,h.usedSize+(h.backingStorageSize??0));samples++;};
  const r=await runtime({files,handle:async()=>{await sample();}});
  let timer;
  try {
    await r.mf.ready;inspectorClient=await inspector(r.mf);timer=setInterval(()=>{void sample().catch(()=>{});},10);
    const args=imageArgs({max_cost_usd:0.5});args.images=[...files.keys()].map((drive_file_id,i)=>({role:i?'crop':'page',label:`Synthetic ${i}`,drive_file_id}));
    const result=await r.call(args);assert.ok(!result.isError,JSON.stringify(result));await sample();
    assert.equal(r.net.uploads(),6);assert.equal(r.net.deletes().length,6);assert.ok(samples>20);
    t.diagnostic(`Measured peak V8 heap + backing storage: ${(peak/1024**2).toFixed(2)} MiB across ${samples} samples (native runtime overhead excluded).`);
    assert.ok(peak<96*1024**2,`Measured ${peak} bytes exceeds the 96 MiB acceptance ceiling.`);
  }finally{clearInterval(timer);inspectorClient?.close();await r.mf.dispose();}
});

test('Cloudflare runtime: bounded JPEG decoder and subsequent upload remain below memory ceiling',async t=>{
  const files=new Map([['test-image-001',jpg(1280,1280)]]);let client,peak=0;
  const sample=async()=>{if(client){const h=await client.call('Runtime.getHeapUsage');peak=Math.max(peak,h.usedSize+(h.backingStorageSize??0));}};
  const r=await runtime({files,mime:'image/jpeg',handle:sample});let timer;
  try{
    await r.mf.ready;client=await inspector(r.mf);timer=setInterval(()=>{void sample().catch(()=>{});},10);
    const result=await r.call(imageArgs());assert.ok(!result.isError,JSON.stringify(result));await sample();
    assert.ok(peak<96*1024**2);t.diagnostic(`JPEG measured peak V8 heap + backing storage: ${(peak/1024**2).toFixed(2)} MiB (native runtime overhead excluded).`);
  }finally{clearInterval(timer);client?.close();await r.mf.dispose();}
});

function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
const timingBindings={TEST_SHORT_DEADLINES:'1'};
const budgetOf=result=>result.structuredContent.private_image_handling.budget;

test('workerd admits a completed inference longer than the minimum when preparation is fast',async()=>{
  const r=await runtime({bindings:timingBindings,handle:async(req,url)=>{
    if(url.pathname==='/v1/responses')await delay(2200);
  }});
  try{
    const result=await r.call(imageArgs());
    assert.ok(!result.isError,JSON.stringify(result));assert.equal(budgetOf(result).settled_usd,0.01);
    assert.equal(budgetOf(result).refunded_usd,0.29);assert.equal(r.net.inferences().length,1);
    assert.equal(r.net.deletes().length,1);
  }finally{await r.mf.dispose();}
});

test('workerd blocks slow preparation and cleans the upload before any paid submission',async()=>{
  const r=await runtime({bindings:timingBindings,handle:async(req,url)=>{
    if(url.pathname.endsWith('/input_tokens'))await delay(1750);
  }});
  try{
    const result=await r.call(imageArgs());
    assert.ok(result.isError);assert.equal(r.net.uploads(),1);assert.equal(r.net.deletes().length,1);
    assert.equal(r.net.inferences().length,0);assert.equal(budgetOf(result).reserved_usd,0);
  }finally{await r.mf.dispose();}
});
test('workerd rejects a late internal admission before preparation',async()=>{
  const r=await runtime();
  try{
    const args=imageArgs(),name='review_illustration',id=await sha256('visual-v5.1:'+args.request_key);
    const ns=await r.mf.getDurableObjectNamespace('EDITORIAL_JOBS');
    const response=await ns.get(ns.idFromName(id)).fetch('https://editorial.internal/visual',{
      method:'POST',body:JSON.stringify({name,args,id,fingerprint:await sha256(stable({name,args})),started_at:Date.now()-46_000})});
    assert.match((await response.json()).content[0].text,/deadline expired before admission/);assert.equal(r.net.calls.length,0);
  }finally{await r.mf.dispose();}
});
test('workerd inference timeout retains the reservation, deletes the upload and replays without a paid retry',async()=>{
  const r=await runtime({bindings:timingBindings,handle:async(req,url)=>{
    if(url.pathname==='/v1/responses')await delay(4200);
  }});
  try{
    const result=await r.call(imageArgs());assert.ok(result.isError,JSON.stringify(result));
    assert.equal(result.structuredContent.private_image_handling.attempt.status,'uncertain');
    const b=budgetOf(result);assert.equal(b.refunded_usd,0);assert.equal(b.reservation_refunded,false);assert.equal(b.settled_usd,0.3);
    assert.deepEqual(await r.call(imageArgs()),result);assert.equal(r.net.inferences().length,1);
    assert.equal(r.net.deletes().length,1);
  }finally{await r.mf.dispose();}
});
test('SQLite ledger shares configured five-dollar capacity and serializes competing releases and reservations',async()=>{
  const r=await runtime({bindings:{EDITORIAL_DAILY_USD:'5',EDITORIAL_MAX_JOB_USD:'3'}});
  try{
    const ns=await r.mf.getDurableObjectNamespace('EDITORIAL_BUDGET');
    const post=async(route,id,amount,fields={})=>ns.get(ns.idFromName('editorial-budget')).fetch('https://budget.internal/'+route,{
      method:'POST',body:JSON.stringify({id:await sha256(id),amount,...fields})});
    assert.equal((await post('reserve','whole-work',3.5)).status,200);
    const blocked=await r.call(imageArgs({max_cost_usd:1.01}));
    assert.ok(blocked.isError);assert.equal(r.net.calls.length,0);
    const visual=await r.call(imageArgs({max_cost_usd:1}));assert.ok(!visual.isError,JSON.stringify(visual));
    // Whole-work + settled visual = 3.51. Only one concurrent 1.00 hold fits.
    const ids=['left','right'];const kind={kind:'visual-v5.1'};
    const holds=await Promise.all(ids.map(id=>post('reserve',id,1,kind)));
    assert.deepEqual(holds.map(x=>x.status).sort(),[200,409]);
    const winner=ids[holds.findIndex(x=>x.ok)];
    const release=()=>post('release',winner,1,{...kind,outcome:'completed',estimated_cost_usd:0.012});
    const [first,second,contender]=await Promise.all([release(),release(),post('reserve','contender',1)]);
    assert.deepEqual(await first.json(),await second.json());
    if(!contender.ok)assert.equal((await post('reserve','contender',1)).status,200);
    assert.equal((await post('reserve','last',0.47)).status,200);
    assert.equal((await post('reserve','overflow',0.001)).status,409);
    assert.equal(r.net.inferences().length,1);
  }finally{await r.mf.dispose();}
});
