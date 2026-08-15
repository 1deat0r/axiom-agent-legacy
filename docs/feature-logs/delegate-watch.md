# Delegate journal and live watch (issue #48, ADR-0072)

Every delegate run now leaves an activity journal on disk, and `axiom delegate
list` / `axiom delegate watch` turn it into a live terminal view. Watch a run
while it works, scroll back, and see the final block when it settles.
