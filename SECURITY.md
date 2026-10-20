# Security

## Reporting a problem

Do **not** open a public issue, pull request or discussion for a security problem, in
Bolt or in any app here.

Email **security@sparcle.app**. Scope, response times and safe harbour are in our
[vulnerability disclosure policy](https://sparcle.app/trust/vulnerability-disclosure/).

Examples of what to report privately:

- an app that does more than its listing says, or hides a permission from the checker;
- a way to get an app past the checker or the review;
- a secret or real personal data that was merged by mistake;
- a flaw in how Bolt verifies, installs or runs a Boltpack.

## How apps here are kept safe

- The checker loads every app with Bolt's own code in a clean setup, recomputes its tier
  and permissions, and looks for secrets and personal data. A failing check blocks the merge.
- Only tier 1 and tier 2 apps are accepted from the community. Anything that runs
  commands, reads files, calls the network or gives an AI agent tools is accepted only
  after a review by Sparcle.
- A person at Sparcle reviews every app before it is merged. "Reviewed by Sparcle" means
  Sparcle checked that version's declared permissions and behaviour. It is not a guarantee.
- What Bolt enforces, and what it does not yet, is listed at
  <https://sparcle.app/docs/extend/security/>.
