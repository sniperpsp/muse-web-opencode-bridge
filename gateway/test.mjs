// Teste de tradução (sem rede): node gateway/test.mjs
process.env.UPSTREAM_KEY = "x";
import assert from "node:assert/strict";
const { toOpenAI, fromOpenAI, unwrapFinal, chainFor, isWarming, demandOf, orderChain, salvageToolCall, compactMessages } = await import("./server.js");

const req = toOpenAI({
  system: [{ type: "text", text: "sys" }],
  tools: [{ name: "Read", description: "d", input_schema: { type: "object", properties: { p: { type: "string" } } } }],
  messages: [
    { role: "user", content: "oi" },
    { role: "assistant", content: [{ type: "text", text: "vou ler" }, { type: "tool_use", id: "t1", name: "Read", input: { p: "a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "conteudo" }] }, { type: "text", text: "continue" }] },
  ],
});
assert.equal(req.messages[0].role, "system");
assert.equal(req.messages[2].tool_calls[0].function.arguments, '{"p":"a"}');
assert.deepEqual(req.messages[3], { role: "tool", tool_call_id: "t1", content: "conteudo" });
assert.deepEqual(req.messages[4], { role: "user", content: "continue" });
assert.equal(req.tools[0].function.name, "Read");

const out = fromOpenAI({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"p":"b"}' } }] }, finish_reason: "tool_calls" }] }, "m");
assert.equal(out.stop_reason, "tool_use");
assert.deepEqual(out.content[0], { type: "tool_use", id: "c1", name: "Read", input: { p: "b" } });
assert.equal(unwrapFinal('{"type":"final","text":"Oi!"}'), "Oi!");
assert.equal(unwrapFinal('{"type":"final","text":"Oi! só "oi"."}'), 'Oi! só "oi".');
assert.equal(unwrapFinal("texto normal {x}"), "texto normal {x}");
// Prompt gigante (como o Claude Code com muitas ferramentas MCP) precisa caber no orçamento.
const big = toOpenAI({
  system: "x".repeat(80000),
  tools: [
    ...["Read", "Edit", "Bash"].map((name) => ({ name, description: "d".repeat(3000), input_schema: { type: "object", properties: { a: { type: "string", description: "p".repeat(500) } } } })),
    ...Array.from({ length: 200 }, (_, i) => ({ name: `mcp__srv__t${i}`, description: "d".repeat(2000), input_schema: { type: "object", properties: { a: { type: "string", description: "p".repeat(300) } } } })),
  ],
  messages: [{ role: "user", content: "oi" }],
});
const size = big.messages[0].content.length + JSON.stringify(big.tools).length;
assert.ok(size <= 60000, `prompt fixo com ${size} chars`);
assert.deepEqual(big.tools.map((t) => t.function.name), ["Read", "Edit", "Bash"]);
const bk = ["deepseek", "muse", "chatgpt"].map((name) => ({ name }));
const routes = { haiku: ["chatgpt", "muse"], default: ["deepseek", "muse", "chatgpt"] };
assert.deepEqual(chainFor("claude-haiku-5-5", bk, routes).map((b) => b.name), ["chatgpt", "muse"]);
assert.deepEqual(chainFor("claude-sonnet-5-5", bk, routes).map((b) => b.name), ["deepseek", "muse", "chatgpt"]);
assert.deepEqual(chainFor("qualquer", bk, {}).map((b) => b.name), ["deepseek", "muse", "chatgpt"]);
const tiers = { tiers: [{ max: 6000, chain: ["muse", "chatgpt"] }, { chain: ["deepseek", "muse"] }] };
assert.deepEqual(chainFor("x", bk, tiers, 100).map((b) => b.name), ["muse", "chatgpt"]);
assert.deepEqual(chainFor("x", bk, tiers, 6000).map((b) => b.name), ["muse", "chatgpt"]);
assert.deepEqual(chainFor("x", bk, tiers, 6001).map((b) => b.name), ["deepseek", "muse"]);
assert.ok(demandOf({ messages: [{ role: "user", content: "oi" }] }) > 0);
const pool = [{ name: "ds", group: "deepseek" }, { name: "ds2", group: "deepseek" }, { name: "ds3", group: "deepseek" }, { name: "muse" }];
const ld = { ds: 1, ds2: 0, ds3: 0, muse: 0 };
assert.deepEqual(chainFor("x", pool, { tiers: [{ chain: ["deepseek", "muse"] }] }).map((b) => b.name), ["ds", "ds2", "ds3", "muse"]);
assert.deepEqual(orderChain(pool, (b) => ld[b.name], (b) => b.name !== "ds2").map((b) => b.name), ["ds3", "ds2", "ds", "muse"]);
assert.deepEqual(orderChain(pool, () => 0, () => true, (b) => b.name === "ds").map((b) => b.name), ["ds2", "ds3", "muse", "ds"]);
const names = ["grep", "Read", "bash"];
assert.deepEqual(salvageToolCall('{"type":"grep","pattern":"A|B","limit":100}', names), { name: "grep", input: { pattern: "A|B", limit: 100 }, pre: "" });
assert.deepEqual(salvageToolCall('{"type":"tool_call","name":"read","arguments":{"path":"a.lua"}}', names), { name: "Read", input: { path: "a.lua" }, pre: "" });
assert.deepEqual(salvageToolCall('```json\n{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}\n```', names), { name: "bash", input: { command: "ls" }, pre: "" });
assert.equal(salvageToolCall('{"type":"final","text":"oi"}', names), null);
assert.equal(salvageToolCall('{"type":"outra","x":1}', names), null);
assert.equal(salvageToolCall("texto normal", names), null);
assert.equal(salvageToolCall('{"type":"grep","pattern":"x"}', []), null);
const fx = fromOpenAI({ choices: [{ message: { content: '{"type":"grep","pattern":"x"}' }, finish_reason: "stop" }] }, "m", names);
assert.equal(fx.stop_reason, "tool_use");
assert.equal(fx.content[0].type, "tool_use");
const hist = [{ role: "user", content: "TAREFA INICIAL" }];
for (let i = 0; i < 40; i++) {
  hist.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "grep", input: { p: i } }] });
  hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(20000) }] });
}
const cm = compactMessages(hist, 60000);
assert.ok(JSON.stringify(cm).length <= 60000, "compactou");
assert.equal(cm[0].content, "TAREFA INICIAL");
assert.deepEqual(cm.at(-1), hist.at(-1));
const usedIds = new Set(cm.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").map((b) => b.id) : [])));
assert.ok(cm.every((m) => !Array.isArray(m.content) || m.content.every((b) => b.type !== "tool_result" || usedIds.has(b.tool_use_id))), "sem tool_result órfão");
assert.equal(compactMessages([{ role: "user", content: "oi" }], 1000).length, 1);
const leak = 'json\n1\n2\n3\n4\n5\n6\n7\n{\n  "type": "tool_call",\n  "name": "shell",\n  "arguments": {\n    "command": "flock -w 900 /tmp/x.lock -c \'python3 t.py\'"\n  }\n}';
assert.deepEqual(salvageToolCall(leak, names), { name: "bash", input: { command: "flock -w 900 /tmp/x.lock -c 'python3 t.py'" }, pre: "" });
assert.equal(salvageToolCall(leak, ["grep", "Read"]), null, "sem bash declarado não converte");
const withPre = salvageToolCall('Vou rodar o teste.\n{"name":"shell","arguments":{"cmd":"ls"}}', names);
assert.equal(withPre.pre, "Vou rodar o teste.");
assert.deepEqual(withPre.input, { command: "ls" });
assert.ok(isWarming("", "muse_browser_reconnecting") && isWarming("Chromium ainda está reconectando") && isWarming("A página ainda não ficou pronta") && !isWarming("prompt grande demais"));
console.log("ok");
