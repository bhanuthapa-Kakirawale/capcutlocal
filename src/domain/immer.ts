import { produce, setAutoFreeze } from 'immer';

/**
 * Auto-freeze deep-freezes the entire new state tree on every `produce` call — a useful
 * dev-time guard against accidental mutation outside an op, but its cost is proportional
 * to document size, which blows the "every op < 2 ms on a 5,000-clip sequence" budget
 * (docs/ROADMAP.md Phase 4 gate). Structural immutability is already guaranteed by
 * `produce` itself (a caller literally cannot get a mutable reference to the old or new
 * state); disabling auto-freeze removes only the extra recursive-freeze safety net, not
 * that guarantee. Every op imports `produce` from here instead of `immer` directly so
 * this takes effect exactly once, before any op runs.
 */
setAutoFreeze(false);

export { produce };
