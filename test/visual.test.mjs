import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import worker,{EditorialJobCore,EditorialBudgetCore} from '../src/worker.mjs';
import legacy from '../src/legacy-v4.1.mjs';
import {createLegacyVisual} from '../src/generated/legacy-visual.mjs';
import {validateImage} from '../src/image-validation.mjs';
import {sha256,stable,getLarge} from '../src/io.mjs';
import {LIMITS,readBounded,networkContext} from '../src/visual-limits.mjs';
import {png,jpg,chunk,imageArgs,letteringArgs,responseFor,bindings,network} from './visual-fixtures.mjs';

class Storage {
  data=new Map(); alarm=null;
  async get(k){return Array.isArray(k)?new Map(k.filter(x=>this.data.has(x)).map(x=>[x,structuredClone(this.data.get(x))])):structuredClone(this.data.get(k));}
  async put(k,v){if(typeof k==='object')for(const [key,value]of Object.entries(k))this.data.set(key,structuredClone(value));else this.data.set(k,structuredClone(v));}
  async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])this.data.delete(key);}
  async setAlarm(at){this.alarm=at;}
  async transaction(fn){return fn(this);}
}
function context(){let queue=Promise.resolve();return {storage:new Storage(),blockConcurrencyWhile(fn){const next=queue.then(fn);queue=next.catch(()=>{});return next;}};}
function environment(){const env=bindings(),jobs=new Map(),budget=new EditorialBudgetCore(context(),env);
  env.EDITORIAL_BUDGET={idFromName:x=>x,get:()=>({fetch:(u,i)=>budget.fetch(new Request(u,i))})};
  env.EDITORIAL_JOBS={idFromName:x=>x,get:id=>({fetch:(u,i)=>{if(!jobs.has(id))jobs.set(id,new EditorialJobCore(context(),env));return jobs.get(id).fetch(new Request(u,i));}})};
  return {env,jobs,budget};
}
const rpc=(name,args,env)=>new Request('https://reviewer.test/mcp',{method:'POST',headers:{'x-api-key':env.MCP_ACCESS_TOKEN},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:args}})});
async function call(env,args=imageArgs(),name='review_illustration'){return (await(await worker.fetch(rpc(name,args,env),env)).json()).result;}
function setup(t,options={}){const net=network(options);t.mock.method(globalThis,'fetch',net.handler);return {...environment(),net};}
const message=r=>r.content.map(x=>x.text).join('\n');

test('generated wrapper exactly matches the protected source and regeneration',async()=>{
  execFileSync(process.execPath,['scripts/generate-legacy-visual.mjs','--check']);
  assert.equal(await sha256(await readFile(new URL('../src/legacy-v4.1.mjs',import.meta.url))),'e34303574abc69b64666621d74edce0cef9dc2687641bd5ff22ae517f10a3950');
});
for(const [name,factory]of [['review_illustration',imageArgs],['review_comic_lettering',letteringArgs]]) {
  for(const locator of ['https://images.example.com/synthetic.png','data:image/png;base64,iVBORw0KGgo='])test(`${name}: successful URL/data legacy parity (${locator.startsWith('data')?'data':'HTTPS'})`,async t=>{
    const env=bindings(),args=factory();delete args.request_key;delete args.max_cost_usd;
    args.images=args.images.map(({drive_file_id,...x})=>({...x,image_url:locator}));
    const payloads=[],transport=async(u,i)=>{payloads.push(JSON.parse(i.body));return Response.json(responseFor(payloads.at(-1)));};
    t.mock.method(globalThis,'fetch',transport);
    const old=await(await legacy.fetch(rpc(name,args,env),env)).json();
    assert.ok(!old.result.isError,message(old.result));
    const wrapped=await(await createLegacyVisual(transport).fetch(rpc(name,args,env),env)).json();
    const now=await(await worker.fetch(rpc(name,args,env),env)).json();
    assert.deepEqual(wrapped,old);assert.deepEqual(now,old);assert.deepEqual(payloads[0],payloads[1]);assert.deepEqual(payloads[1],payloads[2]);
  });
  test(`${name}: private success preserves editorial result and exact file-backed payload`,async t=>{
    let counted,inferred,uploaded;
    const {env,net}=setup(t,{counted:x=>counted=x,inferred:x=>inferred=x,uploaded:x=>uploaded=x});
    const r=await call(env,factory(),name);assert.ok(!r.isError,message(r));
    assert.equal(r.structuredContent.review.verdict,'PASS');
    assert.equal(net.inferences().length,1);assert.equal(net.uploads(),1);assert.equal(net.deletes().length,1);
    assert.equal(uploaded.get('purpose'),'user_data');assert.equal(uploaded.get('expires_after[seconds]'),'86400');
    assert.deepEqual(new Uint8Array(await uploaded.get('file').arrayBuffer()),new Uint8Array(png()));
    assert.deepEqual(counted.input,inferred.input);assert.deepEqual(counted.text,inferred.text);assert.equal(counted.instructions,inferred.instructions);
    assert.equal(inferred.store,false);assert.equal(inferred.background,false);assert.equal(inferred.service_tier,'default');
    const input=inferred.input[0].content.filter(x=>x.type==='input_image');assert.deepEqual(input,[{type:'input_image',file_id:'file_test_1',detail:'original'}]);
    const h=r.structuredContent.private_image_handling;assert.equal(h.sources[0].sha256,await sha256(png()));assert.equal(h.sources[0].originalFilename,'synthetic-original.png');assert.equal(h.budget.reserved_usd,0.3);assert.equal(h.cleanup.pending_file_ids.length,0);
  });
}
test('full and selected lettering rules still reconcile through the generated original',async t=>{
  const {env}=setup(t);const r=await call(env,letteringArgs({focus_rules:['L05']}),'review_comic_lettering');
  assert.ok(!r.isError,message(r));assert.equal(r.structuredContent.review.balloon_results[0].tail_mark,'NOT_TESTED');assert.equal(r.structuredContent.review.balloon_results[0].placement_mark,'PASS');
});
for(const [label,change] of [
  ['both locators',a=>a.images[0].image_url='https://images.example.com/a.png'],
  ['mixed locators',a=>a.images.push({role:'crop',label:'Crop',image_url:'https://images.example.com/a.png'})],
  ['missing page',a=>a.images[0].role='crop'],['two pages',a=>a.images.push({...a.images[0]})],
  ['too many images',a=>a.images.push(...Array.from({length:6},()=>({...a.images[0],role:'crop'})))],
  ['invalid id',a=>a.images[0].drive_file_id='../bad'],['missing cap',a=>delete a.max_cost_usd],
  ['over cap',a=>a.max_cost_usd=1.01],['missing request key',a=>delete a.request_key],
  ['oversized JSON',a=>a.padding='x'.repeat(LIMITS.jsonBytes)],['oversized script',a=>a.script='x'.repeat(12001)]
])test(`private validation rejects ${label} before any network`,async t=>{const {env,net}=setup(t),a=imageArgs();change(a);assert.equal((await call(env,a)).isError,true);assert.equal(net.calls.length,0);});
test('lettering reference role is rejected before network',async t=>{const {env,net}=setup(t),a=letteringArgs();a.images.push({...a.images[0],role:'reference'});assert.equal((await call(env,a,'review_comic_lettering')).isError,true);assert.equal(net.calls.length,0);});
for(const [label,change]of [
  ['external parent',m=>m.parents=['test-external-folder']],['reports parent',m=>m.parents=['test-reports-folder']],
  ['trashed',m=>m.trashed=true],['shortcut',m=>m.shortcutDetails={targetId:'test-image-002'}],
  ['unsupported MIME',m=>m.mimeType='image/webp'],['oversized bytes',m=>m.size=String(LIMITS.fileBytes+1)],
])test(`workspace preflight rejects ${label} without media`,async t=>{const {env,net}=setup(t,{metadata:m=>{if(m.id==='test-image-001')change(m);}});const r=await call(env);assert.equal(r.isError,true,message(r));assert.equal(net.media().length,0);assert.equal(net.inferences().length,0);});
test('all metadata is authorized before first media read',async t=>{const {env,net}=setup(t,{metadata:m=>{if(m.id==='test-image-002')m.parents=['test-reports-folder'];}});const a=imageArgs();a.images.push({...a.images[0],role:'crop',drive_file_id:'test-image-002'});assert.equal((await call(env,a)).isError,true);assert.equal(net.media().length,0);});
test('reference role uses references and no context configuration is fetched',async t=>{
  const files=new Map([['test-image-001',png()],['test-image-002',png()]]);
  const {env,net}=setup(t,{files,metadata:m=>{if(m.id==='test-image-002')m.parents=['test-references'];}});
  env.PROJECT_CONTEXT_FILE_IDS='test-never-read';const a=imageArgs();a.images.push({...a.images[0],role:'reference',drive_file_id:'test-image-002'});
  assert.ok(!(await call(env,a)).isError);assert.equal(net.media().length,2);assert.ok(!net.calls.some(x=>x.url.href.includes('test-never-read')));
});
for(const field of ['version','modifiedTime','name','originalFilename','headRevisionId','parents','size'])test(`source change in ${field} blocks inference and cleans known uploads`,async t=>{
  const {env,net}=setup(t,{metadata:(m,calls)=>{if(m.id==='test-image-001'&&calls.some(x=>x.url.pathname==='/v1/files'))m[field]=field==='parents'?['test-references']:'changed';}});
  const r=await call(env);assert.equal(r.isError,true);assert.match(message(r),/changed/);assert.equal(net.inferences().length,0);assert.equal(net.deletes().length,1);
});
test('aggregate metadata bytes reject before media',async t=>{
  const {env,net}=setup(t,{metadata:m=>{if(m.id.startsWith('test-image'))m.size=String(16*1024**2);}}),a=imageArgs();
  a.images.push({...a.images[0],role:'crop',drive_file_id:'test-image-002'});assert.match(message(await call(env,a)),/30 MiB/);assert.equal(net.media().length,0);
});
test('duplicate key replays identical success without any network or reservation',async t=>{const {env,net}=setup(t);const r=await call(env),count=net.calls.length;assert.deepEqual(await call(env),r);assert.equal(net.calls.length,count);assert.equal(net.inferences().length,1);});
test('key fingerprint includes tool and all arguments',async t=>{const {env,net}=setup(t);await call(env);assert.match(message(await call(env,imageArgs({brief:'Different'}))),/different arguments/);assert.equal(net.inferences().length,1);});
test('shared budget checks the full requested authorization against existing jobs',async t=>{
  const {env,net,budget}=setup(t);await budget.fetch(new Request('https://budget.internal/reserve',{method:'POST',body:JSON.stringify({id:'a'.repeat(64),amount:0.8})}));
  const r=await call(env);assert.match(message(r),/daily budget/);assert.equal(net.inferences().length,0);assert.equal(net.deletes().length,1);
});
for(const [label,opts] of [['excessive tokens',{tokens:200000}],['invalid count',{tokens:null}],['over authorized estimate',{tokens:60000}]])test(`budget rejects ${label}`,async t=>{const {env,net}=setup(t,opts);assert.equal((await call(env)).isError,true);assert.equal(net.inferences().length,0);assert.equal(net.deletes().length,1);});
test('pricing must match resolved vision model before network',async t=>{const {env,net}=setup(t);env.OPENAI_VISION_MODEL='test-unpriced-model';assert.match(message(await call(env)),/pricing model/);assert.equal(net.calls.length,0);});
for(const [label,mutate]of [['missing usage',r=>delete r.usage],['incomplete',r=>r.status='incomplete'],['refusal',r=>r.output[0].content=[{type:'refusal'}]],['invalid JSON',r=>r.output[0].content[0].text='no'],['malformed review',r=>r.output[0].content[0].text='{}'],['excess usage',r=>r.usage.output_tokens=100000]])test(`provider ${label} fails closed, cleans uploads and never repeats`,async t=>{
  const {env,net}=setup(t,{response:p=>{const r=responseFor(p);mutate(r);return r;}});assert.equal((await call(env)).isError,true);assert.equal((await call(env)).isError,true);assert.equal(net.inferences().length,1);assert.equal(net.deletes().length,1);
});
test('lost inference response retains reservation and cannot resubmit',async t=>{
  const {env,net,jobs}=setup(t,{handle:async(r,u)=>{if(u.pathname==='/v1/responses')throw Error('Simulated interruption');}});
  const r=await call(env);assert.equal(r.isError,true);assert.equal(r.structuredContent.private_image_handling.budget.reserved_usd,0.3);
  assert.equal((await call(env)).isError,true);const job=[...jobs.values()][0];job.ctx.storage.data.get('visual').created_at=0;await job.alarm();assert.equal(net.inferences().length,1);
});
test('upload response loss records expiry fallback without inference',async t=>{
  const {env,net}=setup(t,{handle:async(r,u)=>{if(u.pathname==='/v1/files')throw Error('Upload outcome unknown');}});
  const r=await call(env);assert.equal(r.isError,true);assert.equal(r.structuredContent.private_image_handling.cleanup.unknown_upload,true);assert.equal(net.inferences().length,0);
});
test('cleanup failure is durable and alarm retries deletions only',async t=>{
  let fail=true;const {env,net,jobs}=setup(t,{handle:async(r)=>r.method==='DELETE'&&fail?new Response('',{status:503}):null});
  const r=await call(env);assert.equal(r.structuredContent.private_image_handling.cleanup.pending_file_ids.length,1);
  fail=false;await [...jobs.values()][0].alarm();const replay=await call(env);assert.equal(replay.structuredContent.private_image_handling.cleanup.pending_file_ids.length,0);assert.equal(net.inferences().length,1);
});
test('a durable submitting marker survives restart and expiry without refund or paid retry',async t=>{
  const {env,net,budget,jobs}=setup(t);
  const args=imageArgs(),name='review_illustration',id=await sha256('visual-v5.1:'+args.request_key);
  await ledgerCall(budget,'reserve',{id,kind:'visual-v5.1',amount:args.max_cost_usd});
  const restarted=new EditorialJobCore(context(),env);jobs.set(id,restarted);
  await restarted.ctx.storage.put('visual',{id,kind:'visual-v5.1',fingerprint:await sha256(stable({name,args})),
    state:'submitting',api_calls:1,created_at:0,files:['file_test_1'],cleanup_rounds:0,
    reservation_status:'reserved',reserved_usd:args.max_cost_usd,authorized_usd:args.max_cost_usd});
  await restarted.alarm();
  const result=await call(env,args),receipt=reviewBudget(result);
  assert.equal(result.structuredContent.private_image_handling.attempt.status,'uncertain');
  assert.equal(receipt.settled_usd,args.max_cost_usd);assert.equal(receipt.refunded_usd,0);
  assert.equal(net.deletes().length,1);
  const done=await restarted.ctx.storage.get('visual');done.finished_at=1;
  await restarted.ctx.storage.put('visual',done);await restarted.alarm();
  assert.equal(await getLarge(restarted.ctx.storage,'visual-result'),null);
  assert.equal((await restarted.ctx.storage.get('visual')).state,'expired');
  assert.equal((await call(env,args)).isError,true);assert.equal(net.inferences().length,0);
});
test('redirects are rejected without following or forwarding credentials',async t=>{const {env,net}=setup(t,{handle:async(r,u)=>u.searchParams.has('alt')?new Response(null,{status:302,headers:{location:'https://other.example.com/image'}}):null});assert.equal((await call(env)).isError,true);assert.equal(net.inferences().length,0);assert.ok(net.calls.every(x=>!x.url.hostname.includes('other.')));});
test('streamed oversize and stalled bodies cancel the reader',async()=>{
  let cancelled=false;const r=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}}));await assert.rejects(readBounded(r,4),/byte limit/);assert.equal(cancelled,true);
  const abort=new AbortController(),stalled=new Response(new ReadableStream({cancel(){cancelled=true;}}));const promise=readBounded(stalled,4,abort.signal);abort.abort();await assert.rejects(promise,/deadline/);
});
test('subrequest limit fails closed',async()=>{const ctx=networkContext(Date.now()+1000,{count:LIMITS.subrequests});await assert.rejects(ctx.fetch('https://never.example.com'),/subrequest/);});
for(const [format,bytes,mime]of [['PNG',png(),'image/png'],['JPEG',jpg(),'image/jpeg']])test(`fully validates synthetic ${format}`,async()=>{const info=await validateImage(new Uint8Array(bytes),mime);assert.equal(info.width,2);assert.equal(info.height,2);});
for(const [label,bytes,mime]of [
  ['truncated PNG',png().subarray(0,-3),'image/png'],['CRC mismatch',(()=>{const b=png();b[40]^=1;return b;})(),'image/png'],
  ['invalid filter',png(2,2,{filter:5}),'image/png'],['pixel bomb',png(4000,2001),'image/png'],
  ['side limit',png(4097,1),'image/png'],['inflate bomb',png(1,1,{rawOverride:Buffer.alloc(100000)}),'image/png'],
  ['palette index',png(1,1,{color:3,rawOverride:Buffer.from([0,1])}),'image/png'],
  ['animation',png(2,2,{extra:chunk('acTL',Buffer.alloc(8))}),'image/png'],
  ['truncated JPEG',jpg().subarray(0,-2),'image/jpeg'],['MIME mismatch',jpg(),'image/png'],
  ['fake JPEG',Buffer.from([255,216,255,217]),'image/jpeg']
])test(`rejects image ${label}`,async()=>{await assert.rejects(validateImage(new Uint8Array(bytes),mime));});
test('aggregate pixels checked before full decode',async()=>{await assert.rejects(validateImage(new Uint8Array(png()),'image/png',undefined,3),/aggregate/);});
test('legacy request character cap still rejects oversized bodies',async()=>{const env=bindings(),r=rpc('independent_review',{material:'x'.repeat(16_000_000)},env);assert.equal((await worker.fetch(r,env)).status,413);});

test('concurrent duplicate and another key cannot overlap private preparation',async t=>{
  let release,started;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const {env,net}=setup(t,{handle:async(r,u)=>{if(u.searchParams.has('alt')){started();await gate;}}});
  const first=call(env);await waiting;
  const same=await call(env),other=await call(env,imageArgs({request_key:'test-other-key'}));
  assert.match(message(same),/in progress/);assert.match(message(other),/busy/);release();assert.ok(!(await first).isError);assert.equal(net.inferences().length,1);
  assert.ok(!(await call(env,imageArgs({request_key:'test-other-key'}))).isError);assert.equal(net.inferences().length,2);
});
test('final source check also runs after token counting',async t=>{
  const {env,net}=setup(t,{metadata:(m,calls)=>{if(m.id==='test-image-001'&&calls.some(x=>x.url.pathname.endsWith('/input_tokens')))m.version='2';}});
  assert.match(message(await call(env)),/Source changed/);assert.equal(net.inferences().length,0);assert.equal(net.deletes().length,1);
});
test('cleanup recovery stops after four rounds and never repeats inference',async t=>{
  const {env,net,jobs}=setup(t,{handle:async r=>r.method==='DELETE'?new Response('',{status:503}):null});await call(env);
  const job=[...jobs.values()][0];for(let i=0;i<6;i++)await job.alarm();assert.equal(net.deletes().length,4);assert.equal(net.inferences().length,1);
  assert.equal((await call(env)).structuredContent.private_image_handling.cleanup.pending_file_ids.length,1);
});
test('ambiguous reservation is reported without attempting inference',async t=>{
  const {env,net,budget}=setup(t);env.EDITORIAL_BUDGET.get=()=>({fetch:async(u,i)=>{await budget.fetch(new Request(u,i));throw Error('Simulated lost reservation response');}});
  const result=await call(env);assert.equal(result.isError,true);assert.equal(result.structuredContent.private_image_handling.budget.reservation_status,'unknown');assert.equal(net.inferences().length,0);assert.equal(net.deletes().length,1);
});
test('metadata ancestry cycles and multiple parents fail closed',async t=>{
  const {env,net}=setup(t,{metadata:m=>{if(m.id==='test-image-001')m.parents=['test-submissions','test-reports-folder'];}});
  assert.equal((await call(env)).isError,true);assert.equal(net.media().length,0);
});
test('JPEG resource guard rejects an oversized decoder frame before allocation',async()=>{
  const bytes=new Uint8Array(jpg());let p=2;
  while(p<bytes.length){const marker=bytes[p+1],size=(bytes[p+2]<<8)|bytes[p+3];if(marker===192){bytes[p+5]=7;bytes[p+6]=208;bytes[p+7]=15;bytes[p+8]=160;break;}p+=size+2;}
  await assert.rejects(validateImage(bytes,'image/jpeg'),/decoder allocation/);
});
test('JPEG EXIF orientation is recorded without changing transmitted bytes',async t=>{
  const exif=Buffer.alloc(32);exif.write('Exif\0\0',0,'binary');exif.write('II',6);exif.writeUInt16LE(42,8);exif.writeUInt32LE(8,10);exif.writeUInt16LE(1,14);exif.writeUInt16LE(0x112,16);exif.writeUInt16LE(3,18);exif.writeUInt32LE(1,20);exif.writeUInt16LE(6,24);
  const segment=Buffer.alloc(4);segment[0]=255;segment[1]=225;segment.writeUInt16BE(exif.length+2,2);const base=jpg(),bytes=Buffer.concat([base.subarray(0,2),segment,exif,base.subarray(2)]);
  let uploaded;const {env}=setup(t,{files:new Map([['test-image-001',bytes]]),mime:'image/jpeg',uploaded:x=>uploaded=x});
  const result=await call(env);assert.ok(!result.isError,message(result));assert.equal(result.structuredContent.private_image_handling.sources[0].orientation,6);assert.deepEqual(new Uint8Array(await uploaded.get('file').arrayBuffer()),new Uint8Array(bytes));
});
test('private pixel aggregate rejects the later image and cleans earlier uploads',async t=>{
  const bytes=png(4000,2000),files=new Map([['test-image-001',bytes],['test-image-002',bytes],['test-image-003',png()]]);
  const {env,net}=setup(t,{files});const args=imageArgs();args.images=[...files.keys()].map((drive_file_id,i)=>({role:i?'crop':'page',label:'Synthetic',drive_file_id}));
  assert.match(message(await call(env,args)),/aggregate/);assert.equal(net.uploads(),2);assert.equal(net.deletes().length,2);assert.equal(net.inferences().length,0);
});

test('a stalled media body hits the preparation deadline without inference',async t=>{
  const timeout=AbortSignal.timeout.bind(AbortSignal);t.mock.method(AbortSignal,'timeout',ms=>timeout(ms>40000&&ms<=45000?20:ms));
  let cancelled=false;const {env,net}=setup(t,{handle:async(r,u)=>u.searchParams.has('alt')?new Response(new ReadableStream({cancel(){cancelled=true;}})):null});
  // Keep the test event loop alive while the platform timeout fires.
  const keep=setInterval(()=>{},100);try{const result=await call(env);assert.equal(result.isError,true);assert.equal(cancelled,true);assert.equal(net.inferences().length,0);}finally{clearInterval(keep);}
});
test('a deletion response without confirmation remains pending',async t=>{
  const {env}=setup(t,{handle:async r=>r.method==='DELETE'?Response.json({deleted:false}):null});
  const result=await call(env);assert.equal(result.structuredContent.private_image_handling.cleanup.pending_file_ids.length,1);
});

const reviewBudget = result => result.structuredContent.private_image_handling.budget;
const ledgerCall = (budget,route,body) => budget.fetch(new Request('https://budget.internal/'+route,{
  method:'POST',body:JSON.stringify(body)}));

test('settlement uses the original UTC day and immutable receipts across midnight',async t=>{
  const {budget}=environment();
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-01-01T23:59:55Z')});
  const a={id:'a'.repeat(64),kind:'visual-v5.1',amount:0.8};
  await ledgerCall(budget,'reserve',a);
  t.mock.timers.tick(10_000);
  await ledgerCall(budget,'reserve',{...a,id:'b'.repeat(64),amount:1});
  const completed={...a,outcome:'completed',estimated_cost_usd:0.010001};
  const receipt=await (await ledgerCall(budget,'release',completed)).json();
  assert.deepEqual(receipt,{id:a.id,status:'confirmed',day:'2026-01-01',reserved:0.8,settled_usd:0.02,refunded_usd:0.78});
  assert.deepEqual(await (await ledgerCall(budget,'release',completed)).json(),receipt);
  assert.equal((await ledgerCall(budget,'release',{...a,outcome:'unsubmitted'})).status,409);
  assert.equal(await budget.ctx.storage.get('day:2026-01-01'),0.02);
  assert.equal(await budget.ctx.storage.get('day:2026-01-02'),1);
});

test('settlement caps upward rounding at authorization and leaves exact cents alone',async()=>{
  const {budget}=environment();
  for(const [i,amount,cost,settled] of [[1,0.315,0.313,0.315],[2,0.3,0.07,0.07],[3,0.3,0,0]]){
    const body={kind:'visual-v5.1',id:String(i).repeat(64),amount};
    await ledgerCall(budget,'reserve',body);
    const receipt=await(await ledgerCall(budget,'release',{...body,outcome:'completed',estimated_cost_usd:cost})).json();
    assert.equal(receipt.settled_usd,settled);
  }
});
test('numeric-only reservations retain their full debit and cannot credit a guessed day',async()=>{
  const {budget}=environment(),body={id:'f'.repeat(64),amount:0.8,kind:'visual-v5.1'};
  await budget.ctx.storage.put('job:'+body.id,0.8);
  assert.equal((await(await ledgerCall(budget,'reserve',body)).json()).reserved,0.8);
  const receipt=await(await ledgerCall(budget,'release',{...body,outcome:'unsubmitted'})).json();
  assert.equal(receipt.status,'legacy_retained');assert.equal(receipt.refunded_usd,0);
  assert.equal(budget.ctx.storage.data.size,1);
});
test('pre-submission recovery prevents a delayed reserve from charging a closed ID',async()=>{
  const {budget}=environment(),body={id:'d'.repeat(64),amount:1,kind:'visual-v5.1',outcome:'unsubmitted'};
  const receipt=await(await ledgerCall(budget,'release',body)).json();
  assert.equal(receipt.status,'not_reserved');assert.equal(receipt.refunded_usd,0);
  assert.equal((await ledgerCall(budget,'reserve',body)).status,409);
});
test('lost reserve acknowledgement is reconciled as a full pre-submission release',async t=>{
  const {env,net,budget}=setup(t);
  env.EDITORIAL_BUDGET.get=()=>({fetch:async(url,init)=>{
    const response=await budget.fetch(new Request(url,init));
    if(url.endsWith('/reserve'))throw Error('Lost reserve acknowledgement');
    return response;
  }});
  const r=await call(env),b=reviewBudget(r);
  assert.ok(r.isError);assert.equal(b.reservation_refunded,true);assert.equal(b.settled_usd,0);
  assert.equal(b.refunded_usd,0.3);assert.equal(net.inferences().length,0);
});
test('lost settlement response reports pending until restart confirms the same credit',async t=>{
  const {env,net,budget,jobs}=setup(t);let lose=true;
  env.EDITORIAL_BUDGET.get=()=>({fetch:async(url,init)=>{
    const response=await budget.fetch(new Request(url,init));
    if(lose&&url.endsWith('/release'))throw Error('Lost release acknowledgement');
    return response;
  }});
  const result=await call(env),pending=reviewBudget(result);
  assert.ok(!result.isError);assert.equal(pending.settlement_status,'pending');
  assert.equal(pending.reservation_refunded,false);assert.equal(pending.refunded_usd,0);assert.equal(pending.settled_usd,null);
  lose=false;const [job]=jobs.values();const resumed=new EditorialJobCore(job.ctx,env);
  await resumed.alarm();await resumed.alarm();
  const receipt=reviewBudget(await call(env));
  assert.equal(receipt.settlement_status,'confirmed');assert.equal(receipt.refunded_usd,0.29);
  assert.equal(receipt.reservation_refunded,true);assert.equal(receipt.settled_usd,0.01);
  assert.equal(await budget.ctx.storage.get('day:'+receipt.budget_day),0.01);assert.equal(net.inferences().length,1);
});
test('restart after reservation and before paid submission releases all capacity',async t=>{
  const {env,net,budget,jobs}=setup(t);
  const args=imageArgs(),id=await sha256('visual-v5.1:'+args.request_key);
  await ledgerCall(budget,'reserve',{id,kind:'visual-v5.1',amount:args.max_cost_usd});
  const job=new EditorialJobCore(context(),env);jobs.set(id,job);
  await job.ctx.storage.put('visual',{id,fingerprint:await sha256(stable({name:'review_illustration',args})),
    kind:'visual-v5.1',state:'preparing',api_calls:0,created_at:0,files:[],cleanup_rounds:0,
    reservation_status:'unknown',reserved_usd:0,authorized_usd:args.max_cost_usd});
  await job.alarm();const b=reviewBudget(await call(env,args));
  assert.equal(b.refunded_usd,args.max_cost_usd);assert.equal(b.settled_usd,0);assert.equal(net.inferences().length,0);
});
test('untrustworthy usage retains the full paid reservation on replay',async t=>{
  const {env,net}=setup(t,{response:p=>({...responseFor(p),usage:null})});
  const r=await call(env),b=reviewBudget(r);assert.ok(r.isError);assert.equal(b.settled_usd,0.3);
  assert.equal(b.reservation_refunded,false);assert.equal(b.refunded_usd,0);
  assert.deepEqual(await call(env),r);assert.equal(net.inferences().length,1);
});
test('confirmed reservation is fully returned when its acknowledgement arrives too late to submit',async t=>{
  const {env,net,budget}=setup(t);
  env.EDITORIAL_BUDGET.get=()=>({fetch:async(url,init)=>{
    const response=await budget.fetch(new Request(url,init));
    if(url.endsWith('/reserve')){
      const now=Date.now.bind(Date);
      t.mock.method(Date,'now',()=>now()+LIMITS.prepareMs+1);
    }
    return response;
  }});
  const r=await call(env),b=reviewBudget(r);
  assert.match(message(r),/Too little time/);assert.equal(b.reservation_status,'reserved');
  assert.equal(b.refunded_usd,0.3);assert.equal(b.settled_usd,0);assert.equal(b.reservation_refunded,true);
  assert.equal(net.inferences().length,0);assert.equal(net.deletes().length,1);
});
test('a mismatched ledger receipt cannot confirm a refund',async t=>{
  const {env,budget}=setup(t);
  env.EDITORIAL_BUDGET.get=()=>({fetch:async(url,init)=>{
    const response=await budget.fetch(new Request(url,init));
    if(url.endsWith('/release')) return Response.json({...await response.json(),refunded_usd:0.3});
    return response;
  }});
  const budgetResult=reviewBudget(await call(env));
  assert.equal(budgetResult.settlement_status,'pending');assert.equal(budgetResult.reservation_refunded,false);
  assert.equal(budgetResult.refunded_usd,0);assert.equal(budgetResult.settled_usd,null);
});
