// Run locally on the reviewer's authorised computer, never in the hosted Worker.
// Credentials are written to an ignored local file, never printed to the console.
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
const mode=process.env.DRIVE_ACCESS_MODE||'file';
if(!['file','full'].includes(mode))throw Error('DRIVE_ACCESS_MODE must be file or full.');
if(mode==='full'&&process.env.BROAD_DRIVE_SCOPE_ACK!=='I_UNDERSTAND_FULL_DRIVE_ACCESS')throw Error('Full scope grants access to all files visible to the signed-in account. Set BROAD_DRIVE_SCOPE_ACK=I_UNDERSTAND_FULL_DRIVE_ACCESS only after consciously approving that risk; prefer a dedicated review-only Google account.');
const scope=mode==='file'?'https://www.googleapis.com/auth/drive.file':'https://www.googleapis.com/auth/drive';
const downloaded=JSON.parse(await readFile(process.argv[2]||'google-client.json','utf8'));
const client=downloaded.installed;
if(!client?.client_id||!client?.client_secret)throw Error('Use a Google OAuth Desktop app client JSON file.');
const state=randomBytes(24).toString('hex'),verifier=randomBytes(48).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const redirect=`http://127.0.0.1:${server.address().port}/oauth2/callback`;
const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
for(const [k,v] of Object.entries({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope,access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(k,v);
console.log('Google Drive OAuth scope requested: '+scope+'\nOpen this URL on the authorised computer. Connect only a deliberately chosen account for the clean review workspace:\n'+url.href);
let processing=false;
const timer=setTimeout(()=>{console.error('Sign-in timed out. Run the command again.');server.close();},10*60*1000);
server.on('request',async(req,res)=>{
  const incoming=new URL(req.url,redirect);
  if(incoming.pathname!=='/oauth2/callback'||incoming.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid callback.');return;}
  if(processing){res.writeHead(409);res.end('Already processing.');return;}processing=true;
  try{
    const code=incoming.searchParams.get('code');if(!code)throw Error('Sign-in was not completed.');
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,client_id:client.client_id,client_secret:client.client_secret,redirect_uri:redirect,grant_type:'authorization_code',code_verifier:verifier}),signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error(`Token exchange returned HTTP ${r.status}.`);
    const data=await r.json();if(!data.refresh_token)throw Error('Google did not return an offline refresh token.');
    if(!data.scope?.split(' ').includes(scope))throw Error('Google did not grant the requested OAuth scope.');
    await writeFile('google-secrets.json',JSON.stringify({GOOGLE_CLIENT_ID:client.client_id,GOOGLE_CLIENT_SECRET:client.client_secret,GOOGLE_REFRESH_TOKEN:data.refresh_token,GOOGLE_OAUTH_SCOPE:scope},null,2),{mode:0o600,flag:'wx'});
    res.writeHead(200,{'Content-Type':'text/plain'});res.end('Connected. Close this tab and return to your terminal.');
    console.log('Saved google-secrets.json. Upload it with: npx wrangler secret bulk google-secrets.json');
  }catch(e){res.writeHead(400,{'Content-Type':'text/plain'});res.end('Connection failed. Return to your terminal.');console.error(e.message);}
  finally{clearTimeout(timer);server.close();}
});
