# pi-jobs end-to-end scenarios

These scenarios drive a real `pi --mode rpc` session with `anthropic/claude-haiku-4-5`. They
need network access and credentials, and each run costs about a cent.

```sh
cd /path/to/pi-jobs/e2e
node scen.mjs 1     # exit 0 = PASS, 1 = FAIL, 2 = hard timeout (150 s), 64 = unknown id
```

| # | Scenario |
|---|---|
| 1 | Successful job wakes the agent once (`OK-MARKER`, exit 0). |
| 2 | Failing job is reported with its exit code. |
| 3 | Timeout kills the process group (none of the run's marked processes left). |
| 4 | `job_watch` matches when a flag file appears 15 s later. |
| 5 | Two jobs finish during a foreground bash call: each is delivered once, possibly batched. |
| 6a / 6b | Exiting pi (stdin closed or SIGTERM) leaves no job processes behind. |
| 7 | Natural-language request: one `job_*` call, no polling, one wake-up. |
| 8a / 8b | A job finishes while another turn streams. Then Escape (`clear_queue` + `abort`) or an RPC `abort`: the completion arrives once, after the abort. |

**Isolation.** Each run creates its own temp directory (`/tmp/pijobs-e2e-XXXXXX`, also pi's
cwd) and removes it at the end. Scenarios 3 and 6 run their long process as
`exec -a pijobs-e2e-<uuid> sleep …`, so they inspect and kill only processes carrying their own
per-run marker, never other `sleep` processes on the machine. Scenario 6 also requires pi to
exit within 10 s.

A missed wake-up or a run that never settles counts as a failure. `driver.mjs` holds the RPC
plumbing, and `scen.mjs` holds the scenarios.
