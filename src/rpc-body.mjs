// Preserve the legacy UTF-16 character allowance without teeing an unbounded
// request stream. The byte ceiling also bounds malformed UTF-8 before parsing.
export async function readRPC(request) {
  if(Number(request.headers.get('content-length'))>16_000_000) throw Object.assign(Error('Request too large'),{status:413});
  const reader=request.body?.getReader();if(!reader) throw Error('Parse error');
  const decoder=new TextDecoder(),parts=[];let chars=0,bytes=0,pending='';
  const signal=AbortSignal.timeout(15_000);let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{rejectAbort(Error('Request body timed out'));void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    for(;;) {
      const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;
      bytes+=value.length;const text=decoder.decode(value,{stream:true});chars+=text.length;
      if(chars>16_000_000||bytes>48_000_000) throw Object.assign(Error('Request too large'),{status:413});
      pending+=text;
      if(pending.length>=16384){parts.push(pending);pending='';}
    }
    const end=decoder.decode();chars+=end.length;if(chars>16_000_000)throw Object.assign(Error('Request too large'),{status:413});parts.push(pending+end);
    const raw=parts.join('');parts.length=0;pending='';return {raw,body:JSON.parse(raw),bytes};
  } finally {signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
