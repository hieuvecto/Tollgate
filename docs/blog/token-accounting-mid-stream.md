# Token accounting when a streaming request dies mid-flight

Streaming turns a simple billing question into a distributed-systems question: the client, gateway, provider, and ledger can each observe a different prefix of the generation.

Tollgate commits to three rules. It never retries after a client-visible byte, never invents provider-authoritative usage, and never rewrites a settled fact. A completed stream uses the provider's terminal usage. A broken stream records the input estimate and tokens observed by the gateway as `estimated`, retains the raw evidence, and lets reconciliation compare that fact with the provider invoice.

Client disconnects abort upstream. Draining could obtain authoritative usage, but it might generate and charge tokens the client could not receive. The trade-off is explicit: cost containment now, reconciliation uncertainty later.

Exactly-once charging does not require exactly-once delivery. The outbox can be delivered repeatedly because usage is unique per request and a charge is unique per request. The schema requires any future correction to be a reversal or adjustment so investigators can reconstruct every decision, but the current reconciliation workflow reports drift without creating those entries.
