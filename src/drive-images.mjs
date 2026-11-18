import {metadata, assertWorkspaceFolderLayout, assertWorkspaceSource, driveFetch, sha256, stable} from './io.mjs';
import {validateImage} from './image-validation.mjs';
import {LIMITS, readBounded, visualAPI} from './visual-limits.mjs';

const roleFor = image => image.role === 'reference' ? 'reference' : 'current';
function imageMultipart(bytes,mime,index,format) {
  const boundary='image_'+crypto.randomUUID();
  const encoder=new TextEncoder();
  const field=(name,value)=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const prefix=encoder.encode(field('purpose','user_data')+field('expires_after[anchor]','created_at')+
    field('expires_after[seconds]','86400')+`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source-${index+1}.${format==='png'?'png':'jpg'}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const suffix=encoder.encode(`\r\n--${boundary}--\r\n`);
  let stage=0,offset=0;
  // Avoid Blob and FormData materializing additional whole-image copies.
  const body=new ReadableStream({pull(controller){
    if(stage===0){stage=1;controller.enqueue(prefix);return;}
    if(offset<bytes.length){const end=Math.min(offset+64*1024,bytes.length);controller.enqueue(bytes.subarray(offset,end));offset=end;return;}
    controller.enqueue(suffix);controller.close();
  }});
  return {method:'POST',headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`},body,duplex:'half'};
}
function snapshot(m) {
  return {id:m.id,name:m.name,originalFilename:m.originalFilename??null,mimeType:m.mimeType,
    parents:[...(m.parents??[])].sort(),version:m.version,headRevisionId:m.headRevisionId??null,
    modifiedTime:m.modifiedTime,size:m.size,trashed:m.trashed??false,shortcutDetails:m.shortcutDetails??null};
}
function validateMetadata(m) {
  if(m.trashed||m.shortcutDetails||!['image/png','image/jpeg'].includes(m.mimeType))
    throw Error('Private images must be current PNG or JPEG files, not shortcuts or trashed files.');
  if(typeof m.name!=='string'||m.name.length>1024||(m.originalFilename!=null&&(typeof m.originalFilename!=='string'||m.originalFilename.length>1024))||
      !Array.isArray(m.parents)||m.parents.length!==1||typeof m.version!=='string'||m.version.length>200||typeof m.modifiedTime!=='string'||m.modifiedTime.length>100||
      !/^\d+$/.test(String(m.size))||!Number.isSafeInteger(Number(m.size))||Number(m.size)<1||Number(m.size)>LIMITS.fileBytes)
    throw Error('Image metadata is incomplete or exceeds the file byte limit.');
}
async function recheck(env, images, originals, context) {
  context.cache.clear(); await assertWorkspaceFolderLayout(env,context);
  for(let i=0;i<images.length;i++) {
    const current=await metadata(env,images[i].drive_file_id,context);
    if(stable(snapshot(current))!==stable(snapshot(originals[i]))) throw Error('Source changed during preparation. No inference started.');
    await assertWorkspaceSource(env,current,roleFor(images[i]),context);
  }
}
export async function prepareImages(env,images,context,hooks) {
  // Authorize the complete set before fetching any source bytes.
  await assertWorkspaceFolderLayout(env,context);
  const originals=[]; let bytesTotal=0,pixelsTotal=0;
  for(const image of images) {
    const m=await metadata(env,image.drive_file_id,context); validateMetadata(m);
    await assertWorkspaceSource(env,m,roleFor(image),context);
    bytesTotal+=Number(m.size); if(bytesTotal>LIMITS.totalBytes) throw Error('Combined image bytes exceed the 30 MiB limit.');
    originals.push(m);
  }
  const sources=[];
  for(let i=0;i<images.length;i++) {
    context.signal.throwIfAborted();
    const m=originals[i];
    const response=await driveFetch(env,`https://www.googleapis.com/drive/v3/files/${m.id}?alt=media&supportsAllDrives=true`,{},context);
    const bytes=await readBounded(response,Number(m.size),context.signal,true);
    const info=await validateImage(bytes,m.mimeType,context.signal,LIMITS.totalPixels-pixelsTotal);
    pixelsTotal+=info.pixels;
    await recheck(env,[images[i]],[m],context);
    const source={...snapshot(m),role:images[i].role,label:images[i].label,bytes:bytes.length,
      sha256:await sha256(bytes),width:info.width,height:info.height,orientation:info.orientation,
      transformed:false};
    // A lost upload response cannot reveal an ID. Persist the ambiguity before
    // uploading and request expiry as the independent fallback for that copy.
    await hooks.uploading();
    const file=await visualAPI(env,context,'/files',imageMultipart(bytes,m.mimeType,i,info.format));
    if(typeof file.id!=='string'||!/^file[-_][A-Za-z0-9_-]{1,200}$/.test(file.id)) throw Error('Upload did not return a valid file ID; expiry is the fallback.');
    await hooks.uploaded(file.id);
    sources.push({...source,file_id:file.id});
  }
  // A prior image can change while later images are being uploaded.
  await recheck(env,images,originals,context);
  return {sources, recheck:()=>recheck(env,images,originals,context)};
}
