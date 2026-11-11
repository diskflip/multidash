// Serialize updates to one bot (enabled and budget share a PUT payload).
// Polls started before or during a command cannot overwrite its result.
export class BotCommandLane {
  private tails = new Map<string, Promise<unknown>>();
  private revisions = new Map<string, number>();
  revision(symbol: string) { return this.revisions.get(symbol) ?? 0; }
  canApplyPoll(symbol: string, revision: number) {
    return !this.tails.has(symbol) && this.revision(symbol) === revision;
  }
  run<T>(symbol: string, update: () => Promise<T>): Promise<T> {
    this.revisions.set(symbol, this.revision(symbol) + 1);
    const result = (this.tails.get(symbol) ?? Promise.resolve()).catch(() => {}).then(update);
    const tail = result.finally(() => {
      this.revisions.set(symbol, this.revision(symbol) + 1);
      if (this.tails.get(symbol) === tail) this.tails.delete(symbol);
    });
    this.tails.set(symbol, tail);
    return tail;
  }
}
