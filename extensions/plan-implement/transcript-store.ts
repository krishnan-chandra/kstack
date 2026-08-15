export {
	EVICTION_NOTICE,
	MAX_CHILD_ENTRIES,
	MAX_CHILD_TRANSCRIPT_BYTES,
	MAX_ENTRY_TEXT_BYTES,
	type TranscriptEntry,
} from "../shared/transcript-store.ts";

import { ChildTranscriptStore } from "../shared/transcript-store.ts";

/** Plan-implement name for the shared bounded child transcript store. */
export class PlanImplementTranscriptStore extends ChildTranscriptStore {}
