/** bun tests/e2e/pi-child-work.smoke.ts /path/to/pi-subagents/bundle/index.js */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const plugin = process.argv[2]; if (!plugin) throw Error("pass installed pi-subagents bundle/index.js");
const dir = await mkdtemp(join(tmpdir(), "evok-native-smoke-"));
const home = join(dir, "pi"), cwd = join(dir, "work"), output = join(dir, "proof.json");
await Promise.all([mkdir(home), mkdir(cwd)]);
await writeFile(join(home, "AGENTS.md"), "AMBIENT_SECRET_SENTINEL");
let parentRequests = 0;
const calls: {tools: string[]; prior: boolean; key: string; clean: boolean; max: boolean}[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const key = req.headers.authorization ?? "";
  const messages = JSON.stringify(body.messages);
  const isChild = key.includes("round-");
  if (!isChild) parentRequests++;
  if (isChild) calls.push({key, tools: body.tools?.map((t:any) => t.function.name).sort(), prior: messages.includes("unique-native-history"),
    clean: !/AMBIENT_SECRET_SENTINEL|parent-transcript-marker|round-[12]-key/.test(messages), max: body.reasoning_effort === "max"});
  const args = {decision_tag: "阶段发现就绪", summary: "unique-native-history", evidence_refs: [], modified_files: []};
  const tool = {index: 0, id: "call"+calls.length, type: "function", function: {name: "evok_deliver", arguments: JSON.stringify(args)}};
  const chunk = (delta: object, finish_reason: string|null) => "data: " + JSON.stringify({id: "offline", model: body.model, created: 1,
    object: "chat.completion.chunk", choices: [{index:0,delta,finish_reason}],usage: {prompt_tokens:20,completion_tokens:10,total_tokens:30}}) + "\n\n";
  res.writeHead(200, {"Content-Type":"text/event-stream"});
  res.end(chunk(isChild ? {role:"assistant",tool_calls:[tool]} : {role:"assistant",content:"standby"}, null) + chunk({}, isChild?"tool_calls":"stop") + "data: [DONE]\n\n");
});
server.listen(0,"127.0.0.1"); await once(server,"listening");
const address=server.address(); if (!address || typeof address==="string") throw Error("missing local server");
const src = resolve(import.meta.dirname,"../../src");
const ext = join(dir, "fixture.ts");
await writeFile(ext, `
import { writeFileSync } from 'node:fs';
import { runPiWorker } from '${src}/execution/pi-child-work.ts';
import { assembleRoleContext } from '${src}/execution/role-context.ts';
import { createMemorySlice } from '${src}/execution/memory-slice.ts';
import { createCompetitionContract } from '${src}/competition/competition-contract.ts';
import { createRuleVisibilityPolicy } from '${src}/competition/rule-visibility.ts';
export default function(pi){
 const modelId='kimi-k3-1-pro-261024';
 const config={baseUrl:'http://127.0.0.1:${address.port}/v1',api:'openai-completions',apiKey:'parent-key',authHeader:true,models:[{id:modelId,name:'Test Kimi',reasoning:true,thinkingLevelMap:{off:null,low:'low',medium:null,high:'high',xhigh:null,max:'max'},input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1048576,maxTokens:32768,compat:{supportsDeveloperRole:false,supportsStrictMode:true}}]};
 pi.registerProvider('fixture-parent',config);
 pi.registerCommand('check',{description:'Exercise native subagents',handler:async()=>{try{
   pi.sendMessage({customType:'fixture',content:'parent-transcript-marker',display:false});
   const contract=createCompetitionContract({version:'1',competitionId:'offline',objective:'Improve.',scoring:{metric:'reward',direction:'maximize'},dataSplit:{kind:'group',holdout:'protected'},submission:{format:'json'},limits:{network:'restricted'}});
   const policy=createRuleVisibilityPolicy({competitionId:'offline',contractDigest:contract.digest,allow:{researcher:['scoring.metric']}});
   const results=[];
   for(let i=1;i<=2;i++){
     const id={missionId:'mission',taskId:'work',runId:'round'+i,targetAgentId:'node-A'};
     const memorySlice=createMemorySlice({...id,sliceId:'slice'+i});
     const roleContext=assembleRoleContext({...id,role:'researcher',contract,policy,objective:'Improve.',source:'offline',memoryDigest:memorySlice.digest});
     results.push(await runPiWorker(pi,{nodeId:'node-A',roleName:'analyst',profile:'diagnostic',cwd:${JSON.stringify(cwd)},stateDir:${JSON.stringify(join(dir,"state"))},task:'Deliver.',roleContext,memorySlice,
        nativePlugin:${JSON.stringify(resolve(plugin))}, model:{alias:'evok-meter-fixture',id:modelId,config:{...config,apiKey:'round-'+i+'-key'}},resumeRunId:results[0]?.nativeRunId,timeoutMs:35000}));
   }
   writeFileSync(${JSON.stringify(output)},JSON.stringify(results));
 }catch(e){writeFileSync(${JSON.stringify(output)},JSON.stringify({error:String(e),stack:e.stack}));}}});
}`);
const proc=spawn('pi',['--offline','--no-extensions','--no-mcp','-e',resolve(plugin),'-e',ext,'--model','fixture-parent/kimi-k3-1-pro-261024','--mode','rpc'],{
  cwd,env:{HOME:dir,PATH:process.env.PATH,PI_CODING_AGENT_DIR:home,PI_SUBAGENTS_TEMP_ROOT:join(dir,'runner-state'),PI_OFFLINE:'1',NO_COLOR:'1',TERM:'dumb'},stdio:['pipe','ignore','pipe']});
let stderr='';proc.stderr.on('data',d=>{stderr=(stderr+d).slice(-3000)});
const exit=once(proc,'exit');
try {
  proc.stdin.write('{"id":"fixture","type":"prompt","message":"/check"}\n');
  let results;
  for(let n=0;n<900 && proc.exitCode===null;n++) {const data=await readFile(output,'utf8').catch(()=>undefined); if(data){results=JSON.parse(data);break;} await delay(100);}
  assert.ok(Array.isArray(results), JSON.stringify({results,stderr,scratch:dir}));
  assert.equal(parentRequests,0);
  assert.deepEqual(results.map(r=>[r.toolTurns,r.remainingToolTurns]),[[1,7],[1,6]]);
  assert.notEqual(results[0].nativeRunId,results[1].nativeRunId);
  assert.deepEqual(results.map(r=>r.action.name),['evok_deliver','evok_deliver']);
  assert.deepEqual(calls,[1,2].map(i=>({key:'Bearer round-'+i+'-key',tools:['evok_deliver'],prior:i===2,clean:true,max:true})));
  console.log(JSON.stringify({nativeRuns:results.map(r=>r.nativeRunId), calls}));
} finally {proc.kill('SIGTERM');await exit;server.close(); if(process.env.EVOK_KEEP_FIXTURE!=='1') await rm(dir,{recursive:true,force:true});}
