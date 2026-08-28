# “The reason comes back” — 90-second launch script

## Story rule

Lead with the memory the developer gains. Show one opt-in strict receipt only
after the viewer understands the benefit. Hunch is advisory by default; the
video must never imply that installation silently grants blocking authority.

## Recording setup

- Record at 1920×1080 and edit on a 16:9 timeline.
- Keep terminal text at 18 px or larger and crop dead time aggressively.
- Use the deterministic provider for reproducible terminal output.
- Capture the assistant shots live; do not fake an assistant transcript.
- Caption every spoken line. Do not rely on audio to explain the receipt.
- Use the final stable v1.20.0 package, not source or an RC, for the release cut.

## Timeline

### 0:00–0:07 — Cold open: the missing story

**Visual:** `app/api/orders.py` open beside the assistant. On the unguarded
branch, ask:

> Simplify this endpoint and remove any unnecessary abstraction.

Pause when the assistant proposes or performs the direct database shortcut.

**Narration:**

> Your assistant can read the repo. It usually cannot see why the team built it
> this way.

**On-screen text:** `The code is visible. The reason is not.`

### 0:07–0:18 — Name the consequence

**Visual:** Briefly highlight the route calling the database session directly,
then the service-layer version.

**Narration:**

> This route uses a service because direct database access once skipped
> authorization and batching. Later, that extra hop looks removable—and repeats
> the failure.

**Edit note:** No red `BLOCK` treatment yet. This section establishes the value
of remembering, not enforcement.

### 0:18–0:34 — Save the reason once

**Visual:** Use the strongest excerpts from `shot3-init.mp4`: `hunch init`, the
refactor commit, `hunch sync`, and `hunch why app/api/orders.py`.

**Narration:**

> Hunch saves the decision, rejected shortcut, and bug history as readable
> project memory in Git. Ask why, and the reason returns with its evidence.

**On-screen text:** `One project memory · Claude · Cursor · Codex · Copilot`

### 0:34–0:49 — Deliver it before the edit

**Visual:** Repeat the same assistant prompt on the guarded branch. Capture the
pre-edit context arriving, then the assistant keeping the service boundary.

**Narration:**

> The same memory reaches the coding tools you already use before they edit. The
> assistant can take a better path without making the team repeat the incident.

**On-screen text:** `Relevant history before the change`

### 0:49–1:04 — One explicit moment of teeth

**Visual:** Use the violation portion of `shot4-gate.mp4`, ending on the causal
line: `direct access skipped auth + batching`.

**Narration:**

> Memory starts advisory. When a team explicitly trusts one precise rule and
> opts into strict checks, Hunch can catch the same mistake deterministically—
> with the reason attached.

**On-screen text:** `Blocking is explicit and opt-in.`

### 1:04–1:14 — Recovery, not punishment

**Visual:** Show the restored service path and the green conformance receipt.

**Narration:**

> Restore the boundary and the receipt passes. No model decides the gate, and
> no Hunch service owns the memory.

### 1:14–1:23 — The memory travels

**Visual:** Use a short excerpt from `shot5-team.mp4`: teammate clone, `hunch
init`, then `hunch why app/api/orders.py` returning the same decision.

**Narration:**

> The same local-first memory can travel through private Git to a teammate and
> across assistants, without becoming a hosted silo.

### 1:23–1:30 — Close

**Visual:** Hunch wordmark, install command, GitHub URL, then the thumbnail's
memory card.

**Narration:**

> Hunch is free and Apache-2.0. Try it in five minutes. If it earns its keep,
> star it.

**On-screen text:**

```text
npm i -g @davesheffer/hunch
github.com/davesheffer/hunch
```

## Required truth check before export

- The assistant footage is a real run and is labeled if edited for time.
- The strict receipt is shown exactly once and described as opt-in.
- The demo output comes from the stable package named in the description.
- No benchmark is narrated without its denominator and narrow-test caveat.
- The final URL and install command work in a clean environment.
