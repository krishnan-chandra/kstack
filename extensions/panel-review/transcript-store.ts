export {
	MAX_CHILD_ENTRIES,
	MAX_CHILD_TRANSCRIPT_BYTES,
	MAX_ENTRY_TEXT_BYTES,
} from "../shared/transcript-store.ts";

import { ChildTranscriptStore } from "../shared/transcript-store.ts";

/** Panel-review name for the shared bounded child transcript store. */
export class PanelTranscriptStore extends ChildTranscriptStore {}
