// Stabilize presentation only; trading and incoming order updates stay live.
export class RestingHold {
  private latest = false;
  private until = -Infinity;

  update(resting: boolean, now: number, stabilize = true): boolean {
    if (!stabilize) this.until = -Infinity;
    if (stabilize && resting && !this.value(now)) this.until = now + 30;
    this.latest = resting;
    return this.value(now);
  }

  releaseGrace(): boolean {
    this.until = -Infinity;
    return this.latest;
  }

  value(now: number): boolean {
    return this.latest || now < this.until;
  }
}
