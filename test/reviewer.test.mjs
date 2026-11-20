import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{EditorialJobCore,EditorialBudgetCore} from '../src/worker.mjs';
import legacy from '../src/legacy-v4.1.mjs';
import {validateArgs,validateCold,validateReport,phaseInput,CATEGORIES,COLD_SCHEMA,REPORT_SCHEMA} from '../src/editorial.mjs';
import {putLarge,getLarge,sourceBytes,sha256,priceConfig,assertWorkspaceSource,assertWorkspaceFolderLayout,driveAccessMode} from '../src/io.mjs';

const ROOT='root1234567890',SUBMISSIONS='submit1234567890',REFERENCES='references123456',FOLDER='editorial123456',FILE='source1234567890';
const args=()=>({request_key:'unique-request-001',mode:'script',artifact_kind:'script',revision:'test-v3',source:{text:'PAGE 1\nP1.1 Ada opens a box.\nPAGE 2\nP2.1 Ada takes a note.'},expected_pages:2,max_cost_usd:2,panel_manifest:[{page:1,panels:['P1.1']},{page:2,panels:['P2.1']}],reference_file_ids:[]});
const cold=()=>({synopsis:'Ada opens a box and finds a note.',pages:[1,2].map(page=>({page,readable:true,panels:[{panel:`P${page}.1`,observed_action:page===1?'Opens gate.':'Passes through.',causal_link:page===1?'Opening allows passage.':'Gate is already open.',uncertainties:[]}]})),breaks_in_understanding:[],limitations:[]});
const report=()=>({overall_assessment:'The actions form a readable causal sequence.',overall_score:8,verdict:'NO_MATERIAL_ISSUES_FOUND',ratings:CATEGORIES.map(category=>({category,score:8,reason:'Supported by the two-page sequence.'})),findings:[],strengths_to_preserve:['Clear cause and effect.'],revision_priorities:[],limitations:[],change_assessment:{net_change:'not_compared',evidence:[]},prior_issue_status:[]});
const finding=()=>({id:'old-F001',kind:'defect',severity:'major',title:'Unexplained release',evidence:[{source:'current',page:2,panel:'P2.1',observation:'The object falls despite the closed jaws.'}],reader_impact:'Action cannot be followed.',correction_objective:'Make the release visible.',relationships_to_recheck:['Jaw closure and object position.']});
class Storage {
  constructor(){this.data=new Map();this.alarm=null;}
  async get(k){if(Array.isArray(k))return new Map(k.filter(x=>this.data.has(x)).map(x=>[x,structuredClone(this.data.get(x))]));return structuredClone(this.data.get(k));}
  async put(k,v){if(typeof k==='object'){for(const [key,val] of Object.entries(k))this.data.set(key,structuredClone(val));}else this.data.set(k,structuredClone(v));}
  async setAlarm(t){this.alarm=t;}
  async getAlarm(){return this.alarm;}
  async transaction(fn){return fn(this);}
}
function context(){let queue=Promise.resolve();return {storage:new Storage(),blockConcurrencyWhile(fn){const next=queue.then(fn);queue=next.catch(()=>{});return next;}};}
function environment(){
  const env={EDITORIAL_ENABLED:'1',MCP_ACCESS_TOKEN:'test-secret-only',OPENAI_API_KEY:'fake-openai-key',GOOGLE_CLIENT_ID:'fake-client',GOOGLE_CLIENT_SECRET:'fake-secret',GOOGLE_REFRESH_TOKEN:'fake-refresh',WORKSPACE_ROOT_FOLDER_ID:ROOT,SUBMISSIONS_FOLDER_ID:SUBMISSIONS,REFERENCES_FOLDER_ID:REFERENCES,EDITORIAL_FOLDER_ID:FOLDER,DRIVE_ACCESS_MODE:'file',GOOGLE_OAUTH_SCOPE:'https://www.googleapis.com/auth/drive.file',BROAD_DRIVE_SCOPE_ACK:'',EDITORIAL_MAX_JOB_USD:'5',EDITORIAL_DAILY_USD:'10'};
  const jobs=new Map(),budget=new EditorialBudgetCore(context(),env);
  env.EDITORIAL_BUDGET={idFromName:n=>n,get:()=>({fetch:(u,init)=>budget.fetch(new Request(u,init))})};
  env.EDITORIAL_JOBS={idFromName:n=>n,get:id=>({fetch:(u,init)=>{if(!jobs.has(id))jobs.set(id,new EditorialJobCore(context(),env));return jobs.get(id).fetch(new Request(u,init));}})};
  return {env,jobs,budget};
}
const rpc=(name,arguments_,token='test-secret-only')=>new Request('https://reviewer.test/mcp',{method:'POST',headers:{'x-api-key':token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})});
async function call(env,name,a){return (await (await worker.fetch(rpc(name,a),env)).json()).result;}
function mockNetwork(t,options={}){
  const requests=[],saved=[],responses=new Map(),savedById=new Map();let fileNo=0,responseNo=0;
  t.mock.method(globalThis,'fetch',async(url,init={})=>{
    url=String(url);requests.push({url,method:init.method??'GET',init});
    const answer=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
    if(url==='https://oauth2.googleapis.com/token')return answer({access_token:'mock-token',expires_in:3600});
    if(url.startsWith('https://www.googleapis.com/upload/drive/')){
      if(options.saveFails)return answer({},503);
      saved.push(init.body);
      const meta=JSON.parse(init.body.split('\r\n\r\n')[1].split('\r\n--')[0]);
      const data={id:meta.id,name:'report',webViewLink:`https://drive.google.com/file/d/${meta.id}/view`};savedById.set(meta.id,data);
      if(options.lostSaveResponse&&saved.length===1)throw Error('Upload committed; response lost.');
      return answer(data);
    }
    if(url.startsWith('https://www.googleapis.com/drive/v3/files?'))return answer({files:[]});
    if(url.startsWith('https://www.googleapis.com/drive/v3/files/')){
      if(options.driveDenied)return answer({},403);
      const u=new URL(url),id=u.pathname.split('/').at(-1);
      if(id==='generateIds')return answer({ids:['reserved_report_1','reserved_report_2']});
      if(id.startsWith('reserved_report_'))return savedById.has(id)?answer(savedById.get(id)):answer({},404);
      if(u.searchParams.get('alt')==='media')return new Response(options.fileBytes??'%PDF-1.7\nmocked fixture');
      if(u.pathname.endsWith('/export'))return new Response('Google document fixture');
      return answer({id,name:id===FILE?'comic.pdf':'folder',mimeType:id===FILE?'application/pdf':'application/vnd.google-apps.folder',parents:id===ROOT?[]:id===FILE?[options.outsideRoot?'otherroot1234':options.sourceInReports?FOLDER:options.sourceInRefs?REFERENCES:SUBMISSIONS]:[ROOT],version:'1',modifiedTime:'2026-11-17T00:00:00Z'});
    }
    if(url==='https://api.openai.com/v1/files')return answer({id:`file_${++fileNo}`});
    if(url.includes('/files/')&&init.method==='DELETE')return answer({deleted:true});
    if(url.endsWith('/responses/input_tokens'))return answer({input_tokens:options.inputTokens??1000});
    if(url==='https://api.openai.com/v1/responses'){
      if(options.submitNetworkFailure)throw Error('simulated network loss');
      const payload=JSON.parse(init.body),isCold=payload.text?.format?.name==='editorial_cold_read';
      let data=isCold?(options.cold?.()??cold()):(options.report?.()??report());
      if(payload.instructions.includes('Now compare CURRENT'))data={...data,change_assessment:{net_change:'improved',evidence:['The gate now opens before passage.']},prior_issue_status:options.priorRows??[]};
      const response={id:`resp_${++responseNo}`,model:payload.model,status:options.incomplete?'incomplete':'completed',usage:{input_tokens:1000,output_tokens:500},output:[{type:'message',content:options.refusal?[{type:'refusal',refusal:'Cannot assess'}]:[{type:'output_text',text:JSON.stringify(data)}]}]};
      responses.set(response.id,response);return answer(options.async?{id:response.id,status:'queued'}:response);
    }
    if(url.includes('/responses/')&&(init.method==='DELETE'||url.endsWith('/cancel')))return answer({deleted:true});
    if(url.includes('/responses/'))return answer(responses.get(url.split('/').at(-1)));
    throw Error(`Unexpected network request: ${url}`);
  });
  return {requests,saved,responses,inference:()=>requests.filter(x=>x.url==='https://api.openai.com/v1/responses')};
}
async function run(t,options={},input=args()){
  const setup=environment(),network=mockNetwork(t,options);
  const started=await call(setup.env,'start_editorial_review',input);
  assert.equal(started.isError,undefined,JSON.stringify(started));
  const id=started.structuredContent.job_id,core=setup.jobs.get(id);
  for(let i=0;i<14;i++){const j=await core.ctx.storage.get('job');if(['completed','completed_save_failed','blocked','failed'].includes(j.status))break;await core.alarm();}
  return {...setup,...network,id,core,result:(await call(setup.env,'get_editorial_review',{job_id:id})).structuredContent};
}

test('unauthenticated requests cannot discover or start tools',async t=>{mockNetwork(t);const {env}=environment();assert.equal((await worker.fetch(rpc('start_editorial_review',args(),'wrong'),env)).status,401);});
test('bad Origin is rejected even with the correct credential',async()=>{const {env}=environment();const r=rpc('get_editorial_review',{});r.headers.set('Origin','https://evil.example');assert.equal((await worker.fetch(r,env)).status,403);});
test('legacy tool names and editorial descriptions are unchanged; exactly two tools added',async()=>{const {env}=environment();const request=()=>new Request('https://reviewer.test/mcp',{method:'POST',headers:{'x-api-key':env.MCP_ACCESS_TOKEN},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});const old=await(await legacy.fetch(request(),env)).json(),now=await(await worker.fetch(request(),env)).json();assert.deepEqual(now.result.tools[0],old.result.tools[0]);for(let i=1;i<3;i++){assert.equal(now.result.tools[i].name,old.result.tools[i].name);assert.equal(now.result.tools[i].description,old.result.tools[i].description);assert.deepEqual(now.result.tools[i].inputSchema.properties.images.items.properties.image_url,old.result.tools[i].inputSchema.properties.images.items.properties.image_url);}assert.deepEqual(now.result.tools.slice(3).map(x=>x.name),['start_editorial_review','get_editorial_review']);});
test('disabled editorial service leaves legacy validation behaviour intact',async()=>{const {env}=environment();env.EDITORIAL_ENABLED='0';for(const name of ['independent_review','review_illustration','review_comic_lettering'])assert.deepEqual(await(await worker.fetch(rpc(name,{}),env)).json(),await(await legacy.fetch(rpc(name,{}),env)).json());});
test('disabled editorial service blocks before network access',async t=>{const net=mockNetwork(t),{env}=environment();env.EDITORIAL_ENABLED='0';const r=await call(env,'start_editorial_review',args());assert.equal(r.isError,true);assert.equal(net.requests.length,0);});
test('source descriptions cannot masquerade as illustrated comics',()=>assert.throws(()=>validateArgs({...args(),mode:'comic',artifact_kind:'comic'},{}),/actual PDF/));
test('ambiguous source is rejected',()=>assert.throws(()=>validateArgs({...args(),source:{text:'x',drive_file_id:FILE}},{}),/exactly one/));
test('oversized/invalid spend and unknown arguments are rejected',()=>{for(const cost of [0,-1,Infinity,6])assert.throws(()=>validateArgs({...args(),max_cost_usd:cost},{}));assert.throws(()=>validateArgs({...args(),secret_override:'x'},{}),/Unknown/);});
test('revision comparison requires the previous primary source',()=>assert.throws(()=>validateArgs({...args(),mode:'revision'},{}),/previous_source/));
test('duplicate panel IDs are rejected',()=>assert.throws(()=>validateArgs({...args(),panel_manifest:[{page:1,panels:['P1','P1']}]},{}),/Duplicate/));
test('cold read never receives script explanations, context or previous verdict',()=>{
  const snap={current:[{label:'current',input:{type:'input_file',file_id:'current'}}],script:[{label:'SECRET_SCRIPT',input:{type:'input_text',text:'SECRET_SCRIPT'}}],references:[],context:[{label:'SECRET_CANON',input:{type:'input_text',text:'SECRET_CANON'}}],previous:[{label:'SECRET_OLD',input:{type:'input_file',file_id:'old'}}]};
  const input=JSON.stringify(phaseInput('cold',{args:args()},snap,null,null,{verdict:'SECRET_VERDICT'}));for(const word of ['SECRET_SCRIPT','SECRET_CANON','SECRET_OLD','SECRET_VERDICT'])assert.ok(!input.includes(word));assert.ok(input.includes('current'));
});
test('missing page prevents complete assessment',()=>{const c=cold();c.pages.pop();assert.throws(()=>validateCold(c,args()),/omitted/);});
test('missing expected panel prevents complete assessment',()=>{const c=cold();c.pages[0].panels=[];assert.throws(()=>validateCold(c,args()),/Panel coverage/);});
test('duplicate page prevents complete assessment',()=>{const c=cold();c.pages[1].page=1;assert.throws(()=>validateCold(c,args()),/coverage/);});
test('script reviews cannot award finished-art or lettering scores',()=>{const r=validateReport(report(),args(),cold());for(const category of ['visual_continuity','art_composition','lettering','script_fidelity'])assert.equal(r.ratings.find(x=>x.category===category).score,null);});
test('missing rating category is rejected',()=>{const r=report();r.ratings.pop();assert.throws(()=>validateReport(r,args(),cold()),/omitted rating/);});
test('major proven defect cannot produce a clean verdict',()=>{const r=report();r.findings=[finding()];assert.equal(validateReport(r,args(),cold()).verdict,'REVISE');});
test('unreadable pages force inconclusive verdict',()=>{const c=cold();c.pages[0].readable=false;assert.equal(validateReport(report(),args(),c).verdict,'INCONCLUSIVE');});
test('preferences do not silently become rejection criteria',()=>{const r=report();r.findings=[{...finding(),kind:'preference'}];assert.equal(validateReport(r,args(),cold()).verdict,'NO_MATERIAL_ISSUES_FOUND');});
test('prior findings cannot silently disappear',()=>{const prior=report();prior.findings=[finding()];const r=report();r.change_assessment.net_change='improved';assert.throws(()=>validateReport(r,{...args(),mode:'revision'},cold(),prior),/omitted/);r.prior_issue_status=[{previous_id:'old-F001',status:'resolved',evidence:'Page 2 now explicitly releases the object.'}];assert.doesNotThrow(()=>validateReport(r,{...args(),mode:'revision'},cold(),prior));});
test('invented evidence page is rejected',()=>{const r=report();r.findings=[finding()];r.findings[0].evidence[0].page=99;assert.throws(()=>validateReport(r,args(),cold()),/impossible page/);});
test('findings without evidence are rejected',()=>{const r=report();r.findings=[{...finding(),evidence:[]}];assert.throws(()=>validateReport(r,args(),cold()),/evidence/);});
test('strict schemas have required fields and no open objects',()=>{const walk=s=>{if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));Object.values(s.properties).forEach(walk);}if(s.items)walk(s.items);};walk(COLD_SCHEMA);walk(REPORT_SCHEMA);});
test('large Unicode records round-trip across storage chunks',async()=>{const s=new Storage(),v={text:'🧙'.repeat(120000)};await putLarge(s,'x',v);assert.deepEqual(await getLarge(s,'x'),v);});
test('model changes need matching verified pricing',()=>assert.throws(()=>priceConfig({EDITORIAL_MODEL:'another-model'}),/Configure verified/));
test('complete script workflow saves both report formats with exactly two model calls',async t=>{const r=await run(t);assert.equal(r.result.status,'completed');assert.equal(r.inference().length,2);assert.equal(r.saved.length,2);assert.equal(r.result.reports.length,2);assert.match(r.result.markdown,/Page 2/);assert.equal(r.result.usage.length,2);assert.ok(r.result.source_sha256);});
test('asynchronous responses are polled without creating extra inference',async t=>{const r=await run(t,{async:true});assert.equal(r.result.status,'completed');assert.equal(r.inference().length,2);assert.ok(r.requests.some(x=>x.url.endsWith('/responses/resp_1')&&x.method==='GET'));});
test('revision workflow performs three passes and receives actual old source only at comparison',async t=>{const a={...args(),mode:'revision',previous_source:{text:'PAGE 1 Old action\nPAGE 2 Old consequence'},previous_expected_pages:2};const r=await run(t,{},a);assert.equal(r.result.status,'completed');assert.equal(r.inference().length,3);const bodies=r.inference().map(x=>JSON.parse(x.init.body));assert.ok(!JSON.stringify(bodies[0]).includes('PREVIOUS SOURCE'));assert.ok(JSON.stringify(bodies[2]).includes('PREVIOUS SOURCE'));assert.equal(r.result.review.change_assessment.net_change,'improved');});
test('start retries return the same job and do not add charges',async t=>{const r=await run(t);const repeat=await call(r.env,'start_editorial_review',args());assert.equal(repeat.structuredContent.job_id,r.id);assert.equal(r.jobs.size,1);assert.equal(r.inference().length,2);});
test('same request key with altered material is rejected',async t=>{const r=await run(t);const changed=await call(r.env,'start_editorial_review',{...args(),revision:'changed'});assert.equal(changed.isError,true);assert.match(changed.content[0].text,/different arguments/);});
test('daily budget reservations reject a new job before any inference',async t=>{const net=mockNetwork(t),{env}=environment();env.EDITORIAL_DAILY_USD='2';await call(env,'start_editorial_review',args());const r=await call(env,'start_editorial_review',{...args(),request_key:'another-request-002'});assert.equal(r.isError,true);assert.equal(net.inference().length,0);});
test('Drive denial blocks before paid inference',async t=>{const r=await run(t,{driveDenied:true});assert.equal(r.result.status,'blocked');assert.equal(r.inference().length,0);});
test('oversized token count blocks before paid inference',async t=>{const r=await run(t,{inputTokens:250000});assert.equal(r.result.status,'blocked');assert.equal(r.inference().length,0);});
test('insufficient per-job estimate budget blocks before paid inference',async t=>{const r=await run(t,{}, {...args(),max_cost_usd:0.001});assert.equal(r.result.status,'blocked');assert.equal(r.inference().length,0);});
test('unknown submission outcome is never automatically resubmitted',async t=>{const r=await run(t,{submitNetworkFailure:true});assert.equal(r.result.status,'blocked');await r.core.alarm();assert.equal(r.inference().length,1);assert.match(r.result.message,/No automatic paid resubmission/);});
test('incomplete model output cannot become a completed review',async t=>{const r=await run(t,{incomplete:true});assert.equal(r.result.status,'blocked');assert.equal(r.inference().length,1);assert.equal(r.saved.length,0);});
test('model refusal cannot become an editorial verdict',async t=>{const r=await run(t,{refusal:true});assert.equal(r.result.status,'blocked');assert.match(r.result.message,/refused/);});
test('omitted page halts workflow after cold read',async t=>{const r=await run(t,{cold:()=>({...cold(),pages:[cold().pages[0]]})});assert.equal(r.result.status,'blocked');assert.equal(r.inference().length,1);});
test('Drive save failure returns the report and never repeats model work',async t=>{const r=await run(t,{saveFails:true});assert.equal(r.result.status,'completed_save_failed');assert.equal(r.inference().length,2);assert.ok(r.result.markdown);assert.match(r.result.message,/saving failed/);});
test('source hash mismatch is detected before upload',async t=>{mockNetwork(t);const {env}=environment();await assert.rejects(sourceBytes(env,{text:'actual',expected_sha256:'a'.repeat(64)},'script'),/SHA-256/);});
test('actual comic PDF bytes are fetched; metadata pretending to be PDF is rejected',async t=>{mockNetwork(t,{fileBytes:'this is an HTML login page'});const {env}=environment();await assert.rejects(sourceBytes(env,{drive_file_id:FILE},'comic'),/not a PDF/);});
test('completed job output is only available with authentication',async t=>{const r=await run(t);assert.equal((await worker.fetch(rpc('get_editorial_review',{job_id:r.id},'wrong'),r.env)).status,401);});
test('no image-generation, external MCP, browser or source-edit calls are made',async t=>{const r=await run(t);assert.ok(r.requests.every(x=>!x.url.includes('/images/')&&!x.url.includes('scenario')));assert.ok(!r.requests.some(x=>['PATCH','PUT'].includes(x.method)));});
test('consumed response is not counted twice after interrupted bookkeeping',async t=>{const r=await run(t);const job=await r.core.ctx.storage.get('job');job.args=args();job.phase='cold';job.pending={id:'resp_1',pricing:priceConfig(r.env),reserve:1};const spent=job.spent_usd;await r.core.consume(job,r.responses.get('resp_1'));assert.equal(job.spent_usd,spent);assert.equal(job.usage.length,2);});
test('unknown review ID returns an actionable error',async()=>{const {env}=environment();const r=await call(env,'get_editorial_review',{job_id:'a'.repeat(64)});assert.equal(r.isError,true);assert.match(r.content[0].text,/not found/);});
test('lost Drive upload response cannot duplicate the report files',async t=>{const r=await run(t,{lostSaveResponse:true});assert.equal(r.result.status,'completed');assert.equal(r.saved.length,2);assert.equal(r.inference().length,2);});
test('source outside the approved input folders is refused',async t=>{mockNetwork(t,{outsideRoot:true});const {env}=environment();await assert.rejects(sourceBytes(env,{drive_file_id:FILE},'comic'),/outside/);});
test('previous report cannot be reconciled against different source bytes',async t=>{
  const r=await run(t);
  const a={...args(),request_key:'revision-wrong-old-source',mode:'revision',previous_source:{text:'Different old source'},previous_expected_pages:2,previous_review_job_id:r.id};
  const started=await call(r.env,'start_editorial_review',a);assert.ok(!started.isError);
  const core=r.jobs.get(started.structuredContent.job_id);await core.alarm();
  const state=await core.ctx.storage.get('job');assert.equal(state.status,'blocked');assert.match(state.message,/does not match/);assert.equal(r.inference().length,2);
});

// Clean-workspace security tests: actual file contents must not be fetched outside allowlisted subfolders.
test('file OAuth mode is the default and does not accept broad Google OAuth credentials',()=>{
  const {env}=environment();assert.equal(driveAccessMode(env),'file');
  env.GOOGLE_OAUTH_SCOPE='https://www.googleapis.com/auth/drive';
  assert.throws(()=>driveAccessMode(env),/scope mismatch/);
});
test('full Drive OAuth scope requires conscious acknowledgement',()=>{
  const {env}=environment();env.DRIVE_ACCESS_MODE='full';env.GOOGLE_OAUTH_SCOPE='https://www.googleapis.com/auth/drive';
  assert.throws(()=>driveAccessMode(env),/explicit BROAD_DRIVE_SCOPE_ACK/);
  env.BROAD_DRIVE_SCOPE_ACK='I_UNDERSTAND_FULL_DRIVE_ACCESS';
  assert.equal(driveAccessMode(env),'full');
});
test('source in report folder cannot be submitted',async t=>{
  const net=mockNetwork(t,{sourceInReports:true});const {env}=environment();
  await assert.rejects(sourceBytes(env,{drive_file_id:FILE},'comic','current'),/Report files cannot/);
  assert.ok(!net.requests.some(x=>x.url.includes('alt=media')));
});
test('reference folder cannot be used as a new primary submission',async t=>{
  const net=mockNetwork(t,{sourceInRefs:true});const {env}=environment();
  await assert.rejects(sourceBytes(env,{drive_file_id:FILE},'comic','current'),/outside/);
  assert.ok(!net.requests.some(x=>x.url.includes('alt=media')));
});
test('reference role allows only explicit reference folder and not submission folder',async t=>{
  mockNetwork(t,{sourceInRefs:true});const {env}=environment();
  await assert.doesNotReject(sourceBytes(env,{drive_file_id:FILE},'reference','reference'));
});
test('reference role rejects primary-submission files',async t=>{
  const net=mockNetwork(t);const {env}=environment();
  await assert.rejects(sourceBytes(env,{drive_file_id:FILE},'reference','reference'),/outside/);
  assert.ok(!net.requests.some(x=>x.url.includes('alt=media')));
});
test('selected source can be read only after workspace ancestry verified',async t=>{
  const net=mockNetwork(t,{fileBytes:'%PDF-test-payload'});const {env}=environment();
  const s=await sourceBytes(env,{drive_file_id:FILE},'comic','current');
  assert.equal(s.drive_id,FILE);assert.ok(net.requests.some(x=>x.url.includes('alt=media')));
});
test('workspace folder configuration rejects aliases and moved folders',async t=>{
  mockNetwork(t,{outsideRoot:true});const {env}=environment();
  env.REFERENCES_FOLDER_ID=env.SUBMISSIONS_FOLDER_ID;
  await assert.rejects(assertWorkspaceFolderLayout(env),/distinct/);
});
test('optional audience brief is not disclosed to the cold read but is available to assessment',()=>{
  const a={...args(),editorial_brief:'Adult sci-fi audience; satirical tone.'};
  const src={current:[{label:'current',input:{type:'input_text',text:'THE SCRIPT'}}],script:[],references:[],context:[],previous:[]};
  assert.ok(!JSON.stringify(phaseInput('cold',{args:a},src)).includes('Adult sci-fi'));
  assert.ok(JSON.stringify(phaseInput('assess',{args:a},src,cold())).includes('Adult sci-fi'));
  assert.equal(validateArgs(a,{}).editorial_brief,a.editorial_brief);
});
test('unspecified audience cannot receive an invented age-suitability score',()=>{
  const r=validateReport(report(),args(),cold());
  assert.equal(r.ratings.find(x=>x.category==='age_suitability').score,null);
});
test('unconfigured workspace is refused before paid model requests',async t=>{
  const net=mockNetwork(t);const {env}=environment();delete env.SUBMISSIONS_FOLDER_ID;
  const r=await call(env,'start_editorial_review',args());
  assert.equal(r.isError,true);assert.equal(net.inference().length,0);
});
