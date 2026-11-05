// Teste de tradução (sem rede): node gateway/test.mjs
process.env.UPSTREAM_KEY = "x";
import assert from "node:assert/strict";
const { toOpenAI, fromOpenAI, unwrapFinal, chainFor, isWarming, demandOf, orderChain, salvageToolCall } = await import("./server.js");

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
assert.deepEqual(salvageToolCall('{"type":"grep","pattern":"A|B","limit":100}', names), { name: "grep", input: { pattern: "A|B", limit: 100 } });
assert.deepEqual(salvageToolCall('{"type":"tool_call","name":"read","arguments":{"path":"a.lua"}}', names), { name: "Read", input: { path: "a.lua" } });
assert.deepEqual(salvageToolCall('```json\n{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}\n```', names), { name: "bash", input: { command: "ls" } });
assert.equal(salvageToolCall('{"type":"final","text":"oi"}', names), null);
assert.equal(salvageToolCall('{"type":"outra","x":1}', names), null);
assert.equal(salvageToolCall("texto normal", names), null);
assert.equal(salvageToolCall('{"type":"grep","pattern":"x"}', []), null);
const fx = fromOpenAI({ choices: [{ message: { content: '{"type":"grep","pattern":"x"}' }, finish_reason: "stop" }] }, "m", names);
assert.equal(fx.stop_reason, "tool_use");
assert.equal(fx.content[0].type, "tool_use");
assert.ok(isWarming("", "muse_browser_reconnecting") && isWarming("Chromium ainda está reconectando") && isWarming("A página ainda não ficou pronta") && !isWarming("prompt grande demais"));
console.log("ok");
