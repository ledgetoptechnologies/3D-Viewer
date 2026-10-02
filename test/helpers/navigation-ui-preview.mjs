// Full shipped Viewer shell and entrypoint, with synthetic local-only APIs.
// No client assets, production credentials, or real dataset modifications.
import {createServer} from 'vite';
const model={id:'navigation-qa',title:'Navigation QA — synthetic, no client data',assets:{obj:'/synthetic-only.obj'},georef:{rtc:{e:0,n:0,z:0},bboxCenter:{x:0,y:0,z:0},utmZone:16},lodAvailability:{status:'unavailable'}};
const port=Number(process.env.NAVIGATION_QA_PORT||8197);
const server=await createServer({server:{host:'127.0.0.1',port,strictPort:true},plugins:[{name:'navigation-synthetic-api',configureServer(vite){
  vite.middlewares.use((req,res,next)=>{
    if(!req.url.startsWith('/api/'))return next();
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/models')return res.end(JSON.stringify([{id:model.id,title:model.title}]));
    if(req.url===`/api/models/${model.id}`)return res.end(JSON.stringify(model));
    res.statusCode=404;res.end(JSON.stringify({error:'Synthetic local QA only'}));
  });
}}]});
await server.listen();console.log(`Synthetic Viewer navigation QA: http://127.0.0.1:${port}`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.close();process.exit(0);});
