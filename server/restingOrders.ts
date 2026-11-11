type OrderState = { status: string; remaining_count_fp?: string };

// A list response can lag behind the order stream. Check each missing known
// order directly before dropping its chart's protection. Failed reads retain it.
export async function verifyMissingRestingOrders(
  observed: Map<string, string>,
  previous: ReadonlyMap<string, string>,
  lookup: (id: string) => Promise<OrderState>,
): Promise<Map<string, string>> {
  const result = new Map(observed);
  await Promise.all([...previous].filter(([id]) => !result.has(id)).map(async ([id, ticker]) => {
    try {
      const order = await lookup(id);
      if (order.status === "canceled" || order.status === "executed") return;
      // Unknown/transitional statuses aren't confirmation that the order closed.
      result.set(id, ticker);
    } catch {
      result.set(id, ticker);
    }
  }));
  return result;
}
