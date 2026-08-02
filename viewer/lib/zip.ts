type Entry = { name: string; data: string | Uint8Array };
const encoder = new TextEncoder();
const table = new Uint32Array(256).map((_, n) => { let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; return c>>>0; });
function crc32(bytes:Uint8Array){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0}
function u16(n:number){return new Uint8Array([n&255,(n>>>8)&255])}
function u32(n:number){return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255])}
function join(parts:Uint8Array[]){const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.length}return out}
export function createZip(entries:Entry[]){
  const local:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  for(const entry of entries){const name=encoder.encode(entry.name),data=typeof entry.data==="string"?encoder.encode(entry.data):entry.data,crc=crc32(data);
    const header=join([u32(0x04034b50),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name]);
    local.push(header,data);central.push(join([u32(0x02014b50),u16(20),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));offset+=header.length+data.length;
  }
  const directory=join(central),body=join(local);return join([body,directory,u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(directory.length),u32(body.length),u16(0)]);
}
