import { createServer } from '../apps/api/server.js';
const name = process.argv[2];
if (!['observatory', 'daily'].includes(name)) throw new Error('Choose observatory or daily');
const port = Number(process.env.PORT || (name === 'observatory' ? 4312 : 4313));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
// Observatory includes the optional daily archive; no running workbench shell is required.
const server = createServer({ modules:name==='daily'?['daily']:['observatory','daily'], standalone:name });
server.on('error', e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`${name}: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close());
