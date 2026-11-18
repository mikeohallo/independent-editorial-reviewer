import {createLegacyVisual} from './generated/legacy-visual.mjs';
import {LIMITS} from './visual-limits.mjs';
import {priceConfig, workspaceConfiguration, driveAccessMode} from './io.mjs';

export const VISUAL_TOOLS = ['review_illustration','review_comic_lettering'];
export function imageMode(args) {
  if(!Array.isArray(args?.images)) return 'legacy';
  const hasDrive=args.images.some(x=>x&&Object.hasOwn(x,'drive_file_id'));
  for(const image of args.images) {
    if(!image||typeof image!=='object') continue; // Original validator handles this.
    if(Object.hasOwn(image,'drive_file_id')&&Object.hasOwn(image,'image_url')) throw Error('Each image requires exactly one locator.');
    if(hasDrive&&!Object.hasOwn(image,'drive_file_id')) throw Error('Use all Drive images or all legacy images; mixed locators are unsupported.');
  }
  return hasDrive?'drive':'legacy';
}
export function extendVisualSchema(tool) {
  if(!VISUAL_TOOLS.includes(tool.name)) return tool;
  const result=structuredClone(tool),schema=result.inputSchema;
  schema.properties.images.items.properties.drive_file_id={type:'string',pattern:'^[A-Za-z0-9_-]{10,200}$',description:'Private current PNG/JPEG in the approved workspace. Use all Drive images or all image_url images.'};
  const item=schema.properties.images.items;
  item.required=item.required.filter(x=>x!=='image_url');
  item.oneOf=[{required:['image_url'],not:{required:['drive_file_id']}},{required:['drive_file_id'],not:{required:['image_url']}}];
  schema.properties.request_key={type:'string',minLength:8,maxLength:128,description:'Required for Drive images. Reuse only for the identical request; failed or interrupted attempts are not restarted.'};
  schema.properties.max_cost_usd={type:'number',exclusiveMinimum:0,maximum:1,description:'Required for Drive images. Full authorized amount is permanently reserved against the shared daily cap.'};
  schema.allOf=[{if:{properties:{images:{contains:{required:['drive_file_id']}}}},then:{required:['request_key','max_cost_usd'],properties:{images:{items:{required:['drive_file_id']}}}}}];
  return result;
}
export function privateConfiguration(env,args) {
  if(env.EDITORIAL_ENABLED!=='1') throw Error('Private image reviews are disabled.');
  for(const key of ['MCP_ACCESS_TOKEN','OPENAI_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','EDITORIAL_JOBS','EDITORIAL_BUDGET'])
    if(!env[key]) throw Error(`Server configuration missing: ${key}.`);
  workspaceConfiguration(env);driveAccessMode(env);
  const model=env.OPENAI_VISION_MODEL||env.OPENAI_MODEL||'gpt-6.1-sol',pricing=priceConfig(env);
  if(pricing.model!==model) throw Error('Vision model and verified editorial pricing model must match.');
  const cap=Math.min(1,Number(env.EDITORIAL_MAX_JOB_USD||1));
  if(!Number.isFinite(cap)||cap<=0||!Number.isFinite(args.max_cost_usd)||args.max_cost_usd<=0||args.max_cost_usd>cap)
    throw Error('max_cost_usd must be positive and within the configured cap (at most $1).');
  if(typeof args.request_key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(args.request_key)) throw Error('request_key must contain 8–128 letters, digits, underscores or hyphens.');
  if(!Array.isArray(args.images)||args.images.length<1||args.images.length>6) throw Error('Supply one page and at most five other images.');
  for(const image of args.images) if(typeof image.drive_file_id!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(image.drive_file_id)) throw Error('Invalid Drive identifier.');
  return {model,pricing};
}
function requestFor(name,args,env) {
  return new Request('https://reviewer.internal/mcp',{method:'POST',headers:{'x-api-key':env.MCP_ACCESS_TOKEN,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
}
export function legacyArguments(args) {
  const {request_key,max_cost_usd,...legacy}=args;
  return {...legacy,images:args.images.map(({drive_file_id,...image},i)=>({...image,image_url:`https://image-placeholder.invalid/${i}`}))};
}
export async function validateLegacy(name,args,env) {
  let payload;
  const wrapper=createLegacyVisual(async(url,options)=>{
    if(url!=='https://api.openai.com/v1/responses') throw Error('Unexpected legacy transport.');
    payload=JSON.parse(options.body);return Response.json({error:{message:'Validation transport only.'}},{status:400});
  });
  const reply=await(await wrapper.fetch(requestFor(name,legacyArguments(args),env),env)).json();
  if(!payload) throw Error(reply.result?.content?.[0]?.text||'Invalid visual review arguments.');
  return payload;
}
export async function normalizeLegacy(name,args,env,payload,response) {
  const wrapper=createLegacyVisual(async(url,options)=>{
    if(url!=='https://api.openai.com/v1/responses'||JSON.stringify(JSON.parse(options.body))!==JSON.stringify(payload))
      throw Error('Generated legacy payload changed during review.');
    return Response.json(response);
  });
  return (await(await wrapper.fetch(requestFor(name,legacyArguments(args),env),env)).json()).result;
}
// Validate the provider's strict schema before running the legacy formatter.
// This checks shape only; the original module remains the sole editorial ruleset.
export function validateSchema(value,schema) {
  if(schema.enum&&!schema.enum.includes(value)) throw Error('Model output violates the review schema.');
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(!types.includes(type)&&!(types.includes('integer')&&Number.isInteger(value))) throw Error('Model output violates the review schema.');
  if(type==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum))) throw Error('Model output violates the review schema.');
  if(type==='object') {
    for(const key of schema.required??[]) if(!Object.hasOwn(value,key)) throw Error('Model output is missing required review fields.');
    for(const [key,item] of Object.entries(value)) {
      if(schema.properties?.[key]) validateSchema(item,schema.properties[key]);
      else if(schema.additionalProperties===false) throw Error('Model output has unknown review fields.');
    }
  }
  if(type==='array') for(const item of value) validateSchema(item,schema.items);
}
export function validateResponse(response,payload) {
  if(response.status!=='completed') throw Error('Inference did not complete; no review verdict issued.');
  if(response.model&&response.model!==payload.model&&!response.model.startsWith(payload.model+'-')) throw Error('Returned model differs from the priced model.');
  const u=response.usage;
  if(!Number.isSafeInteger(u?.input_tokens)||!Number.isSafeInteger(u?.output_tokens)||u.input_tokens<0||u.output_tokens<0) throw Error('Usage is missing or invalid; accounting is uncertain.');
  const items=(response.output??[]).flatMap(x=>x.content??[]);
  if(items.some(x=>x.type==='refusal')) throw Error('Model refused; no review verdict issued.');
  let review;try {review=JSON.parse(items.filter(x=>x.type==='output_text').map(x=>x.text).join('\n\n'));}
  catch {throw Error('Model output is not review JSON; no inference retry.');}
  validateSchema(review,payload.text.format.schema);
  return u;
}
