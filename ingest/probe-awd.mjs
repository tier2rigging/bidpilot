import { get } from './fetch.mjs';
import fs from 'node:fs';
const MON=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const fold=(d)=>`${String(d.getUTCDate()).padStart(2,'0')}${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
const H=[['SPE7M125V8655P00001','2025-08-28'],['SPE7L124V4230P00001','2024-03-15'],['SPE7L124V2890','2024-01-29']];
const out={};
for(const [c,dt] of H){const base=c.replace(/P\d{5}$/,'');for(const name of [...new Set([c,base])])for(const off of [0,1,2,3,-1,-2,4,5,6,7]){const d=new Date(dt+'T00:00Z');d.setUTCDate(d.getUTCDate()+off);const u=`https://dibbs2.bsm.dla.mil/Downloads/Awards/${fold(d)}/${name}.PDF`;try{const b=await get(u,true);if(b&&b.subarray(0,4).toString()==='%PDF'){(out[c]=out[c]||[]).push(u+' '+b.length)}}catch(e){}}}
for(const v of ['SPE7M125V8655','SPE7L124V4230']){try{const h=await get(`https://www.dibbs.bsm.dla.mil/Awards/AwdRecs.aspx?Category=contract&TypeSrch=cq&Value=${v}`);out['search '+v]=(h.match(/Record Found:\s*\d+|Records Found:\s*[\d,]+/)||['?'])[0]+' '+[...h.matchAll(/Downloads\/Awards\/[^"']+/g)].map(m=>m[0]).join(' ')}catch(e){out['search '+v]='ERR '+e.message}}
fs.mkdirSync('data/lookup',{recursive:true});fs.writeFileSync('data/lookup/_probe.json',JSON.stringify(out,null,1));console.log(out);
