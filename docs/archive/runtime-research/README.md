# Runtime research archive

Start with the [BiRefNet optimization report](../../birefnet-interpolation-findings.md)
for the current result and release-facing explanation. These historical documents
retain evidence and abandoned or deferred directions, rather than serving as
current release guidance:

- [Opportunity assessment](model-runtime-opportunities.md): sampling, conditioning,
  memory and execution options.
- [Experiment results](model-runtime-experiments.md): preparation caching,
  material continuation, shape steps and initial numerical checks.
- [Execution investigation](runtime-execution-research-direction.md): partition
  controls, BiRefNet profiling and the interpolation fix.

Keep these records when simplifying navigation: they support findings beyond the
BiRefNet change. Current adoption decisions live in the
[findings index](../../findings.md) and [research backlog](../../research-backlog.md).
Raw captures, generated models, private test plans and logs remain outside tracked
documentation. No runtime tests or diagnostic tooling were removed by this cleanup.
