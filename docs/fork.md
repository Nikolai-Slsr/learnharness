# This fork: Ollama Cloud + Hermes

Two additions on top of upstream LearnHarness. Everything else tracks
[amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).

## Ollama Cloud provider

`src/agent/ollama-cloud.ts` registers `ollama-cloud` beside pi-ai's builtin
providers. The catalog is dynamic: `GET https://ollama.com/api/tags` lists the
hosted models, `POST /api/show` adds each context window. Models without tool
calling are dropped, since every agent here runs on tools. Capabilities map to
pi-ai's model fields (`thinking` → reasoning, `vision` → image input). Ollama
honors only `low`/`medium`/`high` as `reasoning_effort`, so the other thinking
levels are marked unsupported. Cost is zero (flat plan).

Setup: Settings → Providers → add **Ollama Cloud** with your key, or set
`OLLAMA_API_KEY`. The catalog refreshes at most every 10 minutes.

## Hermes (`ask_hermes`)

`src/agent/tools/hermes.ts` gives the prober and the teacher a consult with
[Hermes](https://hermes-agent.nousresearch.com), the learner's personal agent,
through its OpenAI-compatible API server. Hermes knows what this app cannot:
course notes and slides, the lecturer's notation, exams, open study tasks,
earlier conversations. The tutor asks one self-contained question and blocks
until Hermes answers (timeout 3 minutes). Each lesson keeps its own Hermes
session (`X-Hermes-Session-Id: learnharness-<chatId>`), so follow-ups share
context.

Setup: Settings → Keys → **Hermes** with the API server key (`API_SERVER_KEY`
in `~/.hermes/.env`). `HERMES_API_URL` overrides the default
`http://127.0.0.1:8642`. The tool can be switched off under Settings → Agent.

Security note: the API server runs a full Hermes agent with its configured
toolsets. The request frames Hermes as read-only and marks the question as
agent data, but the boundary is Hermes' own judgment, not a sandbox. Point
`HERMES_API_URL` at a profile with read-only toolsets if that matters.

## Tests

`tests/fork-integrations.test.ts` covers both offline (stubbed fetch).
