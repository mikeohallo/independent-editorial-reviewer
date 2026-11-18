import {deflateSync} from 'node:zlib';
import jpeg from 'jpeg-js';
export function chunk(name,data=Buffer.alloc(0)) {
  const bytes=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
  for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
  const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([length,bytes,sum]);
}
export function png(width=2,height=2,{level=6,filter=0,extra=Buffer.alloc(0),color=6,depth=8,rawOverride,interlace=0}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=depth;header[9]=color;header[12]=interlace;
  const channels={0:1,2:3,3:1,4:2,6:4}[color],row=Math.ceil(width*channels*depth/8)+1;
  const raw=rawOverride??Buffer.alloc(row*height);if(!rawOverride)for(let i=0;i<height;i++)raw[i*row]=filter;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(color===3?[chunk('PLTE',Buffer.from([0,0,0]))]:[]),extra,chunk('IDAT',deflateSync(raw,{level})),chunk('IEND')]);
}
export function jpg(width=2,height=2){return jpeg.encode({width,height,data:Buffer.alloc(width*height*4,180)},80).data;}
export const imageArgs=(overrides={})=>({request_key:'test-visual-001',max_cost_usd:0.3,images:[{role:'page',label:'Synthetic page',drive_file_id:'test-image-001'}],checklist:[{id:'C1',panel:'P1',criterion:'The square is visible.'}],...overrides});
export const letteringArgs=(overrides={})=>({request_key:'test-lettering-001',max_cost_usd:0.3,images:[{role:'page',label:'Synthetic page',drive_file_id:'test-image-001'}],panels:[{panel:'P1',balloons:[{id:'B1',speaker:'Speaker A',text:'Hello.',kind:'speech'}]}],...overrides});
export const illustrationReview=()=>({verdict:'PASS',overall_assessment:'Synthetic assessment.',checklist_results:[{id:'C1',panel:'P1',mark:'PASS',evidence:'A square is visible.',corrective_action:'',confidence:'high'}],panel_findings:[],lettering_checks:[],strengths:[],limitations:[],next_actions:[]});
export const letteringReview=()=>({verdict:'PASS',overall_assessment:'Synthetic assessment.',balloon_results:[{id:'B1',panel:'P1',visual_location:'Upper left.',observed_text:'Hello.',observed_speaker:'Speaker A',text_mark:'PASS',speaker_mark:'PASS',tail_mark:'PASS',placement_mark:'PASS',order_mark:'PASS',style_mark:'PASS',severity:'none',confidence:'high',evidence:'Synthetic evidence.',repair_instruction:''}],panel_summaries:[{panel:'P1',summary:'One balloon.',reading_path:'Left to right.'}],additional_findings:[],limitations:[],priority_fixes:[]});
export const responseFor=payload=>({id:'resp_test_1',model:payload.model,status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(payload.text.format.name==='comic_lettering_v4'?letteringReview():illustrationReview())}]}]});
export const bindings=()=>({EDITORIAL_ENABLED:'1',MCP_ACCESS_TOKEN:'test-mcp-token',OPENAI_API_KEY:'test-openai-key',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',GOOGLE_REFRESH_TOKEN:'test-refresh',WORKSPACE_ROOT_FOLDER_ID:'test-root-folder',SUBMISSIONS_FOLDER_ID:'test-submissions',REFERENCES_FOLDER_ID:'test-references',EDITORIAL_FOLDER_ID:'test-reports-folder',DRIVE_ACCESS_MODE:'file',GOOGLE_OAUTH_SCOPE:'https://www.googleapis.com/auth/drive.file',EDITORIAL_DAILY_USD:'1',EDITORIAL_MAX_JOB_USD:'1'});
export function network(options={}) {
  const calls=[],files=options.files??new Map([['test-image-001',png()]]);let uploads=0;
  const handler=async(request,init)=>{
    const r=typeof request?.url==='string'?request:new Request(request,init),u=new URL(r.url);
    calls.push({url:u,method:r.method});
    if(options.handle){const answer=await options.handle(r,u,calls);if(answer)return answer;}
    if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'test-token',expires_in:3600});
    if(u.hostname==='www.googleapis.com') {
      const id=u.pathname.split('/').at(-1);
      if(u.searchParams.has('alt')) {if(!files.has(id))throw Error('Unexpected media ID');return new Response(files.get(id));}
      const folder=['test-root-folder','test-submissions','test-references','test-reports-folder'].includes(id);
      const m=folder?{id,name:'Synthetic folder',mimeType:'application/vnd.google-apps.folder',parents:id==='test-root-folder'?[]:['test-root-folder'],trashed:false}:
        {id,name:'synthetic.png',originalFilename:'synthetic-original.png',mimeType:options.mime??'image/png',parents:['test-submissions'],version:'1',headRevisionId:'test-revision',modifiedTime:'2026-01-01T00:00:00Z',size:String(files.get(id)?.length??100),trashed:false};
      if(options.metadata)options.metadata(m,calls);
      return Response.json(m);
    }
    if(u.hostname==='api.openai.com') {
      if(u.pathname==='/v1/files'&&r.method==='POST') {const form=await r.formData();options.uploaded?.(form);return Response.json({id:`file_test_${++uploads}`});}
      if(u.pathname.startsWith('/v1/files/')&&r.method==='DELETE')return Response.json({deleted:true});
      if(u.pathname==='/v1/responses/input_tokens'){const body=await r.json();options.counted?.(body);return Response.json({input_tokens:Object.hasOwn(options,'tokens')?options.tokens:100});}
      if(u.pathname==='/v1/responses'&&r.method==='POST'){const body=await r.json();options.inferred?.(body);return Response.json(options.response?options.response(body):responseFor(body));}
    }
    throw Error('Unmocked network request: '+u.pathname);
  };
  return {handler,calls,files,inferences:()=>calls.filter(x=>x.url.pathname==='/v1/responses'),media:()=>calls.filter(x=>x.url.searchParams.has('alt')),uploads:()=>uploads,deletes:()=>calls.filter(x=>x.method==='DELETE')};
}
