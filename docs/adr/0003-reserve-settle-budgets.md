# ADR 0003: Reserve then settle budgets

**Status:** superseded by ADR 0005

Admission atomically reserves estimated input plus maximum output cost in Redis. Settlement charges provider usage and releases the remainder. A model default cap is inserted when absent. This may conservatively reject requests and permits a documented 1% tokenizer-drift tolerance, but bounds concurrent overspend.
