# ADR 0001: Separate data and control planes

**Status:** accepted

The gateway is a stateless, latency-sensitive data plane. Administrative and reporting APIs run separately so expensive reporting and policy mutation cannot consume proxy capacity. Redis caches short-lived policy; PostgreSQL remains authoritative. The split costs another process but preserves independent scaling and failure isolation.
