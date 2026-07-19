# Obsidian Memory

Persistent, reviewable knowledge for Pi: a maintained wiki backed by immutable sources, retrieved sparsely into agent context.

## Language

### Store and layers

**Vault**:
The full Obsidian store Pi is configured against, including sources, the wiki, and router instructions.
_Avoid_: memory folder, knowledge base (as a synonym for the whole store)

**Wiki**:
The maintained knowledge layer under `memory/` — notes agents read from and write into.
_Avoid_: vault (when only the maintained layer is meant), knowledge graph (unless referring to wikilink structure specifically)

**Memory**:
The product capability as a whole — recall, write, propose, decide, ingest, and audit — not a folder name in speech.
_Avoid_: vault, wiki (when meaning the system rather than the store or notes)

**Source**:
Immutable raw input or derived ingest artifact under `sources/`. Never edited as wiki content.
_Avoid_: attachment, upload, document (when the immutability boundary matters)

**Note**:
A single markdown page in the wiki.
_Avoid_: file (when the wiki document is meant), page (unless speaking Obsidian UI)

### Context snapshots

**Working context**:
The cross-project snapshot of what matters right now.
_Avoid_: active context, current focus (as the note name)

**Active context**:
One project's current focus and status snapshot.
_Avoid_: working context, project status (as the note name)

**MEMORY index**:
A short, budgeted project index Note (`memory/projects/<project>/MEMORY.md`) loaded into the session core pack when present. Pointers over prose; detail stays in topic Notes.
_Avoid_: overview (fuller project brief), active context (current work snapshot), dumping long prose into the index

### Write paths

**Write**:
Any mutation of the wiki (immediate or eventually applied).
_Avoid_: save, store, capture (when the write path matters)

**Proposal**:
A queued, not-yet-applied durable write awaiting human review.
_Avoid_: pending write, review item, draft (as the canonical term)

**Decision**:
A first-class durable record of a chosen trade-off with required rationale — not merely any note that mentions a choice.
_Avoid_: note, ADR (unless referring to engineering ADRs outside this memory system), choice

### Continuity

**Session note**:
The chronological, short-lived per-day file for a project under session scope.
_Avoid_: log, transcript, chat history

**Session entry**:
One append to a session note (typically a user request, assistant summary, and tools used).
_Avoid_: turn, message, log line

**Compaction flush**:
The special pre-compact summary written as a session entry before Pi compresses context — not a separate note type.
_Avoid_: session summary (as a distinct document type), pre-compact note

**Log**:
The durable chronological record of memory operations (ingests, recorded decisions, significant maintains), not conversation turns.
_Avoid_: session note, activity feed, audit

### Scope and ownership

**Project**:
A named workspace namespace (slug) that owns project notes and that project's session notes.
_Avoid_: namespace, workspace, repo (when the memory project entity is meant)

**Scope**:
Which slice of the wiki a search or audit covers: project, global, session, or all.
_Avoid_: filter, namespace, collection

**Project scope**:
That project's notes under its project folder in the wiki.
_Avoid_: local, repo scope

**Global scope**:
Cross-project stable knowledge and core router notes.
_Avoid_: shared, common, personal (unless personal is explicitly distinct later)

**Session scope**:
Recent chronological session notes for a project.
_Avoid_: chat scope, history scope

### Ingest

**Ingest**:
The operation that turns a Source into wiki content and may store derived artifacts under sources.
_Avoid_: import, upload, index (indexing is retrieval-side)

**Ingest note**:
The generated wiki Note produced by an ingest; a subtype of Note, auditable like other wiki notes.
_Avoid_: source note, raw note, import file

### Retrieval

**Recall**:
Bringing wiki context into the agent turn (automatic or skill-driven); sparse by default. Umbrella for auto-recall, search, and read when the goal is continuity.
_Avoid_: load, fetch, inject (as the domain term)

**Auto-recall**:
The blocking pre-answer recall that injects search snippets only — not full notes — before the agent responds.
_Avoid_: background recall, prefetch, silent search

**Search**:
Ranked lookup over the wiki that returns snippets and metadata, not full notes.
_Avoid_: recall (when only the lookup step is meant), query (as a noun for the operation)

**Read**:
Loading a full Note, or a bounded slice of one, into the agent turn.
_Avoid_: get, open, fetch (as the domain term)

### Review

**Review queue**:
The store of pending Proposals awaiting human action.
_Avoid_: inbox, backlog, draft folder

**Apply**:
Accept a Proposal and perform its Write.
_Avoid_: approve, commit, merge (as the canonical verb)

**Discard**:
Reject a Proposal without writing.
_Avoid_: reject, delete, ignore (as the canonical verb)

### Health

**Audit**:
A health pass over the wiki for staleness, broken links, orphans, duplicates, and contradiction candidates — not the chronological Log.
_Avoid_: lint, review (when the health pass is meant), log

**Audit finding**:
One reported issue from an audit.
_Avoid_: error, warning, violation (unless severity is being stated)

### Navigation

**Router note**:
A core wiki Note that steers how agents navigate and maintain memory (schema, index, triggers, glossary, working context). Not every global note is a router note.
_Avoid_: core note, hub note, index file (as the general class name)
