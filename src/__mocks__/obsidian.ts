// Minimal stub for Obsidian API used in tests.
// Only export what the tested modules actually import.

export const requestUrl = async (_opts: unknown) => ({ status: 200, text: '', json: {} });
