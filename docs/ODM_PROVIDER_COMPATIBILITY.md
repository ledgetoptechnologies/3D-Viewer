# ODM provider compatibility

LTDS talks to NodeODM's documented API instead of WebODM's Django API. The
adapter is tested against NodeODM 2.2.3 and ClusterODM 1.5.5, but probes
`GET /info` and `GET /options` at runtime instead of rejecting a provider only
because its patch version differs.

The implemented workflow follows the upstream NodeODM API documentation:

1. `POST /task/new/init` with an LTDS-generated UUID in `set-uuid` and options
   as an array of `{name,value}` records.
2. One or more multipart `POST /task/new/upload/{uuid}` calls.
3. `POST /task/new/commit/{uuid}` only after every source file is uploaded.
4. Reconcile with `GET /task/{uuid}/info`; status codes 10/20/30/40/50 map to
   queued/running/failed/completed/cancelled.
5. Cancel with `POST /task/cancel` and retrieve results with
   `GET /task/{uuid}/download/all.zip`.

The assigned UUID, submission phase, and completed photo count are persisted.
After a crash, `GET /task/{uuid}/info.imagesCount` reconciles only the
photo-image prefix. NodeODM also accepts GEO, GCP text, seed ZIP, image-group,
and alignment inputs in the same multipart `images` field, but its image count
cannot prove which auxiliary files committed. An ambiguous auxiliary upload or
queued commit therefore uses documented `POST /task/remove` and restarts the
same deterministic submission rather than guessing. A running/completed task
proves the commit crossed the boundary and is reconciled in place.

Option serialization deliberately retains both boolean `true` and boolean
`false`; falsy options are not filtered. ClusterODM is NodeODM API-compatible
and remains responsible for selecting a node. LTDS limits how many jobs it
admits to the ClusterODM endpoint, while `/info.taskQueueCount`,
`maxParallelTasks`, and the configured local admission limit provide
backpressure. Provider health is never part of Viewer readiness or published
asset authorization.

Primary sources:

- <https://github.com/OpenDroneMap/NodeODM/blob/master/docs/index.adoc>
- <https://github.com/OpenDroneMap/ClusterODM>
