# AGENTS.md

<!-- HUNCH:START — auto-generated, do not edit by hand -->
<!-- hunch:template 3 -->
## 🧠 Hunch (Engineering Memory)

This repo's Hunch graph holds **344 decisions, 2 bugs, 31 constraints, 22 components, 3 policies, 26 open findings**. Call `hunch_context(target)` first, before reading or editing; its tool description lists the rest.

### ⛔ Blocking invariants
- con_2ce3f2a547: Synthesis must use an explicitly selected coding-assistant subscription CLI or the deterministic local fallback; never…
- con_547fff76bd: This repo's generated wiki must never be committed to the public repo — private overlay wiki only (hunch wiki…
- con_8460b6770f: Config/provider writers must merge idempotently into existing user files and refuse to clobber an unparseable file
- con_902759b3dc: All JSON writes to .hunch/ must be atomic (temp-file + rename) so an interrupted write can never truncate the index
- con_947c578b2c: Forward-migrate raw JSON to the current schema BEFORE Zod validation; never silently drop unmigratable records
- con_a87360128b: Semantic vectors are a derived layer in SQLite, never the source of truth; reconcile by content hash on reindex
<!-- HUNCH:END -->
