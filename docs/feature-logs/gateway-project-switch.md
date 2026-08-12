
# ADDENDUM — terminal boxed menus (course-correction)
- [clarify] User wants a BOXED TUI menu in the terminal (not gateway text). Interactive mode already has /profiles+/projects slash commands dumping CLI text; overlay infra exists (SelectList+DynamicBorder+showFullPaneOverlay, /update relaunch precedent).
- [design] No-arg /profiles and /projects open a centered boxed selector (current marked; ↑/↓, Enter, Esc). Select != current -> clean relaunch under --profile/--project (boot-scoped switch, mirrors /update teardown+spawn; strips workspace/session/daemon flags + AXIOM_HOME env so the child resolves its own home). Subcommands stay text. Reuses listProjectNames; new listProfileNames export.
- [tui step1 DONE] workspace-selector component + helpers + listProfileNames; 10 tests green; committed.
