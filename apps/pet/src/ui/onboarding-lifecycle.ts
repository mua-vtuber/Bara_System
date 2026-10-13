/** A callback belongs to one visit to a step, even when that step is entered again. */
export function createStepScope() {
  let generation = 0;
  return {
    enter(): () => boolean {
      const current = ++generation;
      return () => current === generation;
    },
    invalidate(): void { generation++; },
  };
}
