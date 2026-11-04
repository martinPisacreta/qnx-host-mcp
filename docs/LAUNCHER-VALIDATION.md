# Real launcher validation protocol

Status: proposed procedure; not executed. MCP image tools remain blocked.

## Preconditions

Use a disposable Linux test environment with a licensed QNX SDK and no unrelated QEMU instances. Record the SDK, mkqnximage, QEMU and host versions. Verify the documented command options before running them. Do not infer compatibility from fake-executable tests.

## Evidence to collect

1. Build a minimal image in a dedicated workspace using documented options. Save the exact argv, exit status and bounded output.
2. Observe the launcher from spawn onward. Record PID, parent PID, process group, session and procfs start time for the launcher and identified descendants. Determine whether the launcher stays alive, exits or delegates execution.
3. Establish how the running QEMU instance can be identified after launcher exit. A workspace path or executable name alone is insufficient evidence of ownership.
4. Record the documented effective network configuration and the instance's actual IPv4 and IPv6 listening sockets. An empty snapshot before readiness does not establish safe networking. Missing or inconsistent observations must fail validation.
5. Verify the documented stop scope before invoking it. Confirm that stopping the test instance leaves unrelated processes untouched and removes its descendants and listeners. Do not use process-name matching or caller-supplied PIDs.
6. Repeat for cancellation and timeout, including a failed observation. Record whether cleanup completes; preserve an explicit unknown state when termination cannot be confirmed.

## Integration decision

- If the launcher remains alive, evaluate observing its verified group while it runs; command completion cannot be the prerequisite for that observation.
- If the launcher exits, the current group token is insufficient. Require a separately verified instance identity or containment mechanism before integration.
- If descendants escape the tracked group, group-based observation and termination do not establish complete ownership or cleanup.
- Keep MCP image tools blocked until lifecycle, effective networking, isolation and cleanup requirements have been verified.

## Result record

Record commands, versions, process timelines, socket evidence, cleanup outcomes and remaining uncertainties. Exclude license material and credentials. Passing the existing 44 tests does not satisfy this protocol.
