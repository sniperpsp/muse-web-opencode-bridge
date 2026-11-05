// Teste de tradução (sem rede): node gateway/test.mjs
process.env.UPSTREAM_KEY = "x";
import assert from "node:assert/strict";
const { toOpenAI, fromOpenAI } = await import("./server.js");

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
console.log("ok");
