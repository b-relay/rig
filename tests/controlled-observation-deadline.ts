export function controlledDeadline() {
  let expire: (() => void) | undefined;
  const budgets: number[] = [];
  return {
    budgets,
    get pending() {
      return expire !== undefined;
    },
    schedule(budgetMs: number, callback: () => void) {
      budgets.push(budgetMs);
      expire = callback;
      return () => {
        expire = undefined;
      };
    },
    expire() {
      expire?.();
    },
  };
}
