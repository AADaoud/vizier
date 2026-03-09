declare module 'youtube-transcript-api' {
	export interface TranscriptSegment {
		text: string;
		start: string;
		dur: string;
	}
	export interface TranscriptTrack {
		language: string;
		transcript: TranscriptSegment[];
	}
	export interface TranscriptResult {
		id: string;
		title: string;
		tracks: TranscriptTrack[];
		isLive: boolean;
		isLoginRequired: boolean;
		playabilityStatus: {
			status: string;
			reason?: string;
		};
		microformat?: {
			playerMicroformatRenderer?: {
				title?: { simpleText?: string };
				description?: { simpleText?: string };
				category?: string;
			};
		};
		failedReason?: string;
	}
	export default class TranscriptClient {
		ready: Promise<void>;
		getTranscript(id: string): Promise<TranscriptResult>;
	}
}
