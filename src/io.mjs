export const MAX_FILE_BYTES=20*1024*1024;
export const MAX_CONTEXT_BYTES=45*1024*1024;
const DRIVE='https://www.googleapis.com/drive/v3';
const OAI='https://api.openai.com/v1';
const tokens=new WeakMap();
export const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function sha256(value){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
export function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
async function bounded(response,max){
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>max)throw Error('Source exceeds the configured file-size limit.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('Source exceeds the configured file-size limit.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
export async function api(env,path,options={}){
  let r;
  try{r=await fetch(OAI+path,{...options,headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,...options.headers},redirect:'manual',signal:AbortSignal.timeout(55000)});}catch{throw Error('OpenAI network failure; a submitted request may have been accepted. No automatic paid resubmission.');}
  if(!r.ok)throw Error(`OpenAI HTTP ${r.status} at ${path.split('?')[0]}. Check API access, model and input limits; no paid request was automatically repeated.`);
  return r.status===204?{}:r.json();
}
export async function googleToken(env){
  const cached=tokens.get(env);if(cached&&cached.expires>Date.now()+60000)return cached.value;
  if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET||!env.GOOGLE_REFRESH_TOKEN)throw Error('Google Drive OAuth secrets are not configured.');
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'}),redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`Google OAuth HTTP ${response.status}; reconnect the server's Google account.`);
  const data=await response.json();if(!data.access_token)throw Error('Google did not return an access token.');
  driveAccessMode(env); // Prevent using credentials under a different declared access mode.
  tokens.set(env,{value:data.access_token,expires:Date.now()+Number(data.expires_in??3600)*1000});return data.access_token;
}
async function driveFetch(env,url,options={}){
  const r=await fetch(url,{...options,headers:{Authorization:`Bearer ${await googleToken(env)}`,...options.headers},redirect:'manual',signal:AbortSignal.timeout(45000)});
  if(!r.ok)throw Error(`Google Drive HTTP ${r.status}; verify server account access and file/folder permissions.`);return r;
}
export async function metadata(env,id){
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(id))throw Error('Invalid Drive identifier.');
  return (await driveFetch(env,`${DRIVE}/files/${id}?supportsAllDrives=true&fields=id,name,mimeType,parents,version,modifiedTime,size,trashed`)).json();
}
// Enforce the deliberately selected workspace at the server, independently of OAuth breadth.
// The root, submission, reference and report folders were created empty for this reviewer.
const ID_RE=/^[A-Za-z0-9_-]{10,200}$/;
export function driveAccessMode(env){
  const mode=env.DRIVE_ACCESS_MODE||'file';
  if(!['file','full'].includes(mode))throw Error('DRIVE_ACCESS_MODE must be file or full.');
  const expected=mode==='file'?'https://www.googleapis.com/auth/drive.file':'https://www.googleapis.com/auth/drive';
  if(env.GOOGLE_OAUTH_SCOPE!==expected)throw Error(`Google OAuth scope mismatch: reconnect using the ${mode} mode. Do not reuse a token granted to another mode.`);
  if(mode==='full'&&env.BROAD_DRIVE_SCOPE_ACK!=='I_UNDERSTAND_FULL_DRIVE_ACCESS')throw Error('Full Drive scope requires explicit BROAD_DRIVE_SCOPE_ACK. Prefer a separate, limited-access Google account.');
  return mode;
}
export function workspaceConfiguration(env){
  const keys=['WORKSPACE_ROOT_FOLDER_ID','SUBMISSIONS_FOLDER_ID','REFERENCES_FOLDER_ID','EDITORIAL_FOLDER_ID'];
  const values=keys.map(k=>env[k]);
  if(values.some(v=>typeof v!=='string'||!ID_RE.test(v)))throw Error('All four explicitly approved workspace folder IDs must be configured.');
  if(new Set(values).size!==4)throw Error('Workspace folders must be distinct.');
  return Object.fromEntries(keys.map((k,i)=>[k,values[i]]));
}
export async function assertWorkspaceFolderLayout(env){
  const c=workspaceConfiguration(env);
  const root=await metadata(env,c.WORKSPACE_ROOT_FOLDER_ID);
  if(root.trashed||root.mimeType!=='application/vnd.google-apps.folder')throw Error('Workspace root is missing or not a folder.');
  for(const key of ['SUBMISSIONS_FOLDER_ID','REFERENCES_FOLDER_ID','EDITORIAL_FOLDER_ID']){
    const m=await metadata(env,c[key]);
    if(m.trashed||m.mimeType!=='application/vnd.google-apps.folder'||!m.parents?.includes(c.WORKSPACE_ROOT_FOLDER_ID))
      throw Error(`${key} must be a direct child folder of the approved workspace root.`);
  }
  return c;
}
export async function assertWorkspaceSource(env,meta,role){
  const c=workspaceConfiguration(env);
  const allow={current:['SUBMISSIONS_FOLDER_ID'],previous:['SUBMISSIONS_FOLDER_ID'],
    script:['SUBMISSIONS_FOLDER_ID','REFERENCES_FOLDER_ID'],
    reference:['REFERENCES_FOLDER_ID'],context:['REFERENCES_FOLDER_ID']};
  if(!(role in allow))throw Error(`Unknown source role: ${role}`);
  if(meta.mimeType==='application/vnd.google-apps.folder')throw Error('A folder cannot be submitted as a review document.');
  if(meta.trashed)throw Error('Source is in Trash.');
  // Resolve all ancestors rather than trusting caller-provided names or ID prefixes.
  const allowed=new Set(allow[role].map(k=>c[k]));
  const queue=[...(meta.parents||[])],seen=new Set();let steps=0;
  while(queue.length){
    const id=queue.shift();if(seen.has(id))continue;seen.add(id);
    if(id===c.EDITORIAL_FOLDER_ID)throw Error('Report files cannot be used as inputs. Submit a clean copy through submissions/references.');
    if(id===c.WORKSPACE_ROOT_FOLDER_ID)continue;
    if(++steps>40)throw Error('Workspace source ancestry could not be verified.');
    const m=await metadata(env,id);
    if(m.trashed||m.mimeType!=='application/vnd.google-apps.folder')throw Error('Source ancestor is invalid or in Trash.');
    if(allowed.has(id)){
      // The allowed folder itself must still be immediately inside the approved root.
      if(m.parents?.includes(c.WORKSPACE_ROOT_FOLDER_ID))return;
      throw Error('Approved source folder moved outside the workspace.');
    }
    for(const parent of m.parents||[])queue.push(parent);
  }
  throw Error(`Drive file is outside the approved ${role} input folders. No source bytes fetched.`);
}
export async function assertReportFolder(env){
  const c=workspaceConfiguration(env);
  const root=await metadata(env,c.WORKSPACE_ROOT_FOLDER_ID);
  const m=await metadata(env,c.EDITORIAL_FOLDER_ID);
  if(root.trashed||root.mimeType!=='application/vnd.google-apps.folder'||m.trashed||m.mimeType!=='application/vnd.google-apps.folder'||!m.parents?.includes(root.id))
    throw Error('Report folder must be a direct child of the approved workspace root.');
}
export async function sourceBytes(env,source,kind,role='current'){
  let bytes,mime,label,version=null,modified_time=null,drive_id=null;
  if(source.text!=null){bytes=new TextEncoder().encode(source.text);mime='text/plain';label='submitted-script.txt';}
  else{
    const before=await metadata(env,source.drive_file_id);await assertWorkspaceSource(env,before,role);
    drive_id=before.id;version=before.version;modified_time=before.modifiedTime;label=before.name;
    mime=before.mimeType;
    if(kind==='comic'&&mime!=='application/pdf')throw Error('Comic review requires a PDF containing the actual page artwork.');
    let url;
    if(mime==='application/vnd.google-apps.document'){mime='text/plain';label+='.txt';url=`${DRIVE}/files/${before.id}/export?mimeType=text%2Fplain`;}
    else{
      if(!['application/pdf','text/plain','text/markdown','text/x-markdown','application/json','image/png','image/jpeg','image/webp'].includes(mime))throw Error(`Unsupported source format: ${mime}. Use PDF, text/Markdown, Google Docs or reference images.`);
      url=`${DRIVE}/files/${before.id}?alt=media&supportsAllDrives=true`;
    }
    bytes=await bounded(await driveFetch(env,url),MAX_FILE_BYTES);
    const after=await metadata(env,before.id);
    if(after.version!==before.version||after.modifiedTime!==before.modifiedTime)throw Error('Source changed while downloading. Submit a stable revision.');
    await assertWorkspaceSource(env,after,role);
  }
  if(!bytes.length)throw Error('Source file is empty.');
  if(mime==='application/pdf'&&new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('File metadata says PDF but the bytes are not a PDF.');
  if(kind==='comic'&&mime!=='application/pdf')throw Error('Comic source must be PDF.');
  if(kind==='script'&&mime.startsWith('image/'))throw Error('Script source must contain text or PDF.');
  const hash=await sha256(bytes);
  if(source.expected_sha256&&hash!==source.expected_sha256.toLowerCase())throw Error('Source SHA-256 differs from the requested revision.');
  return {bytes,mime,label,sha256:hash,version,modified_time,drive_id};
}
export async function uploadSnapshot(env,data){
  const form=new FormData();form.append('purpose','user_data');
  form.append('file',new Blob([data.bytes],{type:data.mime}),data.label);
  // Expiry is a fallback for an interrupted upload; normal completion deletes uploaded copies.
  form.append('expires_after[anchor]','created_at');form.append('expires_after[seconds]','86400');
  const f=await api(env,'/files',{method:'POST',body:form});
  if(typeof f.id!=='string')throw Error('OpenAI file upload did not return an ID.');
  const input=data.mime.startsWith('image/')?{type:'input_image',file_id:f.id,detail:'original'}:{type:'input_file',file_id:f.id,...(data.mime==='application/pdf'?{detail:'high'}:{})};
  return {label:data.label,sha256:data.sha256,version:data.version,modified_time:data.modified_time,drive_id:data.drive_id,bytes:data.bytes.length,file_id:f.id,input};
}
export function priceConfig(env){
  const model=env.EDITORIAL_MODEL||'gpt-6.1-sol';
  // Conservative short-context rates cover input cache writes up to 12h. No tools or regional endpoint.
  const builtIn={model:'gpt-6.1-sol',input_ceiling_per_million:5,output_per_million:10,verified_on:'2026-11-17'};
  const p=env.EDITORIAL_PRICING_JSON?JSON.parse(env.EDITORIAL_PRICING_JSON):builtIn;
  if(p.model!==model||!Number.isFinite(p.input_ceiling_per_million)||p.input_ceiling_per_million<=0||!Number.isFinite(p.output_per_million)||p.output_per_million<=0)throw Error('Configure verified EDITORIAL_PRICING_JSON for the selected model.');
  return p;
}
export function estimateCost(input,output,pricing){return (input*pricing.input_ceiling_per_million+output*pricing.output_per_million)/1000000;}
export async function putLarge(storage,key,value){
  const s=JSON.stringify(value),chunks=[];for(let i=0;i<s.length;i+=24000)chunks.push(s.slice(i,i+24000));
  const entries=Object.fromEntries(chunks.map((c,i)=>[`${key}:${i}`,c]));entries[`${key}:count`]=chunks.length;
  await storage.put(entries);
}
export async function getLarge(storage,key){
  const count=await storage.get(`${key}:count`);if(count==null)return null;
  const keys=Array.from({length:count},(_,i)=>`${key}:${i}`),parts=await storage.get(keys);
  return JSON.parse(keys.map(k=>parts.get(k)).join(''));
}
export async function reserveReportIds(env){
  const data=await (await driveFetch(env,`${DRIVE}/files/generateIds?count=2&space=drive&type=files`)).json();
  if(!Array.isArray(data.ids)||data.ids.length!==2||data.ids.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]+$/.test(x)))throw Error('Google Drive did not reserve report file IDs.');
  return data.ids;
}
export async function saveDriveReports(env,job,markdown,report,cold,snapshot){
  const title=`Editorial_${job.args.revision.replace(/[^A-Za-z0-9_-]/g,'_')}_${job.id.slice(0,12)}`;
  const files=[['md','text/markdown',markdown],['json','application/json',JSON.stringify({job_id:job.id,revision:job.args.revision,report,cold_read:cold,sources:snapshot,usage:job.usage},null,2)]];
  const results=[];
  for(const [index,[ext,mime,body]] of files.entries()){
    // IDs are reserved and persisted before upload. Lost responses cannot create duplicate reports.
    const tag=`${job.id}:${ext}`;
    const id=job.report_ids[index];
    const existing=await fetch(`${DRIVE}/files/${id}?supportsAllDrives=true&fields=id,name,webViewLink`,{headers:{Authorization:`Bearer ${await googleToken(env)}`},redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(existing.ok){results.push(await existing.json());continue;}
    if(existing.status!==404)throw Error(`Google Drive HTTP ${existing.status} checking the reserved report ID.`);
    const boundary='review_'+crypto.randomUUID().replace(/-/g,'');
    const meta={id,name:`${title}.${ext}`,mimeType:mime,parents:[env.EDITORIAL_FOLDER_ID],appProperties:{editorial_job:tag}};
    const multipart=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--\r\n`;
    const result=await (await driveFetch(env,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart})).json();
    results.push(result);
  }
  return results;
}
