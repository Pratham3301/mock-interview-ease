export class RetainedOperation<T, R> {
  private input?: T;
  private inFlight?: Promise<R>;

  constructor(private readonly execute: (input: T) => Promise<R>) {}

  run(input: T) {
    this.input = input;
    return this.runRetained();
  }

  retry() {
    if (!this.input) throw new Error("There is no operation to retry.");
    return this.runRetained();
  }

  hasInput() {
    return this.input !== undefined;
  }

  private runRetained() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.execute(this.input!).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
