import jpeg from 'jpeg-js';
import {LIMITS} from './visual-limits.mjs';

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels)
    throw Error('Image exceeds the dimension or pixel limit.');
  return {width, height, pixels: width * height};
}
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const fail = () => { throw Error('Invalid or unsupported image encoding.'); };

async function png(bytes, signal, remainingPixels) {
  if (![137,80,78,71,13,10,26,10].every((x,i) => bytes[i] === x)) fail();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), data = [];
  let offset = 8, info, depth, color, interlace, palette = 0, ended = false, dataEnded = false, ancillary = 0, chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) fail();
    const size = v.getUint32(offset), end = offset + size + 12;
    if (end > bytes.length) fail();
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(name) || name[2] !== name[2].toUpperCase() ||
        crc(bytes.subarray(offset + 4, end - 4)) !== v.getUint32(end - 4)) fail();
    const p = offset + 8;
    if (!info && name !== 'IHDR') fail();
    if (name === 'IHDR') {
      if (info || size !== 13) fail();
      info = dimensions(v.getUint32(p), v.getUint32(p + 4));
      if (info.pixels > remainingPixels) throw Error('Combined image pixels exceed the aggregate limit.');
      depth = bytes[p + 8]; color = bytes[p + 9]; interlace = bytes[p + 12];
      const depths = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if (!depths[color]?.includes(depth) || bytes[p+10] || bytes[p+11] || interlace > 1) fail();
    } else if (name === 'PLTE') {
      if (palette || data.length || !size || size % 3 || size > 768 || [0,4].includes(color)) fail();
      palette = size / 3;
      if (color === 3 && palette > 2 ** depth) fail();
    } else if (name === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) fail();
      data.push(bytes.subarray(p, p + size));
    } else if (name === 'IEND') {
      if (size || !data.length || end !== bytes.length) fail();
      ended = true;
    } else {
      if (name[0] === name[0].toUpperCase() || ['acTL','fcTL','fdAT'].includes(name)) fail();
      ancillary += size;
      if (ancillary > LIMITS.jsonBytes) throw Error('Image metadata exceeds the validation limit.');
    }
    if (data.length && name !== 'IDAT') dataEnded = true;
    offset = end;
  }
  if (!ended) fail();
  const channels = {0:1,2:3,3:1,4:2,6:4}[color], bpp = Math.max(1, Math.ceil(channels * depth / 8));
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.map(([x,y,dx,dy]) => ({width: Math.max(0, Math.ceil((info.width-x)/dx)), height: Math.max(0, Math.ceil((info.height-y)/dy))})).filter(p => p.width && p.height);
  let part = 0, partOffset = 0, pass = 0, row = 0, column = -1, filter, prior, current;
  const startPass = () => { const size = Math.ceil(rows[pass].width * channels * depth / 8); prior = new Uint8Array(size); current = new Uint8Array(size); };
  startPass();
  const stream = new ReadableStream({pull(c) {
    while(part<data.length&&partOffset===data[part].length){part++;partOffset=0;}
    if(part===data.length){c.close();return;}
    // Bound each native inflater write even for highly compressible malicious data.
    const end=Math.min(partOffset+2048,data[part].length);c.enqueue(data[part].subarray(partOffset,end));partOffset=end;
  }}).pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  let rejectAbort;
  const aborted = new Promise((_,reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(Error('Image validation deadline exceeded.')); void reader.cancel().catch(()=>{}); };
  signal?.addEventListener('abort', abort, {once:true}); if (signal?.aborted) abort();
  try {
    for (;;) {
      const {done,value} = await Promise.race([reader.read(), aborted]); if (done) break;
      for (const byte of value) {
        if (pass >= rows.length) fail();
        if (column === -1) { if (byte > 4) fail(); filter = byte; column = 0; continue; }
        const a = column >= bpp ? current[column-bpp] : 0, b = prior[column], c = column >= bpp ? prior[column-bpp] : 0;
        let predictor = 0;
        if (filter === 1) predictor = a;
        if (filter === 2) predictor = b;
        if (filter === 3) predictor = (a+b) >>> 1;
        if (filter === 4) { const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); predictor=pa<=pb&&pa<=pc?a:pb<=pc?b:c; }
        current[column++] = (byte + predictor) & 255;
        if (column === current.length) {
          if (color === 3) for (let x=0;x<rows[pass].width;x++) {
            const index=(current[Math.floor(x*depth/8)] >> (8-depth-(x*depth)%8)) & ((1<<depth)-1);
            if (index >= palette) fail();
          }
          [prior,current]=[current,prior]; column=-1;
          if (++row === rows[pass].height) { pass++; row=0; if (pass<rows.length) startPass(); }
        }
      }
    }
    if (pass !== rows.length || column !== -1) fail();
  } finally { signal?.removeEventListener('abort',abort); await reader.cancel().catch(()=>{}); }
  return {...info, orientation: null, format: 'png'};
}
function orientation(bytes) {
  if (bytes.length < 6 || String.fromCharCode(...bytes.subarray(0,6)) !== 'Exif\0\0') return null;
  const t = new DataView(bytes.buffer, bytes.byteOffset+6, bytes.byteLength-6);
  if (t.byteLength<8) fail();
  const little=t.getUint16(0)===0x4949;
  if ((!little && t.getUint16(0)!==0x4d4d)||t.getUint16(2,little)!==42) fail();
  const offset=t.getUint32(4,little); if (offset+2>t.byteLength) fail();
  const count=t.getUint16(offset,little); if (offset+2+count*12+4>t.byteLength) fail();
  for (let i=0;i<count;i++) {
    const p=offset+2+i*12;
    if (t.getUint16(p,little)===0x112) {
      if(t.getUint16(p+2,little)!==3||t.getUint32(p+4,little)!==1) fail();
      const value=t.getUint16(p+8,little); if(value<1||value>8) fail(); return value;
    }
  }
  return null;
}
function jpg(bytes, signal, remainingPixels) {
  if (bytes[0]!==255||bytes[1]!==216) fail();
  let offset=2, info, exif=null, scans=0, ended=false, auxiliary=0, allocation=0;
  while(offset<bytes.length) {
    if(bytes[offset++]!==255) fail();
    while(bytes[offset]===255) offset++;
    const marker=bytes[offset++];
    if(marker===217) { if(offset!==bytes.length||!scans) fail(); ended=true; break; }
    if(marker===216||marker===0||marker===1||(marker>=208&&marker<=215)||offset+2>bytes.length) fail();
    const size=(bytes[offset]<<8)|bytes[offset+1], end=offset+size;
    if(size<2||end>bytes.length) fail();
    if([192,193,194].includes(marker)) {
      if(info||size<8||bytes[offset+2]!==8) fail();
      info=dimensions((bytes[offset+5]<<8)|bytes[offset+6],(bytes[offset+3]<<8)|bytes[offset+4]);
      if(info.pixels>remainingPixels) throw Error('Combined image pixels exceed the aggregate limit.');
      const components=bytes[offset+7]; if(![1,3,4].includes(components)||size!==8+components*3) fail();
      let h=0,v=0,blocks=0; const sampling=[],ids=new Set();
      for(let i=0;i<components;i++) {
        const p=offset+8+i*3,id=bytes[p],x=bytes[p+1]>>4,y=bytes[p+1]&15;
        if(ids.has(id)||!x||!y||x>4||y>4||bytes[p+2]>3) fail();
        ids.add(id); h=Math.max(h,x);v=Math.max(v,y);blocks+=x*y;sampling.push([x,y]);
      }
      if(blocks>10) fail();
      // Account for coefficient arrays AND per-block objects/row arrays, component
      // planes, and both RGB output buffers used by jpeg-js. Encoded bytes are separate.
      for(const [x,y] of sampling) allocation+=Math.ceil(info.width/(h*8))*Math.ceil(info.height/(v*8))*x*y*400;
      allocation+=info.pixels*(components+6)+1024*1024;
      if(allocation>LIMITS.decoderMiB*1024**2) throw Error('JPEG decoder allocation limit exceeded. Supply a smaller image.');
    } else if(marker>=192&&marker<=207&&![196,219,221].includes(marker)) fail();
    if((marker>=224&&marker<=239)||marker===254) {
      auxiliary+=size; if(auxiliary>LIMITS.jsonBytes) throw Error('Image metadata exceeds the validation limit.');
      if(marker===225) { const value=orientation(bytes.subarray(offset+2,end)); if(value!==null) { if(exif!==null&&exif!==value) fail(); exif=value; } }
    }
    offset=end;
    if(marker===218) {
      if(!info||++scans>128) fail();
      while(offset<bytes.length) {
        if(bytes[offset++]!==255) continue;
        const start=offset-1; while(bytes[offset]===255) offset++;
        if(bytes[offset]===0||(bytes[offset]>=208&&bytes[offset]<=215)) { offset++;continue; }
        offset=start;break;
      }
    }
  }
  if(!ended||!info) fail();
  signal?.throwIfAborted();
  // Passing the exact ArrayBuffer avoids jpeg-js copying the compressed image.
  const decoded=jpeg.decode(bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes.buffer:bytes,
    {useTArray:true,formatAsRGBA:false,tolerantDecoding:false,maxResolutionInMP:8,maxMemoryUsageInMB:LIMITS.decoderMiB});
  if(decoded.width!==info.width||decoded.height!==info.height||decoded.data.length!==info.pixels*3) fail();
  signal?.throwIfAborted();
  return {...info,orientation:exif,format:'jpeg',decoder_allocation_ceiling:allocation};
}
export async function validateImage(bytes, mime, signal, remainingPixels=LIMITS.totalPixels) {
  if(!bytes.length||bytes.length>LIMITS.fileBytes) throw Error('Image byte limit exceeded.');
  try {
    if(mime==='image/png') return await png(bytes,signal,remainingPixels);
    if(mime==='image/jpeg') return jpg(bytes,signal,remainingPixels);
    fail();
  } catch(e) { if(e instanceof RangeError) throw Error('Invalid image structure.'); throw e; }
}
