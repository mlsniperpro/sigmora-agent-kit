# Review-first edit

Example request:

> In project `prj_launch`, inspect the ready interview clips and prepare one 60-second vertical cut with captions. Show me the selected sources, cut proposal, and server estimate before rendering.

Expected sequence:

1. call `project_session_start` with `prj_launch` and a persisted opaque `externalSessionId` (generate one when the host supplies none), then verify the binding;
2. inspect its ready assets using stable asset/content IDs;
3. create an edit proposal with review enabled;
4. show the bounded proposal, billing owner, and current estimate;
5. wait for explicit approval;
6. approve once with a stable idempotency key;
7. poll the durable job through success, failure, or cancellation;
8. return the signed artifact and receipt references.
