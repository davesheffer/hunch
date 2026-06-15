---
description: Explain why a file or symbol is the way it is, from Hunch
---
Use the `hunch_why` MCP tool on **$ARGUMENTS** (a file path or symbol name).

Then summarize, with citations:
- the **decisions** that shaped it (id + rationale),
- the **constraints** that must not break,
- the **bug history** behind it (root causes).

Cite record ids and their provenance/confidence. If Hunch returns nothing,
say so plainly and suggest running `hunch index` or `hunch backfill`.
