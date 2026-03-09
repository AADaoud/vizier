import { useState } from 'react';
import { useApp } from '../context';
import { FindCandidate } from '../commands/slashCommands';

interface FindResultsMessageProps {
	query: string;
	candidates: FindCandidate[];
}

export const FindResultsMessage = ({ query, candidates }: FindResultsMessageProps) => {
	const app = useApp();
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(candidates.map(c => c.title))
	);

	const toggle = (title: string) => {
		setSelected(prev => {
			const next = new Set(prev);
			if (next.has(title)) next.delete(title);
			else next.add(title);
			return next;
		});
	};

	const openSelected = () => {
		for (const title of selected) {
			void app.workspace.openLinkText(title, '', false);
		}
	};

	const selectedCount = selected.size;

	return (
		<div className="ai-chat-find-results">
			<p className="ai-chat-find-header">
				Found <strong>{candidates.length}</strong> note{candidates.length !== 1 ? 's' : ''} for <em>"{query}"</em>
			</p>
			<div className="ai-chat-find-list">
				{candidates.map(c => (
					<button
						key={c.title}
						className={`ai-chat-find-candidate${selected.has(c.title) ? ' ai-chat-find-candidate--selected' : ''}`}
						onClick={() => toggle(c.title)}
						title={c.relevance || c.title}
					>
						<span className="ai-chat-find-candidate-check">
							{selected.has(c.title) ? '✓' : '○'}
						</span>
						<span className="ai-chat-find-candidate-body">
							<span className="ai-chat-find-candidate-title">[[{c.title}]]</span>
							{c.relevance && (
								<span className="ai-chat-find-candidate-relevance">{c.relevance}</span>
							)}
							{c.terms.length > 0 && (
								<span className="ai-chat-find-candidate-terms">
									{c.terms.map(t => <code key={t}>{t}</code>)}
								</span>
							)}
						</span>
					</button>
				))}
			</div>
			<div className="ai-chat-find-actions">
				<button
					className="ai-chat-find-open-btn"
					onClick={openSelected}
					disabled={selectedCount === 0}
				>
					Open selected ({selectedCount})
				</button>
				<button
					className="ai-chat-find-toggle-all"
					onClick={() => {
						if (selectedCount === candidates.length) {
							setSelected(new Set());
						} else {
							setSelected(new Set(candidates.map(c => c.title)));
						}
					}}
				>
					{selectedCount === candidates.length ? 'Deselect all' : 'Select all'}
				</button>
			</div>
		</div>
	);
};
