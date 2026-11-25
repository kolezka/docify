# Shared crawl pool

Reduce wall time for one URL source and for several URL sources prepared together in the same Docify instance. Do not coordinate separate CLI processes or change embedding and graph concurrency.

## Approaches

Use the selected shared pool: each active crawl has a queue, the scheduler rotates among eligible queues, and both total and per-host in-flight page reads are bounded. Independent per-source pools would multiply load on a shared host. Distributed workers would require cross-process coordination beyond this scope.

## Behavior

Fetch independent pages concurrently but accept results in breadth-first discovery order. Bound buffered results as well as active reads. Keep redirect scope, ignore rules, deduplication, byte limits and page selection independent of response order. Cancellation drops queued work and interrupts active reads for that source without cancelling others. Hold capacity through body consumption, not just response headers.

## Acceptance

Compare serial and concurrent runs against identical local HTTP fixtures. Report median elapsed time for one large source and a group; distinguish collection from full preparation. Verify paths and content hashes, request overlap, global and per-host ceilings, fairness and cancellation. Choose initial limits from measurements. Do not claim production speedups from local tests.
