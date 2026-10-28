import { createProvider, envApiKeyAuth, type Model, type Models, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * Ollama Cloud — an OpenAI-compatible endpoint pi-ai ships no builtin for,
 * registered beside the builtins in piModels(). The catalog is DYNAMIC:
 * /api/tags lists the hosted models with their capabilities, /api/show adds
 * each model's context window. Ollama Cloud bills a flat plan, so per-token
 * cost is zero.
 */

export const OLLAMA_CLOUD = "ollama-cloud";
export const OLLAMA_API_KEY = "OLLAMA_API_KEY";

const HOST = "https://ollama.com";
const REFRESH_TTL_MS = 10 * 60_000;
/** Ollama publishes no output cap; the reply budget the requests carry. */
const MAX_OUTPUT_TOKENS = 32_768;
/** Ollama accepts any reasoning_effort string but only honors low/medium/high
 *  ("none" leaks the reasoning into content) — the rest is unsupported. */
const THINKING_LEVELS = { off: null, minimal: null, xhigh: null, max: null } as const;

interface TagsResponse {
	models: { name: string; capabilities?: string[] }[];
}

interface ShowResponse {
	model_info?: Record<string, unknown>;
}

async function ollamaJson<T>(path: string, key: string, signal: AbortSignal, body?: object): Promise<T> {
	const res = await fetch(`${HOST}${path}`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
		signal,
	});
	if (!res.ok) throw new Error(`Ollama Cloud ${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

function contextWindowOf(show: ShowResponse): number | undefined {
	const entry = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
	return typeof entry?.[1] === "number" ? entry[1] : undefined;
}

async function fetchCatalog({ credential, signal }: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	const key = credential?.type === "api_key" ? credential.key : undefined;
	if (!key) return [];
	const { models } = await ollamaJson<TagsResponse>("/api/tags", key, signal);
	const chat = models.filter((m) => m.capabilities?.includes("tools"));
	return Promise.all(
		chat.map(async ({ name, capabilities = [] }) => {
			const contextWindow = contextWindowOf(await ollamaJson<ShowResponse>("/api/show", key, signal, { model: name })) ?? 131_072;
			const reasoning = capabilities.includes("thinking");
			return {
				id: name,
				name,
				api: "openai-completions",
				provider: OLLAMA_CLOUD,
				baseUrl: `${HOST}/v1`,
				reasoning,
				...(reasoning ? { thinkingLevelMap: THINKING_LEVELS } : {}),
				input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: Math.min(MAX_OUTPUT_TOKENS, contextWindow),
				compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
			} satisfies Model<"openai-completions">;
		}),
	);
}

export function ollamaCloudProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: OLLAMA_CLOUD,
		name: "Ollama Cloud",
		baseUrl: `${HOST}/v1`,
		auth: { apiKey: envApiKeyAuth("Ollama Cloud API key", [OLLAMA_API_KEY]) },
		models: [],
		fetchModels: fetchCatalog,
		api: openAICompletionsApi(),
	});
}

let lastRefresh: { at: number; run: Promise<void> } | undefined;

/** Load the dynamic catalog into `models` — at most once per TTL, so the
 *  per-turn and per-picker calls stay cheap. A failed or keyless (empty)
 *  refresh is not remembered: the next call retries. */
export function refreshOllamaCloud(models: Models): Promise<void> {
	if (lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) return lastRefresh.run;
	const run = models.refresh({ providers: [OLLAMA_CLOUD] }).then(({ errors }) => {
		const error = errors.get(OLLAMA_CLOUD);
		if (error) console.error("[ollama-cloud] catalog refresh failed:", error.message);
		if (error || models.getModels(OLLAMA_CLOUD).length === 0) lastRefresh = undefined;
	});
	lastRefresh = { at: Date.now(), run };
	return run;
}
