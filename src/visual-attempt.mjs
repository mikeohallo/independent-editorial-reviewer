import {matchesSettlement} from './budget.mjs';
import {json,sha256,stable,putLarge,getLarge,estimateCost} from './io.mjs';
import {LIMITS,networkContext,visualAPI,boundedJSON} from './visual-limits.mjs';
import {prepareImages} from './drive-images.mjs';
import {privateConfiguration,validateLegacy,normalizeLegacy,validateResponse} from './visual-review.mjs';

let occupied = false;
const errorResult = message => ({isError:true,content:[{type:'text',text:message}]});
// Some MCP clients pass only the text content to the model. Repeat the
// evidence there, so a caller can see which bytes a review covered. File
// names, Drive identifiers and provider file identifiers stay out of it.
const usd = value => typeof value==='number'&&Number.isFinite(value)?`$${Number(value.toFixed(6))}`:'unknown';
export function evidenceText({sources,attempt,budget,cleanup}) {
  const lines=[`Attempt: ${attempt.id}; status ${attempt.status}; OpenAI calls: ${attempt.api_calls}; upload outcome: ${cleanup.unknown_upload?'unknown':'known'}.`];
  if(budget.settlement_status==='confirmed'&&typeof budget.settled_usd==='number')
    lines.push(`Budget: settled ${usd(budget.settled_usd)} ${budget.estimated_cost_usd==null?'with no usage estimate':`on a conservative estimate of ${usd(budget.estimated_cost_usd)}`}; budget day ${budget.budget_day}.`);
  else if(budget.settlement_status==='not_applicable'&&budget.reservation_status==='not_requested') lines.push('Budget: no reservation was made.');
  else lines.push(`Budget: not settled (settlement status: ${budget.settlement_status}; reservation status: ${budget.reservation_status}).`);
  if(!sources.length) lines.push('Sources: none verified.');
  else lines.push('Sources:',...sources.map((s,i)=>`${i+1}. ${s.role} | ${s.width}x${s.height} | ${s.bytes} bytes | transformed: ${s.transformed} | sha256 ${s.sha256}`));
  return lines.join('\n');
}
// An internal request can finish in the ledger after its caller times out.
// Bound the caller's wait too. The durable intent reconciles that ambiguity.
async function budgetRequest(env,route,body,signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted=new Promise((_,reject)=>{
    onAbort=()=>reject(signal.reason);
    signal.addEventListener('abort',onAbort,{once:true});
  });
  try {
    const stub=env.EDITORIAL_BUDGET.get(env.EDITORIAL_BUDGET.idFromName('editorial-budget'));
    const read=async()=>{
      const response=await stub.fetch('https://budget.internal/'+route,{
        method:'POST',signal,body:JSON.stringify(body)});
      return {status:response.status,ok:response.ok,data:await boundedJSON(response,signal)};
    };
    return await Promise.race([read(),aborted]);
  } finally {signal.removeEventListener('abort',onAbort);}
}

export class VisualAttempt {
  constructor(ctx,env,timing=LIMITS) { this.ctx=ctx;this.env=env;this.timing=timing; }
  deadlines(start) {
    const end=start+this.timing.totalMs;
    const inferenceEnd=end-this.timing.cleanupMs;
    const latestStart=Math.min(start+this.timing.prepareMs,inferenceEnd-this.timing.minInferenceMs);
    return {end,inferenceEnd,latestStart};
  }
  ensureTime(latestStart) {
    if(Date.now()>=latestStart) throw Error('Too little time remains for a private review. No inference started.');
  }
  async save(record) { await this.ctx.storage.put('visual',record); }
  async fetch(request) {
    const {id,fingerprint,name,args,started_at}=await request.json();
    if(id!==await sha256(`visual-v5.1:${args.request_key}`)||fingerprint!==await sha256(stable({name,args}))) return json(errorResult('Invalid visual attempt identity.'));
    let record,prior,claimed=false;
    await this.ctx.blockConcurrencyWhile(async()=>{
      record=await this.ctx.storage.get('visual');
      if(record) {
        if(record.fingerprint!==fingerprint) prior=errorResult('request_key was already used with different arguments. No new inference started.');
        else if(record.finished_at&&Date.now()<record.finished_at+LIMITS.cacheMs) {
          const cached=await getLarge(this.ctx.storage,'visual-result');
          prior=cached&&record.settlement_version?this.decorate(cached,record):cached;
        }
        else prior=errorResult('This attempt is in progress, interrupted or its result expired. The request key cannot start another inference.');
        return;
      }
      if(occupied) {prior=errorResult('Private image preparation is busy. Retry this identical request later.');return;}
      occupied=true;claimed=true;this.running=true;
      if(!Number.isSafeInteger(started_at)||started_at>Date.now()||Date.now()>=this.deadlines(started_at).latestStart) {
        occupied=false;claimed=false;this.running=false;prior=errorResult('Private request deadline expired before admission.');return;
      }
      record={kind:'visual-v5.1',id,fingerprint,state:'preparing',created_at:started_at,files:[],unknown_upload:false,
        settlement_version:1,cleanup_rounds:0,reserved_usd:0,estimated_cost_usd:null,api_calls:0};
      try {
        await this.ctx.storage.transaction(async tx=>{
          await tx.put('visual',record);
          await tx.setAlarm(this.deadlines(record.created_at).end+1000);
        });
      } catch(e) { occupied=false;this.running=false;claimed=false;throw e; }
    });
    if(!claimed) return json(prior??errorResult('Attempt is unavailable; no inference retried.'));
    let result; const counter={count:0};
    const {end,inferenceEnd,latestStart}=this.deadlines(record.created_at);
    try {
      const {pricing}=privateConfiguration(this.env,args);
      const original=await validateLegacy(name,args,this.env);
      this.ensureTime(latestStart);
      const prepare=networkContext(latestStart,counter);
      const prepared=await prepareImages(this.env,args.images,prepare,{
        uploading:async()=>{record.unknown_upload=true;await this.save(record);},
        uploaded:async id=>{record.files.push(id);record.unknown_upload=false;await this.save(record);},
      });
      const {sources}=prepared;
      record.sources=sources;await this.save(record);
      const payload=structuredClone(original);let i=0;
      for(const message of payload.input) for(let j=0;j<message.content.length;j++) {
        const item=message.content[j];if(item.type!=='input_image')continue;
        if(item.image_url!==`https://image-placeholder.invalid/${i}`||!sources[i]) throw Error('Legacy image transport mapping mismatch.');
        message.content[j]={type:'input_image',file_id:sources[i++].file_id,detail:'original'};
      }
      if(i!==sources.length) throw Error('Legacy image transport count mismatch.');
      Object.assign(payload,{store:false,background:false,service_tier:'default',truncation:'disabled'});
      const countPayload={model:payload.model,input:payload.input,instructions:payload.instructions,text:payload.text};
      const counted=await visualAPI(this.env,prepare,'/responses/input_tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(countPayload)});
      if(!Number.isSafeInteger(counted.input_tokens)||counted.input_tokens<0) throw Error('Input token count is missing or invalid.');
      const ceiling=Math.ceil(counted.input_tokens*1.1)+5000;
      if(ceiling>200000) throw Error('Input exceeds the 200,000-token ceiling. No inference started.');
      record.input_token_ceiling=ceiling;
      record.preflight_cost_usd=estimateCost(ceiling,payload.max_output_tokens,pricing);
      if(record.preflight_cost_usd>args.max_cost_usd) throw Error('Estimated inference cost exceeds max_cost_usd. No inference started.');
      await prepared.recheck();
      prepare.signal.throwIfAborted();
      this.ensureTime(latestStart);
      record.authorized_usd=args.max_cost_usd;record.reservation_status='unknown';await this.save(record);
      const reservation=await budgetRequest(this.env,'reserve',{id,amount:args.max_cost_usd,kind:record.kind},prepare.signal);
      const reserved=reservation.data;
      if(!reservation.ok||reserved.reserved!==args.max_cost_usd) {
        record.reservation_status=reservation.status===409?'rejected':'unknown';
        throw Error('Shared daily budget rejected the full authorized reservation. No inference started.');
      }
      record.reserved_usd=reserved.reserved;record.reservation_status='reserved';
      prepare.signal.throwIfAborted();
      this.ensureTime(latestStart);
      // Persist BEFORE the only paid call. Recovery never runs this code again.
      record.state='submitting';record.api_calls=1;await this.save(record);
      // Early preparation leaves up to 110 seconds for inference. A delayed
      // durable write must not dispatch a request with an exhausted deadline.
      this.ensureTime(latestStart);
      const inference=networkContext(inferenceEnd,counter);
      const response=await visualAPI(this.env,inference,'/responses',{method:'POST',headers:{'Content-Type':'application/json','X-Client-Request-Id':id},body:JSON.stringify(payload)});
      const usage=validateResponse(response,payload);
      record.estimated_cost_usd=estimateCost(usage.input_tokens,usage.output_tokens,pricing);
      if(usage.input_tokens>ceiling||usage.output_tokens>payload.max_output_tokens||record.estimated_cost_usd>args.max_cost_usd)
        throw Error('Reported usage exceeded the authorized estimate. Inspect billing; no inference retry.');
      result=await normalizeLegacy(name,args,this.env,original,response);
      record.state=result.isError?'failed':'completed';
    } catch(e) {
      record.state=record.state==='submitting'?'uncertain':'failed';
      result=errorResult(e?.name==='TimeoutError'||e?.name==='AbortError'?'Private review deadline exceeded; no inference retry.':e.message);
    } finally {
      try {
        const deadline=Math.min(end,Date.now()+this.timing.cleanupMs);
        await this.finish(record,result??errorResult('Review interrupted; no inference retry.'));
        await this.reconcile(record,deadline,counter);
        result=this.decorate(result,record);
      } finally {occupied=false;this.running=false;}
    }
    return json(result);
  }
  async finish(record,result) {
    record.finished_at=Date.now();
    if(['reserved','unknown'].includes(record.reservation_status)) {
      const beforeSubmission=record.api_calls===0&&['failed','interrupted'].includes(record.state);
      const outcome=record.state==='completed'?'completed':beforeSubmission?'unsubmitted':'uncertain';
      record.settlement={outcome,status:'pending',attempts:0};
    }
    // Commit the review and settlement intent together. A restart after this
    // transaction can replay the receipt request without losing the verdict.
    await this.ctx.storage.transaction(async tx=>{
      await putLarge(tx,'visual-result',result);
      await tx.put('visual',record);
      await tx.setAlarm(Date.now()+30_000);
    });
  }
  async settle(record,deadline) {
    const intent=record.settlement;
    if(intent?.status!=='pending'||Date.now()>=deadline) return;
    intent.attempts++;
    try {
      const signal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
      const amount=record.authorized_usd??record.reserved_usd;
      const {ok,data:receipt}=await budgetRequest(this.env,'release',{
        id:record.id,kind:record.kind,amount,outcome:intent.outcome,estimated_cost_usd:record.estimated_cost_usd
      },signal);
      if(!ok)return;
      if(!matchesSettlement(receipt,record.id,amount,intent.outcome,record.estimated_cost_usd))return;
      Object.assign(intent,receipt);
      record.reserved_usd=receipt.reserved;
      record.reservation_status=receipt.status==='not_reserved'?'not_reserved':'reserved';
    } catch { /* Keep the persisted intent pending until a receipt is confirmed. */ }
  }
  async reconcile(record,deadline,counter) {
    // Share the cleanup allowance. Limit ledger I/O to half so file deletion
    // still has a window when the budget object is slow.
    await this.settle(record,Math.min(deadline,Date.now()+Math.floor(this.timing.cleanupMs/2)));
    if(record.files.length&&record.cleanup_rounds<4) await this.cleanup(record,deadline,counter);
    const expires=record.finished_at+LIMITS.cacheMs;
    if(Date.now()>=expires&&record.state!=='expired') {
      const count=await this.ctx.storage.get('visual-result:count');
      if(count!=null) await this.ctx.storage.delete(['visual-result:count',...Array.from({length:count},(_,i)=>'visual-result:'+i)]);
      delete record.sources;record.files=[];record.state='expired';
    }
    let next=record.state==='expired'?Infinity:expires;
    if(record.files.length&&record.cleanup_rounds<4) next=Math.min(next,Date.now()+30_000);
    if(record.settlement?.status==='pending') {
      const delay=Math.min(3600_000,30_000*2**Math.min(7,record.settlement.attempts));
      next=Math.min(next,Date.now()+delay);
    }
    await this.ctx.storage.transaction(async tx=>{
      await tx.put('visual',record);
      if(Number.isFinite(next))await tx.setAlarm(next);
    });
  }
  decorate(result,record) {
    const handling={sources:record.sources??[],attempt:{id:record.id,status:record.state,api_calls:record.api_calls},
      budget:{reserved_usd:record.reserved_usd,authorized_usd:record.authorized_usd??null,reservation_status:record.reservation_status??'not_requested',preflight_cost_usd:record.preflight_cost_usd??null,
        estimated_cost_usd:record.estimated_cost_usd,input_token_ceiling:record.input_token_ceiling??null,
        settlement_status:record.settlement?.status??'not_applicable',settled_usd:record.settlement?.settled_usd??null,
        refunded_usd:record.settlement?.refunded_usd??0,budget_day:record.settlement?.day??null,
        reservation_refunded:record.settlement?.status==='confirmed'&&record.settlement.refunded_usd>0},cleanup:{pending_file_ids:record.files,unknown_upload:record.unknown_upload,
        expiry_seconds:86400,attempts:record.cleanup_rounds},
      limitations:['No resizing or re-encoding. Model-side image dimensions are not reported.',
        'Legacy editorial rules and verdict reconciliation are unchanged. Reservations are estimates, not a billing cap.']};
    const suffix=`\n\nPrivate image handling: ${record.state}; authorized reservation $${record.reserved_usd}; confirmed release $${handling.budget.refunded_usd} (${handling.budget.settlement_status}); ${record.files.length} pending deletions${record.unknown_upload?'; upload outcome unknown, expiry fallback requested':''}.\n${evidenceText(handling)}`;
    return {...result,content:[...(result.structuredContent?.private_image_handling?result.content.slice(0,-1):result.content??[]),{type:'text',text:suffix}],
      structuredContent:{...result.structuredContent,private_image_handling:handling}};
  }
  async cleanup(record,deadline,counter={count:0}) {
    record.cleanup_rounds++;
    const context=networkContext(deadline,counter);
    for(const id of [...record.files]) {
      if(Date.now()>=deadline) break;
      try {
        const r=await context.fetch(`https://api.openai.com/v1/files/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${this.env.OPENAI_API_KEY}`}});
        if(!r.ok&&r.status!==404) {await r.body?.cancel();continue;}
        if(r.status===404||r.status===204)await r.body?.cancel();
        else if((await boundedJSON(r,context.signal)).deleted!==true)continue;
        record.files=record.files.filter(x=>x!==id);await this.save(record);
      } catch { /* Keep the ID for another deletion attempt. */ }
    }
  }
  async alarm() {
    if(this.running){await this.ctx.storage.setAlarm(Date.now()+1000);return;}
    const record=await this.ctx.storage.get('visual');if(!record)return;
    if(!record.finished_at&&Date.now()<this.deadlines(record.created_at).end) {
      await this.ctx.storage.setAlarm(this.deadlines(record.created_at).end+1000);return;
    }
    if(!record.finished_at) {
      record.state=record.api_calls||record.state==='submitting'?'uncertain':'interrupted';
      record.settlement_version=1;
      await this.finish(record,errorResult('Attempt interrupted; no inference was resubmitted.'));
    }
    await this.reconcile(record,Date.now()+this.timing.cleanupMs);
  }
}
