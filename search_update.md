# SQLite FTS5 BM25 Search For AMP Cache

## Summary

Replace the current `.rxai-cache/search.jsonl` linear scan with a local SQLite FTS5 index using BM25 ranking. Keep the existing `npm run cache:search -- "query"` command and output shape, but make it faster and more relevant. The SQLite database remains advisory cache data only; GitHub Issues stays authoritative before writes, duplicate decisions, and conflict resolution.

## Key Changes

- Use Node built-in `node:sqlite` as the SQLite runtime.
- Create `.rxai-cache/search.sqlite` during `npm run cache:sync`.
- Keep `.rxai-cache/search.jsonl` only if needed as a debug/export artifact; search should read from SQLite.
- Add an FTS5 virtual table for issue/comment search records with columns: `kind`, `issue`, `comment_id`, `title`, `author`, `region`, `place`, `type`, `updated_at`, `url`, `preview`, `text`.
- Populate the FTS table from the same issue/comment cache files currently used by `rebuildSearch`.
- Rank results with SQLite `bm25(...)`, with weighting favoring `title`, `region`, `place`, and `type` over body/comment text.
- Preserve existing CLI behavior: `npm run cache:search -- "query terms" [--limit 20]`.
- Update `cache:status` to show SQLite search index presence and record count.
- Update README/PROTOCOL to describe BM25/SQLite FTS5 as the local retrieval accelerator.

## Implementation Details

- Add helpers in `cache_issues.ts`: `searchDbPath(dir)`, `openSearchDb(dir)`, `rebuildSearchDb(dir, manifest)`, and `searchFts(args)`.
- `syncCache()` should rebuild the FTS index after writing `manifest.json`, issue JSON, and comment JSON.
- `searchCache()` should require the manifest and SQLite DB. If the DB is missing, rebuild it from cached JSON before searching.
- Use parameterized SQLite statements for all queries.
- Query FTS with tokenized user input joined as an AND-style query by default, matching the current "all tokens must match" behavior.
- Keep exact phrase boosting by adding a secondary score bonus in TypeScript after BM25 results are returned.
- Keep output fields the same: issue/comment id, `[region/place/type]`, score, title, updated author, preview, URL.
- Do not make SQLite authoritative. Every search result remains a local recall hint.

## Test Plan

- Run `npm run build`.
- Run `npm run typecheck`.
- With a populated cache, run `npm run cache:sync` and verify `.rxai-cache/search.sqlite` is created.
- Run `npm run cache:search -- "token auth"` and confirm ranked results print in the existing format.
- Run `npm run cache:search -- "nonexistent-term"` and confirm the no-match path works.
- Delete `.rxai-cache/search.sqlite`, rerun `npm run cache:search -- "known term"`, and confirm the DB rebuilds from cached JSON.
- Run `npm run cache:status` and confirm it reports issue count plus SQLite search record count.
- Confirm secret scan still passes before commit.

## Assumptions

- The project will target modern Node with `node:sqlite` available.
- The experimental Node warning is acceptable for local cache tooling.
- `cache:search` should be replaced in place rather than adding a separate command.
- SQLite files stay inside `.rxai-cache/` and remain gitignored.
- Existing JSON cache files remain the source used to rebuild the local search index.
