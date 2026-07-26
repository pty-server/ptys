const BUDGET_BYTES = 8 * 1024 * 1024;
const COALESCE_ENTER_BYTES = BUDGET_BYTES * 0.8;
const COALESCE_EXIT_BYTES = BUDGET_BYTES * 0.5;
const DEAD_CEILING_BYTES = BUDGET_BYTES * 2;

export type BackpressureState = "live" | "coalescing" | "dead";

export const BACKPRESSURE_THRESHOLDS = {
  budget: BUDGET_BYTES,
  coalesceEnter: COALESCE_ENTER_BYTES,
  coalesceExit: COALESCE_EXIT_BYTES,
  deadCeiling: DEAD_CEILING_BYTES,
};

export function decideForward(
  state: BackpressureState,
  bufferedAmount: number,
  eligible: boolean,
): { action: "send" | "drop" | "kill"; nextState: BackpressureState } {
  if (state === "dead") return { action: "drop", nextState: "dead" };
  if (state === "coalescing") return { action: "drop", nextState: "coalescing" };
  if (bufferedAmount > DEAD_CEILING_BYTES) return { action: "kill", nextState: "dead" };
  if (eligible && bufferedAmount > COALESCE_ENTER_BYTES) return { action: "drop", nextState: "coalescing" };
  return { action: "send", nextState: "live" };
}

export function decideCoalescingTick(bufferedAmount: number): "kill" | "exit-to-live" | "snapshot" {
  if (bufferedAmount > DEAD_CEILING_BYTES) return "kill";
  if (bufferedAmount < COALESCE_EXIT_BYTES) return "exit-to-live";
  return "snapshot";
}
