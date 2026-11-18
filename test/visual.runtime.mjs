import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {get} from 'node:http';
import WebSocket from 'ws';
import miniflare from 'miniflare';
import {png,jpg,imageArgs,letteringArgs,bindings,network} from './visual-fixtures.mjs';
const {Miniflare,convertV4MiniflareOptions}=miniflare;
async function runtime(options={}) {
  const net=network(options);
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await readFile(new URL('../.test-build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-11-17',cf:false,inspectorPort:0,
    durableObjects:{EDITORIAL_JOBS:{className:'EditorialJob',useSQLite:true},EDITORIAL_BUDGET:{className:'EditorialBudget',useSQLite:true}},bindings:bindings(),outboundService:net.handler}));
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
