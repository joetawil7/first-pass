# Invariants

What this system must never break, whatever the feature. Every change is checked against
the ones it touches (the pre-mortem names them; the breaker checks them). Each invariant
says what holds it today and where it is known to break.

- When a fix lands, move its id out of "Known breaks".
- When a new break is found, add it.
- An invariant held only by convention is a candidate for a check that makes breaking it
  fail CI: a test, a lint rule, a database constraint, or a shared helper that is the only
  way to do the thing.

<!-- One entry per invariant:

1. **<One sentence the system must always keep true.>**
   Held by: <the code, constraint, helper or test that enforces it; "convention only"; or "nothing yet">
   Known breaks: <issue ids or file:line, or "none known">
-->
