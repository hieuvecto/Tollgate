# ADR 0004: Never fail over after client-visible bytes

**Status:** accepted

Failures before the first response byte may use another provider binding. Once bytes are visible, failover could concatenate unrelated generations and double provider cost. Tollgate instead emits a terminal SSE error, records observed partial usage, and reconciles estimates. Client disconnects abort upstream for the same cost-control reason.
