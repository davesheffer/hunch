# Reusing validated ledger snapshots

Repeated state subscriptions and writes can read the same change ledger. Hunch reuses
the validated snapshot when the file's actual UTF-8 content is identical. Every read
still opens the file; timestamps, file size, elapsed time and model judgments do not
authorize reuse. Another process's write, compaction or Git replacement is visible on
the next read, including equal-size changes with an unchanged modification time.

The cache retains a serialized, validated snapshot (including schema defaults).
Each caller receives a fresh object parsed from it, so append, compaction and caller
mutation cannot change the cached snapshot. Changed content goes through the existing
schema, scope and sequence checks; corrupt content fails instead of returning old
state. Missing files retain the existing empty-ledger behavior and discard the cache.

The process-local cache holds at most four files with at most 1,048,576 UTF-16 code
units each, plus their normalized JSON strings. Returned objects consume additional memory. Larger files
use the original uncached path. Entries are evicted by least recent use; no new data
is persisted and JSON remains the source of truth.

This accelerates deterministic ledger reads for every CLI and transport. It does not
cache semantic review decisions, skip reading an external source, change grants,
promote unknown observations to current, or select a provider.
