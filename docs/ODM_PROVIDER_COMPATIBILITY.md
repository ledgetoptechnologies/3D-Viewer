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
