/** Tiny typed event emitter; a throwing listener never breaks the others. */
export class Emitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => void set?.delete(fn as (payload: never) => void);
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) {
      try {
        (fn as (payload: Events[E]) => void)(payload);
      } catch {
        // A listener's bug must not break the client.
      }
    }
  }
}
