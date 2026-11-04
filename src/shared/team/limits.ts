/**
 * A decline reason's limit (spekterm-server protocol §5 `handoff.update`), in UTF-16 code units after normalization
 * (`teammate-handoff-return`). Shared: the main process enforces it, the inbox shows the count against it.
 */
export const MAX_DECLINE_REASON_LENGTH = 500
