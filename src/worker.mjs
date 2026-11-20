import {VisualAttempt} from './visual-attempt.mjs';
import {VISUAL_TOOLS,imageMode,extendVisualSchema,privateConfiguration,validateLegacy} from './visual-review.mjs';
import {LIMITS} from './visual-limits.mjs';
import {readRPC} from './rpc-body.mjs';
import legacy from './legacy-v4.1.mjs';
import {VERSION,RUBRIC_VERSION,START_TOOL,GET_TOOL,COLD_SCHEMA,REPORT_SCHEMA,COLD_INSTRUCTIONS,ASSESS_INSTRUCTIONS,COMPARE_INSTRUCTIONS,validateArgs,validateCold,validateReport,phaseInput,renderReport} from './editorial.mjs';
import {json,sha256,stable,api,sourceBytes,uploadSnapshot,assertReportFolder,priceConfig,estimateCost,putLarge,getLarge,saveDriveReports,reserveReportIds,MAX_CONTEXT_BYTES,driveAccessMode,workspaceConfiguration,assertWorkspaceFolderLayout} from './io.mjs';

const terminal=new Set(['completed','completed_save_failed','failed','blocked']);
const safeEqual=(a,b)=>{if(!a||!b||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
const toolResult=x=>({content:[{type:'text',text:x.markdown??JSON.stringify(x,null,2)}],structuredContent:x,...(['failed','blocked'].includes(x.status)?{isError:true}:{})});
const toolError=e=>({isError:true,content:[{type:'text',text:e.message}]});
function configuration(env){
  if(env.EDITORIAL_ENABLED!=='1')throw Error('Editorial jobs are disabled. Complete setup and enable EDITORIAL_ENABLED before a paid review.');
  for(const k of ['OPENAI_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','WORKSPACE_ROOT_FOLDER_ID','SUBMISSIONS_FOLDER_ID','REFERENCES_FOLDER_ID','EDITORIAL_FOLDER_ID','GOOGLE_OAUTH_SCOPE'])if(!env[k])throw Error(`Server configuration missing: ${k}.`);
  if(!env.EDITORIAL_JOBS||!env.EDITORIAL_BUDGET)throw Error('Editorial Durable Object bindings are missing.');
  workspaceConfiguration(env);
  driveAccessMode(env);
  priceConfig(env);
}
export default {
  async fetch(request,env,ctx){
    const requestStarted=Date.now();
    const url=new URL(request.url);
    if(url.pathname==='/'||url.pathname==='/health')return json({service:'claude-openai-reviewer',status:'online',version:VERSION,legacy_engine:'4.1.0',editorial_enabled:env.EDITORIAL_ENABLED==='1',mcpEndpoint:'/mcp'});
    if(url.pathname!=='/mcp')return legacy.fetch(request,env,ctx);
    const origin=request.headers.get('Origin');
    if(origin&&!['https://claude.ai','https://claude.com'].includes(origin))return json({error:'Origin not allowed'},403);
    if(!env.MCP_ACCESS_TOKEN)return json({error:'Server not configured'},503);
    if(!safeEqual(request.headers.get('x-api-key')||'',env.MCP_ACCESS_TOKEN))return json({error:'Unauthorized'},401);
    if(request.method!=='POST')return legacy.fetch(request,env,ctx);
    let parsed;
    try{parsed=await readRPC(request);}catch(e){return e.status===413?json({error:'Request too large'},413):json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
    const body=parsed.body;
    const legacyRequest=()=>new Request(request.url,{method:'POST',headers:request.headers,body:parsed.raw});
    if(body?.jsonrpc!=='2.0'||body.id===undefined)return legacy.fetch(legacyRequest(),env,ctx);
    if(body.method==='tools/list'||body.method==='initialize'){
      const response=await legacy.fetch(legacyRequest(),env,ctx);const data=await response.json();
      if(body.method==='tools/list'&&data.result)data.result.tools=[...data.result.tools.map(extendVisualSchema),START_TOOL,GET_TOOL];
      if(data.result?.serverInfo)data.result.serverInfo.version=VERSION;
      if(data.result?._meta?.['io.modelcontextprotocol/serverInfo'])data.result._meta['io.modelcontextprotocol/serverInfo'].version=VERSION;
      return json(data,response.status);
    }
    if(body.method==='tools/call'&&VISUAL_TOOLS.includes(body.params?.name)) {
      try {
        const args=body.params.arguments;
        if(imageMode(args)==='drive') {
          if(parsed.bytes>LIMITS.jsonBytes)throw Error('Private image JSON exceeds 256 KiB.');
          parsed.raw=null; // No cloned stream or large ingress buffer survives preparation.
          privateConfiguration(env,args);
          await validateLegacy(body.params.name,args,env); // Validate all editorial inputs before external I/O.
          const id=await sha256(`visual-v5.1:${args.request_key}`),fingerprint=await sha256(stable({name:body.params.name,args}));
          const r=await env.EDITORIAL_JOBS.get(env.EDITORIAL_JOBS.idFromName(id)).fetch('https://editorial.internal/visual',{
            method:'POST',body:JSON.stringify({id,fingerprint,name:body.params.name,args,started_at:requestStarted})});
          const result=await r.json();
          if(body.params?._meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28')
            result._meta={'io.modelcontextprotocol/serverInfo':{name:'claude-openai-reviewer',version:VERSION}};
          return json({jsonrpc:'2.0',id:body.id,result});
        }
      }catch(e){return json({jsonrpc:'2.0',id:body.id,result:toolError(e)});}
    }
    if(body.method!=='tools/call'||![START_TOOL.name,GET_TOOL.name].includes(body.params?.name))return legacy.fetch(legacyRequest(),env,ctx);
    let result;
    try{
      if(body.params.name===START_TOOL.name){
        configuration(env);
        const args=validateArgs(body.params.arguments,env);
        const id=await sha256(`editorial-clean-v5:${args.request_key}`),fingerprint=await sha256(stable(args));
        const stub=env.EDITORIAL_JOBS.get(env.EDITORIAL_JOBS.idFromName(id));
        const r=await stub.fetch('https://editorial.internal/start',{method:'POST',body:JSON.stringify({id,args,fingerprint})});
        const data=await r.json();if(!r.ok)throw Error(data.error||'Job could not start.');result=toolResult(data);
      }else{
        const id=body.params.arguments?.job_id;
        if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid job_id.');
        if(!env.EDITORIAL_JOBS)throw Error('Editorial job storage is not configured.');
        const r=await env.EDITORIAL_JOBS.get(env.EDITORIAL_JOBS.idFromName(id)).fetch('https://editorial.internal/status');
        const data=await r.json();if(!r.ok)throw Error(data.error||'Job not found.');result=toolResult(data);
      }
    }catch(e){result=toolError(e);}
    return json({jsonrpc:'2.0',id:body.id,result});
  }
};

export {EditorialBudgetCore} from './budget.mjs';

export class EditorialJobCore {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.running=false;this.visual=new VisualAttempt(ctx,env);}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/visual')return this.visual.fetch(request);
    if(path==='/start'){
      const incoming=await request.json();
      let response;
      await this.ctx.blockConcurrencyWhile(async()=>{
        const existing=await this.ctx.storage.get('job');
        if(existing){response=existing.fingerprint===incoming.fingerprint?json(await this.status(existing)):json({error:'request_key was already used with different arguments. No new review started.'},409);return;}
        const reservation=await this.env.EDITORIAL_BUDGET.get(this.env.EDITORIAL_BUDGET.idFromName('editorial-budget')).fetch('https://budget.internal/reserve',{method:'POST',body:JSON.stringify({id:incoming.id,amount:incoming.args.max_cost_usd})});
        if(!reservation.ok){response=json(await reservation.json(),409);return;}
        const job={id:incoming.id,fingerprint:incoming.fingerprint,model:this.env.EDITORIAL_MODEL||'gpt-6.1-sol',status:'queued',phase:'prepare',created_at:new Date().toISOString(),usage:[],spent_usd:0,reserved_usd:0,pending:null,calls:0,uploaded:[],save_attempts:0,cleanup_pending:[],rubric:RUBRIC_VERSION};
        await putLarge(this.ctx.storage,'args',incoming.args);
        await this.save(job,1);response=json(await this.status(job));
      });
      return response;
    }
    const job=await this.ctx.storage.get('job');if(!job)return json({error:'Job not found'},404);
    return json(await this.status(job));
  }
  async schedule(seconds=15){await this.ctx.storage.setAlarm(Date.now()+seconds*1000);}
  async save(job,nextSeconds=null){
    const {args,...persist}=job;
    await this.ctx.storage.transaction(async tx=>{await tx.put('job',persist);if(nextSeconds!==null)await this.ctx.storage.setAlarm(Date.now()+nextSeconds*1000);});
  }
  async status(job){
    const data={job_id:job.id,status:job.status,phase:job.phase,message:job.message??null,created_at:job.created_at,model:job.model,rubric:job.rubric,usage:job.usage,estimated_cost_usd:job.spent_usd,reserved_usd:job.reserved_usd,api_calls:job.calls,reports:job.reports??[],cleanup_pending:job.cleanup_pending??[],poll_after_seconds:terminal.has(job.status)?null:15};
    if(job.status.startsWith('completed')){
      data.review=await getLarge(this.ctx.storage,'final');data.markdown=await getLarge(this.ctx.storage,'markdown');
      const snap=await getLarge(this.ctx.storage,'snapshots');data.source_sha256=snap?.current?.[0]?.sha256??null;
    }
    return data;
  }
  async alarm(){
    if(await this.ctx.storage.get('visual'))return this.visual.alarm();
    if(this.running)return;
    this.running=true;
    let job=await this.ctx.storage.get('job');
    try{
      if(!job)return;
      job.args=await getLarge(this.ctx.storage,'args');
      if(terminal.has(job.status))return;
      if(Date.now()-Date.parse(job.created_at)>2*60*60*1000)throw Error('Review exceeded the two-hour runtime limit. No new inference will be started.');
      if(job.phase==='prepare'){await this.prepare(job);return;}
      if(job.phase==='save'){await this.finish(job);return;}
      if(job.pending?.state==='submitting')throw Error('Submission outcome is unknown after interruption. Paid inference was not resubmitted. Inspect the OpenAI request log before starting another review.');
      if(job.pending?.id){await this.poll(job);return;}
      await this.launch(job);
    }catch(e){
      if(job){job.status='blocked';job.message=e.message;await this.save(job);if(job.pending?.id){try{await api(this.env,`/responses/${job.pending.id}/cancel`,{method:'POST'});}catch{job.cleanup_pending.push('Could not confirm cancellation of '+job.pending.id);}}
        // Unknown submission may still be using inputs. Expiry handles its copies.
        if(job.pending?.state!=='submitting')await this.cleanup(job);await this.save(job);
      }
    }finally{this.running=false;}
  }
  async prepare(job){
    job.status='preparing';await this.save(job,65);
    await assertWorkspaceFolderLayout(this.env);
    await assertReportFolder(this.env);
    if(job.args.previous_review_job_id){
      const r=await this.env.EDITORIAL_JOBS.get(this.env.EDITORIAL_JOBS.idFromName(job.args.previous_review_job_id)).fetch('https://editorial.internal/status');
      const previous=await r.json();if(!r.ok||!previous.status?.startsWith('completed')||!previous.review)throw Error('Previous review is unavailable or incomplete.');
      await putLarge(this.ctx.storage,'prior',previous.review);
      job.prior_source_sha256=previous.source_sha256;
    }
    let snap=await getLarge(this.ctx.storage,'snapshots')||{current:[],script:[],references:[],context:[],previous:[]};
    const contextIds=(this.env.PROJECT_CONTEXT_FILE_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
    if(contextIds.length>4)throw Error('Configure at most four concise project context files.');
    const plans=[['current',[job.args.source],job.args.artifact_kind],['script',job.args.script?[job.args.script]:[],'script'],['references',job.args.reference_file_ids.map(drive_file_id=>({drive_file_id})),'reference'],['context',contextIds.map(drive_file_id=>({drive_file_id})),'script'],['previous',job.args.previous_source?[job.args.previous_source]:[],job.args.artifact_kind]];
    for(const [role,sources,kind] of plans){
      for(let i=snap[role].length;i<sources.length;i++){
        const data=await sourceBytes(this.env,sources[i],kind,role);
        const total=Object.values(snap).flat().reduce((n,x)=>n+x.bytes,0)+data.bytes.length;
        if(total>MAX_CONTEXT_BYTES)throw Error('Combined source snapshots exceed the 45 MiB implementation limit.');
        const item=await uploadSnapshot(this.env,data);
        job.uploaded.push(item.file_id);snap[role].push(item);
        await putLarge(this.ctx.storage,'snapshots',snap);await this.save(job);
      }
    }
    if(job.prior_source_sha256&&snap.previous[0]?.sha256!==job.prior_source_sha256)throw Error('Previous source does not match the source reviewed in previous_review_job_id.');
    job.phase='cold';job.status='running';await this.save(job,1);
  }
  async launch(job){
    const phases=job.args.mode==='revision'?['cold','assess','compare']:['cold','assess'];
    if(!phases.includes(job.phase)||job.calls>=phases.length)throw Error('Review call limit reached.');
    const snap=await getLarge(this.ctx.storage,'snapshots'),cold=await getLarge(this.ctx.storage,'cold'),assessment=await getLarge(this.ctx.storage,'assess'),prior=await getLarge(this.ctx.storage,'prior');
    const content=phaseInput(job.phase,job,snap,cold,assessment,prior);
    const instructions=job.phase==='cold'?COLD_INSTRUCTIONS:job.phase==='compare'?COMPARE_INSTRUCTIONS:ASSESS_INSTRUCTIONS;
    const schema=job.phase==='cold'?COLD_SCHEMA:REPORT_SCHEMA;
    const maxOutput=job.phase==='cold'?16000:24000;
    const payload={model:job.model,instructions,input:[{role:'user',content}],reasoning:{effort:this.env.EDITORIAL_REASONING_EFFORT||'high'},text:{format:{type:'json_schema',name:job.phase==='cold'?'editorial_cold_read':'editorial_report',strict:true,schema}},max_output_tokens:maxOutput,background:true,store:false,service_tier:'default',truncation:'disabled'};
    const counted=await api(this.env,'/responses/input_tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:payload.model,input:payload.input,instructions})});
    if(!Number.isInteger(counted.input_tokens)||counted.input_tokens<0)throw Error('Could not count input tokens; paid inference was not started.');
    // Reserve schema overhead and a margin; never enter the higher-price long-context band.
    const inputCeiling=Math.ceil(counted.input_tokens*1.1)+5000;
    if(inputCeiling>200000)throw Error('Input exceeds the 200,000-token implementation ceiling. No truncation or paid retry.');
    const pricing=priceConfig(this.env),reserve=estimateCost(inputCeiling,maxOutput,pricing);
    if(job.spent_usd+reserve>job.args.max_cost_usd)throw Error(`Next pass exceeds the authorised estimated budget. Used $${job.spent_usd.toFixed(4)}; next reservation $${reserve.toFixed(4)}.`);
    job.pending={state:'submitting',phase:job.phase,reserve,pricing};job.reserved_usd=reserve;job.calls++;
    await this.save(job,65);
    const response=await api(this.env,'/responses',{method:'POST',headers:{'Content-Type':'application/json','X-Client-Request-Id':`${job.id}-${job.phase}`},body:JSON.stringify(payload)});
    if(typeof response.id!=='string')throw Error('OpenAI did not return a response ID. Submission will not be repeated.');
    job.pending={...job.pending,state:'polling',id:response.id,started_at:Date.now(),polls:0};await this.save(job,15);
    if(response.status==='completed')await this.consume(job,response);else await this.schedule();
  }
  async poll(job){
    let response;
    try{response=await api(this.env,`/responses/${job.pending.id}`);}catch(e){
      job.pending.polls++;if(job.pending.polls<=3){await this.save(job,20);return;}throw e;
    }
    if(['queued','in_progress'].includes(response.status)){
      if(Date.now()-job.pending.started_at>45*60*1000)throw Error('Model pass exceeded 45 minutes.');
      await this.schedule();return;
    }
    await this.consume(job,response);
  }
  async consume(job,response){
    const u=response.usage;
    const validUsage=Number.isInteger(u?.input_tokens)&&Number.isInteger(u?.output_tokens)&&u.input_tokens>=0&&u.output_tokens>=0;
    const charged=validUsage?estimateCost(u.input_tokens,u.output_tokens,job.pending.pricing):job.pending.reserve;
    if(!job.usage.some(x=>x.response_id===response.id)){
      job.usage.push({phase:job.phase,response_id:response.id,input_tokens:u?.input_tokens??null,output_tokens:u?.output_tokens??null,estimated_usd:charged});job.spent_usd+=charged;
    }
    job.reserved_usd=0;
    await this.save(job);
    if(response.status!=='completed')throw Error(`OpenAI response ended as ${response.status}; an incomplete assessment is not a completed review.`);
    if(!validUsage)throw Error('Usage was missing; budget accounting is uncertain. No further inference started.');
    if(job.spent_usd>job.args.max_cost_usd)throw Error('Reported usage exceeded the estimated budget reservation. Stop and inspect billing before further calls.');
    const items=(response.output??[]).flatMap(x=>x.content??[]);
    if(items.some(x=>x.type==='refusal'))throw Error('The model refused the assessment. No editorial verdict issued.');
    let result;try{result=JSON.parse(items.filter(x=>x.type==='output_text').map(x=>x.text).join(''));}catch{throw Error('The model response was not valid review JSON. No automatic inference retry.');}
    const cold=await getLarge(this.ctx.storage,'cold');
    if(job.phase==='cold')validateCold(result,job.args);
    else{
      const checkArgs=job.phase==='assess'?{...job.args,mode:job.args.artifact_kind}:job.args;
      validateReport(result,checkArgs,cold,job.phase==='compare'?await getLarge(this.ctx.storage,'prior'):null);
      const map=new Map();result.findings.forEach((f,i)=>{map.set(f.id,`${job.id.slice(0,8)}-F${String(i+1).padStart(3,'0')}`);f.id=map.get(f.id);});
    }
    await putLarge(this.ctx.storage,job.phase,result);
    const completedPhase=job.phase;
    job.pending=null;
    if(completedPhase==='cold')job.phase='assess';else if(completedPhase==='assess'&&job.args.mode==='revision')job.phase='compare';else{await putLarge(this.ctx.storage,'final',result);job.phase='save';}
    await this.save(job,1);
    try{await api(this.env,`/responses/${response.id}`,{method:'DELETE'});}catch{job.cleanup_pending.push(`Response ${response.id}: deletion not confirmed`);await this.save(job);}
  }
  async finish(job){
    await this.save(job,65);
    const r=await getLarge(this.ctx.storage,'final'),cold=await getLarge(this.ctx.storage,'cold'),snap=await getLarge(this.ctx.storage,'snapshots');
    const markdown=renderReport(job,r,cold,snap);await putLarge(this.ctx.storage,'markdown',markdown);
    job.save_attempts++;
    try{
      await assertReportFolder(this.env);
      if(!job.report_ids){job.report_ids=await reserveReportIds(this.env);await this.save(job,65);}
      job.reports=await saveDriveReports(this.env,job,markdown,r,cold,snap);job.status='completed';job.phase='done';job.message='Assessment completed and reports saved. This is advisory, not publication approval.';
    }catch(e){
      if(job.save_attempts<3){job.message='Assessment complete; retrying report storage: '+e.message;await this.save(job,30);return;}
      job.status='completed_save_failed';job.phase='done';job.message='Assessment is available here, but Google Drive saving failed: '+e.message;
    }
    await this.cleanup(job);await this.save(job);
  }
  async cleanup(job){
    for(const id of job.uploaded??[]){try{await api(this.env,`/files/${id}`,{method:'DELETE'});}catch{job.cleanup_pending.push(`File ${id}: deletion not confirmed; expiry requested at upload`);}}
    job.uploaded=[];
  }
}
