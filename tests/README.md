# Backend unit tests

Run from the repository root using Python 3.10 or 3.13:

```sh
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m pip check
python -m pytest tests/unit -q --require-tests --junitxml=test-results/unit.xml
```

The suite runs without Chrome, extensions, provider credentials, GPU models or
FFmpeg. It imports the real FastAPI app and sends requests through ASGITransport,
without starting the app lifespan or background workers. SQLite stores and output
paths are temporary; outbound socket connections fail immediately. External
ChatGPT HTTP and ElevenLabs browser operations are mocked at the transport edge.

Coverage includes:

- API registration/imports, input validation, missing jobs, duplicate requests,
  batch idempotency and aggregate success/failure reporting.
- SQLite queue priority, retry scheduling, in-flight exclusions, limits and stale
  operation recovery without automatically repeating uncertain generations.
- SRT source text preservation, Japanese text, duplicate alignment avoidance,
  millisecond units, missing/overlapping/invalid timing, immutable snapshot hashes,
  continuous output and unconfirmed audio duration reporting.
- ChatGPT durable-before-ACK ordering, failed ACKs, capacity reservation,
  cancellation/retry, non-submission versus uncertain errors and restart recovery.
- ElevenLabs lossless UTF-16-aware chunking, reviewed retries, restart recovery,
  pause/disconnect behavior, uncertain paid requests, durable audio before ACK,
  and rejection of invalid audio payloads.

`--require-tests` additionally returns exit 5 if no test call passes, including an
all-skipped suite. Normal collection errors and test failures retain their nonzero
exit codes. Subprocess regression tests cover passing, skipped, empty, deselected,
failing, invalid and missing test suites. Do not add `continue-on-error` or `|| true`
to the test step. Each Python matrix job uploads its JUnit report even on failure;
a missing report is also an error.

These tests do not establish real browser/DOM compatibility, speech quality,
FFmpeg rendering, full application startup or end-to-end generation correctness.
Add separate integration tests when covering those boundaries; unit tests must
never send paid generation requests.
