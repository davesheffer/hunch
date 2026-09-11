import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgentCli, readAgentCliConfig, discoverAgentClis, type AgentCliAdapter } from "../src/synthesis/cliAdapter.js";
import { withInitiator } from "../src/synthesis/initiator.js";

test("custom stdin CLI receives literal input and initiating identity without a shell prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cli-adapter-"));
  try {
    const file = join(root, "worker with spaces.mjs");
    writeFileSync(file, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d=>input+=d); process.stdin.on('end',()=>console.log(JSON.stringify({input,origin:process.env.HUNCH_INITIATOR})));`);
    const adapter: AgentCliAdapter = { name: "custom", command: process.execPath, args: [file], protocol: "stdin", probe_args: ["--version"], timeout_ms: 5000 };
    const prompt = 'literal `command` $(command) & %PATH% "quoted"\nשלום';
    const output = await withInitiator({ provider: "custom", source: "explicit" }, () => runAgentCli(adapter, prompt));
    assert.deepEqual(JSON.parse(output), { input: prompt, origin: "custom" });
    const config = join(root, "adapters.json");
    writeFileSync(config, JSON.stringify([adapter]));
    assert.equal(discoverAgentClis(readAgentCliConfig(config), "custom")[0]!.name, "custom");
    writeFileSync(config, JSON.stringify([adapter, adapter]));
    assert.throws(() => readAgentCliConfig(config), /duplicate/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP initializes a fresh session, streams only assistant text and denies tool requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-acp-adapter-"));
  try {
    const file = join(root, "acp.mjs");
    writeFileSync(file, `
import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
let promptId;
let denied=0;
readline.createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
 else if(m.method==='session/new') {
   if(m.params.mcpServers.length)process.exit(3);
   send({id:m.id,result:{sessionId:'test'}});
 } else if(m.method==='session/prompt') {
   promptId=m.id;
   send({id:100,method:'session/request_permission',params:{}});
   send({id:101,method:'fs/read_text_file',params:{path:'/secret'}});
 } else if(m.id===100||m.id===101) {
   if(m.id===100&&m.result?.outcome?.outcome!=='cancelled')process.exit(4);
   if(m.id===101&&!m.error)process.exit(5);
   if(++denied===2) {
     send({method:'session/update',params:{sessionId:'test',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'not output'}}}});
     send({method:'session/update',params:{sessionId:'test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"action":"review"}'}}}});
     send({id:promptId,result:{stopReason:'end_turn'}});
   }
 }
});
`);
    const adapter: AgentCliAdapter = { name: "acp-test", command: process.execPath, args: [file], protocol: "acp", probe_args: ["--version"], timeout_ms: 5000 };
    assert.deepEqual(JSON.parse(await runAgentCli(adapter, "analyze supplied data only")), { action: "review" });
    writeFileSync(file, "setInterval(()=>{},1000);");
    await assert.rejects(runAgentCli({ ...adapter, timeout_ms: 1000 }, "data"), /timed out/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  }
});
