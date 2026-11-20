import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import miniflare from 'miniflare';
import {CATEGORIES} from '../src/editorial.mjs';
const {Miniflare,convertV4MiniflareOptions}=miniflare;
test('Cloudflare runtime: authenticated MCP, SQLite jobs, real alarms and saved reports',async()=>{
  let calls=0,uploads=0,saves=0;
  const cold={synopsis:'Ada opens a box.',pages:[{page:1,readable:true,panels:[{panel:'P1.1',observed_action:'Opens the gate.',causal_link:'Turning the key opens the gate.',uncertainties:[]}]}],breaks_in_understanding:[],limitations:[]};
  const report={overall_assessment:'The action is clear.',overall_score:8,verdict:'NO_MATERIAL_ISSUES_FOUND',ratings:CATEGORIES.map(category=>({category,score:8,reason:'Evidence supplied.'})),findings:[],strengths_to_preserve:['Clear action.'],revision_priorities:[],limitations:[],change_assessment:{net_change:'not_compared',evidence:[]},prior_issue_status:[]};
  const config={modules:true,script:await readFile(new URL('../.test-build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-11-17',cf:false,
    durableObjects:{EDITORIAL_JOBS:{className:'EditorialJob',useSQLite:true},EDITORIAL_BUDGET:{className:'EditorialBudget',useSQLite:true}},
    bindings:{EDITORIAL_ENABLED:'1',MCP_ACCESS_TOKEN:'runtime-test',OPENAI_API_KEY:'fake-key',GOOGLE_CLIENT_ID:'fake-id',GOOGLE_CLIENT_SECRET:'fake-secret',GOOGLE_REFRESH_TOKEN:'fake-refresh',WORKSPACE_ROOT_FOLDER_ID:'root1234567890',SUBMISSIONS_FOLDER_ID:'submit1234567890',REFERENCES_FOLDER_ID:'references123456',EDITORIAL_FOLDER_ID:'editorial123456',DRIVE_ACCESS_MODE:'file',GOOGLE_OAUTH_SCOPE:'https://www.googleapis.com/auth/drive.file'},
    outboundService:async request=>{
      const url=new URL(request.url),answer=x=>Response.json(x);
      if(url.hostname==='oauth2.googleapis.com')return answer({access_token:'fake-token',expires_in:3600});
      if(url.hostname==='www.googleapis.com'){
        if(url.pathname.startsWith('/upload/')){saves++;return answer({id:`saved${saves}`,name:'report',webViewLink:`https://drive.google.com/file/d/saved${saves}/view`});}
        if(url.pathname==='/drive/v3/files')return answer({files:[]});
        if(url.pathname.endsWith('/generateIds'))return answer({ids:['reserved_report_1','reserved_report_2']});
        if(url.pathname.includes('/reserved_report_'))return new Response('{}',{status:404});
        const id=url.pathname.split('/').at(-1);return answer({id,name:'folder',mimeType:'application/vnd.google-apps.folder',parents:id==='root1234567890'?[]:['root1234567890'],version:'1'});
      }
      if(url.hostname==='api.openai.com'){
        if(url.pathname==='/v1/files')return answer({id:`file_${++uploads}`});
        if(request.method==='DELETE')return answer({deleted:true});
        if(url.pathname.endsWith('/input_tokens'))return answer({input_tokens:100});
        if(url.pathname==='/v1/responses'){
          calls++;const payload=await request.json(),data=payload.text.format.name==='editorial_cold_read'?cold:report;
          return answer({id:`resp_${calls}`,status:'completed',model:'gpt-6.1-sol',usage:{input_tokens:100,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]});
        }
      }
      throw Error('Network access not mocked: '+url.href);
    }};
  const mf=new Miniflare(convertV4MiniflareOptions(config));
  try{
    const health=await(await mf.dispatchFetch('https://reviewer.test/health')).json();assert.equal(health.legacy_engine,'4.1.0');
    const request=(name,args,token='runtime-test')=>mf.dispatchFetch('https://reviewer.test/mcp',{method:'POST',headers:{'x-api-key':token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    assert.equal((await request('start_editorial_review',{},'wrong')).status,401);
    const start=await(await request('start_editorial_review',{request_key:'runtime-review-1',mode:'script',artifact_kind:'script',revision:'fixture',source:{text:'PAGE 1. P1.1 Ada opens the box.'},expected_pages:1,panel_manifest:[{page:1,panels:['P1.1']}],max_cost_usd:2})).json();
    assert.ok(!start.result.isError,JSON.stringify(start));const id=start.result.structuredContent.job_id;
    let status;
    for(let n=0;n<50;n++){
      status=(await(await request('get_editorial_review',{job_id:id})).json()).result.structuredContent;
      if(['completed','completed_save_failed','blocked','failed'].includes(status.status))break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(status.status,'completed',JSON.stringify(status));assert.equal(calls,2);assert.equal(saves,2);assert.match(status.markdown,/Page 1/);
  }finally{await mf.dispose();}
});

// Included by the existing runtime command and release checks without changing CI.
import './visual.runtime.mjs';
