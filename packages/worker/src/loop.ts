export function singleFlight(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<boolean> {
  let running = false;
  return async () => {
    if (running) return false;
    running = true;
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
    return true;
  };
}
