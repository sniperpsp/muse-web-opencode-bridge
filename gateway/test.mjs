// Teste de tradução (sem rede): node gateway/test.mjs
process.env.UPSTREAM_KEY = "x";
import assert from "node:assert/strict";
const { toOpenAI, fromOpenAI, unwrapFinal, chainFor } = await import("./server.js");

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
console.log("ok");
