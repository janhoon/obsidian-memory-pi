# Proposal Triage is a focused overlay with human-only Review resolve

Review used to be a toast-and-confirm maze (`/memory-review pick` → notify dump → Apply? → Discard?). That is the wrong surface for a human who just needs to Apply or Discard what is already queued.

We made Triage the default review job: one focused Proposal, identity + rationale + short preview, then `a` Apply / `d` Discard / `e` Inspect / `esc` leave. The overlay, slash, and `memory_review_resolve` share one Review resolve operation and one order (current project oldest first, then the rest oldest first). Only a human may resolve; the agent can drive the resolver after a clear ask, never on its own.

**Considered options:** keep slash-only pick; make the below-editor widget the keyboard; let the agent Apply obvious extract items; newest-first; overlay batch keys.

**Consequences:** Telegram inherits chat remote-control, not a native review card. Edit, target-Note diffs, skip, and overlay Apply/Discard-all stay out until Triage is the comfortable path.
