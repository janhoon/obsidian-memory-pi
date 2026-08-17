# Reliable session memory capture

How a coding-agent memory system should turn reviewable writes into durable, non-redundant wiki notes — not raw transcript dumps.

This note cites **primary sources** only (official docs, first-party papers, this repo, this vault). It does **not** make product decisions.

## Question

How should session memory be captured so that Apply produces semantic/state Notes, while chronology stays in Session notes?

## What this repo already says

- Session notes are **chronological, short-lived**; Log is operations, not conversation turns. ([`CONTEXT.md`](../CONTEXT.md))
- Writing rules: concise summaries, not transcripts; prefer synthesis; **never paste raw assistant chat dumps into core-pack Notes** (`working-context`, `MEMORY.md`, `active-context`). ([vault `memory/schema.md`](/home/janhoon/Documents/Master Vault/memory/schema.md))
- DEC-001 adopts Context Lake layers as **soft** contracts: episodic / semantic / state path layers; Dream/maintainer treat promotion as Context Preparation. ([DEC-001](/home/janhoon/Documents/Master Vault/memory/projects/obsidian-memory-pi/decisions/DEC-001%20-%20Context%20Lake%20soft%20alignment%20for%20memory%20layers.md))
- Blueprint: `agent_end` appends a concise session-note entry (last user request, assistant summary, tools). Significance extract is a **capped, review-only** Proposal when no memory tool ran. Dream consolidates Session notes into semantic Wiki Notes. ([`docs/blueprint.md`](../blueprint.md))
- Extract previously concatenated user + assistant text, then Applied `User:` / `Assistant:` snippets into `active-context.md` and `progress.md`. ([`extensions/obsidian-memory/significance.ts`](../../extensions/obsidian-memory/significance.ts), [`index.ts`](../../extensions/obsidian-memory/index.ts) `agent_end`)

## Layers: working / episodic / semantic

| Layer | Role in first-party systems | Local analogue |
| --- | --- | --- |
| Working / core / state | Always-on, budgeted, self-edited facts (persona, human, current task). MemGPT *working context* is a fixed-size read/write block, **not** the FIFO message queue. ([MemGPT, arXiv:2310.08560](https://arxiv.org/abs/2310.08560); [Letta memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks/)) | Core pack: `working-context.md`, `active-context.md`, `MEMORY.md` ([`core-pack.ts`](../../extensions/obsidian-memory/core-pack.ts)) |
| Episodic / recall | Full message history or discrete episodes, searchable, **non-lossy provenance**. Graphiti *episode subgraph* stores raw input; semantic facts cite episodes. ([Zep/Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview); [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) | `memory/sessions/<project>/YYYY-MM-DD.md` |
| Semantic / archival | Extracted facts, entities, preferences — retrieved on demand, not always in prompt. Letta archival entries ~300 tokens; Mem0 `add(infer=True)` stores distilled facts, not transcripts. ([Letta archival](https://docs.letta.com/v1-sdk/memory/archival-memory/); [Mem0 how it works](https://docs.mem0.ai/core-concepts/how-it-works); [Mem0 add](https://docs.mem0.ai/core-concepts/memory-operations/add)) | Decisions, progress bullets, prefs, doctrine Notes |

MemGPT’s FIFO queue + recursive summary is the eviction path for **messages**; working context is updated only via explicit memory functions (`append` / `replace`). Mixing those tiers is the failure mode this vault already forbids. ([MemGPT PDF](https://arxiv.org/pdf/2310.08560); vault schema)

Letta’s context hierarchy is system prompt + memory blocks + recent messages + summaries of older context. Blocks are for high-priority / frequently needed facts; archival is for large or infrequently needed material. ([Letta context hierarchy](https://docs.letta.com/v1-sdk/memory/context-hierarchy))

## Salience: extract facts, not turns

- **Mem0**: default `infer=True` runs an LLM to pull key facts/decisions/preferences. `infer=False` (raw messages) is an opt-in that “can create duplicates if mixed with inferred adds.” v3 hashes facts (MD5) for dedupe and looks up related existing memories before insert. ([Mem0 add](https://docs.mem0.ai/core-concepts/memory-operations/add); [Mem0 v3 migration](https://docs.mem0.ai/migration/oss-v2-to-v3))
- **Anthropic (claude.ai)**: memory “synthesizes and extracts relevant details … rather than storing full conversation transcripts.” Complementary **chat search** covers the transcript layer. Claude Code splits **you-write** `CLAUDE.md` (instructions) from **auto memory** notes under `~/.claude/projects/<project>/memory/`, plus optional Auto Dream consolidation. ([Anthropic memory announcement](https://www.anthropic.com/news/memory); [Claude Code memory](https://docs.anthropic.com/en/docs/claude-code/memory))
- **OpenAI ChatGPT**: Saved Memories are discrete facts; later “reference chat history” infers high-level insights, not every detail; 2026 “Dreaming” builds a reviewable Memory Summary. Temporary Chat neither uses nor writes memory. ([Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq); [Memory and new controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/); [ChatGPT memory dreaming](https://openai.com/index/chatgpt-memory-dreaming/))
- **Cursor**: Memories are short, project-scoped facts treated as rules (Settings → Rules), not chat dumps. Cloud Agents use a separate named notes file (default `MEMORIES.md`). ([Cursor 1.0 changelog](https://cursor.com/changelog/1-0); [Cursor cloud-agent automations](https://cursor.com/docs/cloud-agent/automations))
- **Graphiti/Zep**: episodes stay raw; **entity/fact extraction + temporal invalidation** produce the semantic graph. Facts are invalidated, not deleted, when superseded. ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956))

Cue-scanning **assistant** vocabulary (`default to`, `trade-off`, `merged`) is not how these systems decide salience. They either (a) extract from the **user** (or a dedicated memory function), or (b) run a later synthesis pass over episodes.

## Review / human-in-the-loop

- ChatGPT and Claude both expose **view / edit / delete** of extracted memories; neither applies raw transcripts as always-on profile. ([OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq); [Claude support: chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context))
- This package already separates Write vs Proposal vs Decision vs Ingest; extract is review-only. ([`write-policy.ts`](../../extensions/obsidian-memory/write-policy.ts); DEC-002 / ADR-0002)
- Apply of a Proposal currently **appends the Proposal body as-is**. If the body is a transcript, the wiki becomes a transcript. ([`applyReviewProposal` in `index.ts`](../../extensions/obsidian-memory/index.ts))

## Dedupe and promotion

- Mem0: related-memory lookup + hash dedupe on add; facts accumulate rather than blindly overwrite. ([Mem0 v3](https://docs.mem0.ai/migration/oss-v2-to-v3))
- Graphiti: incremental extraction with entity resolution against recent episodes; contradictions become temporal invalidation. ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956))
- This repo’s Dream is the promotion pass (Session → Active/MEMORY/progress + Proposals). Residual `other` and YAML frontmatter previously leaked into core-pack Notes. ([`dream.ts`](../../extensions/obsidian-memory/dream.ts); project progress 2026-08-10)

## Implications for this repo

Change options only — not decisions.

1. **Keep Session notes as the episodic store.** Do not copy the same turn into Active context / progress. Extract should emit a **claim** (one sentence + kind + cue), or not run at all when the turn is already in today’s session note.
2. **Scan user text for cues; treat assistant text as discussion.** Product words (`default to`, `merged`, `trade-off`) in assistant output are not user preferences/milestones. Skip skill XML, child-completion notices, and `# review` wrappers (they are injected task packets).
3. **Do not Apply extracts onto core-pack paths.** Stage in `inbox.md` (or a session-adjacent extracts note). Dream / maintainer promote synthesized bullets into Active context, MEMORY, progress, or `memory_record_decision`.
4. **Make Apply preserve origin.** `source: "auto"` remaps to metrics `fallback`, so extract apply/discard rates cannot drive the kill-switch. Persist `origin: extract|dream|audit|explicit`.
5. **Dedupe before enqueue.** Fingerprint `(kind, claim, project)` against recent extract Proposals. Mem0-style hash is enough for exact repeats; later work can add semantic near-dupe.
6. **Dream is the synthesis job.** Cue-extract is a **candidate generator**. Dream should skip YAML/`other`, rewrite core-pack only when focus/progress/decision/risk material exists, and never append frontmatter keys as bullets.
7. **Triage UX option:** Apply on an extract Proposal could require a claim-shaped body (reject or rewrite if it contains `- User:` / `- Assistant:`). That is a resolve-time guard, complementary to better drafts.
8. **Session-note option:** shorten auto session entries (user + tools only, or a 1-line assistant gist) so Dream has less transcript to re-classify. Compaction flush already exists for the full span. ([`index.ts` `session_before_compact`](../../extensions/obsidian-memory/index.ts))

## Sources

- Packer et al., *MemGPT: Towards LLMs as Operating Systems*, arXiv:2310.08560, https://arxiv.org/abs/2310.08560
- Letta: memory blocks, archival, context hierarchy — https://docs.letta.com/v1-sdk/memory/memory-blocks/ , https://docs.letta.com/v1-sdk/memory/archival-memory/ , https://docs.letta.com/v1-sdk/memory/context-hierarchy
- Zep/Graphiti overview — https://help.getzep.com/graphiti/getting-started/overview
- Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*, arXiv:2501.13956 — https://arxiv.org/abs/2501.13956
- Mem0: how it works, add, memory types, v3 — https://docs.mem0.ai/core-concepts/how-it-works , https://docs.mem0.ai/core-concepts/memory-operations/add , https://docs.mem0.ai/core-concepts/memory-types , https://docs.mem0.ai/migration/oss-v2-to-v3
- Anthropic: https://www.anthropic.com/news/memory , https://docs.anthropic.com/en/docs/claude-code/memory
- OpenAI: https://help.openai.com/en/articles/8590148-memory-faq , https://openai.com/index/memory-and-new-controls-for-chatgpt/ , https://openai.com/index/chatgpt-memory-dreaming/
- Cursor 1.0 changelog — https://cursor.com/changelog/1-0
- Local: `CONTEXT.md`, `docs/blueprint.md`, vault `memory/schema.md`, DEC-001, `significance.ts`, `write-policy.ts`, `dream.ts`, `index.ts`
