# Developer Notes

## Sanity checks
- `curl -i https://<your-host>/healthz`

## Direct booking test
- `curl -s -X POST https://<your-host>/schedule-demo-graph -H 'Content-Type: application/json' -d '{"email":"you@example.com","start":"2025-10-01T15:00:00Z"}'`

Watch server logs for `postBookDemo ENTER`, `BOOK_POST_TARGETS`, `[BOOK ...] creating invite`, and `[GRAPH] SUCCESS`.
