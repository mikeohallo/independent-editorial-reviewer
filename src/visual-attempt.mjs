import {json,sha256,stable,putLarge,getLarge,estimateCost} from './io.mjs';
import {LIMITS,networkContext,visualAPI,boundedJSON} from './visual-limits.mjs';
import {prepareImages} from './drive-images.mjs';
import {privateConfiguration,validateLegacy,normalizeLegacy,validateResponse} from './visual-review.mjs';

let occupied = false;
const errorResult = message => ({isError:true,content:[{type:'text',text:message}]});
export class VisualAttempt {
  constructor(ctx,env) { this.ctx=ctx;this.env=env; }
  async save(record) { await this.ctx.storage.put('visual',record); }
  async fetch(request) {
    const {id,fingerprint,name,args,started_at}=await request.json();
    if(id!==await sha256(`visual-v5.1:${args.request_key}`)||fingerprint!==await sha256(stable({name,args}))) return json(errorResult('Invalid visual attempt identity.'));
    let record,prior,claimed=false;
    await this.ctx.blockConcurrencyWhile(async()=>{
      record=await this.ctx.storage.get('visual');
      if(record) {
        if(record.fingerprint!==fingerprint) prior=errorResult('request_key was already used with different arguments. No new inference started.');
        else if(record.finished_at&&Date.now()<record.finished_at+LIMITS.cacheMs) prior=await getLarge(this.ctx.storage,'visual-result');
        else prior=errorResult('This attempt is in progress, interrupted or its result expired. The request key cannot start another inference.');
        return;
      }
      if(occupied) {prior=errorResult('Private image preparation is busy. Retry this identical request later.');return;}
      occupied=true;claimed=true;this.running=true;
      if(!Number.isSafeInteger(started_at)||started_at>Date.now()||started_at+LIMITS.totalMs<=Date.now()) {
        occupied=false;claimed=false;this.running=false;prior=errorResult('Private request deadline expired before admission.');return;
      }
      record={kind:'visual-v5.1',id,fingerprint,state:'preparing',created_at:started_at,files:[],unknown_upload:false,
        cleanup_rounds:0,reserved_usd:0,estimated_cost_usd:null,api_calls:0};
      try {
        await this.ctx.storage.transaction(async tx=>{
          await tx.put('visual',record);
          await tx.setAlarm(record.created_at+LIMITS.totalMs+1000);
        });
      } catch(e) { occupied=false;this.running=false;claimed=false;throw e; }
    });
    if(!claimed) return json(prior??errorResult('Attempt is unavailable; no inference retried.'));
    let result; const counter={count:0};
    try {
      const {pricing}=privateConfiguration(this.env,args);
      const original=await validateLegacy(name,args,this.env);
      const prepare=networkContext(record.created_at+LIMITS.prepareMs,counter);
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
      record.authorized_usd=args.max_cost_usd;record.reservation_status='unknown';await this.save(record);
      const reservation=await this.env.EDITORIAL_BUDGET.get(this.env.EDITORIAL_BUDGET.idFromName('editorial-budget')).fetch('https://budget.internal/reserve',{
        method:'POST',body:JSON.stringify({id,amount:args.max_cost_usd,kind:'visual-v5.1'}),signal:prepare.signal});
      const reserved=await reservation.json();
      if(!reservation.ok||reserved.reserved!==args.max_cost_usd) {
        record.reservation_status=reservation.ok?'unknown':'rejected';
        throw Error('Shared daily budget rejected the full authorized reservation. No inference started.');
      }
      record.reserved_usd=reserved.reserved;record.reservation_status='reserved';
      prepare.signal.throwIfAborted();
      // Persist BEFORE the only paid call. Recovery never runs this code again.
      record.state='submitting';record.api_calls=1;await this.save(record);
      const inference=networkContext(Math.min(Date.now()+LIMITS.inferenceMs,record.created_at+LIMITS.totalMs-LIMITS.cleanupMs),counter);
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
        await this.cleanup(record,Math.min(Date.now()+LIMITS.cleanupMs,record.created_at+LIMITS.totalMs),counter);
        record.finished_at=Date.now();
        result=this.decorate(result??errorResult('Review interrupted; no inference retry.'),record);
        await putLarge(this.ctx.storage,'visual-result',result);
        await this.save(record);
        await this.ctx.storage.setAlarm(record.files.length?Date.now()+30_000:record.finished_at+LIMITS.cacheMs);
      } finally {occupied=false;this.running=false;}
    }
    return json(result);
  }
  decorate(result,record) {
    const handling={sources:record.sources??[],attempt:{id:record.id,status:record.state,api_calls:record.api_calls},
      budget:{reserved_usd:record.reserved_usd,authorized_usd:record.authorized_usd??null,reservation_status:record.reservation_status??'not_requested',preflight_cost_usd:record.preflight_cost_usd??null,
        estimated_cost_usd:record.estimated_cost_usd,input_token_ceiling:record.input_token_ceiling??null,
        reservation_refunded:false},cleanup:{pending_file_ids:record.files,unknown_upload:record.unknown_upload,
        expiry_seconds:86400,attempts:record.cleanup_rounds},
      limitations:['No resizing or re-encoding. Model-side image dimensions are not reported.',
        'Legacy editorial rules and verdict reconciliation are unchanged. Reservations are estimates, not a billing cap.']};
    const suffix=`\n\nPrivate image handling: ${record.state}; authorized reservation $${record.reserved_usd}; ${record.files.length} pending deletions${record.unknown_upload?'; upload outcome unknown, expiry fallback requested':''}.`;
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
      } catch { /* Only deletion is eligible for bounded recovery. */ }
    }
  }
  async alarm() {
    if(this.running){await this.ctx.storage.setAlarm(Date.now()+1000);return;}
    const record=await this.ctx.storage.get('visual');if(!record)return;
    if(!record.finished_at&&Date.now()<record.created_at+LIMITS.totalMs) {
      await this.ctx.storage.setAlarm(record.created_at+LIMITS.totalMs+1000);return;
    }
    if(!record.finished_at) {
      record.state=record.state==='submitting'?'uncertain':'interrupted';record.finished_at=Date.now();
      await putLarge(this.ctx.storage,'visual-result',errorResult('Attempt interrupted; no inference was resubmitted.'));
    }
    if(record.files.length&&record.cleanup_rounds<4) await this.cleanup(record,Date.now()+LIMITS.cleanupMs);
    if(Date.now()>=record.finished_at+LIMITS.cacheMs) {
      const count=await this.ctx.storage.get('visual-result:count');
      if(count!=null) await this.ctx.storage.delete(['visual-result:count',...Array.from({length:count},(_,i)=>`visual-result:${i}`)]);
      // Keep the identity tombstone, not source names or review text, indefinitely.
      delete record.sources;record.files=[];record.state='expired';await this.save(record);return;
    }
    const result=await getLarge(this.ctx.storage,'visual-result');
    if(result) await putLarge(this.ctx.storage,'visual-result',this.decorate(result,record));
    await this.save(record);
    await this.ctx.storage.setAlarm(record.files.length&&record.cleanup_rounds<4?Date.now()+30_000:record.finished_at+LIMITS.cacheMs);
  }
}
