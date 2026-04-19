export interface PersonNote {
	type: 'person';
	name: string;
	born: string;
	died: string;
	nationality: string[];
	roles: string[];
	wikipedia: string;
	image: string;
	bio: string;
	related_people: string[];
	related_events: string[];
	related_ideas: string[];
	tags: string[];
}

export interface EventNote {
	type: 'event';
	title: string;
	date: string;
	date_end: string;
	location: string;
	participants: string[];
	timeline_tags: string[];
	significance: 'low' | 'medium' | 'high' | '';
	related_events: string[];
	related_people: string[];
	wikipedia: string;
	tags: string[];
}

export interface IdeaNote {
	type: 'idea';
	title: string;
	domain: string[];
	proponents: string[];
	period: string;
	related_ideas: string[];
	tags: string[];
}

export interface WikiSearchResult {
	title: string;
	snippet: string;
}

export interface WikiPageData {
	title: string;
	summary: string;
	extract: string;
	url: string;
	image_url: string;
}

export interface ManualPersonData {
	name: string;
	born: string;
	died: string;
	nationality: string;
	roles: string;
	bio: string;
}

export interface ManualEventData {
	title: string;
	date: string;
	date_end: string;
	location: string;
	participants: string;
	timeline_tags: string;
	significance: string;
}

export interface PersonStructured {
	born: string;
	died: string;
	nationality: string[];
	roles: string[];
	bio: string;
	related_people: string[];
	related_events: string[];
	related_ideas: string[];
	tags: string[];
}

export interface EventStructured {
	date: string;
	date_end: string;
	location: string;
	participants: string[];
	timeline_tags: string[];
	significance: 'low' | 'medium' | 'high' | '';
	related_events: string[];
	related_people: string[];
	tags: string[];
}

export interface IdeaStructured {
	title: string;
	domain: string[];
	proponents: string[];
	period: string;
	related_ideas: string[];
	bio: string;
	tags: string[];
}
