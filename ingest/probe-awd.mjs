import fs from 'node:fs';
const out={};
for(const piid of ['SPE7M125V8655','SPE7L124V4230','SPE7L124V2890']){
  try{
    const r=await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filters:{award_type_codes:['A','B','C','D'],keywords:[piid],time_period:[{start_date:'2007-10-01',end_date:'2026-12-31'}]},fields:['Award ID','Recipient Name','Award Amount','Start Date','End Date','Description','generated_internal_id','Last Modified Date'],limit:5})});
    const j=await r.json();out[piid]={status:r.status,res:j.results||j};
    const id=(j.results||[])[0]?.generated_internal_id;
    if(id){const t=await fetch('https://api.usaspending.gov/api/v2/transactions/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({award_id:id,limit:10,sort:'action_date',order:'asc'})});const tj=await t.json();out[piid].tx=(tj.results||tj)}
  }catch(e){out[piid]='ERR '+e.message}
}
fs.mkdirSync('data/lookup',{recursive:true});fs.writeFileSync('data/lookup/_probe.json',JSON.stringify(out,null,1));
