const PREFIX = '[Vizier]';

export const logger = {
	log:   (...args: unknown[]) => console.debug(PREFIX, ...args),
	warn:  (...args: unknown[]) => console.warn(PREFIX, ...args),
	error: (...args: unknown[]) => console.error(PREFIX, ...args),
};
