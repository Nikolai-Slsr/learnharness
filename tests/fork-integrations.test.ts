/**
 * The fork's two integrations, offline: the Ollama Cloud catalog (built from
 * /api/tags + /api/show) and the ask_hermes consult (wire shape, gating).
 * fetch is stubbed — no network.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { OLLAMA_CLOUD, ollamaCloudProvider } from "../src/agent/ollama-cloud.ts";
import { hermesTools } from "../src/agent/tools/hermes.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.HERMES_API_KEY;
});

type Handler = (url: string, init: RequestInit) => unknown;
function stubFetch(handler: Handler, calls: { url: string; init: RequestInit }[] = []) {
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		calls.push({ url: String(input), init });
		return Response.json(handler(String(input), init));
	}) as typeof fetch;
	return calls;
}

describe("Ollama Cloud catalog", () => {
	it("lists tool-capable models with capabilities and context windows", async () => {
		const calls = stubFetch((url, init) => {
			if (url.endsWith("/api/tags"))
				return {
					models: [
						{ name: "kimi-k3", capabilities: ["completion", "tools", "thinking", "vision"] },
						{ name: "mistral-large-3:675b", capabilities: ["completion", "tools"] },
						{ name: "clef:27b", capabilities: ["completion"] },
					],
				};
			const { model } = JSON.parse(String(init.body)) as { model: string };
			return { model_info: { [`${model}.context_length`]: model === "kimi-k3" ? 1_048_576 : 8_192 } };
		});
		const models = createModels({ authContext: { env: async (name) => (name === "OLLAMA_API_KEY" ? "test-key" : undefined), fileExists: async () => false } });
		models.setProvider(ollamaCloudProvider());
		const { errors } = await models.refresh({ providers: [OLLAMA_CLOUD] });
		assert.equal(errors.size, 0);

		const kimi = models.getModel(OLLAMA_CLOUD, "kimi-k3")!;
		assert.equal(kimi.reasoning, true);
		assert.deepEqual(kimi.input, ["text", "image"]);
		assert.equal(kimi.contextWindow, 1_048_576);
		assert.equal(kimi.baseUrl, "https://ollama.com/v1");
		assert.equal(kimi.thinkingLevelMap?.off, null);

		const mistral = models.getModel(OLLAMA_CLOUD, "mistral-large-3:675b")!;
		assert.equal(mistral.reasoning, false);
		assert.equal(mistral.thinkingLevelMap, undefined);
		assert.equal(mistral.maxTokens, 8_192, "output cap never exceeds the context window");

		assert.equal(models.getModel(OLLAMA_CLOUD, "clef:27b"), undefined, "models without tool calling are dropped");
		assert.ok(calls.every((c) => new Headers(c.init.headers).get("authorization") === "Bearer test-key"));
	});
});

describe("ask_hermes", () => {
	it("is absent without HERMES_API_KEY", () => {
		assert.deepEqual(hermesTools("chat_1"), {});
	});

	it("asks the API server inside the lesson's own Hermes session", async () => {
		process.env.HERMES_API_KEY = "hermes-test-key";
		const calls = stubFetch(() => ({ choices: [{ message: { content: " Die Vorlesung nutzt j statt i. " } }] }));
		const tool = hermesTools("chat_42").ask_hermes!;
		const result = await tool.execute("call_1", { question: "Welche Notation nutzt die Vorlesung?" }, new AbortController().signal);

		assert.deepEqual(result.content, [{ type: "text", text: "Die Vorlesung nutzt j statt i." }]);
		const { url, init } = calls[0]!;
		assert.equal(url, "http://127.0.0.1:8642/v1/chat/completions");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer hermes-test-key");
		assert.equal(headers.get("x-hermes-session-id"), "learnharness-chat_42");
		const body = JSON.parse(String(init.body)) as { stream: boolean; messages: { role: string; content: string }[] };
		assert.equal(body.stream, false);
		assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
		assert.equal(body.messages[1]!.content, "Welche Notation nutzt die Vorlesung?");
	});

	it("reports an unreachable Hermes as a tool error the teacher can read", async () => {
		process.env.HERMES_API_KEY = "hermes-test-key";
		globalThis.fetch = (async () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 })) as typeof fetch;
		const tool = hermesTools("chat_1").ask_hermes!;
		await assert.rejects(tool.execute("call_1", { question: "?" }, new AbortController().signal), /HTTP 401.*Invalid API key/);
	});
});
