const fs=require('fs');
const p='src/renderer/app/pages/Productos.jsx';
let s=fs.readFileSync(p,'utf8');
if(s.includes('btn-sm')) console.log('has'); else console.log('no');
