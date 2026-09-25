// A two-thread spinlock model.
export function init() { return { held: false, holder: null }; }

export function acquire(state, thread) {
  if (state.held) return state;
  return { held: true, holder: thread };
}

export function release(state, thread) {
  if (state.held && state.holder === thread) {
    return { held: false, holder: null };
  }
  return state;
}
