/** Preserves Error instances while adding context to unknown thrown values. */
export default function normalizeError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error })
}
